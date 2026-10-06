//! Step 1 regression fixtures. Every database lives in a disposable directory.
use super::*;
use serde_json::{json, Value};

struct FixedClock(i64);
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

fn whiteboard(id: &str, updated_at: i64) -> WhiteboardPad {
    serde_json::from_value(json!({
        "id": id, "title": "Original", "updated_at": updated_at,
        "page_count": 2, "board": {"v": 1, "elements": []}, "agent": []
    }))
    .unwrap()
}

fn annotate(id: &str, updated_at: i64) -> AnnotatePad {
    serde_json::from_value(json!({
        "id": id, "name": "notes.md", "hash": "source-hash", "doc_type": "markdown",
        "updated_at": updated_at, "source": "# Notes", "footnotes": [],
        "board": {"v": 1, "elements": []}, "agent": []
    }))
    .unwrap()
}

fn problem(id: &str, updated_at: i64) -> ProblemPad {
    let (dataset, task_id) = id.split_once('/').unwrap();
    serde_json::from_value(json!({
        "id": id, "dataset": dataset, "task_id": task_id, "updated_at": updated_at,
        "board": {"v": 1, "elements": []}, "agent": []
    }))
    .unwrap()
}

fn packed_ink(empty: bool) -> Vec<u8> {
    let meta = if empty {
        json!({"meta": []})
    } else {
        json!({"meta": [], "raw": [{"kind": "draw", "points": [{"x": 2, "y": 3}]}]})
    };
    let meta = serde_json::to_vec(&meta).unwrap();
    let mut packed = b"inkC".to_vec();
    packed.extend_from_slice(&1u32.to_le_bytes());
    packed.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    packed.extend_from_slice(&meta);
    packed
}

fn page(kind: &str, key: &str, page_id: i64, updated_at: i64, empty: bool) -> InkPageRow {
    serde_json::from_value(json!({
        "kind": kind, "key": key, "page_id": page_id, "updated_at": updated_at,
        "gz": BASE64.encode(packed_ink(empty))
    }))
    .unwrap()
}

fn head(conn: &Connection, kind: &str, id: &str) -> i64 {
    list_book_heads(conn)
        .unwrap()
        .into_iter()
        .find(|head| head.kind == kind && head.id == id)
        .unwrap()
        .rev
}

fn sequence(conn: &Connection) -> i64 {
    conn.query_row("SELECT value FROM meta WHERE key='rev_seq'", [], |row| {
        row.get(0)
    })
    .unwrap()
}

fn create_legacy_schema(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE whiteboard (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL,
            page_count INTEGER NOT NULL, deleted_at INTEGER,
            board_json TEXT NOT NULL, agent_json TEXT NOT NULL
        );
        CREATE TABLE annotate (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, doc_type TEXT NOT NULL,
            updated_at INTEGER NOT NULL, deleted_at INTEGER, source_text TEXT NOT NULL,
            footnotes_json TEXT NOT NULL, board_json TEXT NOT NULL, agent_json TEXT NOT NULL
        );
        CREATE TABLE problem (
            id TEXT PRIMARY KEY, dataset TEXT NOT NULL, task_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL, board_json TEXT NOT NULL, agent_json TEXT NOT NULL,
            sync_seq INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE ink_pages (
            kind TEXT NOT NULL, key TEXT NOT NULL, page_id INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, gz BLOB NOT NULL, PRIMARY KEY(kind,key,page_id)
        );
        CREATE TABLE gone (
            kind TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, gone_at INTEGER NOT NULL,
            PRIMARY KEY(kind,id)
        );
        CREATE TABLE snapshots (
            kind TEXT NOT NULL, key TEXT NOT NULL, tier TEXT NOT NULL, written_at INTEGER NOT NULL,
            payload_json TEXT NOT NULL, PRIMARY KEY(kind,key,tier)
        );
        CREATE TABLE revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, pad_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL, written_at INTEGER NOT NULL
        );
    "#,
    )
    .unwrap();
    conn
}

