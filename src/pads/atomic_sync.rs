//! Atomic book publication and revision-pinned acquisition. No retry payloads live here.
use super::*;
use anyhow::{ensure, Context};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolError {
    pub status: u16,
    pub body: Value,
}
impl ProtocolError {
    pub fn new(status: u16, body: Value) -> Self {
        Self { status, body }
    }
}
impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.status, self.body)
    }
}
impl std::error::Error for ProtocolError {}
pub type ProtocolResult<T> = Result<std::result::Result<T, ProtocolError>>;

#[derive(Debug)]
struct UnreadableInkPage {
    key: String,
    page_id: i64,
}
impl std::fmt::Display for UnreadableInkPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unreadable ink {} page {}", self.key, self.page_id)
    }
}
impl std::error::Error for UnreadableInkPage {}
fn unreadable_body(error: &anyhow::Error) -> Value {
    let mut body = json!({"status":"unreadable_content","message":format!("{error:#}")});
    if let Some(page) = error.downcast_ref::<UnreadableInkPage>() {
        body["pages"] = json!([{"key":page.key,"page_id":page.page_id}]);
    }
    body
}

fn protocol<T>(value: Result<T>) -> ProtocolResult<T> {
    match value {
        Ok(value) => Ok(Ok(value)),
        Err(error) if format!("{error:#}").contains("unreadable") => Ok(Err(ProtocolError::new(
            422,
            unreadable_body(&error),
        ))),
        Err(error) => match error.downcast::<ProtocolError>() {
            Ok(error) => Ok(Err(error)),
            Err(error) => Err(error),
        },
    }
}
fn reject(status: u16, body: Value) -> anyhow::Error {
    ProtocolError::new(status, body).into()
}
fn invalid(message: impl ToString) -> anyhow::Error {
    reject(
        400,
        json!({"status":"invalid","message":message.to_string()}),
    )
}

pub fn migrate(conn: &Connection) -> Result<()> {
    ensure!(
        !conn.is_autocommit(),
        "atomic schema migration requires a transaction"
    );
    conn.execute_batch("CREATE TABLE IF NOT EXISTS ink_stage (
        upload_id TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,page_id INTEGER NOT NULL,
        gz BLOB NOT NULL,wire_hash TEXT NOT NULL,is_empty INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,
        PRIMARY KEY(upload_id,kind,key,page_id));
        CREATE TABLE IF NOT EXISTS commits (
        upload_id TEXT PRIMARY KEY,kind TEXT NOT NULL,pad_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,result_json TEXT NOT NULL,committed_at INTEGER NOT NULL);")?;
    ensure_column(conn, "ink_stage", "wire_hash", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "ink_stage", "is_empty", "INTEGER NOT NULL DEFAULT 0")?;
    Ok(())
}

