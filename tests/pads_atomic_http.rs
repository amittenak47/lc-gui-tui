//! Dedicated test process: the global config directory points only at this
//! temporary directory before the production router opens any storage.
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use serde_json::{json, Value};
use tower::ServiceExt;
use whiteboard::{config, pads, serve};

async fn request(
    state: &serve::Shared,
    native: bool,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let bytes = body
        .map(|value| serde_json::to_vec(&value).unwrap())
        .unwrap_or_default();
    let (status, bytes) = if native {
        let (status, bytes, _) =
            serve::dispatch(state.clone(), method, uri, bytes, Some("application/json"))
                .await
                .unwrap();
        (status, bytes)
    } else {
        let response = serve::router(state.clone())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(Body::from(bytes))
                    .unwrap(),
            )
            .await
            .unwrap();
        (
            response.status().as_u16(),
            to_bytes(response.into_body(), 1_048_576)
                .await
                .unwrap()
                .to_vec(),
        )
    };
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn pads_atomic_http_and_native_dispatch_publish_one_version_and_retain_receipts() {
    let directory = tempfile::tempdir().unwrap();
    config::set_config_dir(directory.path().to_path_buf());
    let state = serve::new_state(config::Config::default());
    let fixture: Value = serde_json::from_str(include_str!(
        "../app/src/util/fixtures/sync-content-golden.json"
    ))
    .unwrap();
    let ink = fixture["ink"][1]["base64"].as_str().unwrap();
    let ink_hash = fixture["ink"][1]["hash"].as_str().unwrap();
    for (index, native) in [false, true].into_iter().enumerate() {
        let id = format!("transport{index}");
        let upload_id = format!("00000000-0000-4000-8000-{index:012}");
        let (status, initial) = request(
            &state,
            native,
            "GET",
            &format!("/pads/books/whiteboard/{id}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(initial["state"], "absent");
        assert_eq!(initial["book_rev"], 0);
        let stage_uri = format!("/pads/stage/{upload_id}/whiteboard/{id}/113");
        let (status, staged) =
            request(&state, native, "PUT", &stage_uri, Some(json!({"gz":ink}))).await;
        assert_eq!(status, 200);
        assert_eq!(staged, json!({"staged":true,"hash":ink_hash}));
        let (_, before) = request(
            &state,
            native,
            "GET",
            &format!("/pads/books/whiteboard/{id}"),
            None,
        )
        .await;
        assert_eq!(before, initial, "staging cannot change the visible book");
        let (_, staged_list) = request(
            &state,
            native,
            "GET",
            &format!("/pads/stage/{upload_id}"),
            None,
        )
        .await;
        assert_eq!(
            staged_list,
            json!([{"kind":"whiteboard","key":id,"page_id":113,"hash":ink_hash}])
        );
        let body = json!({"upload_id":upload_id,"kind":"whiteboard","id":id,"action":"upsert",
            "record":{"base_rev":0,"value":{"id":id,"title":"Algorithms","updated_at":0,"page_count":114,
                "board":{"elements":[],"appState":{}},"agent":[],"unknown_authored":{"kept":true}}},
            "pages":[{"key":id,"page_id":113,"base_rev":0,"hash":ink_hash}]});
        let (status, committed) =
            request(&state, native, "POST", "/pads/commit", Some(body.clone())).await;
        assert_eq!(status, 200, "{committed}");
        assert_eq!(committed["status"], "committed");
        assert_eq!(
            committed["book"]["record"]["unknown_authored"],
            json!({"kept":true})
        );
        assert_eq!(
            committed["book"]["record"]["board"]["inkPages"]["pageIds"],
            json!([113])
        );
        let book_rev = committed["book"]["book_rev"].as_i64().unwrap();
        let page_rev = committed["book"]["pages"][0]["rev"].as_i64().unwrap();
        assert!(book_rev > page_rev && page_rev > 0);
        let (status, page) = request(
            &state,
            native,
            "GET",
            &format!("/pads/ink/whiteboard/{id}/113?book_rev={book_rev}&page_rev={page_rev}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(page["gz"], ink);
        assert_eq!(page["hash"], ink_hash);
        let (status, changed) = request(
            &state,
            native,
            "GET",
            &format!("/pads/ink/whiteboard/{id}/113?book_rev=0&page_rev={page_rev}"),
            None,
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(changed["status"], "book_changed");
        let (status, head) = request(
            &state,
            native,
            "GET",
            &format!("/pads/books/whiteboard/{id}/head?book_rev={book_rev}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(head, json!({"unchanged":true,"book_rev":book_rev}));
        let (status, retry) =
            request(&state, native, "POST", "/pads/commit", Some(body.clone())).await;
        assert_eq!(status, 200);
        assert_eq!(
            retry, committed,
            "lost acknowledgement retry must return the original complete version"
        );
        let (status, receipt) = request(
            &state,
            native,
            "GET",
            &format!("/pads/commits/{upload_id}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(receipt, committed);
        let mut changed_body = body;
        changed_body["record"]["value"]["title"] = json!("changed");
        let (status, reused) =
            request(&state, native, "POST", "/pads/commit", Some(changed_body)).await;
        assert_eq!(status, 409);
        assert_eq!(reused["status"], "upload_id_reused");
        let snapshot = pads::SnapshotRow {
            kind: "whiteboard".into(),
            key: id.clone(),
            tier: "2h".into(),
            written_at: 7,
            payload: json!({"name":"retained","board":{"elements":[]},"unknown":"kept"}),
        };
        let copy_hash = pads::snapshot_copies::content_hash(&snapshot).unwrap();
        let copy_uri = format!("/pads/snapshot-copies/whiteboard/{id}/{copy_hash}");
        let (status, _) = request(
            &state,
            native,
            "PUT",
            &copy_uri,
            Some(serde_json::to_value(&snapshot).unwrap()),
        )
        .await;
        assert_eq!(status, 200);
        let (status, retained) = request(&state, native, "GET", &copy_uri, None).await;
        assert_eq!(status, 200);
        assert_eq!(retained, serde_json::to_value(snapshot).unwrap());
        let delete_id = format!("00000000-0000-4000-8000-{:012}", index + 10);
        let (status, _) = request(
            &state,
            native,
            "POST",
            "/pads/commit",
            Some(json!({
                "upload_id":delete_id,"kind":"whiteboard","id":id,"action":"delete",
                "record":null,"pages":[],"base_book_rev":book_rev,"seq":1
            })),
        )
        .await;
        assert_eq!(status, 200);
        let (status, legacy) = request(
            &state,
            native,
            "PUT",
            "/pads/ink",
            Some(json!({
                "kind":"whiteboard","key":id,"page_id":113,"updated_at":10,"sync_seq":2,"gz":ink
            })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(legacy["applied"], true);
        let (status, gone) = request(
            &state,
            native,
            "GET",
            &format!("/pads/books/whiteboard/{id}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(gone["state"], "gone");
        assert_eq!(gone["pages"], json!([]));
        let retained_page = &gone["retained_restore_pages"][0];
        assert_eq!(retained_page["hash"], ink_hash);
        let gone_head = gone["book_rev"].as_i64().unwrap();
        let retained_rev = retained_page["rev"].as_i64().unwrap();
        let (status, retained_ink) = request(
            &state,
            native,
            "GET",
            &format!("/pads/ink/whiteboard/{id}/113?book_rev={gone_head}&page_rev={retained_rev}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(retained_ink["gz"], ink);
        let restore_id = format!("00000000-0000-4000-8000-{:012}", index + 20);
        let empty_ink = fixture["ink"][0]["base64"].as_str().unwrap();
        let empty_hash = fixture["ink"][0]["hash"].as_str().unwrap();
        let (status, _) = request(
            &state,
            native,
            "PUT",
            &format!("/pads/stage/{restore_id}/whiteboard/{id}/113"),
            Some(json!({"gz":empty_ink})),
        )
        .await;
        assert_eq!(status, 200);
        let mut restore_body = json!({"upload_id":restore_id,"kind":"whiteboard","id":id,"action":"restore",
            "base_book_rev":gone_head,"gone_seq":1,"seq":2,
            "record":{"base_rev":0,"value":committed["book"]["record"]},
            "pages":[{"key":id,"page_id":113,"base_rev":0,"hash":empty_hash}]});
        let (status, rejected) = request(
            &state,
            native,
            "POST",
            "/pads/commit",
            Some(restore_body.clone()),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(rejected["pages"][0]["hub_rev"], retained_rev);
        restore_body["pages"][0]["base_rev"] = json!(retained_rev);
        let (status, restored) =
            request(&state, native, "POST", "/pads/commit", Some(restore_body)).await;
        assert_eq!(status, 200, "{restored}");
        assert_eq!(restored["book"]["state"], "live");
        assert_eq!(restored["book"]["pages"][0]["hash"], empty_hash);
        let (status, backup_after_restore) = request(&state, native, "GET", &copy_uri, None).await;
        assert_eq!(status, 200);
        assert_eq!(backup_after_restore, retained);
    }
    let (status, inventory) = request(&state, false, "GET", "/pads/sync?since=0", None).await;
    assert_eq!(status, 200);
    assert!(inventory["features"]
        .as_array()
        .unwrap()
        .contains(&json!("atomic_book_sync_v1")));
    assert_eq!(inventory["books"].as_array().unwrap().len(), 2);
    // Both transports preserve the structured identity of a corrupt page;
    // the healthy neighbouring book remains available and no bytes are erased.
    let path = pads::db_path().unwrap();
    assert!(path.starts_with(directory.path()));
    let conn = pads::open(&path).unwrap();
    conn.execute("UPDATE ink_pages SET gz=X'00' WHERE key='transport0'", [])
        .unwrap();
    for native in [false, true] {
        let (status, error) = request(&state, native, "GET", "/pads/books/whiteboard/transport0", None).await;
        assert_eq!(status, 422);
        assert_eq!(error["status"], "unreadable_content");
        assert_eq!(error["pages"], json!([{"key":"transport0","page_id":113}]));
        let (status, healthy) = request(&state, native, "GET", "/pads/books/whiteboard/transport1", None).await;
        assert_eq!(status, 200);
        assert_eq!(healthy["state"], "live");
    }
    let bytes: Vec<u8> = conn
        .query_row("SELECT gz FROM ink_pages WHERE key='transport0'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(bytes, [0]);
}