fn seed_same_time_legacy(path: &Path, reverse: bool) {
    let conn = create_legacy_schema(path);
    conn.execute("INSERT INTO annotate VALUES('a','notes.md','source-hash','markdown',7000,NULL,'# Notes','[]','{\"v\":1,\"unknown\":{\"keep\":true}}','[]')", []).unwrap();
    conn.execute("INSERT INTO whiteboard VALUES('w','Original',7000,2,NULL,'{\"v\":1,\"elements\":[]}','[]')", []).unwrap();
    conn.execute("INSERT INTO problem VALUES('leetcode/42','leetcode','42',7000,'{\"v\":1,\"elements\":[]}','[]',0)", []).unwrap();
    conn.execute("INSERT INTO gone VALUES('annotate','deleted',4,7000)", [])
        .unwrap();
    let mut pages = vec![
        ("annotate", "a", 0, false),
        ("annotate", "a", 15, false),
        ("annotate", "a", 113, true),
        ("annotate", "a/fn/n", 0, false),
        ("whiteboard", "w", 0, true),
        ("whiteboard", "w", 9, false),
    ];
    if reverse {
        pages.reverse();
    }
    for (kind, key, page_id, empty) in pages {
        conn.execute(
            "INSERT INTO ink_pages VALUES(?1,?2,?3,7000,?4)",
            params![kind, key, page_id, packed_ink(empty)],
        )
        .unwrap();
    }
}

