//! Named Tauri commands — one per harness route. No URL, no dummy host.
//!
//! Each command builds the same path the old `lc_dispatch` client used, then
//! runs [`super::lc_client::call_router`]. Handlers stay in `harness::serve`.

use harness::serve::Shared;
use serde::Deserialize;
use serde_json::json;
use tauri::State;

use super::lc_client::{call_router, LcResponse};

fn enc(raw: &str) -> String {
    let mut out = String::new();
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn qs(params: &[(&str, Option<String>)]) -> String {
    let mut parts = Vec::new();
    for (key, value) in params {
        let Some(value) = value else { continue };
        if value.is_empty() {
            continue;
        }
        parts.push(format!("{key}={}", enc(value)));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

fn num(n: Option<u32>) -> Option<String> {
    n.map(|n| n.to_string())
}

async fn go(
    state: State<'_, Shared>,
    method: &str,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<LcResponse, String> {
    call_router(state.inner().clone(), method, path, body, None).await
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct SearchArgs {
    pub dataset: Option<String>,
    pub difficulty: Option<String>,
    pub tag: Option<String>,
    pub q: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub sort: Option<String>,
}

impl SearchArgs {
    fn query(&self) -> String {
        qs(&[
            ("dataset", self.dataset.clone()),
            ("difficulty", self.difficulty.clone()),
            ("tag", self.tag.clone()),
            ("q", self.q.clone()),
            ("limit", num(self.limit)),
            ("offset", num(self.offset)),
            ("sort", self.sort.clone()),
        ])
    }
}

#[tauri::command]
pub async fn lc_health(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "GET", "/health".into(), None).await
}

#[tauri::command]
pub async fn lc_list_problems(
    state: State<'_, Shared>,
    args: Option<SearchArgs>,
) -> Result<LcResponse, String> {
    let q = args.unwrap_or_default().query();
    go(state, "GET", format!("/problems{q}"), None).await
}

#[tauri::command]
pub async fn lc_list_tags(
    state: State<'_, Shared>,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "GET",
        format!("/tags{}", qs(&[("dataset", dataset)])),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_list_datasets(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "GET", "/datasets".into(), None).await
}

#[tauri::command]
pub async fn lc_random_problem(
    state: State<'_, Shared>,
    args: Option<SearchArgs>,
) -> Result<LcResponse, String> {
    let q = args.unwrap_or_default().query();
    go(state, "GET", format!("/random{q}"), None).await
}

#[tauri::command]
pub async fn lc_get_session(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "GET", "/session".into(), None).await
}

#[tauri::command]
pub async fn lc_reset_session(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "POST", "/session/reset".into(), None).await
}

#[tauri::command]
pub async fn lc_enqueue_session(
    state: State<'_, Shared>,
    task_id: String,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        "/session/enqueue".into(),
        Some(json!({ "task_id": task_id, "dataset": dataset })),
    )
    .await
}

#[tauri::command]
pub async fn lc_random_session(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "POST", "/session/random".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_get_config(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "GET", "/config".into(), None).await
}

#[tauri::command]
pub async fn lc_put_config(
    state: State<'_, Shared>,
    config: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "PUT", "/config".into(), Some(config)).await
}

#[tauri::command]
pub async fn lc_llm_status(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "GET", "/llm/status".into(), None).await
}

#[tauri::command]
pub async fn lc_llm_models(
    state: State<'_, Shared>,
    provider: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "GET",
        format!("/llm/models{}", qs(&[("provider", provider)])),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_llm_start(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "POST", "/llm/start".into(), None).await
}

#[tauri::command]
pub async fn lc_llm_stop(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "POST", "/llm/stop".into(), None).await
}

