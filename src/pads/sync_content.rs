//! Content identity for atomic sync. This contract is mirrored by syncContent.ts.
//! Keys sort by UTF-16 code units; numbers use ECMAScript's shortest spelling.
//! Only named root transport fields and board view/manifests are excluded.
use anyhow::{ensure, Context, Result};
use flate2::bufread::GzDecoder;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;

pub const MAX_PACKED_INK_BYTES: usize = super::artifact_assets::MAX_ASSET_BYTES;
pub const MAX_INK_TRANSFER_BYTES: usize = 32 * 1024 * 1024;
pub const RECORD_TRANSPORT_KEYS: &[&str] = &[
    "rev", "record_rev", "book_rev", "record_hash", "base_rev", "base_updated_at",
    "upload_id", "request_hash", "updated_at", "deleted_at", "sync_seq",
];
pub const LOCAL_VIEW_KEYS: &[&str] = &["scrollX", "scrollY", "zoom", "pdfPage", "pdfSpread"];

pub fn hash_bytes(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

/// Canonical JSON is built directly, since insertion-sorted objects still reorder
/// integer-like keys in JavaScript JSON.stringify. Integers must survive f64.
pub fn canonical_json(value: &Value) -> Result<String> {
    fn append(value: &Value, out: &mut String) -> Result<()> {
        match value {
            Value::Null => out.push_str("null"),
            Value::Bool(v) => out.push_str(if *v { "true" } else { "false" }),
            Value::String(v) => out.push_str(&serde_json::to_string(v)?),
            Value::Number(v) => {
                let f = v.as_f64().context("number cannot be represented as an ECMAScript number")?;
                ensure!(f.is_finite(), "nonfinite JSON number");
                if let Some(n) = v.as_u64() {
                    ensure!(f as u128 == n as u128, "integer loses precision in ECMAScript JSON");
                } else if let Some(n) = v.as_i64() {
                    ensure!(f as i128 == n as i128, "integer loses precision in ECMAScript JSON");
                }
                let mut buffer = ryu_js::Buffer::new();
                out.push_str(if f == 0.0 { "0" } else { buffer.format(f) });
            }
            Value::Array(values) => {
                out.push('[');
                for (i, value) in values.iter().enumerate() {
                    if i != 0 { out.push(','); }
                    append(value, out)?;
                }
                out.push(']');
            }
            Value::Object(values) => {
                out.push('{');
                let mut keys: Vec<_> = values.keys().collect();
                keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                for (i, key) in keys.iter().enumerate() {
                    if i != 0 { out.push(','); }
                    out.push_str(&serde_json::to_string(key)?);
                    out.push(':');
                    append(&values[*key], out)?;
                }
                out.push('}');
            }
        }
        Ok(())
    }
    let mut out = String::new();
    append(value, &mut out)?;
    Ok(out)
}

fn normalize_board(board: &mut Value) {
    if let Some(object) = board.as_object_mut() {
        object.remove("inkPages");
        if let Some(state) = object.get_mut("appState").and_then(Value::as_object_mut) {
            for key in LOCAL_VIEW_KEYS { state.remove(*key); }
            // A camera-only addition has no shared state after exclusions.
            if state.is_empty() { object.remove("appState"); }
        }
    }
}

pub fn normalize_record(value: &Value) -> Result<Value> {
    ensure!(value.is_object(), "book record must be an object");
    // Validate before filtering, so invalid numbers never become hidden no-ops.
    canonical_json(value)?;
    let mut value = value.clone();
    let object = value.as_object_mut().unwrap();
    for key in RECORD_TRANSPORT_KEYS { object.remove(*key); }
    if let Some(board) = object.get_mut("board") { normalize_board(board); }
    if let Some(boards) = object.get_mut("footnote_boards").and_then(Value::as_object_mut) {
        for content in boards.values_mut() {
            if let Some(board) = content.get_mut("board") { normalize_board(board); }
        }
    }
    Ok(value)
}

pub fn record_hash(value: &Value) -> Result<String> {
    Ok(hash_bytes(canonical_json(&normalize_record(value)?)?.as_bytes()))
}

#[derive(Debug, Clone)]
pub struct ValidatedInk {
    pub packed: Vec<u8>,
    pub wire_hash: String,
    /// No draw operations; erase-only pages still preserve their exact bytes.
    pub is_empty: bool,
}

fn finite(value: &Value, field: &str) -> Result<f64> {
    let n = value[field].as_f64().with_context(|| format!("invalid ink {field}"))?;
    ensure!(n.is_finite(), "nonfinite ink {field}");
    Ok(n)
}

fn count(value: &Value, field: &str, optional: bool) -> Result<usize> {
    if optional && value.get(field).is_none() { return Ok(0); }
    let n = value[field].as_u64().with_context(|| format!("invalid ink {field}"))?;
    ensure!(n <= MAX_PACKED_INK_BYTES as u64, "ink buffer exceeds limit");
    Ok(n as usize)
}

fn validate_optional_numbers(value: &Value, fields: &[&str]) -> Result<()> {
    for field in fields {
        if value.get(*field).is_some() { finite(value, field)?; }
    }
    Ok(())
}

pub fn validate_packed_ink(packed: &[u8]) -> Result<bool> {
    ensure!(packed.len() <= MAX_PACKED_INK_BYTES, "ink exceeds expanded limit");
    ensure!(packed.len() >= 12 && &packed[..4] == b"inkC", "invalid packed ink header");
    ensure!(u32::from_le_bytes(packed[4..8].try_into()?) == 1, "invalid packed ink envelope version");
    let meta_len = u32::from_le_bytes(packed[8..12].try_into()?) as usize;
    ensure!(meta_len <= packed.len() - 12, "truncated packed ink metadata");
    let meta: Value = serde_json::from_slice(&packed[12..12 + meta_len]).context("invalid packed ink metadata JSON")?;
    let ops = meta["meta"].as_array().context("invalid packed ink operations")?;
    let mut offset = 12 + meta_len;
    let mut is_empty = true;
    for op in ops {
        ensure!(matches!(op["k"].as_str(), Some("d" | "e")), "invalid ink operation kind");
        is_empty &= op["k"] != "d";
        finite(op, "x0")?; finite(op, "y0")?;
        let n = count(op, "n", false)?;
        ensure!(n > 0, "invalid ink point count");
        let xy = count(op, "xyN", false)?;
        let pr = count(op, "prN", false)?;
        let sl = count(op, "slN", false)?;
        let rr = count(op, "rrN", true)?;
        ensure!(xy == (n - 1) * 2 && (pr == 0 || pr == n) && (sl == 0 || sl == n)
            && (rr == 0 || rr == n), "invalid ink buffer counts");
        validate_optional_numbers(op, &["w", "f", "pc", "ps", "si", "sbb", "btg", "sf", "gr", "ib", "hl", "ht", "hk", "hsl", "hst", "i", "s", "r"])?;
        if let Some(c) = op.get("c") { ensure!(c.is_string(), "invalid ink color"); }
        if let Some(halts) = op.get("bh") {
            for halt in halts.as_array().context("invalid ink pooling stamps")? {
                finite(halt, "x")?; finite(halt, "y")?; finite(halt, "g")?;
                validate_optional_numbers(halt, &["p", "s"])?;
            }
        }
        offset = offset.checked_add(xy * 2 + pr + sl + rr * 2).context("ink buffer overflow")?;
        ensure!(offset <= packed.len(), "truncated packed ink buffers");
    }
    ensure!(offset == packed.len(), "trailing packed ink bytes");
    if let Some(raw) = meta.get("raw") {
        for op in raw.as_array().context("invalid raw ink operations")? {
            ensure!(matches!(op["kind"].as_str(), Some("draw" | "erase")), "invalid raw ink kind");
            is_empty &= op["kind"] != "draw";
            for point in op["points"].as_array().context("invalid raw ink points")? {
                finite(point, "x")?; finite(point, "y")?;
                validate_optional_numbers(point, &["pressure", "slowness", "radius"])?;
            }
            validate_optional_numbers(op, &["baseWidth", "maxFullness", "pressureClip", "speedInk", "speedBlotBlend", "blotTipGrow", "speedFade", "grain", "boldness", "hostKey", "scrollLeftAtDraw", "scrollTopAtDraw", "id", "seq", "radius"])?;
            if let Some(color) = op.get("color") { ensure!(color.is_string(), "invalid raw ink color"); }
            for flag in ["pressureSensitive", "highlight", "highlightTips"] {
                if let Some(v) = op.get(flag) { ensure!(v.is_boolean(), "invalid raw ink style"); }
            }
            if let Some(halts) = op.get("blotHalts") {
                for halt in halts.as_array().context("invalid raw pooling stamps")? {
                    finite(halt, "x")?; finite(halt, "y")?; finite(halt, "grow")?;
                    validate_optional_numbers(halt, &["pressure", "slowness"])?;
                }
            }
        }
    }
    if let Some(layout) = meta.get("layout") {
        ensure!(finite(layout, "w")? > 0.0 && layout["spread"].is_boolean(), "invalid ink layout");
    }
    Ok(is_empty)
}

pub fn validate_ink(bytes: &[u8]) -> Result<ValidatedInk> {
    ensure!(bytes.len() <= MAX_INK_TRANSFER_BYTES, "ink exceeds transfer limit");
    let packed = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = GzDecoder::new(bytes);
        let mut packed = Vec::new();
        decoder.by_ref().take((MAX_PACKED_INK_BYTES + 1) as u64).read_to_end(&mut packed)
            .context("invalid compressed ink (CRC or truncated stream)")?;
        ensure!(packed.len() <= MAX_PACKED_INK_BYTES, "ink exceeds expanded limit");
        ensure!(decoder.get_ref().is_empty(), "trailing compressed ink bytes");
        packed
    } else { bytes.to_vec() };
    let is_empty = validate_packed_ink(&packed)?;
    Ok(ValidatedInk { wire_hash: hash_bytes(&packed), packed, is_empty })
}