fn revision_vector(conn: &Connection) -> Vec<(String, String, i64, i64)> {
    let mut statement = conn
        .prepare(
            r#"
        SELECT 'annotate',id,0,rev FROM annotate
        UNION ALL SELECT 'gone',kind || ':' || id,0,rev FROM gone
        UNION ALL SELECT 'ink_pages',kind || ':' || key,page_id,rev FROM ink_pages
        UNION ALL SELECT 'problem',id,0,rev FROM problem
        UNION ALL SELECT 'whiteboard',id,0,rev FROM whiteboard
        ORDER BY 4
    "#,
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn same_time_backfill_is_deterministic_and_reopen_preserves_every_revision() {
    let directory = tempfile::tempdir().unwrap();
    let forward_path = directory.path().join("forward.db");
    let reverse_path = directory.path().join("reverse.db");
    seed_same_time_legacy(&forward_path, false);
    seed_same_time_legacy(&reverse_path, true);
    let forward = open(&forward_path).unwrap();
    let reverse = open(&reverse_path).unwrap();
    let expected: Vec<_> = [
        ("annotate", "a", 0, 1),
        ("gone", "annotate:deleted", 0, 2),
        ("ink_pages", "annotate:a", 0, 3),
        ("ink_pages", "annotate:a", 15, 4),
        ("ink_pages", "annotate:a", 113, 5),
        ("ink_pages", "annotate:a/fn/n", 0, 6),
        ("ink_pages", "whiteboard:w", 0, 7),
        ("ink_pages", "whiteboard:w", 9, 8),
        ("problem", "leetcode/42", 0, 9),
        ("whiteboard", "w", 0, 10),
    ]
    .into_iter()
    .map(|(table, key, page, rev)| (table.into(), key.into(), page, rev))
    .collect();
    assert_eq!(revision_vector(&forward), expected);
    assert_eq!(
        revision_vector(&reverse),
        expected,
        "insertion order must not decide revisions"
    );
    let heads = list_book_heads(&forward).unwrap();
    assert_eq!(
        heads,
        vec![
            BookHead {
                kind: "annotate".into(),
                id: "a".into(),
                rev: 6
            },
            BookHead {
                kind: "annotate".into(),
                id: "deleted".into(),
                rev: 2
            },
            BookHead {
                kind: "problem".into(),
                id: "leetcode/42".into(),
                rev: 9
            },
            BookHead {
                kind: "whiteboard".into(),
                id: "w".into(),
                rev: 10
            },
        ]
    );
    assert_eq!(sequence(&forward), 10);
    let before_record =
        serde_json::to_value(get_annotate(&forward, "a").unwrap().unwrap()).unwrap();
    let before_pages =
        serde_json::to_value(get_ink_pages(&forward, "annotate", "a").unwrap()).unwrap();
    assert_eq!(before_record["updated_at"], 7000);
    assert_eq!(before_record["board"]["unknown"]["keep"], true);
    assert_eq!(
        BASE64
            .decode(before_pages[2]["gz"].as_str().unwrap())
            .unwrap(),
        packed_ink(true)
    );
    drop(forward);
    let reopened = open(&forward_path).unwrap();
    assert_eq!(revision_vector(&reopened), expected);
    assert_eq!(list_book_heads(&reopened).unwrap(), heads);
    assert_eq!(sequence(&reopened), 10);
    assert_eq!(
        serde_json::to_value(get_annotate(&reopened, "a").unwrap().unwrap()).unwrap(),
        before_record
    );
    assert_eq!(
        serde_json::to_value(get_ink_pages(&reopened, "annotate", "a").unwrap()).unwrap(),
        before_pages
    );
    let allocated = write_transaction(&reopened, || next_rev(&reopened)).unwrap();
    assert_eq!(
        allocated, 11,
        "migration must leave the allocator above all backfilled rows"
    );
}

#[test]
fn wal_reader_keeps_one_book_snapshot_while_another_connection_commits() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("snapshot.db");
    let reader = open(&path).unwrap();
    let writer = open(&path).unwrap();
    assert_eq!(
        reader
            .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    put_whiteboard_with_clock(&writer, &whiteboard("w", 1000), &FixedClock(10)).unwrap();
    put_ink_page_with_clock(
        &writer,
        &page("whiteboard", "w", 1, 1000, false),
        &FixedClock(10),
    )
    .unwrap();
    let old_head = head(&reader, "whiteboard", "w");
    let old_page = serde_json::to_value(
        get_ink_page(&reader, "whiteboard", "w", 1)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    read_transaction(&reader, || {
        let first = get_whiteboard(&reader, "w")?.unwrap();
        assert_eq!(first.title, "Original");
        assert_eq!(first.board["inkPages"]["pageIds"], json!([1]));
        write_transaction(&writer, || {
            let mut changed = whiteboard("w", 2000);
            changed.title = "Committed later".into();
            changed.base_updated_at = Some(10);
            assert!(matches!(
                put_whiteboard_with_clock(&writer, &changed, &FixedClock(20))?,
                PutOutcome::Written(_)
            ));
            assert!(
                put_ink_page_with_clock(
                    &writer,
                    &page("whiteboard", "w", 1, 2000, true),
                    &FixedClock(20)
                )?
                .applied
            );
            assert!(
                put_ink_page_with_clock(
                    &writer,
                    &page("whiteboard", "w", 2, 2000, false),
                    &FixedClock(20)
                )?
                .applied
            );
            Ok(())
        })?;
        assert_eq!(head(&reader, "whiteboard", "w"), old_head);
        assert_eq!(
            serde_json::to_value(get_ink_page(&reader, "whiteboard", "w", 1)?.unwrap())?,
            old_page
        );
        assert!(get_ink_page(&reader, "whiteboard", "w", 2)?.is_none());
        let still_old = list_whiteboard(&reader, false)?;
        assert_eq!(still_old[0].title, "Original");
        assert_eq!(still_old[0].rev, first.rev);
        assert_eq!(still_old[0].board["inkPages"]["pageIds"], json!([1]));
        Ok(())
    })
    .unwrap();
    let current = get_whiteboard(&reader, "w").unwrap().unwrap();
    assert_eq!(current.title, "Committed later");
    assert_eq!(current.board["inkPages"]["pageIds"], json!([1, 2]));
    assert!(head(&reader, "whiteboard", "w") > old_head);
    assert_eq!(
        BASE64
            .decode(
                get_ink_page(&reader, "whiteboard", "w", 1)
                    .unwrap()
                    .unwrap()
                    .gz
            )
            .unwrap(),
        packed_ink(true)
    );
}

#[test]
fn manifests_use_committed_primary_and_child_rows_including_empty_pages() {
    let directory = tempfile::tempdir().unwrap();
    let conn = open(&directory.path().join("manifests.db")).unwrap();
    for (kind, key, id, empty) in [
        ("annotate", "a", 113, true),
        ("annotate", "a", 0, false),
        ("annotate", "a/fn/n", 2, true),
        ("annotate", "a/fn/n", 0, false),
        ("annotate", "another", 999, false),
        ("annotate", "a/fn/neighbour", 999, false),
        ("whiteboard", "w", 0, true),
    ] {
        assert!(
            put_ink_page_with_clock(&conn, &page(kind, key, id, 1000, empty), &FixedClock(10))
                .unwrap()
                .applied
        );
    }
    let mut input = annotate("a", 1000);
    input.board["inkPages"] = json!({"v":1,"pageIds":[999]});
    input.footnote_boards = json!({
        "n":{"board":{"v":1,"elements":[],"inkPages":{"v":1,"pageIds":[999]}},"pageCount":3},
        "empty":{"board":{"v":1,"elements":[],"inkPages":{"v":1,"pageIds":[999]}},"pageCount":1}
    });
    let written = match put_annotate_with_clock(&conn, &input, &FixedClock(10)).unwrap() {
        PutOutcome::Written(value) => value,
        other => panic!("{other:?}"),
    };
    assert_eq!(written.board["inkPages"]["pageIds"], json!([0, 113]));
    assert_eq!(
        written.footnote_boards["n"]["board"]["inkPages"]["pageIds"],
        json!([0, 2])
    );
    assert_eq!(
        written.footnote_boards["empty"]["board"]["inkPages"]["pageIds"],
        json!([])
    );
    let stored: (String, String) = conn
        .query_row(
            "SELECT board_json,footnote_boards_json FROM annotate WHERE id='a'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(serde_json::from_str::<Value>(&stored.0)
        .unwrap()
        .get("inkPages")
        .is_none());
    assert!(
        serde_json::from_str::<Value>(&stored.1).unwrap()["n"]["board"]
            .get("inkPages")
            .is_none()
    );
    let mut notebook = whiteboard("w", 1000);
    notebook.board["inkPages"] = json!({"v":1,"pageIds":[999]});
    put_whiteboard_with_clock(&conn, &notebook, &FixedClock(10)).unwrap();
    assert_eq!(
        get_whiteboard(&conn, "w").unwrap().unwrap().board["inkPages"]["pageIds"],
        json!([0])
    );
    let prior_head = head(&conn, "annotate", "a");
    assert!(
        put_ink_page_with_clock(
            &conn,
            &page("annotate", "a", 15, 2000, true),
            &FixedClock(20)
        )
        .unwrap()
        .applied
    );
    let after = get_annotate(&conn, "a").unwrap().unwrap();
    assert_eq!(
        after.rev, written.rev,
        "an ink write must not change the record revision"
    );
    assert_eq!(after.board["inkPages"]["pageIds"], json!([0, 15, 113]));
    assert!(head(&conn, "annotate", "a") > prior_head);
    assert_eq!(list_annotate(&conn, false).unwrap()[0].board, after.board);
}

#[test]
fn unknown_authored_fields_round_trip_and_survive_legacy_clients_for_all_kinds() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("unknown.db");
    let conn = open(&path).unwrap();
    let future =
        json!({"hash":"authored-hash","rev":42,"paper":{"color":"sepia"},"array":[null,7]});
    let mut w = whiteboard("w", 1000);
    w.extra.insert("futureAuthored".into(), future.clone());
    let mut a = annotate("a", 1000);
    a.extra.insert("futureAuthored".into(), future.clone());
    let mut p = problem("leetcode/42", 1000);
    p.extra.insert("futureAuthored".into(), future.clone());
    put_whiteboard_with_clock(&conn, &w, &FixedClock(10)).unwrap();
    put_annotate_with_clock(&conn, &a, &FixedClock(10)).unwrap();
    put_problem_with_clock(&conn, &p, &FixedClock(10)).unwrap();
    // Old clients omit the unknown key while changing fields they understand.
    put_whiteboard_with_clock(&conn, &whiteboard("w", 2000), &FixedClock(20)).unwrap();
    put_annotate_with_clock(&conn, &annotate("a", 2000), &FixedClock(20)).unwrap();
    put_problem_with_clock(&conn, &problem("leetcode/42", 2000), &FixedClock(20)).unwrap();
    drop(conn);
    let conn = open(&path).unwrap();
    let values = [
        serde_json::to_value(get_whiteboard(&conn, "w").unwrap().unwrap()).unwrap(),
        serde_json::to_value(get_annotate(&conn, "a").unwrap().unwrap()).unwrap(),
        serde_json::to_value(get_problem(&conn, "leetcode/42").unwrap().unwrap()).unwrap(),
    ];
    for value in values {
        assert_eq!(value["futureAuthored"], future);
        assert!(
            value.get("extra").is_none(),
            "unknown authored keys remain flattened on the wire"
        );
        assert_eq!(value["updated_at"], 20);
    }
}

#[test]
fn deleting_live_books_preserves_backup_payloads_and_revision_history() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("delete.db");
    let conn = open(&path).unwrap();
    put_whiteboard_with_clock(&conn, &whiteboard("w", 1000), &FixedClock(10)).unwrap();
    put_annotate_with_clock(&conn, &annotate("a", 1000), &FixedClock(10)).unwrap();
    put_whiteboard_with_clock(&conn, &whiteboard("w", 2000), &FixedClock(20)).unwrap();
    put_annotate_with_clock(&conn, &annotate("a", 2000), &FixedClock(20)).unwrap();
    let payload = json!({"name":"retained","board":{"v":1,"elements":[{"id":"saved"}]},"future":{"keep":true}});
    for (kind, id) in [(PadKind::Whiteboard, "w"), (PadKind::Annotate, "a")] {
        let snapshot: SnapshotRow = serde_json::from_value(json!({
            "kind":kind.as_str(),"key":id,"tier":"2h","written_at":17,"payload":payload
        }))
        .unwrap();
        assert!(put_snapshot(&conn, &snapshot).unwrap().applied);
        assert_eq!(revision_count(&conn, kind.as_str(), id).unwrap(), 1);
        assert!(delete_pad(&conn, kind, id, 1).unwrap().applied);
        assert_eq!(revision_count(&conn, kind.as_str(), id).unwrap(), 1);
        let retained = get_snapshots(&conn, kind.as_str(), id).unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].payload, payload);
    }
    drop(conn);
    let conn = open(&path).unwrap();
    assert!(get_whiteboard(&conn, "w").unwrap().is_none());
    assert!(get_annotate(&conn, "a").unwrap().is_none());
    for (kind, id) in [("whiteboard", "w"), ("annotate", "a")] {
        assert_eq!(get_snapshots(&conn, kind, id).unwrap()[0].payload, payload);
        assert_eq!(revision_count(&conn, kind, id).unwrap(), 1);
        assert!(head(&conn, kind, id) > 0);
    }
}

