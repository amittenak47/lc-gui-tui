use super::*;

struct TestClock(i64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}
struct Fixture {
    dir: tempfile::TempDir,
    conn: Connection,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("pads.db")).unwrap();
        Self { dir, conn }
    }
    fn commit(&self, request: &CommitRequest) -> std::result::Result<Value, ProtocolError> {
        commit_pad_with_context(&self.conn, request, &TestClock(10_000), self.dir.path()).unwrap()
    }
    fn book(&self, kind: &str, id: &str) -> BookState {
        get_book_state(&self.conn, kind, id).unwrap()
    }
}
fn id(index: u32) -> String {
    format!("00000000-0000-4000-8000-{index:012x}")
}
fn record(kind: &str, key: &str) -> Value {
    match kind {
        "annotate" => {
            json!({"id":key,"name":"notes.md","hash":"source-id","doc_type":"markdown","updated_at":4,"source":"# preserved","footnotes":[],"footnote_boards":{},"board":{"v":1,"elements":[],"inkPages":{"v":1,"pageIds":[999]}},"agent":[]})
        }
        "whiteboard" => {
            json!({"id":key,"title":"Book","updated_at":4,"page_count":3,"board":{"v":1,"elements":[]},"agent":[]})
        }
        "problem" => {
            json!({"id":key,"dataset":"leetcode","task_id":"one","updated_at":4,"board":{"v":1,"elements":[]},"agent":[]})
        }
        _ => unreachable!(),
    }
}
fn request(index: u32, kind: &str, key: &str) -> CommitRequest {
    CommitRequest {
        upload_id: id(index),
        kind: kind.into(),
        id: key.into(),
        action: "upsert".into(),
        record: Some(CommitRecord {
            base_rev: 0,
            value: record(kind, key),
        }),
        pages: vec![],
        base_book_rev: None,
        seq: None,
        gone_seq: None,
    }
}
fn packed(label: &str, draw: bool) -> Vec<u8> {
    let ops = if draw {
        json!([{"k":"d","x0":1.0,"y0":2.0,"n":1,"xyN":0,"prN":0,"slN":0,"c":label}])
    } else {
        json!([])
    };
    let metadata = serde_json::to_vec(&json!({"meta":ops,"label":label})).unwrap();
    let mut bytes = b"inkC".to_vec();
    bytes.extend_from_slice(&1_u32.to_le_bytes());
    bytes.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    bytes.extend(metadata);
    bytes
}
fn stage(
    f: &Fixture,
    request: &mut CommitRequest,
    key: &str,
    page: i64,
    base: i64,
    label: &str,
    draw: bool,
) {
    let hash = stage_ink(
        &f.conn,
        &request.upload_id,
        &request.kind,
        key,
        page,
        &BASE64.encode(packed(label, draw)),
    )
    .unwrap()
    .unwrap();
    request.pages.push(CommitPage {
        key: key.into(),
        page_id: page,
        base_rev: base,
        hash,
    });
}
fn create(f: &Fixture, index: u32, kind: &str, key: &str) -> BookState {
    f.commit(&request(index, kind, key)).unwrap();
    f.book(kind, key)
}
fn pages_request(index: u32, kind: &str, key: &str) -> CommitRequest {
    let mut value = request(index, kind, key);
    value.record = None;
    value
}
fn delete_request(index: u32, kind: &str, key: &str, head: i64, seq: i64) -> CommitRequest {
    let mut value = pages_request(index, kind, key);
    value.action = "delete".into();
    value.base_book_rev = Some(head);
    value.seq = Some(seq);
    value
}
fn legacy_restore_page(
    f: &Fixture,
    kind: &str,
    key: &str,
    page: i64,
    time: i64,
    label: &str,
    draw: bool,
) {
    let row: InkPageRow = serde_json::from_value(json!({"kind":kind,"key":key,"page_id":page,
        "updated_at":time,"sync_seq":2,"gz":BASE64.encode(packed(label,draw))}))
    .unwrap();
    put_ink_page_with_clock(&f.conn, &row, &TestClock(500 + time)).unwrap();
}
fn restore_request(index: u32, gone: &BookState) -> CommitRequest {
    let mut value = request(index, &gone.kind, &gone.id);
    value.action = "restore".into();
    value.base_book_rev = Some(gone.book_rev);
    value.gone_seq = gone.gone_seq;
    value.seq = Some(gone.gone_seq.unwrap() + 1);
    value
}