pub fn wire_ink_hash(bytes: &[u8]) -> Result<String> { Ok(validate_ink(bytes)?.wire_hash) }

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use flate2::{write::GzEncoder, Compression};
    use serde_json::json;
    use std::io::Write;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../app/src/util/fixtures/sync-content-golden.json")).unwrap()
    }

    fn packed(meta: &Value, payload: &[u8]) -> Vec<u8> {
        let json = serde_json::to_vec(meta).unwrap();
        let mut bytes = b"inkC".to_vec();
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&json);
        bytes.extend_from_slice(payload);
        bytes
    }

    fn gzip(bytes: &[u8], level: u32) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(level));
        encoder.write_all(bytes).unwrap(); encoder.finish().unwrap()
    }

    #[test]
    fn canonical_json_and_record_hash_match_shared_golden_fixtures() {
        let fixture = golden();
        for item in fixture["canonical"].as_array().unwrap() {
            let value: Value = serde_json::from_str(item["input"].as_str().unwrap()).unwrap();
            let text = canonical_json(&value).unwrap();
            assert_eq!(text, item["canonical"].as_str().unwrap(), "{}", item["name"]);
            assert_eq!(hash_bytes(text.as_bytes()), item["hash"].as_str().unwrap());
        }
        for item in fixture["records"].as_array().unwrap() {
            let value: Value = serde_json::from_str(item["input"].as_str().unwrap()).unwrap();
            assert_eq!(canonical_json(&normalize_record(&value).unwrap()).unwrap(), item["canonical"].as_str().unwrap());
            assert_eq!(record_hash(&value).unwrap(), item["hash"].as_str().unwrap());
        }
    }

    #[test]
    fn normalization_keeps_source_hash_unknown_fields_and_authored_paper() {
        let value = json!({"id":"b", "hash":"source", "unknown":{"rev":7,"hash":"nested"},
            "board":{"inkPages":{"v":1,"pageIds":[113]}, "appState":{"scrollX":2,"pdfSpread":true,"linedPitch":24}}});
        let hash = record_hash(&value).unwrap();
        let mut changed = value.clone();
        changed["board"]["appState"]["scrollX"] = json!(999);
        changed["board"]["appState"]["pdfSpread"] = json!(false);
        changed["board"]["inkPages"]["pageIds"] = json!([5]);
        assert_eq!(record_hash(&changed).unwrap(), hash);
        changed["hash"] = json!("different-source");
        assert_ne!(record_hash(&changed).unwrap(), hash);
        changed = value.clone(); changed["board"]["appState"]["linedPitch"] = json!(32);
        assert_ne!(record_hash(&changed).unwrap(), hash);
        changed = value; changed["unknown"]["rev"] = json!(8);
        assert_ne!(record_hash(&changed).unwrap(), hash);
    }

    #[test]
    fn canonical_json_rejects_integer_precision_loss() {
        assert!(canonical_json(&json!(9_007_199_254_740_993_u64)).is_err());
        assert!(canonical_json(&json!(i64::MAX)).is_err());
        assert_eq!(canonical_json(&json!(9_007_199_254_740_992_u64)).unwrap(), "9007199254740992");
    }

    #[test]
    fn raw_gzip_empty_historical_ink_hashes_match_shared_fixtures() {
        for item in golden()["ink"].as_array().unwrap() {
            let raw = STANDARD.decode(item["base64"].as_str().unwrap()).unwrap();
            let result = validate_ink(&raw).unwrap();
            assert_eq!(result.wire_hash, item["hash"].as_str().unwrap());
            assert_eq!(result.is_empty, item["isEmpty"].as_bool().unwrap());
            for level in [1, 9] {
                let compressed = validate_ink(&gzip(&raw, level)).unwrap();
                assert_eq!(compressed.packed, raw);
                assert_eq!(compressed.wire_hash, result.wire_hash);
            }
        }
    }

    #[test]
    fn ink_rejects_corruption_truncation_trailing_bytes_and_bad_counts() {
        let raw = packed(&json!({"meta":[]}), &[]);
        let mut bad = gzip(&raw, 6);
        let end = bad.len(); bad[end - 8] ^= 1;
        assert!(validate_ink(&bad).is_err());
        let good = gzip(&raw, 6);
        assert!(validate_ink(&good[..good.len() - 3]).is_err());
        let mut trailing = good.clone(); trailing.push(0);
        assert!(validate_ink(&trailing).is_err());
        let mut multiple = good.clone(); multiple.extend_from_slice(&good);
        assert!(validate_ink(&multiple).is_err());
        let mut trailing = raw.clone(); trailing.push(0);
        assert!(validate_ink(&trailing).is_err());
        for op in [
            json!({"k":"x","x0":0,"y0":0,"n":1,"xyN":0,"prN":0,"slN":0}),
            json!({"k":"d","x0":0,"y0":0,"n":2,"xyN":0,"prN":0,"slN":0}),
            json!({"k":"d","x0":0,"y0":0,"n":2,"xyN":2,"prN":1,"slN":0}),
            json!({"k":"e","x0":0,"y0":0,"n":1,"xyN":9_007_199_254_740_991_u64,"prN":0,"slN":0}),
        ] { assert!(validate_ink(&packed(&json!({"meta":[op]}), &[])).is_err()); }
        for layout in [json!({"w":0,"spread":false}),json!({"w":760,"spread":1})] {
            assert!(validate_ink(&packed(&json!({"meta":[],"layout":layout}), &[])).is_err());
        }
        let bad = packed(&json!({"meta":[],"raw":[{"kind":"erase","points":[{"x":null,"y":0}]}]}), &[]);
        assert!(validate_ink(&bad).is_err());
    }

    #[test]
    fn packed_ink_limit_is_inclusive_and_expansion_is_bounded() {
        let baseline = packed(&json!({"meta":[], "future":""}), &[]).len();
        let raw = packed(&json!({"meta":[], "future":" ".repeat(MAX_PACKED_INK_BYTES - baseline)}), &[]);
        assert_eq!(raw.len(), MAX_PACKED_INK_BYTES);
        assert!(validate_ink(&raw).is_ok());
        let mut over = raw; over.push(0);
        assert!(validate_ink(&over).is_err());
        assert!(validate_ink(&gzip(&over, 1)).is_err());
    }
}