#[test]
fn migrating_old_tombstones_retains_backups_and_history() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tombstones.db");
    let legacy = create_legacy_schema(&path);
    legacy
        .execute(
            "INSERT INTO whiteboard VALUES('gone','Original',10,1,20,'{\"v\":1}','[]')",
            [],
        )
        .unwrap();
    let backup = r#"{"board":{"elements":[{"id":"saved"}]},"unknown":{"keep":true}}"#;
    legacy
        .execute(
            "INSERT INTO snapshots VALUES('whiteboard','gone','7d',8,?1)",
            params![backup],
        )
        .unwrap();
    legacy.execute("INSERT INTO revisions(kind,pad_id,updated_at,payload_json,written_at) VALUES('whiteboard','gone',5,?1,6)",params![backup]).unwrap();
    drop(legacy);
    let conn = open(&path).unwrap();
    assert!(get_whiteboard(&conn, "gone").unwrap().is_none());
    assert_eq!(
        get_snapshots(&conn, "whiteboard", "gone").unwrap()[0].payload,
        serde_json::from_str::<Value>(backup).unwrap()
    );
    assert_eq!(revision_count(&conn, "whiteboard", "gone").unwrap(), 2);
    let original_history: String = conn
        .query_row(
            "SELECT payload_json FROM revisions WHERE kind='whiteboard' AND pad_id='gone' AND updated_at=5",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        original_history, backup,
        "the older history payload survives unchanged"
    );
    let archived_record: String = conn
        .query_row(
            "SELECT payload_json FROM revisions WHERE kind='whiteboard' AND pad_id='gone' AND updated_at=10",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&archived_record).unwrap()["title"],
        "Original"
    );
    assert_eq!(gone_seq(&conn, PadKind::Whiteboard, "gone").unwrap(), 1);
    let vector = revision_vector(&conn);
    let heads = list_book_heads(&conn).unwrap();
    drop(conn);
    let reopened = open(&path).unwrap();
    assert_eq!(revision_vector(&reopened), vector);
    assert_eq!(list_book_heads(&reopened).unwrap(), heads);
    assert_eq!(
        get_snapshots(&reopened, "whiteboard", "gone").unwrap()[0].payload,
        serde_json::from_str::<Value>(backup).unwrap()
    );
    assert_eq!(revision_count(&reopened, "whiteboard", "gone").unwrap(), 2);
    let reopened_history: String = reopened
        .query_row(
            "SELECT payload_json FROM revisions WHERE kind='whiteboard' AND pad_id='gone' AND updated_at=5",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(reopened_history, original_history);
}