#[tauri::command]
pub async fn lc_get_problem(
    state: State<'_, Shared>,
    id: String,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "GET",
        format!("/problems/{}{}", enc(&id), qs(&[("dataset", dataset)])),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_adjacent_problem(
    state: State<'_, Shared>,
    id: String,
    args: Option<SearchArgs>,
) -> Result<LcResponse, String> {
    let q = args.unwrap_or_default().query();
    go(
        state,
        "GET",
        format!("/problems/{}/adjacent{q}", enc(&id)),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_load_problem(
    state: State<'_, Shared>,
    id: String,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        format!("/problems/{}/load{}", enc(&id), qs(&[("dataset", dataset)])),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_workspace_meta(
    state: State<'_, Shared>,
    id: String,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "GET",
        format!(
            "/workspace/{}/meta{}",
            enc(&id),
            qs(&[("dataset", dataset)])
        ),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_run_tests(
    state: State<'_, Shared>,
    id: String,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        format!(
            "/workspace/{}/test{}",
            enc(&id),
            qs(&[("dataset", dataset)])
        ),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_open_workspace(
    state: State<'_, Shared>,
    id: String,
    target: String,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        format!(
            "/workspace/{}/open{}",
            enc(&id),
            qs(&[("dataset", dataset)])
        ),
        Some(json!({ "target": target })),
    )
    .await
}

#[tauri::command]
pub async fn lc_get_solution(
    state: State<'_, Shared>,
    id: String,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "GET",
        format!(
            "/workspace/{}/solution{}",
            enc(&id),
            qs(&[("dataset", dataset)])
        ),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_put_solution(
    state: State<'_, Shared>,
    id: String,
    source: String,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "PUT",
        format!(
            "/workspace/{}/solution{}",
            enc(&id),
            qs(&[("dataset", dataset)])
        ),
        Some(json!({ "source": source })),
    )
    .await
}

#[tauri::command]
pub async fn lc_get_board(
    state: State<'_, Shared>,
    id: String,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "GET",
        format!(
            "/workspace/{}/board{}",
            enc(&id),
            qs(&[("dataset", dataset)])
        ),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_put_board(
    state: State<'_, Shared>,
    id: String,
    board: serde_json::Value,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "PUT",
        format!(
            "/workspace/{}/board{}",
            enc(&id),
            qs(&[("dataset", dataset)])
        ),
        Some(json!({ "board": board })),
    )
    .await
}

#[tauri::command]
pub async fn lc_get_agent_session(
    state: State<'_, Shared>,
    id: String,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "GET",
        format!(
            "/workspace/{}/agent{}",
            enc(&id),
            qs(&[("dataset", dataset)])
        ),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_put_agent_session(
    state: State<'_, Shared>,
    id: String,
    messages: serde_json::Value,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "PUT",
        format!(
            "/workspace/{}/agent{}",
            enc(&id),
            qs(&[("dataset", dataset)])
        ),
        Some(json!({ "messages": messages })),
    )
    .await
}

#[tauri::command]
pub async fn lc_finish_attempt(
    state: State<'_, Shared>,
    id: String,
    solved: bool,
    save: bool,
    dataset: Option<String>,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        format!(
            "/workspace/{}/attempt{}",
            enc(&id),
            qs(&[("dataset", dataset)])
        ),
        Some(json!({ "solved": solved, "save": save })),
    )
    .await
}

#[tauri::command]
pub async fn lc_coach_capabilities(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "GET", "/coach/capabilities".into(), None).await
}

#[tauri::command]
pub async fn lc_coach_review(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "POST", "/coach/review".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_coach_ask(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "POST", "/coach/ask".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_coach_viz(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "POST", "/coach/viz".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_coach_draw_review(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "POST", "/coach/draw_review".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_coach_reveal(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "POST", "/coach/reveal".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_coach_lazy(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "POST", "/coach/lazy".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_coach_scaffold(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "POST", "/coach/scaffold".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_docs_get_index(
    state: State<'_, Shared>,
    hash: String,
) -> Result<LcResponse, String> {
    go(state, "GET", format!("/docs/{}/index", enc(&hash)), None).await
}

/// One budget of the embedding pass. Call until `done == total`.
///
/// Short by design: a book is minutes of work, and a call that returns between
/// budgets is one the reader can close the app in the middle of.
#[tauri::command]
pub async fn lc_docs_embed(
    state: State<'_, Shared>,
    hash: String,
) -> Result<LcResponse, String> {
    go(state, "POST", format!("/docs/{}/embed", enc(&hash)), None).await
}

#[tauri::command]
pub async fn lc_docs_put_index(
    state: State<'_, Shared>,
    hash: String,
    body: serde_json::Value,
    force: Option<bool>,
) -> Result<LcResponse, String> {
    // `force` rewrites vectors for a document whose page count has not changed —
    // the shape of "I just turned an embedding model on".
    let path = if force.unwrap_or(false) {
        format!("/docs/{}/index?force=true", enc(&hash))
    } else {
        format!("/docs/{}/index", enc(&hash))
    };
    go(state, "PUT", path, Some(body)).await
}

/// Nearest chunks of one document — link suggestions, and anything else that
/// wants "what else in this file is about that".
///
/// Per **file hash**, like the index it reads: two annotation sets over one
/// textbook suggest from the same text, because it is the same text.
#[tauri::command]
pub async fn lc_docs_retrieve(
    state: State<'_, Shared>,
    hash: String,
    query: String,
    k: Option<usize>,
) -> Result<LcResponse, String> {
    let path = format!(
        "/docs/{}/retrieve?q={}&k={}",
        enc(&hash),
        enc(&query),
        k.unwrap_or(4)
    );
    go(state, "POST", path, None).await
}

#[tauri::command]
pub async fn lc_docs_get_bytes(
    state: State<'_, Shared>,
    hash: String,
) -> Result<LcResponse, String> {
    go(state, "GET", format!("/docs/{}/bytes", enc(&hash)), None).await
}

#[tauri::command]
pub async fn lc_docs_put_bytes(
    state: State<'_, Shared>,
    hash: String,
    raw_base64: String,
) -> Result<LcResponse, String> {
    call_router(
        state.inner().clone(),
        "PUT",
        format!("/docs/{}/bytes", enc(&hash)),
        None,
        Some(raw_base64),
    )
    .await
}

#[tauri::command]
pub async fn lc_get_ink_pages(
    state: State<'_, Shared>,
    kind: String,
    key: String,
) -> Result<LcResponse, String> {
    go(
        state,
        "GET",
        format!("/pads/ink/{}/{}", enc(&kind), enc(&key)),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_put_ink_page(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "PUT", "/pads/ink".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_put_edges(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "PUT", "/pads/edges".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_tombstone_edge(
    state: State<'_, Shared>,
    id: String,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        format!("/pads/edges/{}/tombstone", enc(&id)),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_docs_retrieve_library(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "POST", "/docs/retrieve".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_docs_list_chunk_digests(
    state: State<'_, Shared>,
) -> Result<LcResponse, String> {
    go(state, "GET", "/docs/chunk-digests".into(), None).await
}

#[tauri::command]
pub async fn lc_docs_get_chunks(
    state: State<'_, Shared>,
    hash: String,
) -> Result<LcResponse, String> {
    go(state, "GET", format!("/docs/{}/chunks", enc(&hash)), None).await
}

#[tauri::command]
pub async fn lc_docs_put_chunks(
    state: State<'_, Shared>,
    hash: String,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(
        state,
        "PUT",
        format!("/docs/{}/chunks", enc(&hash)),
        Some(body),
    )
    .await
}

#[tauri::command]
pub async fn lc_list_whiteboard(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "GET", "/pads/whiteboard".into(), None).await
}

#[tauri::command]
pub async fn lc_archive_whiteboard(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "GET", "/pads/whiteboard/archive".into(), None).await
}

#[tauri::command]
pub async fn lc_put_whiteboard(
    state: State<'_, Shared>,
    id: String,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(
        state,
        "PUT",
        format!("/pads/whiteboard/{}", enc(&id)),
        Some(body),
    )
    .await
}

#[tauri::command]
pub async fn lc_tombstone_whiteboard(
    state: State<'_, Shared>,
    id: String,
    seq: Option<i64>,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        format!("/pads/whiteboard/{}/tombstone", enc(&id)),
        Some(json!({ "seq": seq.unwrap_or(0) })),
    )
    .await
}

#[tauri::command]
pub async fn lc_restore_whiteboard(
    state: State<'_, Shared>,
    id: String,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        format!("/pads/whiteboard/{}/restore", enc(&id)),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_list_annotate(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "GET", "/pads/annotate".into(), None).await
}

#[tauri::command]
pub async fn lc_archive_annotate(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "GET", "/pads/annotate/archive".into(), None).await
}

#[tauri::command]
pub async fn lc_put_annotate(
    state: State<'_, Shared>,
    id: String,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(
        state,
        "PUT",
        format!("/pads/annotate/{}", enc(&id)),
        Some(body),
    )
    .await
}

#[tauri::command]
pub async fn lc_tombstone_annotate(
    state: State<'_, Shared>,
    id: String,
    seq: Option<i64>,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        format!("/pads/annotate/{}/tombstone", enc(&id)),
        Some(json!({ "seq": seq.unwrap_or(0) })),
    )
    .await
}

#[tauri::command]
pub async fn lc_restore_annotate(
    state: State<'_, Shared>,
    id: String,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        format!("/pads/annotate/{}/restore", enc(&id)),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_get_problem_pad(
    state: State<'_, Shared>,
    dataset: String,
    task_id: String,
) -> Result<LcResponse, String> {
    go(
        state,
        "GET",
        format!(
            "/pads/problem/{}/{}",
            enc(&dataset),
            enc(&task_id)
        ),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_put_problem(
    state: State<'_, Shared>,
    dataset: String,
    task_id: String,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(
        state,
        "PUT",
        format!(
            "/pads/problem/{}/{}",
            enc(&dataset),
            enc(&task_id)
        ),
        Some(body),
    )
    .await
}

#[tauri::command]
pub async fn lc_tombstone_problem(
    state: State<'_, Shared>,
    dataset: String,
    task_id: String,
    seq: Option<i64>,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        format!(
            "/pads/problem/{}/{}/tombstone",
            enc(&dataset),
            enc(&task_id)
        ),
        Some(json!({ "seq": seq.unwrap_or(0) })),
    )
    .await
}

#[tauri::command]
pub async fn lc_put_snapshot(
    state: State<'_, Shared>,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(state, "PUT", "/pads/snapshots".into(), Some(body)).await
}

#[tauri::command]
pub async fn lc_get_snapshots(
    state: State<'_, Shared>,
    kind: String,
    key: String,
) -> Result<LcResponse, String> {
    go(
        state,
        "GET",
        format!("/pads/snapshots/{}/{}", enc(&kind), enc(&key)),
        None,
    )
    .await
}

#[tauri::command]
pub async fn lc_pads_sync(state: State<'_, Shared>, since: i64) -> Result<LcResponse, String> {
    go(state, "GET", format!("/pads/sync?since={since}"), None).await
}

#[tauri::command]
pub async fn lc_list_devices(state: State<'_, Shared>) -> Result<LcResponse, String> {
    go(state, "GET", "/devices".into(), None).await
}

#[tauri::command]
pub async fn lc_get_device_prefs(
    state: State<'_, Shared>,
    id: String,
) -> Result<LcResponse, String> {
    go(state, "GET", format!("/devices/{}/prefs", enc(&id)), None).await
}

#[tauri::command]
pub async fn lc_put_device_prefs(
    state: State<'_, Shared>,
    id: String,
    body: serde_json::Value,
) -> Result<LcResponse, String> {
    go(
        state,
        "PUT",
        format!("/devices/{}/prefs", enc(&id)),
        Some(body),
    )
    .await
}

#[tauri::command]
pub async fn lc_clone_device_prefs(
    state: State<'_, Shared>,
    id: String,
    role: String,
) -> Result<LcResponse, String> {
    go(
        state,
        "POST",
        format!("/devices/{}/clone", enc(&id)),
        Some(json!({ "role": role })),
    )
    .await
}

