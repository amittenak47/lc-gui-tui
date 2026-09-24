use std::path::Path;
use whiteboard::{config::Config, dataset, generator, loader, problem};

/// Read-only diagnostic against an installed index; generated workspaces are
/// isolated in a temporary directory, never the user's practice workspace.
#[test]
#[ignore = "set LC_CORPUS_REVIEW_DB to an installed index"]
fn installed_corpus_samples_open() {
    let path = std::env::var("LC_CORPUS_REVIEW_DB").expect("installed index path");
    let conn = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let mut cfg = Config::default();
    cfg.workspace.dir = temp.path().display().to_string();
    for dataset in &dataset::DATASETS {
        let count: usize = conn.query_row(&format!("SELECT COUNT(*) FROM {}", dataset.table), [], |r| r.get(0)).unwrap();
        if count == 0 { continue; }
        for offset in [0, count / 2, count - 1] {
            let id: String = conn.query_row(&format!("SELECT task_id FROM {} ORDER BY task_id LIMIT 1 OFFSET ?1", dataset.table), [offset], |r| r.get(0)).unwrap();
            let row = loader::resolve_in(&conn, dataset, &id).unwrap();
            let start = std::time::Instant::now();
            let problem = problem::load_task_for(dataset, Path::new(&row.json_path), &id).unwrap_or_else(|err| panic!("{}/{id}: {err:#}", dataset.id));
            let dir = generator::generate(&cfg, dataset, &problem, Path::new(&row.json_path), false).unwrap_or_else(|err| panic!("generate {}/{id}: {err:#}", dataset.id));
            assert!(dir.join(".lc/meta.json").is_file());
            println!("{}/{id}: opened in {:?}", dataset.id, start.elapsed());
        }
    }
}