#[test]
fn same_clock_legacy_writes_still_advance_revisions_and_use_hub_display_time() {
    let directory = tempfile::tempdir().unwrap();
    let conn = open(&directory.path().join("clock.db")).unwrap();
    let mut input = whiteboard("w", 9_000_000_000);
    let first = match put_whiteboard_with_clock(&conn, &input, &FixedClock(71)).unwrap() {
        PutOutcome::Written(value) => value,
        other => panic!("{other:?}"),
    };
    let first_head = head(&conn, "whiteboard", "w");
    assert_eq!(first.updated_at, 71);
    input.title = "Second title".into();
    input.base_updated_at = Some(first.updated_at);
    let second = match put_whiteboard_with_clock(&conn, &input, &FixedClock(71)).unwrap() {
        PutOutcome::Written(value) => value,
        other => panic!("{other:?}"),
    };
    assert_eq!(second.updated_at, 71);
    assert!(second.rev > first.rev);
    assert!(head(&conn, "whiteboard", "w") > first_head);
    let page_head = head(&conn, "whiteboard", "w");
    assert!(
        put_ink_page_with_clock(
            &conn,
            &page("whiteboard", "w", 113, 9_000_000_000, true),
            &FixedClock(71)
        )
        .unwrap()
        .applied
    );
    let ink = get_ink_page(&conn, "whiteboard", "w", 113)
        .unwrap()
        .unwrap();
    assert_eq!(ink.updated_at, 71);
    assert!(ink.rev > second.rev);
    assert!(head(&conn, "whiteboard", "w") > page_head);
    assert_eq!(get_whiteboard(&conn, "w").unwrap().unwrap().rev, second.rev);
}
