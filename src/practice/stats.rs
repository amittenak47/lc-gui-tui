use anyhow::Result;
use comfy_table::Table;
use rusqlite::{params, Connection};

use crate::index::ProblemRow;
use crate::session::{ProblemState, Session};

#[derive(Debug, Default)]
pub struct Aggregate {
    pub total: u32,
    pub easy: u32,
    pub medium: u32,
    pub hard: u32,
    pub unknown_difficulty: u32,
    pub loaded: u32,
    pub passed: u32,
    pub failed: u32,
    pub untested: u32,
    pub total_cases: i64,
}

pub fn session(conn: &Connection, session: &Session) -> Result<()> {
    let rows = if let Some(name) = &session.active_list {
        list_rows(conn, name)?
    } else {
        all_rows(conn)?
    };

    let agg = aggregate_inner(&rows, Some(session));
    print_block(
        if let Some(name) = &session.active_list {
            format!("Session stats (list: {name})")
        } else {
            "Session stats (full corpus)".into()
        },
        &agg,
        session.started_at,
    );
    print_reveals(session);
    Ok(())
}

/// How often the whiteboard coach's reveal was tapped. Absent entirely when it
/// never was, so the usual output is unchanged.
fn print_reveals(session: &Session) {
    let revealed = session.revealed_problems();
    if revealed.is_empty() {
        return;
    }
    let total: u32 = revealed.iter().map(|(_, count)| count).sum();
    println!(
        "\n  reference revealed: {total} time{} across {} problem{}",
        if total == 1 { "" } else { "s" },
        revealed.len(),
        if revealed.len() == 1 { "" } else { "s" }
    );
    for (task_id, count) in revealed.iter().take(10) {
        println!("    {task_id} ×{count}");
    }
}

pub fn list(conn: &Connection, name: &str, session: Option<&Session>) -> Result<()> {
    let rows = list_rows(conn, name)?;
    let agg = aggregate_inner(&rows, session);
    print_block(format!("List stats: {name}"), &agg, 0);
    Ok(())
}

pub fn corpus(conn: &Connection) -> Result<()> {
    let rows = all_rows(conn)?;
    let agg = aggregate_inner(&rows, None);
    print_block("Corpus stats".into(), &agg, 0);
    Ok(())
}

pub fn aggregate_for_display(rows: &[ProblemRow], session: &Session) -> Aggregate {
    aggregate_inner(rows, Some(session))
}

fn aggregate_inner(rows: &[ProblemRow], session: Option<&Session>) -> Aggregate {
    let mut agg = Aggregate {
        total: rows.len() as u32,
        total_cases: rows.iter().map(|r| r.test_count).sum(),
        ..Default::default()
    };

    for row in rows {
        match row.difficulty.as_deref() {
            Some("Easy") => agg.easy += 1,
            Some("Medium") => agg.medium += 1,
            Some("Hard") => agg.hard += 1,
            _ => agg.unknown_difficulty += 1,
        }

        let Some(session) = session else {
            agg.untested += 1;
            continue;
        };

        match session.progress(&row.key()) {
            None => agg.untested += 1,
            Some(p) => match p.state {
                ProblemState::Loaded => agg.loaded += 1,
                ProblemState::Passed => agg.passed += 1,
                ProblemState::Failed => agg.failed += 1,
            },
        }
    }
    agg
}

fn print_block(title: String, agg: &Aggregate, started_at: u64) {
    println!("{title}");
    if started_at > 0 {
        println!("  started: {started_at}");
    }
    println!("  problems: {}", agg.total);
    println!(
        "  difficulty: Easy {} · Medium {} · Hard {} · other {}",
        agg.easy, agg.medium, agg.hard, agg.unknown_difficulty
    );
    println!("  test cases (sum): {}", agg.total_cases);
    if agg.loaded + agg.passed + agg.failed + agg.untested == agg.total && agg.total > 0 {
        println!(
            "  progress: {} passed · {} failed · {} loaded · {} not started",
            agg.passed, agg.failed, agg.loaded, agg.untested
        );
    }

    let mut table = Table::new();
    table.load_preset(comfy_table::presets::UTF8_FULL_CONDENSED);
    table.set_header(["metric", "count"]);
    table.add_row(["total", &agg.total.to_string()]);
    table.add_row(["Easy", &agg.easy.to_string()]);
    table.add_row(["Medium", &agg.medium.to_string()]);
    table.add_row(["Hard", &agg.hard.to_string()]);
    if agg.passed + agg.failed + agg.loaded > 0 {
        table.add_row(["passed", &agg.passed.to_string()]);
        table.add_row(["failed", &agg.failed.to_string()]);
        table.add_row(["loaded", &agg.loaded.to_string()]);
        table.add_row(["not started", &agg.untested.to_string()]);
    }
    println!("{table}");
}

fn all_rows(conn: &Connection) -> Result<Vec<ProblemRow>> {
    crate::index::search(
        conn,
        crate::dataset::default(),
        None,
        None,
        None,
        u32::MAX,
        false,
        crate::index::SearchSort::TaskId,
    )
}

fn list_rows(conn: &Connection, name: &str) -> Result<Vec<ProblemRow>> {
    let list_id: i64 = conn.query_row(
        "SELECT id FROM lists WHERE name = ?1",
        params![name],
        |r| r.get(0),
    )?;

    // Named lists belong to the default corpus — see `index::SHARED_SCHEMA`.
    let mut stmt = conn.prepare(
        "SELECT p.task_id, p.question_id, p.difficulty, p.tags, p.json_path, p.test_count \
         FROM list_items li \
         JOIN problems p ON p.task_id = li.task_id \
         WHERE li.list_id = ?1 \
         ORDER BY li.position",
    )?;
    let rows = stmt.query_map(params![list_id], crate::index::row_to_problem)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
