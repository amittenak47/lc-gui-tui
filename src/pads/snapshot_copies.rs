//! Immutable, self-contained backups; a live parent is deliberately unnecessary.
//!
//! Identity is SHA-256 of canonical JSON `{tier,payload}`. Only recognized
//! primary/footnote gzip fields are normalized to their validated packed bytes,
//! and attachment payload JSON strings are canonicalized. Every authored field,
//! source string, view setting, timestamp and unknown field remains included.
//! Storage retains the original DTO content and first copy's display timestamp.
use super::atomic_sync::ProtocolError;
use super::{
    artifacts, read_transaction, sync_content, write_transaction, SnapshotRow, SystemClock,
};
use anyhow::{ensure, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    ensure!(
        !conn.is_autocommit(),
        "snapshot migration requires a transaction"
    );
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS snapshot_copies (
            kind TEXT NOT NULL, key TEXT NOT NULL, content_hash TEXT NOT NULL,
            tier TEXT NOT NULL, payload_json TEXT NOT NULL, written_at INTEGER NOT NULL,
            stored_at INTEGER NOT NULL, PRIMARY KEY(kind,key,content_hash)
        );",
    )?;
    Ok(())
}

fn validate_owner(kind: &str, key: &str) -> Result<()> {
    ensure!(
        matches!(kind, "annotate" | "whiteboard"),
        "unknown snapshot kind"
    );
    ensure!(
        !key.is_empty()
            && key.trim() == key
            && key.encode_utf16().count() <= 1024
            && !key.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}'),
        "invalid snapshot owner"
    );
    Ok(())
}

fn validate_hash(hash: &str) -> Result<()> {
    ensure!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "invalid snapshot content hash"
    );
    Ok(())
}

fn normalize_ink_pages(pages: &mut Value) -> Result<()> {
    // Reuse the legacy shape checks for child pages as well as primary pages.
    super::validate_snapshot_payload(&json!({"ink": pages}))?;
    for page in pages
        .as_array_mut()
        .context("snapshot ink must be an array")?
    {
        let text = page["gz"].as_str().context("snapshot ink page needs gz")?;
        let bytes = BASE64.decode(text).context("snapshot ink is not base64")?;
        let validated = sync_content::validate_ink(&bytes)?;
        page["gz"] = Value::String(BASE64.encode(validated.packed));
    }
    Ok(())
}

pub fn normalized_payload(payload: &Value) -> Result<Value> {
    let mut normalized = payload.clone();
    if let Some(pages) = normalized.get_mut("ink") {
        normalize_ink_pages(pages)?;
    }
    if let Some(children) = normalized.get_mut("footnoteInk") {
        for pages in children
            .as_object_mut()
            .context("snapshot footnote ink must be an object")?
            .values_mut()
        {
            normalize_ink_pages(pages)?;
        }
    }
    if let Some(bundle) = normalized.get_mut("artifactBundle") {
        let assets = bundle
            .get_mut("assets")
            .and_then(Value::as_array_mut)
            .context("missing backup assets")?;
        for asset in assets {
            let text = asset["payload"]
                .as_str()
                .context("invalid backup asset payload")?;
            let parsed: Value = serde_json::from_str(text).context("invalid backup asset JSON")?;
            asset["payload"] = Value::String(sync_content::canonical_json(&parsed)?);
        }
    }
    Ok(normalized)
}

fn hash_input(row: &SnapshotRow) -> Result<Value> {
    validate_owner(&row.kind, &row.key)?;
    ensure!(
        matches!(row.tier.as_str(), "2h" | "24h" | "7d"),
        "unknown snapshot tier"
    );
    super::validate_snapshot_payload(&row.payload)?;
    artifacts::validate_snapshot_bundle(row.payload.get("artifactBundle"), &row.kind, &row.key)?;
    Ok(json!({"tier": row.tier, "payload": normalized_payload(&row.payload)?}))
}

pub fn content_hash(row: &SnapshotRow) -> Result<String> {
    Ok(sync_content::hash_bytes(
        sync_content::canonical_json(&hash_input(row)?)?.as_bytes(),
    ))
}