pub fn sweep(conn: &Connection) -> Result<()> {
    sweep_with_clock(conn, &SystemClock)
}
pub fn sweep_with_clock(conn: &Connection, clock: &dyn Clock) -> Result<()> {
    write_transaction(conn, || {
        let now = now_ms(clock);
        let last: Option<i64> = conn
            .query_row("SELECT value FROM meta WHERE key='last_sweep'", [], |row| {
                row.get(0)
            })
            .optional()?;
        if last.is_some_and(|last| now.saturating_sub(last) < 3_600_000) {
            return Ok(());
        }
        conn.execute(
            "DELETE FROM ink_stage WHERE created_at < ?1",
            params![now.saturating_sub(86_400_000)],
        )?;
        conn.execute(
            "DELETE FROM commits WHERE committed_at < ?1",
            params![now.saturating_sub(604_800_000)],
        )?;
        conn.execute("INSERT INTO meta(key,value) VALUES('last_sweep',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![now])?;
        Ok(())
    })
}

fn identity(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.trim() == value
            && value.encode_utf16().count() <= 1024
            && !value.chars().any(|c| c.is_control()),
        "invalid identity"
    );
    Ok(())
}
fn pad_kind(kind: &str) -> Result<PadKind> {
    match kind {
        "annotate" => Ok(PadKind::Annotate),
        "whiteboard" => Ok(PadKind::Whiteboard),
        "problem" => Ok(PadKind::Problem),
        _ => anyhow::bail!("invalid kind"),
    }
}
fn uuid(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    ensure!(
        bytes.len() == 36
            && bytes[14] == b'4'
            && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| if [8, 13, 18, 23].contains(&index) {
                    *byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }),
        "invalid UUID-v4"
    );
    Ok(())
}
fn safe_integer(value: i64) -> Result<()> {
    ensure!(
        (0..=9_007_199_254_740_991).contains(&value),
        "invalid nonnegative safe integer"
    );
    Ok(())
}
fn page_identity(kind: &str, key: &str, page_id: i64) -> Result<String> {
    identity(key)?;
    safe_integer(page_id)?;
    ensure!(
        matches!(kind, "annotate" | "whiteboard"),
        "invalid ink kind"
    );
    if kind == "annotate" {
        if let Some((parent, child)) = key.split_once(INK_FOOTNOTE_SEP) {
            identity(parent)?;
            identity(child)?;
            ensure!(
                !parent.contains('/') && !child.contains('/'),
                "invalid footnote key"
            );
            return Ok(parent.to_string());
        }
    }
    ensure!(!key.contains('/'), "invalid primary ink key");
    Ok(key.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BookPage {
    pub key: String,
    pub page_id: i64,
    pub rev: i64,
    pub hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookState {
    pub kind: String,
    pub id: String,
    pub book_rev: i64,
    pub state: String,
    pub gone_seq: Option<i64>,
    pub record_rev: i64,
    pub record_hash: Option<String>,
    pub record: Option<Value>,
    pub pages: Vec<BookPage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub retained_restore_pages: Vec<BookPage>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub retained_unpublished: bool,
}

fn strict_record_json(conn: &Connection, kind: &str, id: &str) -> Result<()> {
    let columns = match kind {
        "annotate" => {
            "board_json,agent_json,footnotes_json,footnote_boards_json,artifacts_json,extra_json"
        }
        _ => "board_json,agent_json,artifacts_json,extra_json",
    };
    let sql = format!("SELECT {columns} FROM {kind} WHERE id=?1");
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params![id])?;
    if let Some(row) = rows.next()? {
        for index in 0..row.as_ref().column_count() {
            if let Some(raw) = row.get::<_, Option<String>>(index)? {
                let value: Value = serde_json::from_str(&raw).context("unreadable book JSON")?;
                if index == 0 {
                    ensure!(value.is_object(), "unreadable book board");
                }
                if index == 1 {
                    ensure!(value.is_array(), "unreadable book transcript");
                }
            }
        }
    }
    Ok(())
}

fn owned_pages(conn: &Connection, kind: &str, id: &str) -> Result<Vec<(BookPage, Vec<u8>)>> {
    let prefix = format!("{id}{INK_FOOTNOTE_SEP}");
    let mut statement = conn.prepare(
        "SELECT key,page_id,rev,gz FROM ink_pages WHERE kind=?1
        AND (key=?2 OR (?1='annotate' AND substr(key,1,?3)=?4)) ORDER BY key,page_id",
    )?;
    let rows = statement.query_map(
        params![kind, id, prefix.chars().count() as i64, prefix],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        },
    )?;
    let mut pages = Vec::new();
    for row in rows {
        let (key, page_id, rev, bytes) = row?;
        page_identity(kind, &key, page_id).with_context(|| UnreadableInkPage {
            key: key.clone(),
            page_id,
        })?;
        let hash = sync_content::validate_ink(&bytes)
            .with_context(|| UnreadableInkPage {
                key: key.clone(),
                page_id,
            })?
            .wire_hash;
        pages.push((
            BookPage {
                key,
                page_id,
                rev,
                hash,
            },
            bytes,
        ));
    }
    Ok(pages)
}

pub fn get_book_state(conn: &Connection, kind: &str, id: &str) -> Result<BookState> {
    let parsed = pad_kind(kind)?;
    identity(id)?;
    read_transaction(conn, || {
        let book_rev = conn
            .query_row(
                "SELECT rev FROM book_heads WHERE kind=?1 AND id=?2",
                params![kind, id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let gone_seq = conn
            .query_row(
                "SELECT seq FROM gone WHERE kind=?1 AND id=?2",
                params![kind, id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if let Some(seq) = gone_seq {
            return Ok(BookState {
                kind: kind.into(),
                id: id.into(),
                book_rev,
                state: "gone".into(),
                gone_seq: Some(seq),
                record_rev: 0,
                record_hash: None,
                record: None,
                pages: Vec::new(),
                retained_restore_pages: owned_pages(conn, kind, id)?
                    .into_iter()
                    .map(|(page, _)| page)
                    .collect(),
                retained_unpublished: false,
            });
        }
        strict_record_json(conn, kind, id)?;
        let (record, record_rev) = match parsed {
            PadKind::Annotate => match get_annotate(conn, id)? {
                Some(record) => {
                    let rev = record.rev;
                    (Some(serde_json::to_value(record)?), rev)
                }
                None => (None, 0),
            },
            PadKind::Whiteboard => match get_whiteboard(conn, id)? {
                Some(record) => {
                    let rev = record.rev;
                    (Some(serde_json::to_value(record)?), rev)
                }
                None => (None, 0),
            },
            PadKind::Problem => match get_problem(conn, id)? {
                Some(record) => {
                    let rev = record.rev;
                    (Some(serde_json::to_value(record)?), rev)
                }
                None => (None, 0),
            },
        };
        let record_hash = record
            .as_ref()
            .map(sync_content::record_hash)
            .transpose()
            .context("unreadable book content")?;
        let pages = if kind == "problem" {
            Vec::new()
        } else {
            owned_pages(conn, kind, id)?
                .into_iter()
                .map(|(page, _)| page)
                .collect()
        };
        let retained_unpublished = record.is_none() && !pages.is_empty();
        Ok(BookState {
            kind: kind.into(),
            id: id.into(),
            book_rev,
            state: if record.is_some() { "live" } else { "absent" }.into(),
            gone_seq: None,
            record_rev,
            record_hash,
            record,
            pages,
            retained_restore_pages: Vec::new(),
            retained_unpublished,
        })
    })
}

pub fn get_book_state_protocol(conn: &Connection, kind: &str, id: &str) -> ProtocolResult<BookState> {
    protocol(get_book_state(conn, kind, id))
}

pub fn list_book_inventory(conn: &Connection) -> Result<Vec<Value>> {
    read_transaction(conn, || {
        list_book_heads(conn)?.into_iter().map(|head| {
            match get_book_state(conn,&head.kind,&head.id) {
                Ok(book)=>Ok(serde_json::to_value(book)?),
                Err(error) if format!("{error:#}").contains("unreadable")=>Ok(json!({"kind":head.kind,"id":head.id,"book_rev":head.rev,"error":unreadable_body(&error)})),
                Err(error)=>Err(error),
            }
        }).collect()
    })
}

pub fn check_book_head(
    conn: &Connection,
    kind: &str,
    id: &str,
    expected: i64,
) -> ProtocolResult<BookState> {
    protocol(read_transaction(conn, || {
        safe_integer(expected).map_err(invalid)?;
        let book = get_book_state(conn, kind, id)?;
        if book.book_rev != expected {
            return Err(reject(409, json!({"status":"book_changed","book":book})));
        }
        Ok(book)
    }))
}

pub fn get_conditional_ink(
    conn: &Connection,
    kind: &str,
    key: &str,
    page_id: i64,
    book_rev: i64,
    page_rev: i64,
) -> ProtocolResult<InkPageRow> {
    protocol(read_transaction(conn, || {
        safe_integer(book_rev).map_err(invalid)?;
        safe_integer(page_rev).map_err(invalid)?;
        let parent = page_identity(kind, key, page_id).map_err(invalid)?;
        let book = get_book_state(conn, kind, &parent)?;
        if book.book_rev != book_rev {
            return Err(reject(409, json!({"status":"book_changed"})));
        }
        if book.state == "gone" {
            let retained = book
                .retained_restore_pages
                .iter()
                .find(|page| page.key == key && page.page_id == page_id)
                .ok_or_else(|| reject(404, json!({"status":"not_found"})))?;
            if retained.rev != page_rev {
                return Err(reject(409, json!({"status":"book_changed"})));
            }
        }
        let page = get_ink_page(conn, kind, key, page_id)?
            .ok_or_else(|| reject(404, json!({"status":"not_found"})))?;
        if page.rev != page_rev {
            return Err(reject(409, json!({"status":"book_changed"})));
        }
        ensure!(page.hash.is_some(), "unreadable ink page");
        Ok(page)
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageDigest {
    pub kind: String,
    pub key: String,
    pub page_id: i64,
    pub hash: String,
}
pub fn stage_ink(
    conn: &Connection,
    upload_id: &str,
    kind: &str,
    key: &str,
    page_id: i64,
    gz: &str,
) -> ProtocolResult<String> {
    let preparation = (|| {
        uuid(upload_id).map_err(invalid)?;
        page_identity(kind, key, page_id).map_err(invalid)?;
        if gz.len() > sync_content::MAX_INK_TRANSFER_BYTES.saturating_add(2) / 3 * 4 {
            return Err(invalid("ink exceeds transfer limit"));
        }
        let bytes = BASE64.decode(gz).map_err(invalid)?;
        let validated = sync_content::validate_ink(&bytes).map_err(|error| {
            reject(
                400,
                json!({"status":"invalid","message":format!("{error:#}")}),
            )
        })?;
        Ok((bytes, validated.wire_hash, validated.is_empty))
    })();
    let (bytes, hash, is_empty) = match protocol(preparation)? {
        Ok(value) => value,
        Err(error) => return Ok(Err(error)),
    };
    protocol(write_transaction(conn, || {
        conn.execute("INSERT INTO ink_stage(upload_id,kind,key,page_id,gz,wire_hash,is_empty,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
            ON CONFLICT(upload_id,kind,key,page_id) DO UPDATE SET gz=excluded.gz,wire_hash=excluded.wire_hash,is_empty=excluded.is_empty,created_at=excluded.created_at",
            params![upload_id,kind,key,page_id,bytes,hash,is_empty,now_ms(&SystemClock)])?;
        Ok(hash)
    }))
}
pub fn list_staged(conn: &Connection, upload_id: &str) -> Result<Vec<StageDigest>> {
    uuid(upload_id)?;
    let mut statement=conn.prepare("SELECT kind,key,page_id,wire_hash FROM ink_stage WHERE upload_id=?1 ORDER BY kind,key,page_id")?;
    let values = statement
        .query_map(params![upload_id], |row| {
            Ok(StageDigest {
                kind: row.get(0)?,
                key: row.get(1)?,
                page_id: row.get(2)?,
                hash: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(values)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitRecord {
    pub base_rev: i64,
    pub value: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitPage {
    pub key: String,
    pub page_id: i64,
    pub base_rev: i64,
    pub hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitRequest {
    pub upload_id: String,
    pub kind: String,
    pub id: String,
    pub action: String,
    pub record: Option<CommitRecord>,
    pub pages: Vec<CommitPage>,
    #[serde(default)]
    pub base_book_rev: Option<i64>,
    #[serde(default)]
    pub seq: Option<i64>,
    #[serde(default)]
    pub gone_seq: Option<i64>,
}
pub fn get_commit(conn: &Connection, upload_id: &str) -> Result<Option<Value>> {
    uuid(upload_id)?;
    let raw = conn
        .query_row(
            "SELECT result_json FROM commits WHERE upload_id=?1",
            params![upload_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    raw.map(|value| serde_json::from_str(&value).map_err(Into::into))
        .transpose()
}

fn effective_record(request: &CommitRequest, current: &BookState) -> Result<Option<Value>> {
    let Some(input) = request.record.as_ref() else {
        return Ok(current.record.clone());
    };
    let sequence = if request.action == "restore" {
        request.seq.unwrap_or(0)
    } else {
        current
            .record
            .as_ref()
            .and_then(|record| record["sync_seq"].as_i64())
            .unwrap_or(0)
    };
    let existing_extra = current
        .record
        .as_ref()
        .map(|value| value.as_object().cloned().unwrap_or_default());
    let mut record = input.value.clone();
    ensure!(record.is_object(), "record must be an object");
    ensure!(
        record["id"].as_str() == Some(request.id.as_str()),
        "foreign record id"
    );
    if let Some(existing) = existing_extra {
        let target = record.as_object_mut().unwrap();
        for (key, value) in existing {
            if !target.contains_key(&key) {
                target.insert(key, value);
            }
        }
    }
    record["sync_seq"] = json!(sequence);
    record["rev"] = json!(0);
    let existing_agent = current
        .record
        .as_ref()
        .map(|record| record["agent"].clone())
        .unwrap_or_else(|| json!([]));
    let incoming_agent = record.get("agent").cloned().unwrap_or_else(|| json!([]));
    ensure!(incoming_agent.is_array(), "invalid record transcript");
    record["agent"] = crate::agent_transcript::update(&existing_agent, &incoming_agent);
    ensure!(record["board"].is_object(), "invalid record board");
    match request.kind.as_str() {
        "annotate" => {
            let mut parsed: AnnotatePad = serde_json::from_value(record)?;
            ensure!(
                matches!(
                    parsed.doc_type.as_str(),
                    "markdown" | "pdf" | "epub" | "code" | "web"
                ),
                "invalid annotate source type"
            );
            ensure!(
                parsed.footnotes.is_array() && parsed.footnote_boards.is_object(),
                "invalid annotate footnotes"
            );
            parsed.footnotes =
                crate::agent_transcript::prune_footnote_links(&parsed.footnotes, &parsed.agent);
            parsed.board = without_manifest(&parsed.board);
            parsed.footnote_boards = without_footnote_manifests(&parsed.footnote_boards);
            parsed.label = parsed.label.trim().to_string();
            Ok(Some(serde_json::to_value(parsed)?))
        }
        "whiteboard" => {
            let mut parsed: WhiteboardPad = serde_json::from_value(record)?;
            safe_integer(parsed.page_count)?;
            ensure!(parsed.page_count > 0, "invalid whiteboard page count");
            parsed.board = without_manifest(&parsed.board);
            Ok(Some(serde_json::to_value(parsed)?))
        }
        "problem" => {
            let parsed: ProblemPad = serde_json::from_value(record)?;
            ensure!(
                parsed.id == format!("{}/{}", parsed.dataset.trim(), parsed.task_id.trim())
                    && !parsed.dataset.trim().is_empty()
                    && !parsed.task_id.trim().is_empty(),
                "invalid problem identity"
            );
            Ok(Some(serde_json::to_value(parsed)?))
        }
        _ => Err(invalid("invalid record kind")),
    }
}

fn footnote_ids(record: Option<&Value>) -> BTreeSet<String> {
    record
        .and_then(|record| record.get("footnote_boards"))
        .and_then(Value::as_object)
        .map(|boards| boards.keys().cloned().collect())
        .unwrap_or_default()
}

fn dependencies(
    conn: &Connection,
    request: &CommitRequest,
    current: &BookState,
    effective: &Value,
    blob_dir: &Path,
) -> Result<()> {
    let catalog = effective.get("artifacts").filter(|value| !value.is_null());
    let old = current
        .record
        .as_ref()
        .and_then(|record| record.get("artifacts"))
        .filter(|value| !value.is_null());
    artifacts::validate(catalog, old, &request.kind, &request.id).map_err(|error| {
        reject(
            422,
            json!({"status":"invalid_dependency","message":format!("{error:#}")}),
        )
    })?;
    artifacts::require_assets(conn, catalog, &request.kind, &request.id).map_err(|error| {
        reject(
            422,
            json!({"status":"invalid_dependency","message":format!("{error:#}")}),
        )
    })?;
    if request.kind == "annotate" && matches!(effective["doc_type"].as_str(), Some("pdf" | "epub"))
    {
        let hash = effective["hash"]
            .as_str()
            .ok_or_else(|| invalid("source hash is required"))?;
        if !blob_exists(blob_dir, hash).map_err(invalid)? {
            return Err(reject(
                422,
                json!({"status":"invalid_dependency","source_hash":hash,"message":"source bytes are missing"}),
            ));
        }
    }
    Ok(())
}

fn write_effective_record(
    conn: &Connection,
    kind: &str,
    value: Value,
    clock: &dyn Clock,
) -> Result<()> {
    let outcome = match kind {
        "annotate" => match write_annotate(conn, &serde_json::from_value(value)?, clock, false)? {
            PutOutcome::Written(_) => true,
            _ => false,
        },
        "whiteboard" => {
            match write_whiteboard(conn, &serde_json::from_value(value)?, clock, false)? {
                PutOutcome::Written(_) => true,
                _ => false,
            }
        }
        "problem" => match write_problem(conn, &serde_json::from_value(value)?, clock, false)? {
            PutOutcome::Written(_) => true,
            _ => false,
        },
        _ => false,
    };
    ensure!(outcome, "validated modern record publication was refused");
    Ok(())
}

pub fn commit_pad(conn: &Connection, request: &CommitRequest) -> ProtocolResult<Value> {
    commit_pad_with_context(conn, request, &SystemClock, &blobs_dir()?)
}

pub fn commit_pad_with_context(
    conn: &Connection,
    request: &CommitRequest,
    clock: &dyn Clock,
    blob_dir: &Path,
) -> ProtocolResult<Value> {
    // Envelope identity and hashing use prepared request data, before opening the write transaction.
    let preparation = (|| {
        uuid(&request.upload_id).map_err(invalid)?;
        pad_kind(&request.kind).map_err(invalid)?;
        identity(&request.id).map_err(invalid)?;
        if request.kind != "problem" && request.id.contains('/') {
            return Err(invalid("invalid book id"));
        }
        if !matches!(request.action.as_str(), "upsert" | "delete" | "restore") {
            return Err(invalid("invalid commit action"));
        }
        for value in [request.base_book_rev, request.seq, request.gone_seq]
            .into_iter()
            .flatten()
        {
            safe_integer(value).map_err(invalid)?;
        }
        if let Some(record) = &request.record {
            safe_integer(record.base_rev).map_err(invalid)?;
        }
        let mut identities = BTreeSet::new();
        for page in &request.pages {
            let owner = page_identity(&request.kind, &page.key, page.page_id).map_err(invalid)?;
            safe_integer(page.base_rev).map_err(invalid)?;
            if owner != request.id || !identities.insert((page.key.clone(), page.page_id)) {
                return Err(invalid("foreign or duplicate page"));
            }
            if page.hash.len() != 64
                || !page
                    .hash
                    .bytes()
                    .all(|byte| matches!(byte,b'0'..=b'9'|b'a'..=b'f'))
            {
                return Err(invalid("invalid staged hash"));
            }
        }
        if request.kind == "problem" && !request.pages.is_empty() {
            return Err(invalid("problem pages must be inline"));
        }
        match request.action.as_str() {
            "upsert" => {
                if request.base_book_rev.is_some()
                    || request.seq.is_some()
                    || request.gone_seq.is_some()
                {
                    return Err(invalid("invalid upsert lifecycle fields"));
                }
            }
            "delete" => {
                if request.record.is_some()
                    || !request.pages.is_empty()
                    || request.base_book_rev.is_none()
                    || request.seq.is_none()
                    || request.gone_seq.is_some()
                {
                    return Err(invalid("invalid delete request"));
                }
            }
            "restore" => {
                if request.record.is_none()
                    || request.base_book_rev.is_none()
                    || request.gone_seq.is_none()
                    || request.seq.is_none()
                    || request
                        .record
                        .as_ref()
                        .is_some_and(|record| record.base_rev != 0)
                {
                    return Err(invalid("invalid restore request"));
                }
            }
            _ => unreachable!(),
        }
        let request_hash = sync_content::hash_bytes(
            sync_content::canonical_json(&serde_json::to_value(request)?)
                .map_err(invalid)?
                .as_bytes(),
        );
        Ok(request_hash)
    })();
    let request_hash = match protocol(preparation)? {
        Ok(value) => value,
        Err(error) => return Ok(Err(error)),
    };
    protocol(write_transaction(conn, || {
        let previous = conn
            .query_row(
                "SELECT kind,pad_id,request_hash,result_json FROM commits WHERE upload_id=?1",
                params![request.upload_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((kind, id, hash, json)) = previous {
            if kind != request.kind || id != request.id || hash != request_hash {
                return Err(reject(409, json!({"status":"upload_id_reused"})));
            }
            return Ok(serde_json::from_str(&json)?);
        }
        let current = get_book_state(conn, &request.kind, &request.id)?;
        if request.action == "upsert" && current.state == "gone" {
            return Err(reject(
                410,
                json!({"status":"gone","book_rev":current.book_rev,"seq":current.gone_seq,"book":current}),
            ));
        }
        if request.action != "upsert"
            && (request.base_book_rev != Some(current.book_rev)
                || (request.action == "restore"
                    && (current.state != "gone"
                        || request.gone_seq != current.gone_seq
                        || request.seq.unwrap_or(0) <= current.gone_seq.unwrap_or(0))))
        {
            return Err(reject(
                409,
                json!({"status":"lifecycle_conflict","book":current}),
            ));
        }
        let old_sequence = current
            .gone_seq
            .or_else(|| {
                current
                    .record
                    .as_ref()
                    .and_then(|record| record["sync_seq"].as_i64())
            })
            .unwrap_or(0);
        if request.action == "delete" && request.seq.unwrap_or(0) < old_sequence {
            return Err(reject(
                409,
                json!({"status":"lifecycle_conflict","book":current}),
            ));
        }
        if request.action == "upsert" && current.record.is_none() && request.record.is_none() {
            return Err(reject(
                422,
                json!({"status":"invalid","message":"page-only commit needs a live parent"}),
            ));
        }
        let current_pages = if current.state == "gone" {
            &current.retained_restore_pages
        } else {
            &current.pages
        };
        let existing_pages: BTreeMap<_, _> = current_pages
            .iter()
            .map(|page| ((page.key.clone(), page.page_id), page))
            .collect();
        let record_conflict = request.record.as_ref().and_then(|record| {
            (record.base_rev != current.record_rev).then(|| json!({"hub_rev":current.record_rev}))
        });
        let page_conflicts: Vec<_> = request
            .pages
            .iter()
            .filter_map(|page| {
                let rev = existing_pages
                    .get(&(page.key.clone(), page.page_id))
                    .map(|page| page.rev)
                    .unwrap_or(0);
                (rev != page.base_rev)
                    .then(|| json!({"key":page.key,"page_id":page.page_id,"hub_rev":rev}))
            })
            .collect();
        if record_conflict.is_some() || !page_conflicts.is_empty() {
            return Err(reject(
                409,
                json!({"status":"conflict","record":record_conflict,"pages":page_conflicts}),
            ));
        }
        // A legacy restore can leave live ink below a gone parent. Restore
        // must explicitly account for every disclosed page, including erasures.
        if request.action == "restore" {
            let omitted: Vec<_> = current.retained_restore_pages.iter().filter(|retained| {
                !request.pages.iter().any(|page| page.key == retained.key && page.page_id == retained.page_id)
            }).map(|page| json!({"key":page.key,"page_id":page.page_id,"hub_rev":page.rev,"hash":page.hash})).collect();
            if !omitted.is_empty() {
                return Err(reject(
                    409,
                    json!({"status":"retained_restore_conflict","pages":omitted,
                    "message":"Restore must include every retained page."}),
                ));
            }
        }
        let mut staged = BTreeMap::new();
        let mut missing = Vec::new();
        for page in &request.pages {
            let row=conn.query_row("SELECT gz,wire_hash,is_empty FROM ink_stage WHERE upload_id=?1 AND kind=?2 AND key=?3 AND page_id=?4",
                params![request.upload_id,request.kind,page.key,page.page_id],|row|Ok((row.get::<_,Vec<u8>>(0)?,row.get::<_,String>(1)?,row.get::<_,bool>(2)?))).optional()?;
            if let Some((bytes, hash, is_empty)) = row.filter(|(_, hash, _)| hash == &page.hash) {
                staged.insert((page.key.clone(), page.page_id), (bytes, hash, is_empty));
            } else {
                missing.push(json!({"key":page.key,"page_id":page.page_id}));
            }
        }
        if !missing.is_empty() {
            return Err(reject(
                422,
                json!({"status":"invalid","missing_staged":missing}),
            ));
        }
        let effective =
            effective_record(request, &current).map_err(|error| invalid(format!("{error:#}")))?;
        if request.action != "delete" {
            let effective = effective
                .as_ref()
                .ok_or_else(|| invalid("record is required"))?;
            let cap = match request.kind.as_str() {
                "annotate" => Some(ANNOTATE_LIVE_CAP),
                "whiteboard" => Some(WHITEBOARD_LIVE_CAP),
                _ => None,
            };
            if current.record.is_none() {
                if let Some(cap) = cap {
                    if live_count(conn, &request.kind)? >= cap {
                        return Err(reject(
                            403,
                            json!({"status":"full","kind":request.kind,"limit":cap,"message":format!("{} library is full ({cap})",request.kind)}),
                        ));
                    }
                }
            }
            dependencies(conn, request, &current, effective, blob_dir)?;
            if request.kind == "annotate" {
                let before = footnote_ids(current.record.as_ref());
                let after = footnote_ids(Some(effective));
                let removed: BTreeSet<_> = before.difference(&after).cloned().collect();
                for page in &request.pages {
                    if let Some((_, child)) = page.key.split_once(INK_FOOTNOTE_SEP) {
                        if !after.contains(child)
                            && !((removed.contains(child)
                                || (request.action == "restore"
                                    && existing_pages
                                        .contains_key(&(page.key.clone(), page.page_id))))
                                && staged[&(page.key.clone(), page.page_id)].2)
                        {
                            return Err(reject(
                                409,
                                json!({"status":"footnote_removed","board":child,"key":page.key,"page_id":page.page_id}),
                            ));
                        }
                    }
                }
                let mut dependency_conflicts = Vec::new();
                for (page, bytes) in owned_pages(conn, "annotate", &request.id)? {
                    if let Some((_, child)) = page.key.split_once(INK_FOOTNOTE_SEP) {
                        if after.contains(child) {
                            continue;
                        }
                        if sync_content::validate_ink(&bytes)?.is_empty {
                            continue;
                        }
                        let replacement = request.pages.iter().find(|candidate| {
                            candidate.key == page.key && candidate.page_id == page.page_id
                        });
                        if replacement.is_none_or(|replacement| {
                            replacement.base_rev != page.rev
                                || !staged[&(page.key.clone(), page.page_id)].2
                        }) {
                            dependency_conflicts.push(
                                json!({"key":page.key,"page_id":page.page_id,"hub_rev":page.rev}),
                            );
                        }
                    }
                }
                if !dependency_conflicts.is_empty() {
                    return Err(reject(
                        409,
                        json!({"status":"dependency_conflict","pages":dependency_conflicts}),
                    ));
                }
            }
        }
        let mut mutation = false;
        let mut page_revs = Vec::new();
        if request.action == "delete" {
            if current.state != "gone" {
                delete_pad_ink(conn, &request.kind, &request.id)?;
                conn.execute(
                    &format!("DELETE FROM {} WHERE id=?1", request.kind),
                    params![request.id],
                )?;
                let rev = next_rev(conn)?;
                conn.execute("INSERT INTO gone(kind,id,seq,gone_at,rev) VALUES(?1,?2,?3,?4,?5)
                    ON CONFLICT(kind,id) DO UPDATE SET seq=excluded.seq,gone_at=excluded.gone_at,rev=excluded.rev",
                    params![request.kind,request.id,request.seq,now_ms(clock),rev])?;
                mutation = true;
            }
        } else {
            if let Some(value) = effective {
                let hash = sync_content::record_hash(&value).map_err(invalid)?;
                if request.record.is_some()
                    && (request.action == "restore" || current.record_hash.as_ref() != Some(&hash))
                {
                    write_effective_record(conn, &request.kind, value, clock)?;
                    mutation = true;
                }
            }
            for page in &request.pages {
                let (bytes, hash, _) = &staged[&(page.key.clone(), page.page_id)];
                let existing = existing_pages.get(&(page.key.clone(), page.page_id));
                let rev = if existing.is_some_and(|page| &page.hash == hash) {
                    existing.unwrap().rev
                } else {
                    let rev = next_rev(conn)?;
                    conn.execute("INSERT INTO ink_pages(kind,key,page_id,updated_at,gz,rev,legacy_updated_at) VALUES(?1,?2,?3,?4,?5,?6,?4)
                        ON CONFLICT(kind,key,page_id) DO UPDATE SET updated_at=excluded.updated_at,gz=excluded.gz,rev=excluded.rev,legacy_updated_at=excluded.legacy_updated_at",
                        params![request.kind,page.key,page.page_id,now_ms(clock),bytes,rev])?;
                    mutation = true;
                    rev
                };
                page_revs
                    .push(json!({"key":page.key,"page_id":page.page_id,"rev":rev,"hash":hash}));
            }
        }
        if mutation {
            bump_book_head(conn, &request.kind, &request.id)?;
        }
        let book = get_book_state(conn, &request.kind, &request.id)?;
        let result = json!({"status":"committed","upload_id":request.upload_id,"record_rev":if book.state=="live"{Some(book.record_rev)}else{None},"page_revs":page_revs,"book":book});
        conn.execute(
            "DELETE FROM ink_stage WHERE upload_id=?1",
            params![request.upload_id],
        )?;
        conn.execute("INSERT INTO commits(upload_id,kind,pad_id,request_hash,result_json,committed_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![request.upload_id,request.kind,request.id,request_hash,serde_json::to_string(&result)?,now_ms(clock)])?;
        Ok(result)
    }))
}

#[cfg(test)]
mod tests;