#[test]
fn unreadable_page_contract_names_the_page_without_mutating_its_bytes_or_head() {
    let f = Fixture::new();
    let mut input = request(1, "whiteboard", "book");
    stage(&f, &mut input, "book", 113, 0, "empty", false);
    f.commit(&input).unwrap();
    let head = f.book("whiteboard", "book").book_rev;
    f.conn
        .execute("UPDATE ink_pages SET gz=X'00' WHERE key='book'", [])
        .unwrap();
    let expected = json!([{"key":"book","page_id":113}]);
    let inventory = list_book_inventory(&f.conn).unwrap();
    assert_eq!(inventory[0]["error"]["pages"], expected);
    let direct = get_book_state_protocol(&f.conn, "whiteboard", "book")
        .unwrap()
        .unwrap_err();
    assert_eq!(direct.status, 422);
    assert_eq!(direct.body["pages"], expected);
    assert_eq!(
        check_book_head(&f.conn, "whiteboard", "book", head)
            .unwrap()
            .unwrap_err()
            .body["pages"],
        expected
    );
    let bytes: Vec<u8> = f.conn
        .query_row("SELECT gz FROM ink_pages WHERE key='book'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(bytes, [0]);
    assert_eq!(list_book_heads(&f.conn).unwrap()[0].rev, head);
}

#[test]
fn commit_writes_record_pages_head_history_and_receipt_together() {
    let f = Fixture::new();
    let mut input = request(1, "annotate", "book");
    stage(&f, &mut input, "book", 113, 0, "empty", false);
    assert!(get_annotate(&f.conn, "book").unwrap().is_none());
    assert!(get_ink_pages(&f.conn, "annotate", "book")
        .unwrap()
        .is_empty());
    let success = f.commit(&input).unwrap();
    let state = f.book("annotate", "book");
    assert_eq!(state.pages.len(), 1);
    assert_eq!(
        state.record.as_ref().unwrap()["board"]["inkPages"]["pageIds"],
        json!([113])
    );
    assert!(
        state.record_rev > 0
            && state.pages[0].rev > state.record_rev
            && state.book_rev > state.pages[0].rev
    );
    assert_eq!(state.record.as_ref().unwrap()["updated_at"], 10_000);
    assert!(list_staged(&f.conn, &input.upload_id).unwrap().is_empty());
    assert_eq!(
        get_commit(&f.conn, &input.upload_id).unwrap(),
        Some(success)
    );
    let raw: String = f
        .conn
        .query_row(
            "SELECT board_json FROM annotate WHERE id='book'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!raw.contains("inkPages"));
}

#[test]
fn stale_record_and_every_stale_page_are_reported_without_writes() {
    let f = Fixture::new();
    let mut initial = request(1, "whiteboard", "book");
    stage(&f, &mut initial, "book", 1, 0, "one", true);
    stage(&f, &mut initial, "book", 2, 0, "two", true);
    f.commit(&initial).unwrap();
    let before = f.book("whiteboard", "book");
    let sequence: i64 = f
        .conn
        .query_row("SELECT value FROM meta WHERE key='rev_seq'", [], |row| {
            row.get(0)
        })
        .unwrap();
    let mut stale = request(2, "whiteboard", "book");
    stage(&f, &mut stale, "book", 1, 0, "new one", true);
    stage(&f, &mut stale, "book", 2, 0, "new two", true);
    let error = f.commit(&stale).unwrap_err();
    assert_eq!(error.status, 409);
    assert_eq!(error.body["record"]["hub_rev"], before.record_rev);
    assert_eq!(error.body["pages"].as_array().unwrap().len(), 2);
    assert_eq!(
        serde_json::to_value(f.book("whiteboard", "book")).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    assert_eq!(
        f.conn
            .query_row("SELECT value FROM meta WHERE key='rev_seq'", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        sequence
    );
    assert!(get_commit(&f.conn, &stale.upload_id).unwrap().is_none());
    assert_eq!(list_staged(&f.conn, &stale.upload_id).unwrap().len(), 2);
}

#[test]
fn missing_stage_is_422_and_new_parent_remains_absent() {
    let f = Fixture::new();
    let mut input = request(1, "whiteboard", "book");
    input.pages.push(CommitPage {
        key: "book".into(),
        page_id: 1,
        base_rev: 0,
        hash: "a".repeat(64),
    });
    let error = f.commit(&input).unwrap_err();
    assert_eq!(error.status, 422);
    assert_eq!(error.body["missing_staged"][0]["page_id"], 1);
    assert_eq!(f.book("whiteboard", "book").book_rev, 0);
    assert!(get_commit(&f.conn, &input.upload_id).unwrap().is_none());
}

#[test]
fn commit_idempotency_returns_exact_receipt_and_rejects_reused_body() {
    let f = Fixture::new();
    let input = request(1, "whiteboard", "book");
    let first = f.commit(&input).unwrap();
    assert_eq!(f.commit(&input).unwrap(), first);
    assert_eq!(
        f.book("whiteboard", "book").book_rev,
        first["book"]["book_rev"]
    );
    let mut reuse = input.clone();
    reuse.record.as_mut().unwrap().value["title"] = json!("changed");
    assert_eq!(
        f.commit(&reuse).unwrap_err().body["status"],
        "upload_id_reused"
    );
    assert_eq!(get_commit(&f.conn, &input.upload_id).unwrap(), Some(first));
    assert!(get_commit(&f.conn, &id(99)).unwrap().is_none());
}

#[test]
fn different_pages_both_land_without_global_head_cas_same_page_conflicts() {
    let f = Fixture::new();
    create(&f, 1, "whiteboard", "book");
    let mut left = pages_request(2, "whiteboard", "book");
    let mut right = pages_request(3, "whiteboard", "book");
    stage(&f, &mut left, "book", 1, 0, "left", true);
    stage(&f, &mut right, "book", 2, 0, "right", true);
    f.commit(&left).unwrap();
    let result = f.commit(&right).unwrap();
    assert_eq!(result["book"]["pages"].as_array().unwrap().len(), 2);
    let mut same = pages_request(4, "whiteboard", "book");
    stage(&f, &mut same, "book", 1, 0, "competing", true);
    let error = f.commit(&same).unwrap_err();
    assert_eq!(error.status, 409);
    assert_eq!(error.body["pages"][0]["page_id"], 1);
}

#[test]
fn semantic_record_and_page_noops_keep_revisions_heads_and_history() {
    let f = Fixture::new();
    let mut initial = request(1, "whiteboard", "book");
    stage(&f, &mut initial, "book", 1, 0, "one", true);
    f.commit(&initial).unwrap();
    let before = f.book("whiteboard", "book");
    let mut input = request(2, "whiteboard", "book");
    input.record = Some(CommitRecord {
        base_rev: before.record_rev,
        value: before.record.clone().unwrap(),
    });
    input.record.as_mut().unwrap().value["board"]["appState"] = json!({"zoom":3,"scrollX":20});
    stage(&f, &mut input, "book", 1, before.pages[0].rev, "one", true);
    let after = f.commit(&input).unwrap();
    assert_eq!(after["book"]["book_rev"], before.book_rev);
    assert_eq!(after["record_rev"], before.record_rev);
    assert_eq!(after["page_revs"][0]["rev"], before.pages[0].rev);
    assert_eq!(revision_count(&f.conn, "whiteboard", "book").unwrap(), 0);
}

#[test]
fn stale_delete_after_page_only_commit_preserves_ink_and_atomic_restore_wins_late_delete() {
    let f = Fixture::new();
    let before = create(&f, 1, "whiteboard", "book");
    let mut ink = pages_request(2, "whiteboard", "book");
    stage(&f, &mut ink, "book", 1, 0, "kept", true);
    f.commit(&ink).unwrap();
    let stale = delete_request(3, "whiteboard", "book", before.book_rev, 1);
    assert_eq!(f.commit(&stale).unwrap_err().status, 409);
    assert_eq!(f.book("whiteboard", "book").pages.len(), 1);
    let live = f.book("whiteboard", "book");
    let deletion = delete_request(4, "whiteboard", "book", live.book_rev, 1);
    f.commit(&deletion).unwrap();
    let gone = f.book("whiteboard", "book");
    assert_eq!(gone.state, "gone");
    assert!(gone.pages.is_empty());
    let mut update = pages_request(5, "whiteboard", "book");
    stage(&f, &mut update, "book", 1, 0, "late", true);
    assert_eq!(f.commit(&update).unwrap_err().status, 410);
    let mut restore = request(6, "whiteboard", "book");
    restore.action = "restore".into();
    restore.base_book_rev = Some(gone.book_rev);
    restore.gone_seq = Some(1);
    restore.seq = Some(2);
    stage(&f, &mut restore, "book", 1, 0, "kept", true);
    f.commit(&restore).unwrap();
    let restored = f.book("whiteboard", "book");
    assert_eq!(restored.state, "live");
    assert!(restored.book_rev > gone.book_rev);
    assert_eq!(restored.pages.len(), 1);
    let late_delete = delete_request(7, "whiteboard", "book", gone.book_rev, 1);
    assert_eq!(f.commit(&late_delete).unwrap_err().status, 409);
    assert_eq!(f.book("whiteboard", "book").book_rev, restored.book_rev);
}

#[test]
fn invalid_foreign_duplicate_orphan_and_problem_pages_never_publish() {
    let f = Fixture::new();
    let mut foreign = request(1, "whiteboard", "book");
    foreign.record.as_mut().unwrap().value["id"] = json!("other");
    assert_eq!(f.commit(&foreign).unwrap_err().status, 400);
    let mut foreign_page = request(2, "whiteboard", "book");
    stage(&f, &mut foreign_page, "other", 1, 0, "foreign", true);
    assert_eq!(f.commit(&foreign_page).unwrap_err().status, 400);
    let mut duplicate = request(3, "whiteboard", "book");
    stage(&f, &mut duplicate, "book", 1, 0, "one", true);
    duplicate.pages.push(duplicate.pages[0].clone());
    assert_eq!(f.commit(&duplicate).unwrap_err().status, 400);
    let orphan = pages_request(4, "whiteboard", "book");
    assert_eq!(f.commit(&orphan).unwrap_err().status, 422);
    let mut problem = request(5, "problem", "leetcode/one");
    problem.pages.push(CommitPage {
        key: "leetcode/one".into(),
        page_id: 1,
        base_rev: 0,
        hash: "0".repeat(64),
    });
    assert_eq!(f.commit(&problem).unwrap_err().status, 400);
    assert_eq!(f.book("whiteboard", "book").state, "absent");
    f.commit(&request(6, "problem", "leetcode/one")).unwrap();
    assert_eq!(f.book("problem", "leetcode/one").state, "live");
}

#[test]
fn staged_extras_never_leak_and_bad_ink_is_rejected() {
    let f = Fixture::new();
    let input = request(1, "whiteboard", "book");
    stage_ink(
        &f.conn,
        &input.upload_id,
        "whiteboard",
        "other",
        1,
        &BASE64.encode(packed("extra", true)),
    )
    .unwrap()
    .unwrap();
    assert!(get_ink_pages(&f.conn, "whiteboard", "other")
        .unwrap()
        .is_empty());
    assert!(list_ink_digests(&f.conn, 0).unwrap().is_empty());
    f.commit(&input).unwrap();
    assert!(get_ink_pages(&f.conn, "whiteboard", "other")
        .unwrap()
        .is_empty());
    assert_eq!(
        stage_ink(
            &f.conn,
            &id(2),
            "whiteboard",
            "book",
            1,
            &BASE64.encode(b"bad")
        )
        .unwrap()
        .unwrap_err()
        .status,
        400
    );
    assert_eq!(
        stage_ink(
            &f.conn,
            "not-uuid",
            "whiteboard",
            "book",
            1,
            &BASE64.encode(packed("", false))
        )
        .unwrap()
        .unwrap_err()
        .status,
        400
    );
}

#[test]
fn conditional_reads_and_final_head_check_reject_interleaved_publication() {
    let f = Fixture::new();
    let mut initial = request(1, "whiteboard", "book");
    stage(&f, &mut initial, "book", 1, 0, "old", true);
    f.commit(&initial).unwrap();
    let old = f.book("whiteboard", "book");
    assert!(get_conditional_ink(
        &f.conn,
        "whiteboard",
        "book",
        1,
        old.book_rev,
        old.pages[0].rev
    )
    .unwrap()
    .is_ok());
    let mut change = pages_request(2, "whiteboard", "book");
    stage(&f, &mut change, "book", 1, old.pages[0].rev, "new", true);
    f.commit(&change).unwrap();
    assert_eq!(
        get_conditional_ink(
            &f.conn,
            "whiteboard",
            "book",
            1,
            old.book_rev,
            old.pages[0].rev
        )
        .unwrap()
        .unwrap_err()
        .status,
        409
    );
    assert_eq!(
        check_book_head(&f.conn, "whiteboard", "book", old.book_rev)
            .unwrap()
            .unwrap_err()
            .status,
        409
    );
    let latest = f.book("whiteboard", "book");
    assert!(
        check_book_head(&f.conn, "whiteboard", "book", latest.book_rev)
            .unwrap()
            .is_ok()
    );
}

#[test]
fn legacy_preparent_rows_are_disclosed_readable_and_reconciled() {
    let f = Fixture::new();
    let bytes = packed("preparent", true);
    let row:InkPageRow=serde_json::from_value(json!({"kind":"whiteboard","key":"book","page_id":1,"updated_at":123,"gz":BASE64.encode(&bytes)})).unwrap();
    put_ink_page_with_clock(&f.conn, &row, &TestClock(500)).unwrap();
    let unpublished = f.book("whiteboard", "book");
    assert_eq!(unpublished.state, "absent");
    assert!(unpublished.retained_unpublished && unpublished.book_rev > 0);
    assert_eq!(unpublished.pages.len(), 1);
    assert!(get_conditional_ink(
        &f.conn,
        "whiteboard",
        "book",
        1,
        unpublished.book_rev,
        unpublished.pages[0].rev
    )
    .unwrap()
    .is_ok());
    let mut creation = request(1, "whiteboard", "book");
    stage(
        &f,
        &mut creation,
        "book",
        1,
        unpublished.pages[0].rev,
        "preparent",
        true,
    );
    f.commit(&creation).unwrap();
    assert_eq!(
        f.book("whiteboard", "book").pages[0].rev,
        unpublished.pages[0].rev
    );
}

fn scratch_record() -> Value {
    let mut value = record("annotate", "book");
    value["footnote_boards"] = json!({"scratch":{"board":{"v":1,"elements":[]},"pageCount":2}});
    value
}
#[test]
fn footnote_removal_rejects_new_shard_both_before_and_after_removal() {
    let f = Fixture::new();
    let mut initial = request(1, "annotate", "book");
    initial.record.as_mut().unwrap().value = scratch_record();
    stage(&f, &mut initial, "book/fn/scratch", 1, 0, "one", true);
    f.commit(&initial).unwrap();
    let base = f.book("annotate", "book");
    let mut removal = request(2, "annotate", "book");
    removal.record = Some(CommitRecord {
        base_rev: base.record_rev,
        value: record("annotate", "book"),
    });
    stage(
        &f,
        &mut removal,
        "book/fn/scratch",
        1,
        base.pages[0].rev,
        "empty",
        false,
    );
    let mut arrival = pages_request(3, "annotate", "book");
    stage(&f, &mut arrival, "book/fn/scratch", 2, 0, "new shard", true);
    f.commit(&arrival).unwrap();
    let error = f.commit(&removal).unwrap_err();
    assert_eq!(error.status, 409);
    assert_eq!(error.body["status"], "dependency_conflict");
    assert_eq!(error.body["pages"][0]["page_id"], 2);
    assert!(
        f.book("annotate", "book").record.unwrap()["footnote_boards"]
            .get("scratch")
            .is_some()
    );
    let newest = f.book("annotate", "book");
    stage(
        &f,
        &mut removal,
        "book/fn/scratch",
        2,
        newest
            .pages
            .iter()
            .find(|page| page.page_id == 2)
            .unwrap()
            .rev,
        "empty",
        false,
    );
    f.commit(&removal).unwrap();
    let mut delayed = pages_request(4, "annotate", "book");
    stage(&f, &mut delayed, "book/fn/scratch", 3, 0, "delayed", true);
    assert_eq!(
        f.commit(&delayed).unwrap_err().body["status"],
        "footnote_removed"
    );
    assert_eq!(f.book("annotate", "book").pages.len(), 2);
}

#[test]
fn missing_source_cap_and_database_failure_roll_back_book_and_receipt() {
    let f = Fixture::new();
    let mut pdf = request(1, "annotate", "book");
    pdf.record.as_mut().unwrap().value["doc_type"] = json!("pdf");
    stage(&f, &mut pdf, "book", 1, 0, "ink", true);
    assert_eq!(
        f.commit(&pdf).unwrap_err().body["status"],
        "invalid_dependency"
    );
    assert_eq!(f.book("annotate", "book").state, "absent");
    put_blob(f.dir.path(), "source-id", b"pdf bytes").unwrap();
    f.commit(&pdf).unwrap();
    f.conn.execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON commits BEGIN SELECT RAISE(ABORT,'receipt fault'); END;").unwrap();
    let mut broken = request(2, "whiteboard", "new");
    stage(&f, &mut broken, "new", 1, 0, "kept staged", true);
    assert!(commit_pad_with_context(&f.conn, &broken, &TestClock(10_000), f.dir.path()).is_err());
    assert_eq!(f.book("whiteboard", "new").state, "absent");
    assert!(get_commit(&f.conn, &broken.upload_id).unwrap().is_none());
    assert_eq!(list_staged(&f.conn, &broken.upload_id).unwrap().len(), 1);
}

#[test]
fn corrupt_historical_book_is_isolated_from_healthy_inventory() {
    let f = Fixture::new();
    create(&f, 1, "whiteboard", "bad");
    create(&f, 2, "whiteboard", "good");
    f.conn
        .execute(
            "UPDATE whiteboard SET board_json='not json' WHERE id='bad'",
            [],
        )
        .unwrap();
    assert!(format!(
        "{:#}",
        get_book_state(&f.conn, "whiteboard", "bad").unwrap_err()
    )
    .contains("unreadable book"));
    let inventory = list_book_inventory(&f.conn).unwrap();
    assert_eq!(inventory.len(), 2);
    assert_eq!(
        inventory.iter().find(|book| book["id"] == "bad").unwrap()["error"]["status"],
        "unreadable_content"
    );
    assert_eq!(
        inventory.iter().find(|book| book["id"] == "good").unwrap()["state"],
        "live"
    );
}

#[test]
fn sweep_expires_only_staging_and_receipts_at_most_hourly() {
    let f = Fixture::new();
    let initial = request(1, "whiteboard", "book");
    f.commit(&initial).unwrap();
    stage_ink(
        &f.conn,
        &id(2),
        "whiteboard",
        "book",
        1,
        &BASE64.encode(packed("stage", false)),
    )
    .unwrap()
    .unwrap();
    f.conn
        .execute("UPDATE ink_stage SET created_at=1", [])
        .unwrap();
    f.conn
        .execute("UPDATE commits SET committed_at=1", [])
        .unwrap();
    f.conn
        .execute("UPDATE meta SET value=0 WHERE key='last_sweep'", [])
        .unwrap();
    let before = f.book("whiteboard", "book");
    sweep_with_clock(&f.conn, &TestClock(700_000_000)).unwrap();
    assert!(list_staged(&f.conn, &id(2)).unwrap().is_empty());
    assert!(get_commit(&f.conn, &initial.upload_id).unwrap().is_none());
    assert_eq!(f.book("whiteboard", "book").book_rev, before.book_rev);
    stage_ink(
        &f.conn,
        &id(3),
        "whiteboard",
        "book",
        1,
        &BASE64.encode(packed("recent", false)),
    )
    .unwrap()
    .unwrap();
    f.conn
        .execute("UPDATE ink_stage SET created_at=1", [])
        .unwrap();
    sweep_with_clock(&f.conn, &TestClock(700_000_001)).unwrap();
    assert_eq!(list_staged(&f.conn, &id(3)).unwrap().len(), 1);
}

#[test]
fn modern_restore_requires_acquired_retained_revision_before_explicit_replacement() {
    let f = Fixture::new();
    let original = create(&f, 1, "whiteboard", "book");
    f.commit(&delete_request(
        2,
        "whiteboard",
        "book",
        original.book_rev,
        1,
    ))
    .unwrap();
    let retained = packed("legacy different ink", true);
    let row: InkPageRow =
        serde_json::from_value(json!({"kind":"whiteboard","key":"book","page_id":1,
        "updated_at":123,"sync_seq":2,"gz":BASE64.encode(&retained)}))
        .unwrap();
    put_ink_page_with_clock(&f.conn, &row, &TestClock(500)).unwrap();
    let gone = f.book("whiteboard", "book");
    assert_eq!(gone.state, "gone");
    assert!(gone.pages.is_empty());
    assert!(gone.record.is_none());
    assert_eq!(gone.record_rev, 0);
    assert_eq!(gone.gone_seq, Some(1));
    assert_eq!(gone.retained_restore_pages.len(), 1);
    let latent = &gone.retained_restore_pages[0];
    assert_eq!(latent.key, "book");
    assert_eq!(latent.page_id, 1);
    assert!(latent.rev > 0);
    assert_eq!(latent.hash, sync_content::wire_ink_hash(&retained).unwrap());
    let mut restoration = request(3, "whiteboard", "book");
    restoration.action = "restore".into();
    restoration.seq = Some(2);
    restoration.base_book_rev = Some(gone.book_rev);
    restoration.gone_seq = Some(1);
    stage(
        &f,
        &mut restoration,
        "book",
        1,
        0,
        "modern different ink",
        true,
    );
    let error = f.commit(&restoration).unwrap_err();
    assert_eq!(error.status, 409);
    assert_eq!(error.body["status"], "conflict");
    assert_eq!(error.body["pages"][0]["hub_rev"], latent.rev);
    assert_eq!(
        get_ink_page(&f.conn, "whiteboard", "book", 1)
            .unwrap()
            .unwrap()
            .gz,
        BASE64.encode(&retained)
    );
    assert_eq!(f.book("whiteboard", "book").book_rev, gone.book_rev);
    assert!(get_commit(&f.conn, &restoration.upload_id)
        .unwrap()
        .is_none());
    let acquired = get_conditional_ink(&f.conn, "whiteboard", "book", 1, gone.book_rev, latent.rev)
        .unwrap()
        .unwrap();
    assert_eq!(acquired.gz, BASE64.encode(&retained));
    assert_eq!(
        get_conditional_ink(&f.conn, "whiteboard", "book", 1, gone.book_rev, 0)
            .unwrap()
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(
        get_conditional_ink(&f.conn, "whiteboard", "book", 2, gone.book_rev, 0)
            .unwrap()
            .unwrap_err()
            .status,
        404
    );
    restoration.pages[0].base_rev = acquired.rev;
    f.commit(&restoration).unwrap();
    let restored = f.book("whiteboard", "book");
    assert_eq!(restored.state, "live");
    assert!(restored.retained_restore_pages.is_empty());
    assert!(serde_json::to_value(&restored)
        .unwrap()
        .get("retained_restore_pages")
        .is_none());
    assert_eq!(
        get_ink_page(&f.conn, "whiteboard", "book", 1)
            .unwrap()
            .unwrap()
            .gz,
        BASE64.encode(packed("modern different ink", true))
    );
    assert!(restored.pages[0].rev > acquired.rev);
}

#[test]
fn identical_complete_legacy_restore_ink_can_be_republished_without_loss() {
    let f = Fixture::new();
    let original = create(&f, 1, "whiteboard", "book");
    f.commit(&delete_request(
        2,
        "whiteboard",
        "book",
        original.book_rev,
        1,
    ))
    .unwrap();
    let row: InkPageRow =
        serde_json::from_value(json!({"kind":"whiteboard","key":"book","page_id":1,
        "updated_at":123,"sync_seq":2,"gz":BASE64.encode(packed("same",true))}))
        .unwrap();
    put_ink_page_with_clock(&f.conn, &row, &TestClock(500)).unwrap();
    let gone = f.book("whiteboard", "book");
    let mut restore = request(3, "whiteboard", "book");
    restore.action = "restore".into();
    restore.seq = Some(2);
    restore.base_book_rev = Some(gone.book_rev);
    restore.gone_seq = Some(1);
    let retained_rev = gone.retained_restore_pages[0].rev;
    stage(&f, &mut restore, "book", 1, retained_rev, "same", true);
    f.commit(&restore).unwrap();
    let after = f.book("whiteboard", "book");
    assert_eq!(after.state, "live");
    assert_eq!(after.pages[0].rev, retained_rev);
    assert_eq!(
        get_ink_page(&f.conn, "whiteboard", "book", 1)
            .unwrap()
            .unwrap()
            .gz,
        row.gz
    );
}

#[test]
fn retained_restore_capture_rejects_new_legacy_ink_without_replacing_either_version() {
    let f = Fixture::new();
    let original = create(&f, 1, "whiteboard", "book");
    f.commit(&delete_request(
        2,
        "whiteboard",
        "book",
        original.book_rev,
        1,
    ))
    .unwrap();
    legacy_restore_page(&f, "whiteboard", "book", 1, 100, "captured", true);
    let captured = f.book("whiteboard", "book");
    let page = &captured.retained_restore_pages[0];
    let acquired = get_conditional_ink(
        &f.conn,
        "whiteboard",
        "book",
        1,
        captured.book_rev,
        page.rev,
    )
    .unwrap()
    .unwrap();
    assert_eq!(acquired.gz, BASE64.encode(packed("captured", true)));
    let mut restore = restore_request(3, &captured);
    stage(
        &f,
        &mut restore,
        "book",
        1,
        page.rev,
        "explicit alternative",
        true,
    );

    legacy_restore_page(&f, "whiteboard", "book", 1, 101, "later legacy", true);
    let newer = f.book("whiteboard", "book");
    assert!(newer.book_rev > captured.book_rev);
    assert!(newer.retained_restore_pages[0].rev > page.rev);
    assert_eq!(
        get_conditional_ink(
            &f.conn,
            "whiteboard",
            "book",
            1,
            captured.book_rev,
            page.rev
        )
        .unwrap()
        .unwrap_err()
        .status,
        409
    );
    let error = f.commit(&restore).unwrap_err();
    assert_eq!(error.status, 409);
    assert_eq!(error.body["status"], "lifecycle_conflict");
    assert_eq!(f.book("whiteboard", "book").book_rev, newer.book_rev);
    assert_eq!(
        get_ink_page(&f.conn, "whiteboard", "book", 1)
            .unwrap()
            .unwrap()
            .gz,
        BASE64.encode(packed("later legacy", true))
    );
    assert!(get_commit(&f.conn, &restore.upload_id).unwrap().is_none());
    assert_eq!(list_staged(&f.conn, &restore.upload_id).unwrap().len(), 1);
}

#[test]
fn complete_restore_accounts_for_empty_and_footnote_retained_pages_without_cross_book_mutation() {
    let f = Fixture::new();
    let original = create(&f, 1, "annotate", "book");
    f.commit(&delete_request(2, "annotate", "book", original.book_rev, 1))
        .unwrap();
    legacy_restore_page(&f, "annotate", "book", 1, 100, "primary", true);
    legacy_restore_page(&f, "annotate", "book/fn/child", 1, 100, "child", true);
    legacy_restore_page(
        &f,
        "annotate",
        "book/fn/child",
        2,
        100,
        "erased child",
        false,
    );
    legacy_restore_page(
        &f,
        "annotate",
        "book/fn/retired",
        0,
        100,
        "historic erasure",
        false,
    );
    let foreign = create(&f, 3, "annotate", "other");
    legacy_restore_page(&f, "annotate", "other/fn/child", 1, 100, "foreign", true);
    let foreign_page = get_ink_page(&f.conn, "annotate", "other/fn/child", 1)
        .unwrap()
        .unwrap();
    let gone = f.book("annotate", "book");
    assert_eq!(gone.retained_restore_pages.len(), 4);
    assert!(gone
        .retained_restore_pages
        .iter()
        .all(|page| !page.key.starts_with("other")));
    for page in &gone.retained_restore_pages {
        let read = get_conditional_ink(
            &f.conn,
            "annotate",
            &page.key,
            page.page_id,
            gone.book_rev,
            page.rev,
        )
        .unwrap()
        .unwrap();
        assert_eq!(read.hash.as_ref(), Some(&page.hash));
    }

    let mut incomplete = restore_request(4, &gone);
    incomplete.record.as_mut().unwrap().value["footnote_boards"] =
        json!({"child":{"board":{"v":1,"elements":[]},"pageCount":2}});
    let primary = gone
        .retained_restore_pages
        .iter()
        .find(|page| page.key == "book")
        .unwrap();
    stage(&f, &mut incomplete, "book", 1, primary.rev, "primary", true);
    let error = f.commit(&incomplete).unwrap_err();
    assert_eq!(error.status, 409);
    assert_eq!(error.body["status"], "retained_restore_conflict");
    let omitted = error.body["pages"].as_array().unwrap();
    assert_eq!(omitted.len(), 3);
    assert!(omitted
        .iter()
        .any(|page| page["key"] == "book/fn/child" && page["page_id"] == 2));
    assert!(omitted.iter().any(|page| page["key"] == "book/fn/retired"));
    assert_eq!(f.book("annotate", "book").book_rev, gone.book_rev);

    let mut foreign_request = restore_request(5, &gone);
    stage(
        &f,
        &mut foreign_request,
        "other/fn/child",
        1,
        foreign_page.rev,
        "foreign changed",
        true,
    );
    assert_eq!(f.commit(&foreign_request).unwrap_err().status, 400);
    assert_eq!(
        get_ink_page(&f.conn, "annotate", "other/fn/child", 1)
            .unwrap()
            .unwrap()
            .gz,
        foreign_page.gz
    );

    let mut complete = restore_request(6, &gone);
    complete.record.as_mut().unwrap().value["footnote_boards"] =
        incomplete.record.unwrap().value["footnote_boards"].clone();
    for page in &gone.retained_restore_pages {
        let (label, draw) = match (page.key.as_str(), page.page_id) {
            ("book", _) => ("explicit primary alternative", true),
            ("book/fn/child", 1) => ("child", true),
            ("book/fn/child", 2) => ("erased child", false),
            ("book/fn/retired", _) => ("historic erasure", false),
            _ => unreachable!(),
        };
        stage(
            &f,
            &mut complete,
            &page.key,
            page.page_id,
            page.rev,
            label,
            draw,
        );
    }
    // Nonempty retained ink still requires its restored child board.
    let mut orphan = complete.clone();
    orphan.record.as_mut().unwrap().value["footnote_boards"] = json!({});
    assert_eq!(
        f.commit(&orphan).unwrap_err().body["status"],
        "footnote_removed"
    );
    assert_eq!(f.book("annotate", "book").book_rev, gone.book_rev);
    f.commit(&complete).unwrap();
    let restored = f.book("annotate", "book");
    assert_eq!(restored.state, "live");
    assert_eq!(restored.pages.len(), 4);
    assert!(restored.retained_restore_pages.is_empty());
    for retained in gone
        .retained_restore_pages
        .iter()
        .filter(|page| page.key != "book")
    {
        assert!(restored.pages.iter().any(|page| page == retained));
    }
    assert_eq!(
        get_ink_page(&f.conn, "annotate", "other/fn/child", 1)
            .unwrap()
            .unwrap()
            .gz,
        foreign_page.gz
    );
    assert!(f.book("annotate", "other").book_rev > foreign.book_rev);
}

#[test]
fn corrupt_gone_retained_ink_is_reported_per_book_and_cannot_be_restored() {
    let f = Fixture::new();
    let original = create(&f, 1, "whiteboard", "book");
    f.commit(&delete_request(
        2,
        "whiteboard",
        "book",
        original.book_rev,
        1,
    ))
    .unwrap();
    let gone = f.book("whiteboard", "book");
    assert!(serde_json::to_value(&gone)
        .unwrap()
        .get("retained_restore_pages")
        .is_none());
    legacy_restore_page(&f, "whiteboard", "book", 1, 100, "retained", true);
    f.conn
        .execute(
            "UPDATE ink_pages SET gz=X'00' WHERE kind='whiteboard' AND key='book'",
            [],
        )
        .unwrap();
    assert!(get_book_state(&f.conn, "whiteboard", "book")
        .unwrap_err()
        .to_string()
        .contains("unreadable ink"));
    let inventory = list_book_inventory(&f.conn).unwrap();
    assert_eq!(inventory[0]["error"]["status"], "unreadable_content");
    assert_eq!(
        check_book_head(&f.conn, "whiteboard", "book", gone.book_rev)
            .unwrap()
            .unwrap_err()
            .status,
        422
    );
    assert_eq!(
        f.commit(&restore_request(3, &gone)).unwrap_err().status,
        422
    );
    assert!(get_commit(&f.conn, &id(3)).unwrap().is_none());
}

#[test]
fn modern_lifecycle_preserves_unicode_parent_footnotes_and_invalid_conditions_fail() {
    let f = Fixture::new();
    let key = "本";
    let child = "本/fn/笔";
    let mut initial = request(1, "annotate", key);
    initial.record.as_mut().unwrap().value["footnote_boards"] =
        json!({"笔":{"board":{"v":1,"elements":[]},"pageCount":1}});
    stage(&f, &mut initial, child, 1, 0, "owned", true);
    f.commit(&initial).unwrap();
    let before = f.book("annotate", key);
    assert_eq!(before.pages.len(), 1);
    assert_eq!(
        check_book_head(&f.conn, "annotate", key, -1)
            .unwrap()
            .unwrap_err()
            .status,
        400
    );
    assert_eq!(
        get_conditional_ink(&f.conn, "annotate", child, 1, before.book_rev, -1)
            .unwrap()
            .unwrap_err()
            .status,
        400
    );
    f.commit(&delete_request(2, "annotate", key, before.book_rev, 1))
        .unwrap();
    assert!(get_ink_pages(&f.conn, "annotate", child)
        .unwrap()
        .is_empty());
}

#[test]
fn unreadable_modern_protocol_results_are_explicit_422() {
    let f = Fixture::new();
    create(&f, 1, "whiteboard", "bad");
    f.conn
        .execute(
            "UPDATE whiteboard SET agent_json='broken' WHERE id='bad'",
            [],
        )
        .unwrap();
    assert_eq!(
        check_book_head(&f.conn, "whiteboard", "bad", 1)
            .unwrap()
            .unwrap_err()
            .status,
        422
    );
    assert_eq!(
        get_conditional_ink(&f.conn, "whiteboard", "bad", 1, 1, 1)
            .unwrap()
            .unwrap_err()
            .status,
        422
    );
    assert_eq!(
        f.commit(&pages_request(2, "whiteboard", "bad"))
            .unwrap_err()
            .status,
        422
    );
}
