//! Opaque transcript updates. Only identity, tombstones and cancellation are
//! interpreted; every other JSON field is retained without a message schema.
use serde_json::{json, Value};
use std::collections::HashMap;

fn id(row: &Value) -> Option<&str> { row.get("id").and_then(Value::as_str) }
fn deleted(row: &Value) -> u64 { row.get("deletedAt").and_then(Value::as_u64).unwrap_or(0) }

/// Accepted writes may advance/edit a turn, but cannot resurrect a removed or
/// cancelled turn. Omitted rows remain: deletion is explicit, never absence.
pub fn update(stored: &Value, incoming: &Value) -> Value {
    let mut rows = stored.as_array().cloned().unwrap_or_default();
    for next in incoming.as_array().into_iter().flatten() {
        let at = id(next).and_then(|key| rows.iter().position(|row| id(row) == Some(key)));
        if let Some(at) = at {
            let old = &rows[at];
            let winner = if deleted(old) > deleted(next) ||
                (deleted(next) == 0 && old.get("requestState").and_then(Value::as_str) == Some("cancelled")) {
                old
            } else { next };
            let mut merged = old.as_object().cloned().unwrap_or_default();
            if let Some(fields) = next.as_object() { merged.extend(fields.clone()); }
            if let Some(fields) = winner.as_object() { merged.extend(fields.clone()); }
            if deleted(winner) > 0 || winner.get("requestState").and_then(Value::as_str) == Some("cancelled") {
                merged.insert("pending".into(), json!(false));
            }
            rows[at] = Value::Object(merged);
        } else if !rows.contains(next) { rows.push(next.clone()); }
    }
    // Include replies made offline before their replica learned the deletion.
    loop {
        let deleted_by: HashMap<String, u64> = rows.iter().filter_map(|row| id(row).map(|key| (key.to_owned(), deleted(row)))).collect();
        let mut changed = false;
        for row in &mut rows {
            let parent = row.pointer("/replyTo/id").and_then(Value::as_str)
                .and_then(|key| deleted_by.get(key)).copied().unwrap_or(0);
            if parent > deleted(row) {
                row["deletedAt"] = json!(parent); row["pending"] = json!(false); changed = true;
            }
        }
        if !changed { break; }
    }
    Value::Array(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_updates_cannot_resurrect_deleted_turns_or_offline_replies() {
        let old = json!([{"id":"q","deletedAt":30,"sessionId":"session-q","future":{"v":2}}]);
        let stale = json!([{"id":"q","content":"question"},{"id":"reply","replyTo":{"id":"q"}}]);
        let merged = update(&old, &stale);
        assert_eq!(merged[0]["deletedAt"],30); assert_eq!(merged[1]["deletedAt"],30);
        assert_eq!(merged[0]["future"]["v"],2);
        assert_eq!(update(&merged,&stale),merged);
    }
    #[test]
    fn cancelled_turn_rejects_a_late_answer_and_preserves_unknown_fields() {
        let old=json!([{"id":"a","requestState":"cancelled","content":"partial","future":true}]);
        let late=json!([{"id":"a","requestState":"completed","content":"late answer","pending":false}]);
        let merged=update(&old,&late);
        assert_eq!(merged[0]["content"],"partial"); assert_eq!(merged[0]["requestState"],"cancelled");
        assert_eq!(merged[0]["future"],true);
    }
    #[test]
    fn accepted_edits_advance_without_duplicating_the_message() {
        let old=json!([{"id":"q","requestState":"queued","content":"old","future":42}]);
        let new=json!([{"id":"q","requestState":"queued","content":"edited","sessionId":"session-q"}]);
        let result=update(&old,&new); assert_eq!(result.as_array().unwrap().len(),1);
        assert_eq!(result[0]["content"],"edited"); assert_eq!(result[0]["future"],42);
    }
}
