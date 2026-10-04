
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