fn invalid(message: impl std::fmt::Display) -> ProtocolError {
    ProtocolError {
        status: 422,
        body: json!({"error": "invalid_snapshot_copy", "message": message.to_string()}),
    }
}

fn copy_metadata(hash: &str, row: &SnapshotRow) -> Value {
    json!({
        "content_hash": hash, "tier": row.tier, "written_at": row.written_at,
        "name": row.payload.get("name").and_then(Value::as_str).unwrap_or("")
    })
}

fn read_copy(conn: &Connection, kind: &str, key: &str, hash: &str) -> Result<Option<SnapshotRow>> {
    Ok(conn
        .query_row(
            "SELECT kind,key,tier,written_at,payload_json FROM snapshot_copies
            WHERE kind=?1 AND key=?2 AND content_hash=?3",
            params![kind, key, hash],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
        .map(
            |(kind, key, tier, written_at, payload)| -> Result<SnapshotRow> {
                Ok(SnapshotRow {
                    kind,
                    key,
                    tier,
                    written_at,
                    payload: serde_json::from_str(&payload)
                        .context("unreadable immutable snapshot JSON")?,
                })
            },
        )
        .transpose()?)
}

fn legacy_rows(conn: &Connection, kind: &str, key: &str) -> Result<Vec<(String, i64, String)>> {
    let mut statement = conn.prepare(
        "SELECT tier,written_at,payload_json FROM snapshots WHERE kind=?1 AND key=?2 ORDER BY tier",
    )?;
    let rows = statement
        .query_map(params![kind, key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn parse_legacy_copy(
    kind: &str,
    key: &str,
    (tier, written_at, payload): (String, i64, String),
) -> Result<SnapshotRow> {
    Ok(SnapshotRow {
        kind: kind.into(),
        key: key.into(),
        tier,
        written_at,
        payload: serde_json::from_str(&payload).context("unreadable legacy snapshot JSON")?,
    })
}

fn legacy_copies(conn: &Connection, kind: &str, key: &str) -> Result<Vec<SnapshotRow>> {
    legacy_rows(conn, kind, key)?
        .into_iter()
        .map(|row| parse_legacy_copy(kind, key, row))
        .collect()
}

/// A failed request cannot publish, resurrect, compact or replace any book data.
pub fn put_snapshot_copy(
    conn: &Connection,
    kind: &str,
    key: &str,
    hash: &str,
    row: &SnapshotRow,
) -> Result<Result<Value, ProtocolError>> {
    let validated = (|| -> Result<String> {
        validate_owner(kind, key)?;
        validate_hash(hash)?;
        ensure!(
            row.kind == kind && row.key == key,
            "snapshot URL and body owners differ"
        );
        let input = sync_content::canonical_json(&hash_input(row)?)?;
        ensure!(
            sync_content::hash_bytes(input.as_bytes()) == hash,
            "snapshot content hash differs from URL"
        );
        Ok(input)
    })();
    let input = match validated {
        Ok(input) => input,
        Err(error) => return Ok(Err(invalid(error))),
    };
    write_transaction(conn, || {
        if let Some(existing) = read_copy(conn, kind, key, hash)? {
            if sync_content::canonical_json(&hash_input(&existing)?)? != input {
                return Ok(Err(ProtocolError {
                    status: 409,
                    body: json!({
                        "error":"immutable_snapshot_conflict", "content_hash":hash
                    }),
                }));
            }
            return Ok(Ok(copy_metadata(hash, &existing)));
        }
        conn.execute(
            "INSERT INTO snapshot_copies(kind,key,content_hash,tier,payload_json,written_at,stored_at)
                VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![kind,key,hash,row.tier,serde_json::to_string(&row.payload)?,row.written_at,
                super::now_ms(&SystemClock)],
        )?;
        Ok(Ok(copy_metadata(hash, row)))
    })
}

pub fn list_snapshot_copies(conn: &Connection, kind: &str, key: &str) -> Result<Vec<Value>> {
    validate_owner(kind, key)?;
    read_transaction(conn, || {
        let mut copies = BTreeMap::new();
        let hashes = {
            let mut statement = conn.prepare(
                "SELECT content_hash FROM snapshot_copies WHERE kind=?1 AND key=?2 ORDER BY content_hash",
            )?;
            let hashes = statement
                .query_map(params![kind, key], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            hashes
        };
        for hash in hashes {
            let row =
                read_copy(conn, kind, key, &hash)?.context("immutable snapshot disappeared")?;
            ensure!(
                content_hash(&row)? == hash,
                "immutable snapshot content is unreadable or mismatched"
            );
            copies.insert(hash.clone(), copy_metadata(&hash, &row));
        }
        for row in legacy_copies(conn, kind, key)? {
            let hash = content_hash(&row)?;
            copies
                .entry(hash.clone())
                .or_insert_with(|| copy_metadata(&hash, &row));
        }
        Ok(copies.into_values().collect())
    })
}

pub fn get_snapshot_copy(
    conn: &Connection,
    kind: &str,
    key: &str,
    hash: &str,
) -> Result<Option<SnapshotRow>> {
    validate_owner(kind, key)?;
    validate_hash(hash)?;
    read_transaction(conn, || {
        if let Some(row) = read_copy(conn, kind, key, hash)? {
            ensure!(
                content_hash(&row)? == hash,
                "immutable snapshot content is unreadable or mismatched"
            );
            return Ok(Some(row));
        }
        let mut unreadable = None;
        for raw in legacy_rows(conn, kind, key)? {
            let result = (|| -> Result<(SnapshotRow, String)> {
                let row = parse_legacy_copy(kind, key, raw)?;
                let hash = content_hash(&row)?;
                Ok((row, hash))
            })();
            match result {
                Ok((row, row_hash)) if row_hash == hash => return Ok(Some(row)),
                Ok(_) => {}
                Err(error) => {
                    unreadable.get_or_insert(error);
                }
            }
        }
        if let Some(error) = unreadable {
            return Err(error);
        }
        Ok(None)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn snapshot_hash_matches_the_shared_typescript_golden_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../app/src/util/fixtures/snapshot-copy-golden.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let row: SnapshotRow = serde_json::from_value(case["input"].clone()).unwrap();
            assert_eq!(
                content_hash(&row).unwrap(),
                case["hash"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                sync_content::canonical_json(&hash_input(&row).unwrap()).unwrap(),
                sync_content::canonical_json(&case["normalized"]).unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    fn packed_ink(erase_only: bool) -> Vec<u8> {
        let meta = serde_json::to_vec(&json!({"meta":[],"raw":[{
            "kind": if erase_only {"erase"} else {"draw"},"points":[{"x":2,"y":3}]
        }]}))
        .unwrap();
        let mut bytes = b"inkC".to_vec();
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        bytes.extend(meta);
        bytes
    }

    fn gz(erase_only: bool) -> String {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&packed_ink(erase_only)).unwrap();
        BASE64.encode(encoder.finish().unwrap())
    }

    fn full_snapshot(key: &str) -> SnapshotRow {
        serde_json::from_value(
            json!({"kind":"annotate","key":key,"tier":"24h","written_at":123,
            "payload":{
                "name":"Algorithms","board":{"v":1,"elements":[],"appState":{"scrollX":12}},
                "source":"{\"keep this source text\": true}","footnotes":[{"id":"note"}],
                "agent":[{"id":"turn","role":"user","content":"a retained question"}],
                "ink":[{"pageId":113,"updatedAt":10,"gz":gz(true)}],
                "footnoteBoards":{"scratch":{"board":{"v":1,"elements":[]},"pageCount":1}},
                "footnoteInk":{"scratch":[{"pageId":0,"updatedAt":11,"gz":gz(false)}]},
                "edges":[{"id":"edge","kind":"related","from":{"type":"annotate","id":key},
                    "to":{"type":"thread","id":"turn"}}],
                "unknownAuthored":{"hash":"retained","rev":9}
            }}),
        )
        .unwrap()
    }

    fn copy_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM snapshot_copies", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn missing_and_deleted_parents_accept_full_immutable_backups_without_resurrection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backups.db");
        let conn = super::super::open(&path).unwrap();
        let deleted_parent: super::super::AnnotatePad = serde_json::from_value(json!({
            "id":"deleted","name":"notes.md","hash":"source","updated_at":10,
            "board":{"v":1,"elements":[]},"source":"# Notes"
        }))
        .unwrap();
        super::super::put_annotate(&conn, &deleted_parent).unwrap();
        super::super::delete_pad(&conn, super::super::PadKind::Annotate, "deleted", 2).unwrap();
        let original_heads = super::super::list_book_heads(&conn).unwrap();
        for key in ["missing", "deleted"] {
            let row = full_snapshot(key);
            let hash = content_hash(&row).unwrap();
            assert!(put_snapshot_copy(&conn, &row.kind, key, &hash, &row)
                .unwrap()
                .is_ok());
            let restored = get_snapshot_copy(&conn, &row.kind, key, &hash)
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::to_value(restored).unwrap(),
                serde_json::to_value(&row).unwrap()
            );
            assert!(super::super::get_annotate(&conn, key).unwrap().is_none());
            assert_eq!(
                list_snapshot_copies(&conn, &row.kind, key).unwrap()[0]["name"],
                "Algorithms"
            );
        }
        assert_eq!(copy_count(&conn), 2);
        assert_eq!(
            super::super::gone_seq(&conn, super::super::PadKind::Annotate, "deleted").unwrap(),
            2
        );
        assert_eq!(
            super::super::list_book_heads(&conn).unwrap(),
            original_heads
        );
        drop(conn);
        let reopened = super::super::open(&path).unwrap();
        assert_eq!(copy_count(&reopened), 2);
        for key in ["missing", "deleted"] {
            assert_eq!(
                list_snapshot_copies(&reopened, "annotate", key)
                    .unwrap()
                    .len(),
                1
            );
        }
    }

    #[test]
    fn normalized_retries_keep_first_bytes_and_same_tier_distinct_copies_are_retained() {
        let directory = tempfile::tempdir().unwrap();
        let conn = super::super::open(&directory.path().join("copies.db")).unwrap();
        let mut first = full_snapshot("a");
        first.payload["unknownAuthored"]["scale"] = json!(1);
        let hash = content_hash(&first).unwrap();
        put_snapshot_copy(&conn, "annotate", "a", &hash, &first)
            .unwrap()
            .unwrap();
        let mut repeated = first.clone();
        repeated.written_at = 999;
        repeated.payload["unknownAuthored"]["scale"] = json!(1.0);
        repeated.payload["ink"][0]["gz"] = json!(BASE64.encode(packed_ink(true)));
        repeated.payload["footnoteInk"]["scratch"][0]["gz"] =
            json!(BASE64.encode(packed_ink(false)));
        assert_eq!(content_hash(&repeated).unwrap(), hash);
        let ack = put_snapshot_copy(&conn, "annotate", "a", &hash, &repeated)
            .unwrap()
            .unwrap();
        assert_eq!(ack["written_at"], 123);
        assert_eq!(
            serde_json::to_value(
                get_snapshot_copy(&conn, "annotate", "a", &hash)
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(&first).unwrap()
        );
        let mut changed = first.clone();
        changed.payload["source"] = json!("another retained source");
        let changed_hash = content_hash(&changed).unwrap();
        assert_ne!(changed_hash, hash);
        assert_eq!(
            put_snapshot_copy(&conn, "annotate", "a", &hash, &changed)
                .unwrap()
                .unwrap_err()
                .status,
            422
        );
        assert_eq!(
            copy_count(&conn),
            1,
            "a different body never replaces an existing copy"
        );
        put_snapshot_copy(&conn, "annotate", "a", &changed_hash, &changed)
            .unwrap()
            .unwrap();
        assert_eq!(copy_count(&conn), 2);
        assert_eq!(
            list_snapshot_copies(&conn, "annotate", "a").unwrap().len(),
            2
        );
        changed.tier = "7d".into();
        assert_ne!(
            content_hash(&changed).unwrap(),
            changed_hash,
            "tier participates in copy identity"
        );
    }

    #[test]
    fn wrong_identity_hash_tier_and_unreadable_primary_or_child_ink_are_rejected_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let conn = super::super::open(&directory.path().join("validation.db")).unwrap();
        let row = full_snapshot("a");
        let hash = content_hash(&row).unwrap();
        for (kind, key, request_hash) in [
            ("whiteboard", "a", hash.as_str()),
            ("annotate", "other", hash.as_str()),
            ("annotate", "a", "bad-hash"),
            (
                "annotate",
                "a",
                "0000000000000000000000000000000000000000000000000000000000000000",
            ),
        ] {
            assert_eq!(
                put_snapshot_copy(&conn, kind, key, request_hash, &row)
                    .unwrap()
                    .unwrap_err()
                    .status,
                422
            );
        }
        let mut bad = row.clone();
        bad.tier = "forever".into();
        assert_eq!(
            put_snapshot_copy(&conn, "annotate", "a", &hash, &bad)
                .unwrap()
                .unwrap_err()
                .status,
            422
        );
        bad = row.clone();
        bad.payload["ink"][0]["gz"] = json!(BASE64.encode(b"broken"));
        assert!(content_hash(&bad).is_err());
        assert_eq!(
            put_snapshot_copy(&conn, "annotate", "a", &hash, &bad)
                .unwrap()
                .unwrap_err()
                .status,
            422
        );
        bad = row.clone();
        bad.payload["footnoteInk"]["scratch"][0]["gz"] = json!(BASE64.encode([0x1f, 0x8b, 0]));
        assert!(content_hash(&bad).is_err());
        assert_eq!(
            put_snapshot_copy(&conn, "annotate", "a", &hash, &bad)
                .unwrap()
                .unwrap_err()
                .status,
            422
        );
        assert_eq!(copy_count(&conn), 0);
        assert!(super::super::list_book_heads(&conn).unwrap().is_empty());
    }

    #[test]
    fn legacy_tiers_are_readable_by_exact_hash_without_rewrites_and_overlap_is_deduplicated() {
        let directory = tempfile::tempdir().unwrap();
        let conn = super::super::open(&directory.path().join("legacy.db")).unwrap();
        let row = full_snapshot("removed");
        let original = format!("  {}  ", serde_json::to_string(&row.payload).unwrap());
        conn.execute(
            "INSERT INTO snapshots(kind,key,tier,written_at,payload_json) VALUES(?1,?2,?3,?4,?5)",
            params![row.kind, row.key, row.tier, row.written_at, original],
        )
        .unwrap();
        let hash = content_hash(&row).unwrap();
        assert_eq!(
            list_snapshot_copies(&conn, "annotate", "removed")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            get_snapshot_copy(&conn, "annotate", "removed", &hash)
                .unwrap()
                .unwrap()
                .payload,
            row.payload
        );
        assert!(
            get_snapshot_copy(&conn, "annotate", "removed", &"0".repeat(64))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            copy_count(&conn),
            0,
            "reading legacy backups never migrates or publishes them"
        );
        put_snapshot_copy(&conn, "annotate", "removed", &hash, &row)
            .unwrap()
            .unwrap();
        assert_eq!(
            list_snapshot_copies(&conn, "annotate", "removed")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(copy_count(&conn), 1);
        let preserved: String = conn
            .query_row(
                "SELECT payload_json FROM snapshots WHERE key='removed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, original);
        let mut different = row.clone();
        different.payload["unknownAuthored"]["rev"] = json!(10);
        put_snapshot_copy(
            &conn,
            "annotate",
            "removed",
            &content_hash(&different).unwrap(),
            &different,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            list_snapshot_copies(&conn, "annotate", "removed")
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn attachment_bundles_are_self_contained_canonical_and_retained_in_full() {
        let directory = tempfile::tempdir().unwrap();
        let conn = super::super::open(&directory.path().join("attachments.db")).unwrap();
        let mut row = full_snapshot("a");
        let asset_payload = json!({"v":1,"owned":true,"docType":"markdown","name":"Saved.md",
            "source":"{\"source must remain text\":1}","footnotes":[],"agent":[],"ink":[],
            "board":{"v":1,"elements":[],"appState":{"scrollX":0,"scrollY":0,"zoom":1}},
            "unknown":{"rev":42,"hash":"keep"}});
        row.payload["artifactBundle"] = json!({"v":1,"catalog":{
            "v":1,"parent":{"kind":"annotate","id":"a"},"revision":"catalog-1",
            "artifacts":[{"id":"note","title":"Saved.md","revision":"note-1","createdAt":1,"updatedAt":2,
                "associations":[{"kind":"file"}],"content":{"kind":"markdown","documentId":"owned","sourceRevision":"source-1"}}]},
            "assets":[{"parent":{"kind":"annotate","id":"a"},"dependency":{"kind":"document","id":"owned","revision":"source-1"},
                "payload":serde_json::to_string_pretty(&asset_payload).unwrap()}]});
        let hash = content_hash(&row).unwrap();
        let mut equivalent = row.clone();
        equivalent.payload["artifactBundle"]["assets"][0]["payload"] =
            json!(serde_json::to_string(&asset_payload).unwrap());
        assert_eq!(content_hash(&equivalent).unwrap(), hash);
        assert_eq!(
            normalized_payload(&row.payload).unwrap()["source"],
            row.payload["source"]
        );
        put_snapshot_copy(&conn, "annotate", "a", &hash, &row)
            .unwrap()
            .unwrap();
        assert_eq!(
            get_snapshot_copy(&conn, "annotate", "a", &hash)
                .unwrap()
                .unwrap()
                .payload,
            row.payload
        );
        let mut incomplete = row.clone();
        incomplete.payload["artifactBundle"]["assets"] = json!([]);
        assert!(content_hash(&incomplete).is_err());
        assert_eq!(
            put_snapshot_copy(&conn, "annotate", "a", &hash, &incomplete)
                .unwrap()
                .unwrap_err()
                .status,
            422
        );
        let mut changed = equivalent;
        changed.payload["artifactBundle"]["catalog"]["revision"] = json!("catalog-2");
        assert_ne!(content_hash(&changed).unwrap(), hash);
        assert_eq!(copy_count(&conn), 1);
    }

    #[test]
    fn unreadable_historic_backups_report_an_error_and_remain_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let conn = super::super::open(&directory.path().join("unreadable.db")).unwrap();
        let broken = "{broken historical JSON";
        conn.execute(
            "INSERT INTO snapshots VALUES('annotate','a','7d',123,?1)",
            params![broken],
        )
        .unwrap();
        assert!(list_snapshot_copies(&conn, "annotate", "a").is_err());
        // A broken tier does not hide another known, valid restore copy.
        let valid = full_snapshot("a");
        conn.execute(
            "INSERT INTO snapshots VALUES(?1,?2,?3,?4,?5)",
            params![
                valid.kind,
                valid.key,
                valid.tier,
                valid.written_at,
                serde_json::to_string(&valid.payload).unwrap()
            ],
        )
        .unwrap();
        let valid_hash = content_hash(&valid).unwrap();
        assert_eq!(
            get_snapshot_copy(&conn, "annotate", "a", &valid_hash)
                .unwrap()
                .unwrap()
                .payload,
            valid.payload
        );
        assert!(get_snapshot_copy(&conn, "annotate", "a", &"0".repeat(64)).is_err());
        let retained: String = conn
            .query_row(
                "SELECT payload_json FROM snapshots WHERE key='a' AND tier='7d'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, broken);
        assert_eq!(copy_count(&conn), 0);
    }

    #[test]
    fn a_stored_hash_collision_is_reported_and_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let conn = super::super::open(&directory.path().join("collision.db")).unwrap();
        let incoming = full_snapshot("a");
        let hash = content_hash(&incoming).unwrap();
        let mut existing = incoming.clone();
        existing.payload["source"] = json!("a different retained backup");
        let original_json = serde_json::to_string(&existing.payload).unwrap();
        // Fault injection: an inconsistent historic identifier must not authorize replacement.
        conn.execute(
            "INSERT INTO snapshot_copies VALUES('annotate','a',?1,'24h',?2,123,456)",
            params![hash, original_json],
        )
        .unwrap();
        let error = put_snapshot_copy(&conn, "annotate", "a", &hash, &incoming)
            .unwrap()
            .unwrap_err();
        assert_eq!(error.status, 409);
        assert_eq!(error.body["error"], "immutable_snapshot_conflict");
        let retained: String = conn
            .query_row(
                "SELECT payload_json FROM snapshot_copies WHERE key='a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, original_json);
        assert!(get_snapshot_copy(&conn, "annotate", "a", &hash).is_err());
        assert_eq!(copy_count(&conn), 1);
    }
}
