//! Catalog metadata validation. Asset staging/publication is a separate layer.
use anyhow::{ensure, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use rusqlite::Connection;
use super::artifact_assets::{self, AssetDependency, AssetLocator, AssetParent};

#[derive(Debug, Deserialize)]
struct Parent {
    kind: String,
    id: String,
}

#[derive(Debug, Deserialize)]
struct Catalog {
    v: u32,
    parent: Parent,
    revision: String,
    artifacts: Vec<Artifact>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    id: String,
    title: String,
    revision: String,
    created_at: u64,
    updated_at: u64,
    associations: Vec<Association>,
    content: Content,
    deleted_at: Option<u64>,
    /// An explicit restore names the tombstone revision it supersedes.
    restored_from: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum Association {
    #[serde(rename = "file")]
    File,
    #[serde(rename = "thread")]
    Thread { #[serde(rename = "rootId")] root_id: String },
    #[serde(rename = "footnote")]
    Footnote { #[serde(rename = "footnoteId")] footnote_id: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InkRevision {
    page_id: u64,
    revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum Content {
    #[serde(rename = "whiteboard")]
    Whiteboard {
        #[serde(rename = "boardId")]
        board_id: String,
        #[serde(rename = "sceneRevision")]
        scene_revision: String,
        ink: Vec<InkRevision>,
    },
    #[serde(rename = "code")]
    Code {
        #[serde(rename = "documentId")]
        document_id: String,
        #[serde(rename = "sourceRevision")]
        source_revision: String,
    },
    #[serde(rename = "markdown")]
    Markdown {
        #[serde(rename = "documentId")]
        document_id: String,
        #[serde(rename = "sourceRevision")]
        source_revision: String,
    },
}

fn identity(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 1024 && value.trim() == value
        && !value.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}')
}

const JS_MAX_INTEGER: u64 = 9_007_199_254_740_991;

fn parse(value: &Value, kind: &str, id: &str) -> Result<Catalog> {
    let catalog: Catalog = serde_json::from_value(value.clone())?;
    ensure!(catalog.v == 1, "unsupported artifact catalog version");
    ensure!(catalog.parent.kind == kind && catalog.parent.id == id,
        "artifact catalog belongs to a different parent");
    ensure!(matches!(kind, "annotate" | "whiteboard" | "problem") && identity(id)
        && identity(&catalog.revision), "invalid artifact catalog identity");
    let mut ids = HashSet::new();
    for artifact in &catalog.artifacts {
        ensure!(identity(&artifact.id) && identity(&artifact.revision) && ids.insert(&artifact.id),
            "invalid or duplicate artifact identity");
        ensure!(!artifact.title.trim().is_empty() && artifact.created_at <= artifact.updated_at
            && artifact.updated_at <= JS_MAX_INTEGER, "invalid artifact metadata");
        if let Some(at) = artifact.deleted_at {
            ensure!(at >= artifact.created_at && at <= artifact.updated_at, "invalid artifact tombstone");
        }
        if let Some(revision) = &artifact.restored_from {
            ensure!(identity(revision), "invalid artifact restore revision");
        }
        let mut associations = HashSet::new();
        for association in &artifact.associations {
            let key = match association {
                Association::File => ("file", ""),
                Association::Thread { root_id } => {
                    ensure!(identity(root_id), "invalid thread identity");
                    ("thread", root_id.as_str())
                }
                Association::Footnote { footnote_id } => {
                    ensure!(identity(footnote_id), "invalid footnote identity");
                    ("footnote", footnote_id.as_str())
                }
            };
            ensure!(associations.insert(key), "duplicate artifact association");
        }
        match &artifact.content {
            Content::Whiteboard { board_id, scene_revision, ink } => {
                ensure!(identity(board_id) && identity(scene_revision), "invalid scene dependency");
                let mut pages = HashSet::new();
                for page in ink {
                    ensure!(page.page_id <= JS_MAX_INTEGER && identity(&page.revision)
                        && pages.insert(page.page_id), "invalid or duplicate ink dependency");
                }
            }
            Content::Code { document_id, source_revision }
            | Content::Markdown { document_id, source_revision } => {
                ensure!(identity(document_id) && identity(source_revision), "invalid document dependency");
            }
        }
    }
    Ok(catalog)
}

/// Omission by an older client preserves the stored field (SQL COALESCE).
/// Presence must be valid; deleting an artifact means retaining its tombstone.
pub(super) fn validate(
    incoming: Option<&Value>, previous: Option<&Value>, kind: &str, id: &str,
) -> Result<()> {
    let Some(incoming) = incoming else { return Ok(()) };
    let next = parse(incoming, kind, id)?;
    let Some(previous) = previous else { return Ok(()) };
    let before = parse(previous, kind, id)?;
    if next.revision == before.revision {
        ensure!(incoming == previous, "artifact catalog revision reused for different content");
    }
    let next_by_id: HashMap<_, _> = next.artifacts.iter().enumerate()
        .map(|(index, item)| (item.id.as_str(), (index, item))).collect();
    for (index, old) in before.artifacts.iter().enumerate() {
        let (new_index, new) = next_by_id.get(old.id.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing artifact deletion record: {}", old.id))?;
        if new.revision == old.revision {
            ensure!(incoming["artifacts"][*new_index] == previous["artifacts"][index],
                "artifact revision reused for different content");
        }
        if old.deleted_at.is_some() && new.deleted_at.is_none() {
            ensure!(new.revision != old.revision && new.restored_from.as_deref() == Some(old.revision.as_str()),
                "artifact restore must name the tombstone revision");
        }
    }
    Ok(())
}

/// Dependencies are immutable and never removed during staging/publication.
/// A parent PUT cannot advertise missing scene/source/ink revisions as usable.
pub(super) fn require_assets(conn: &Connection, value: Option<&Value>, kind: &str, id: &str) -> Result<()> {
    let Some(value) = value else { return Ok(()) };
    let catalog = parse(value, kind, id)?;
    let read = |dependency| -> Result<Value> {
        let locator = AssetLocator {
            parent: AssetParent { kind: kind.to_string(), id: id.to_string() }, dependency,
        };
        let asset = artifact_assets::get(conn, &locator)?
            .ok_or_else(|| anyhow::anyhow!("attachment dependency not staged; parent was not published"))?;
        artifact_assets::validate(&asset)?;
        Ok(serde_json::from_str(&asset.payload)?)
    };
    for artifact in catalog.artifacts {
        if artifact.deleted_at.is_some() { continue; }
        match artifact.content {
            Content::Whiteboard { board_id, scene_revision, ink } => {
                let scene = read(AssetDependency::Scene { id: board_id.clone(), revision: scene_revision })?;
                let pages: HashSet<_> = ink.iter().map(|page| page.page_id).collect();
                let manifest = scene["board"]["inkPages"]["pageIds"].as_array();
                ensure!(manifest.map_or(0, Vec::len) == pages.len()
                    && manifest.is_none_or(|ids| ids.iter().all(|id| id.as_u64().is_some_and(|id| pages.contains(&id)))),
                    "scratch scene and catalog ink manifests differ");
                for page in ink {
                    read(AssetDependency::Ink { id: board_id.clone(), revision: page.revision, page_id: page.page_id })?;
                }
            }
            Content::Code { document_id, source_revision } => {
                let document = read(AssetDependency::Document { id: document_id, revision: source_revision })?;
                ensure!(document["docType"] == "code", "code attachment kind mismatch");
            }
            Content::Markdown { document_id, source_revision } => {
                let document = read(AssetDependency::Document { id: document_id, revision: source_revision })?;
                ensure!(document["docType"] == "markdown", "markdown attachment kind mismatch");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalog() -> Value {
        json!({
            "v": 1, "parent": {"kind": "annotate", "id": "a1"}, "revision": "c1",
            "artifacts": [{
                "id": "w1", "title": "Diagram", "revision": "r1",
                "createdAt": 1, "updatedAt": 2,
                "associations": [{"kind": "thread", "rootId": "turn-1"}],
                "content": {"kind": "whiteboard", "boardId": "board-1", "sceneRevision": "s1",
                    "ink": [{"pageId": 0, "revision": "i1"}]}
            }]
        })
    }

    #[test]
    fn old_clients_and_identical_retries_preserve_the_catalog() {
        let saved = catalog();
        assert!(validate(None, Some(&saved), "annotate", "a1").is_ok());
        assert!(validate(Some(&saved), Some(&saved), "annotate", "a1").is_ok());
    }

    #[test]
    fn malformed_foreign_or_duplicate_records_are_rejected() {
        let mut value = catalog();
        assert!(validate(Some(&value), None, "annotate", "other").is_err());
        value["v"] = json!(2);
        assert!(validate(Some(&value), None, "annotate", "a1").is_err());
        value = catalog();
        value["artifacts"][0]["content"]["ink"] = json!([
            {"pageId": 0, "revision": "i1"}, {"pageId": 0, "revision": "i2"}
        ]);
        assert!(validate(Some(&value), None, "annotate", "a1").is_err());
    }

    #[test]
    fn removal_requires_a_tombstone_and_new_revision() {
        let saved = catalog();
        let mut incoming = saved.clone();
        incoming["revision"] = json!("c2");
        incoming["artifacts"] = json!([]);
        assert!(validate(Some(&incoming), Some(&saved), "annotate", "a1").is_err());
        incoming = saved.clone();
        incoming["artifacts"][0]["title"] = json!("changed without revision");
        assert!(validate(Some(&incoming), Some(&saved), "annotate", "a1").is_err());
        incoming["revision"] = json!("c2");
        assert!(validate(Some(&incoming), Some(&saved), "annotate", "a1").is_err());
        incoming["artifacts"][0]["revision"] = json!("r2");
        incoming["artifacts"][0]["deletedAt"] = json!(2);
        assert!(validate(Some(&incoming), Some(&saved), "annotate", "a1").is_ok());
    }

    #[test]
    fn explicit_restore_must_name_the_exact_tombstone() {
        let mut saved = catalog();
        saved["artifacts"][0]["deletedAt"] = json!(2);
        let mut restored = catalog();
        restored["revision"] = json!("c2");
        restored["artifacts"][0]["revision"] = json!("r2");
        assert!(validate(Some(&restored), Some(&saved), "annotate", "a1").is_err());
        restored["artifacts"][0]["restoredFrom"] = json!("wrong");
        assert!(validate(Some(&restored), Some(&saved), "annotate", "a1").is_err());
        restored["artifacts"][0]["restoredFrom"] = json!("r1");
        assert!(validate(Some(&restored), Some(&saved), "annotate", "a1").is_ok());
    }
}
