//! Immutable staging, separate from published parent pointers and live editors.
use anyhow::{ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_ASSET_BYTES: usize = 24 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetParent { pub kind: String, pub id: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum AssetDependency {
    #[serde(rename = "scene")]
    Scene { id: String, revision: String },
    #[serde(rename = "document")]
    Document { id: String, revision: String },
    #[serde(rename = "ink")]
    Ink { id: String, revision: String, #[serde(rename = "pageId")] page_id: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetLocator { pub parent: AssetParent, pub dependency: AssetDependency }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactAsset {
    #[serde(flatten)]
    pub locator: AssetLocator,
    pub payload: String,
}

impl AssetLocator {
    pub fn key(&self) -> Result<String> {
        let identity = |s: &str| !s.is_empty() && s.trim() == s && s.encode_utf16().count() <= 1024
            && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}');
        ensure!(matches!(self.parent.kind.as_str(), "whiteboard" | "annotate" | "problem")
            && identity(&self.parent.id), "invalid attachment parent");
        let (kind, id, revision, page) = match &self.dependency {
            AssetDependency::Scene { id, revision } => ("scene", id, revision, None),
            AssetDependency::Document { id, revision } => ("document", id, revision, None),
            AssetDependency::Ink { id, revision, page_id } => {
                ensure!(*page_id <= 9_007_199_254_740_991, "invalid attachment page");
                ("ink", id, revision, Some(*page_id))
            }
        };
        ensure!(identity(id) && identity(revision), "invalid attachment identity");
        Ok(serde_json::to_string(&json!([self.parent.kind, self.parent.id, kind, id, page, revision]))?)
    }
}

fn validate_board(board: &Value) -> Result<()> {
    ensure!(board["v"] == 1 && board["elements"].is_array(), "invalid attachment scene");
    let state = &board["appState"];
    ensure!(state["scrollX"].as_f64().is_some() && state["scrollY"].as_f64().is_some()
        && state["zoom"].as_f64().is_some_and(|n| n > 0.0), "invalid attachment camera");
    ensure!(board.get("ink").is_none() && board.get("inkC").is_none(), "ink must be packed separately");
    if let Some(manifest) = board.get("inkPages") {
        ensure!(manifest["v"] == 1, "invalid ink manifest");
        let pages = manifest["pageIds"].as_array().ok_or_else(|| anyhow::anyhow!("missing page IDs"))?;
        let mut seen = std::collections::HashSet::new();
        for page in pages {
            let id = page.as_u64().ok_or_else(|| anyhow::anyhow!("invalid page ID"))?;
            ensure!(id <= 9_007_199_254_740_991 && seen.insert(id), "invalid or duplicate page ID");
        }
    }
    Ok(())
}

fn validate_packed(value: &Value) -> Result<()> {
    let text = value.as_str().ok_or_else(|| anyhow::anyhow!("missing packed ink"))?;
    let bytes = STANDARD.decode(text)?;
    ensure!(bytes.len() >= 12 && &bytes[0..4] == b"inkC"
        && u32::from_le_bytes(bytes[4..8].try_into()?) == 1, "invalid packed ink header");
    let meta_len = u32::from_le_bytes(bytes[8..12].try_into()?) as usize;
    ensure!(meta_len <= bytes.len() - 12, "truncated packed ink metadata");
    let meta: Value = serde_json::from_slice(&bytes[12..12 + meta_len])?;
    let ops = meta["meta"].as_array().ok_or_else(|| anyhow::anyhow!("invalid ink operations"))?;
    let mut length = 12_u64 + meta_len as u64;
    for op in ops {
        for (field, width) in [("xyN", 2), ("prN", 1), ("slN", 1), ("rrN", 2)] {
            let count = op[field].as_u64().ok_or_else(|| anyhow::anyhow!("invalid ink buffer length"))?;
            length = length.checked_add(count.checked_mul(width).ok_or_else(|| anyhow::anyhow!("ink buffer overflow"))?)
                .ok_or_else(|| anyhow::anyhow!("ink buffer overflow"))?;
        }
    }
    ensure!(length == bytes.len() as u64, "truncated packed ink buffers");
    // Client also decodes using the existing ink codec before accepting a download.
    Ok(())
}

pub fn validate(asset: &ArtifactAsset) -> Result<()> {
    asset.locator.key()?;
    ensure!(asset.payload.len() <= MAX_ASSET_BYTES, "attachment exceeds transfer limit");
    let value: Value = serde_json::from_str(&asset.payload)?;
    ensure!(value["v"] == 1 && value.is_object(), "invalid attachment payload version");
    match &asset.locator.dependency {
        AssetDependency::Scene { .. } => {
            validate_board(&value["board"])?;
            ensure!(value["pageCount"].as_u64().is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
                && value["programs"].is_array(), "invalid scratch scene metadata");
        }
        AssetDependency::Ink { .. } => validate_packed(&value["packed"] )?,
        AssetDependency::Document { .. } => {
            ensure!(value["owned"] == true && matches!(value["docType"].as_str(), Some("code" | "markdown"))
                && value["name"].as_str().is_some_and(|s| !s.trim().is_empty())
                && value["source"].is_string() && value["footnotes"].is_array()
                && value["agent"].is_array(), "invalid owned document attachment");
            validate_board(&value["board"])?;
            let ink = value["ink"].as_array().ok_or_else(|| anyhow::anyhow!("missing document ink"))?;
            let mut pages = std::collections::HashSet::new();
            for page in ink {
                let id = page["pageId"].as_u64().ok_or_else(|| anyhow::anyhow!("invalid document ink page"))?;
                ensure!(id <= 9_007_199_254_740_991 && pages.insert(id), "duplicate document ink page");
                validate_packed(&page["packed"])?;
            }
            let expected = value["board"]["inkPages"]["pageIds"].as_array();
            ensure!(expected.map_or(0, Vec::len) == pages.len()
                && expected.is_none_or(|ids| ids.iter().all(|id| id.as_u64().is_some_and(|id| pages.contains(&id)))),
                "document ink manifest is incomplete");
        }
    }
    Ok(())
}

pub fn put(conn: &Connection, asset: &ArtifactAsset) -> Result<()> {
    validate(asset)?;
    let key = asset.locator.key()?;
    // Immutable rows make duplicate/retried uploads idempotent. No live parent
    // is required: dependencies must be stageable before the first parent PUT.
    conn.execute("INSERT INTO artifact_assets (asset_key, parent_kind, parent_id, payload, staged_at)
        VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(asset_key) DO NOTHING",
        params![key, asset.locator.parent.kind, asset.locator.parent.id, asset.payload, super::now_ms()])?;
    let existing: String = conn.query_row("SELECT payload FROM artifact_assets WHERE asset_key = ?1",
        params![key], |row| row.get(0))?;
    ensure!(existing == asset.payload, "attachment revision already has different content");
    Ok(())
}

pub fn get(conn: &Connection, locator: &AssetLocator) -> Result<Option<ArtifactAsset>> {
    let payload: Option<String> = conn.query_row(
        "SELECT payload FROM artifact_assets WHERE asset_key = ?1", params![locator.key()?],
        |row| row.get(0)).optional()?;
    Ok(payload.map(|payload| ArtifactAsset { locator: locator.clone(), payload }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pads;

    fn scene() -> ArtifactAsset {
        ArtifactAsset {
            locator: AssetLocator {
                parent: AssetParent { kind: "whiteboard".into(), id: "w1".into() },
                dependency: AssetDependency::Scene { id: "b1".into(), revision: "s1".into() },
            },
            payload: json!({"v": 1, "board": {"v": 1, "elements": [],
                "appState": {"scrollX": 0, "scrollY": 0, "zoom": 1}},
                "pageCount": 1, "programs": []}).to_string(),
        }
    }

    #[test]
    fn staging_is_idempotent_immutable_and_parent_scoped() {
        let dir = tempfile::tempdir().unwrap();
        let conn = pads::open(&dir.path().join("pads.db")).unwrap();
        let first = scene();
        put(&conn, &first).unwrap();
        put(&conn, &first).unwrap();
        let mut changed = first.clone();
        changed.payload.push(' ');
        assert!(put(&conn, &changed).is_err());
        assert_eq!(get(&conn, &first.locator).unwrap().unwrap().payload, first.payload);
        changed.locator.parent.id = "another-parent".into();
        assert!(get(&conn, &changed.locator).unwrap().is_none());
        put(&conn, &changed).unwrap();
        assert_eq!(get(&conn, &changed.locator).unwrap().unwrap().payload, changed.payload);
    }

    #[test]
    fn parent_publication_requires_the_staged_scene() {
        let dir = tempfile::tempdir().unwrap();
        let conn = pads::open(&dir.path().join("pads.db")).unwrap();
        let asset = scene();
        let pad: pads::WhiteboardPad = serde_json::from_value(json!({
            "id": "w1", "title": "Notebook", "updated_at": 10, "page_count": 1,
            "board": {"v": 1, "elements": []}, "agent": [],
            "artifacts": {"v": 1, "parent": {"kind": "whiteboard", "id": "w1"},
                "revision": "c1", "artifacts": [{"id": "a1", "title": "Diagram", "revision": "r1",
                    "createdAt": 1, "updatedAt": 1, "associations": [{"kind": "file"}],
                    "content": {"kind": "whiteboard", "boardId": "b1", "sceneRevision": "s1", "ink": []}}]}
        })).unwrap();
        assert!(pads::put_whiteboard(&conn, &pad).is_err());
        assert!(pads::get_whiteboard(&conn, "w1").unwrap().is_none());
        put(&conn, &asset).unwrap();
        assert!(matches!(pads::put_whiteboard(&conn, &pad).unwrap(), pads::PutOutcome::Written(_)));
        let mut mismatch = pad.clone();
        mismatch.artifacts.as_mut().unwrap()["artifacts"][0]["content"]["ink"] = json!([
            {"pageId": 0, "revision": "missing-ink"}
        ]);
        assert!(pads::put_whiteboard(&conn, &mismatch).is_err());
        assert_eq!(pads::get_whiteboard(&conn, "w1").unwrap().unwrap().artifacts, pad.artifacts);
    }

    #[test]
    fn packed_ink_checks_headers_metadata_and_buffer_lengths() {
        let meta = br#"{"meta":[]}"#;
        let mut bytes = b"inkC".to_vec();
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        bytes.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        bytes.extend_from_slice(meta);
        assert!(validate_packed(&json!(STANDARD.encode(&bytes))).is_ok());
        bytes.push(0);
        assert!(validate_packed(&json!(STANDARD.encode(&bytes))).is_err());
        assert!(validate_packed(&json!("AA==")).is_err());
    }
}
