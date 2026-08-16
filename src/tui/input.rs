use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use super::ascii_morph::{self, AsciiPlayer};
use crate::attempt;
use crate::dataset;
use crate::index::{self, SearchSort};
use crate::loader;
use crate::session::Session;

use super::app::{App, BrowseFilter, ListPickPurpose, Screen};
use super::{hard_refresh, PAGE_SIZE, TuiTerminal};

pub(crate) fn handle_key(app: &mut App, terminal: &mut TuiTerminal, key: KeyEvent) -> Result<bool> {
    if key.kind != KeyEventKind::Press {
        return Ok(false);
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return Ok(true);
    }

    if app.screen == Screen::InputId {
        return handle_input_id(app, key);
    }
    if app.screen == Screen::InputListName {
        return handle_input_list_name(app, key);
    }
    if app.screen == Screen::Message {
        return handle_message(app, key);
    }
    if app.screen == Screen::CoachChat {
        return handle_coach_chat(app, terminal, key);
    }
    if app.screen == Screen::AsciiAnim {
        return handle_ascii_anim(app, key);
    }
    if app.screen == Screen::Browse && app.browse_search_active {
        return handle_browse_search(app, key);
    }

    match key.code {
        KeyCode::Char('q') if app.screen == Screen::Main => return Ok(true),
        KeyCode::Esc => {
            match app.screen {
                Screen::Main => return Ok(true),
                Screen::ProblemActions => {
                    if app.workspace_needs_leave_prompt() {
                        if let Err(e) = app.begin_leave_confirm() {
                            app.status = format!("{e:#}");
                        }
                    } else {
                        app.screen = Screen::Browse;
                        app.menu_sel = 0;
                    }
                }
                Screen::LeaveConfirm => {
                    app.screen = Screen::ProblemActions;
                    app.menu_sel = 0;
                }
                Screen::CoachChat => {
                    app.screen = Screen::ProblemActions;
                    app.menu_sel = 0;
                }
                Screen::AsciiAnim => {
                    app.ascii_player = None;
                    app.screen = Screen::Main;
                    app.menu_sel = 0;
                }
                Screen::StartSession => app.screen = Screen::Main,
                Screen::ChooseProblems | Screen::DifficultyPick | Screen::ListPick => {
                    app.screen = Screen::StartSession;
                }
                Screen::Browse => app.screen = app.back_screen,
                Screen::Settings | Screen::Help => app.screen = Screen::Main,
                Screen::InputId => app.screen = app.back_screen,
                Screen::InputListName => app.screen = Screen::ListPick,
                Screen::Message => app.screen = app.back_screen,
            }
            if app.screen != Screen::LeaveConfirm {
                app.menu_sel = 0;
            }
        }
        KeyCode::Char('w') | KeyCode::Up => menu_up(app),
        KeyCode::Char('s') | KeyCode::Down => menu_down(app),
        KeyCode::Enter => {
            if activate(app, terminal)? {
                return Ok(true);
            }
        }
        KeyCode::Char('a') if app.screen == Screen::Browse => {
            if app.browse_page > 0 {
                app.browse_page -= 1;
                app.browse_sel = 0;
                app.reload_browse_page()?;
            }
        }
        KeyCode::Char('d') if app.screen == Screen::Browse => {
            let max_page = app.browse_total.saturating_sub(1) / PAGE_SIZE;
            if app.browse_page < max_page {
                app.browse_page += 1;
                app.browse_sel = 0;
                app.reload_browse_page()?;
            }
        }
        KeyCode::Char('t') if app.screen == Screen::Browse => app.cycle_tag()?,
        KeyCode::Char('e') if app.screen == Screen::Browse => app.cycle_difficulty()?,
        KeyCode::Char('o') if app.screen == Screen::Browse => app.cycle_sort()?,
        KeyCode::Char('g') if app.screen == Screen::Browse => app.cycle_dataset()?,
        KeyCode::Char('/') if app.screen == Screen::Browse => {
            app.browse_search_active = true;
            app.browse_search_buf = app
                .browse
                .slug_query
                .clone()
                .unwrap_or_default();
            app.status = "search: type filter · Enter apply · Esc cancel".into();
        }
        KeyCode::Char('i') if app.screen == Screen::Browse => {
            app.input_buf.clear();
            app.screen = Screen::InputId;
            app.back_screen = Screen::Browse;
        }
        KeyCode::Char('l') if app.screen == Screen::Browse => {
            if let Some(row) = app.browse_rows.get(app.browse_sel).cloned() {
                app.open_list_pick(
                    ListPickPurpose::AddTask {
                        task_id: row.task_id,
                    },
                    Screen::Browse,
                )?;
            }
        }
        KeyCode::Char('r') if app.screen == Screen::Browse => {
            app.open_list_pick(ListPickPurpose::AddRandom, Screen::Browse)?;
        }
        _ => {}
    }
    Ok(false)
}

fn handle_input_id(app: &mut App, key: KeyEvent) -> Result<bool> {
    if key.kind != KeyEventKind::Press {
        return Ok(false);
    }
    match key.code {
        KeyCode::Esc => {
            app.input_buf.clear();
            app.screen = app.back_screen;
        }
        KeyCode::Enter => {
            if let Err(e) = app.resolve_input_id() {
                app.status = format!("{e:#}");
            }
        }
        KeyCode::Backspace => {
            app.input_buf.pop();
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => app.input_buf.push(c),
        _ => {}
    }
    Ok(false)
}

fn handle_browse_search(app: &mut App, key: KeyEvent) -> Result<bool> {
    if key.kind != KeyEventKind::Press {
        return Ok(false);
    }
    match key.code {
        KeyCode::Esc => {
            app.browse_search_active = false;
            app.browse_search_buf = app
                .browse
                .slug_query
                .clone()
                .unwrap_or_default();
            app.status = "search cancelled".into();
        }
        KeyCode::Enter => {
            if let Err(e) = app.apply_browse_search() {
                app.status = format!("{e:#}");
            }
        }
        KeyCode::Backspace => {
            app.browse_search_buf.pop();
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.browse_search_buf.push(c);
        }
        _ => {}
    }
    Ok(false)
}

fn handle_input_list_name(app: &mut App, key: KeyEvent) -> Result<bool> {
    if key.kind != KeyEventKind::Press {
        return Ok(false);
    }
    match key.code {
        KeyCode::Esc => {
            app.input_buf.clear();
            app.screen = Screen::ListPick;
        }
        KeyCode::Enter => {
            if let Err(e) = app.resolve_input_list_name() {
                app.status = format!("{e:#}");
            }
        }
        KeyCode::Backspace => {
            app.input_buf.pop();
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => app.input_buf.push(c),
        _ => {}
    }
    Ok(false)
}

fn handle_message(app: &mut App, key: KeyEvent) -> Result<bool> {
    if key.kind != KeyEventKind::Press {
        return Ok(false);
    }
    match key.code {
        KeyCode::Esc | KeyCode::Enter => {
            app.screen = Screen::ProblemActions;
        }
        KeyCode::Char('w') | KeyCode::Up => {
            app.message_scroll = app.message_scroll.saturating_sub(1);
        }
        KeyCode::Char('s') | KeyCode::Down => {
            if app.message_scroll + 1 < app.message_lines.len() {
                app.message_scroll += 1;
            }
        }
        _ => {}
    }
    Ok(false)
}

fn handle_coach_chat(
    app: &mut App,
    terminal: &mut TuiTerminal,
    key: KeyEvent,
) -> Result<bool> {
    if key.kind != KeyEventKind::Press {
        return Ok(false);
    }
    match key.code {
        KeyCode::Esc => {
            if let Ok(dir) = app.workspace_dir() {
                let _ = app.persist_coach(&dir);
            }
            app.ascii_player = None;
            app.ascii_msg_id = None;
            app.screen = Screen::ProblemActions;
            app.menu_sel = 0;
            app.input_buf.clear();
            // Coach chat can leave wrap/mouse-scroll ghosts on the alternate
            // screen; wipe before the problem menu draws.
            hard_refresh(terminal)?;
        }
        KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.coach_draw = !app.coach_draw;
            app.status = format!(
                "draw {} — next reply will {} ASCII morph",
                if app.coach_draw { "ON" } else { "OFF" },
                if app.coach_draw { "include" } else { "skip" }
            );
        }
        KeyCode::Char(' ') | KeyCode::Char('r')
            if key.modifiers.contains(KeyModifiers::CONTROL) =>
        {
            if let Some(player) = app.ascii_player.as_mut() {
                player.restart();
                app.status = "animation restarted".into();
            }
        }
        KeyCode::Enter => {
            if let Err(e) = app.send_coach_message(terminal) {
                app.status = format!("{e:#}");
                let _ = hard_refresh(terminal);
            }
        }
        KeyCode::Backspace => {
            app.input_buf.pop();
        }
        // Avoid Ctrl+W / Ctrl+S — terminals often bind those (close tab / freeze).
        KeyCode::Up => {
            app.coach_scroll = app.coach_scroll.saturating_sub(1);
        }
        KeyCode::Down => {
            app.coach_scroll = app.coach_scroll.saturating_add(1);
        }
        KeyCode::PageUp => {
            app.coach_scroll = app.coach_scroll.saturating_sub(10);
        }
        KeyCode::PageDown => {
            app.coach_scroll = app.coach_scroll.saturating_add(10);
        }
        KeyCode::Home => {
            app.coach_scroll = 0;
        }
        KeyCode::End => {
            // draw_coach_chat clamps to the real max on the next frame.
            app.coach_scroll = usize::MAX / 4;
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.input_buf.push(c);
        }
        _ => {}
    }
    Ok(false)
}

fn handle_ascii_anim(app: &mut App, key: KeyEvent) -> Result<bool> {
    if key.kind != KeyEventKind::Press {
        return Ok(false);
    }
    match key.code {
        KeyCode::Esc => {
            app.ascii_player = None;
            app.screen = Screen::Main;
            app.menu_sel = 0;
            app.status = "WASD navigate · Enter select · Esc back · q quit".into();
        }
        KeyCode::Char(' ') | KeyCode::Char('r') => {
            if let Some(player) = app.ascii_player.as_mut() {
                player.restart();
            }
            app.status = "restarted · Space/r again · Esc back".into();
        }
        _ => {}
    }
    Ok(false)
}

fn menu_up(app: &mut App) {
    if app.screen == Screen::Browse {
        if app.browse_sel > 0 {
            app.browse_sel -= 1;
        }
        return;
    }
    if app.menu_sel > 0 {
        app.menu_sel -= 1;
    }
}

fn menu_down(app: &mut App) {
    let max = menu_len(app).saturating_sub(1);
    if app.screen == Screen::Browse {
        if app.browse_sel < app.browse_rows.len().saturating_sub(1) {
            app.browse_sel += 1;
        }
        return;
    }
    if app.menu_sel < max {
        app.menu_sel += 1;
    }
}

fn menu_len(app: &App) -> usize {
    match app.screen {
        Screen::Main => 6,
        Screen::StartSession => 6,
        Screen::ChooseProblems => 3,
        Screen::DifficultyPick => 4,
        Screen::ListPick => app.list_names.len() + 2,
        Screen::Browse => app.browse_rows.len(),
        Screen::ProblemActions => 10,
        Screen::LeaveConfirm => 3,
        Screen::Settings => 7,
        Screen::Help => 1,
        Screen::InputId | Screen::InputListName | Screen::Message | Screen::CoachChat | Screen::AsciiAnim => 0,
    }
}

fn activate(app: &mut App, terminal: &mut TuiTerminal) -> Result<bool> {
    match app.screen {
        Screen::Main => match app.menu_sel {
            0 => {
                app.session = Session::reset()?;
                app.screen = Screen::StartSession;
                app.menu_sel = 0;
                app.status = "new session started".into();
            }
            1 => {
                app.open_browse(
                    BrowseFilter {
                        difficulty: None,
                        tag_index: 0,
                        list_name: None,
                        slug_query: None,
                    },
                    Screen::Main,
                )?;
            }
            2 => {
                app.screen = Screen::Settings;
                app.menu_sel = 0;
            }
            3 => {
                app.screen = Screen::Help;
                app.menu_sel = 0;
            }
            4 => {
                app.ascii_player = Some(AsciiPlayer::new(ascii_morph::bubble_sort_demo()));
                app.screen = Screen::AsciiAnim;
                app.status = "ASCII morph demo · Space restart · Esc back".into();
            }
            5 => return Ok(true),
            _ => return Ok(false),
        },
        Screen::StartSession => match app.menu_sel {
            0 => {
                app.open_browse(
                    BrowseFilter {
                        difficulty: None,
                        tag_index: 0,
                        list_name: None,
                        slug_query: None,
                    },
                    Screen::StartSession,
                )?;
            }
            1 => {
                app.screen = Screen::DifficultyPick;
                app.difficulty_pick_for = Screen::StartSession;
                app.menu_sel = 0;
            }
            2 => {
                app.open_list_pick(ListPickPurpose::LoadSession, Screen::StartSession)?;
            }
            3 => {
                app.input_buf.clear();
                app.back_screen = Screen::StartSession;
                app.screen = Screen::InputId;
            }
            4 => show_session_stats(app)?,
            _ => {
                app.screen = Screen::Main;
                app.menu_sel = 0;
            }
        },
        Screen::ChooseProblems => match app.menu_sel {
            0 => {
                app.open_browse(
                    BrowseFilter {
                        difficulty: None,
                        tag_index: 0,
                        list_name: None,
                        slug_query: None,
                    },
                    Screen::ChooseProblems,
                )?;
            }
            1 => {
                app.input_buf.clear();
                app.back_screen = Screen::ChooseProblems;
                app.screen = Screen::InputId;
            }
            2 => {
                app.screen = Screen::DifficultyPick;
                app.difficulty_pick_for = Screen::ChooseProblems;
                app.menu_sel = 0;
            }
            _ => {
                app.screen = Screen::StartSession;
                app.menu_sel = 0;
            }
        },
        Screen::DifficultyPick => {
            let diff = match app.menu_sel {
                0 => None,
                1 => Some("Easy".into()),
                2 => Some("Medium".into()),
                3 => Some("Hard".into()),
                _ => None,
            };
            if app.difficulty_pick_for == Screen::StartSession {
                app.browse.difficulty = diff;
                app.pick_random()?;
            } else {
                app.open_browse(
                    BrowseFilter {
                        difficulty: diff,
                        tag_index: 0,
                        list_name: None,
                        slug_query: None,
                    },
                    Screen::ChooseProblems,
                )?;
            }
        }
        Screen::ListPick => {
            let create_idx = app.list_names.len();
            let back_idx = app.list_names.len() + 1;
            if app.menu_sel == back_idx {
                app.screen = app.back_screen;
                app.menu_sel = 0;
                return Ok(false);
            }
            if app.menu_sel == create_idx {
                app.input_buf.clear();
                app.screen = Screen::InputListName;
                return Ok(false);
            }
            let name = app.list_names[app.menu_sel].clone();
            match app.list_pick_purpose.clone() {
                ListPickPurpose::LoadSession => {
                    app.session.set_active_list(Some(name.clone()))?;
                    app.session = Session::load_or_new()?;
                    let rows =
                        index::list_problem_rows(&app.conn, &name, SearchSort::Question)?;
                    for row in &rows {
                        app.session.add_to_queue(&row.task_id)?;
                    }
                    app.open_browse(
                        BrowseFilter {
                            difficulty: None,
                            tag_index: 0,
                            list_name: Some(name),
                            slug_query: None,
                        },
                        Screen::StartSession,
                    )?;
                    app.status = format!("list loaded ({} problems)", app.browse_total);
                }
                ListPickPurpose::AddTask { task_id } => {
                    if let Err(e) = app.add_task_to_list(&name, &task_id) {
                        app.status = format!("{e:#}");
                    }
                    app.screen = app.back_screen;
                }
                ListPickPurpose::AddRandom => {
                    if let Err(e) = app.random_add_to_list(&name) {
                        app.status = format!("{e:#}");
                    }
                    app.screen = app.back_screen;
                }
            }
        }
        Screen::Browse => {
            if let Some(row) = app.browse_rows.get(app.browse_sel).cloned() {
                app.session.add_to_queue(&row.task_id)?;
                app.selected_problem = Some(row);
                app.screen = Screen::ProblemActions;
                app.menu_sel = 0;
            }
        }
        Screen::ProblemActions => match app.menu_sel {
            0 => {
                if let Err(e) = app.open_problem_target("canvas") {
                    app.status = format!("{e:#}");
                }
            }
            1 => {
                if let Err(e) = app.open_problem_target("ide") {
                    app.status = format!("{e:#}");
                }
            }
            2 => {
                if let Err(e) = app.edit_solution(terminal) {
                    app.status = format!("{e:#}");
                }
            }
            3 => {
                if let Err(e) = app.open_workspace_folder() {
                    app.status = format!("{e:#}");
                }
            }
            4 => {
                if let Err(e) = app.open_problem_target("tui") {
                    app.status = format!("{e:#}");
                }
            }
            5 => {
                if let Err(e) = app.run_tests("run") {
                    app.status = format!("{e:#}");
                }
                let _ = hard_refresh(terminal);
                if app.coach_messages.iter().any(|m| {
                    m.get("role").and_then(|v| v.as_str()) == Some("app")
                }) {
                    // Reload thread and show coach so the Tests bubble is visible.
                    if let Ok(dir) = app.workspace_dir() {
                        app.coach_messages = attempt::read_tui_agent(&dir)
                            .map(|s| s.messages)
                            .unwrap_or_default();
                    }
                    app.screen = Screen::CoachChat;
                    app.input_buf.clear();
                    app.coach_scroll = 0;
                }
            }
            6 => {
                if let Err(e) = app.open_coach_chat() {
                    app.status = format!("{e:#}");
                }
            }
            7 => {
                if let Err(e) = app.submit_locally() {
                    app.status = format!("{e:#}");
                }
                let _ = hard_refresh(terminal);
            }
            8 => {
                if let Some(row) = app.selected_problem.clone() {
                    app.open_list_pick(
                        ListPickPurpose::AddTask {
                            task_id: row.task_id,
                        },
                        Screen::ProblemActions,
                    )?;
                }
            }
            _ => {
                if app.workspace_needs_leave_prompt() {
                    if let Err(e) = app.begin_leave_confirm() {
                        app.status = format!("{e:#}");
                    }
                } else {
                    app.screen = Screen::Browse;
                    app.menu_sel = 0;
                }
            }
        },
        Screen::LeaveConfirm => match app.menu_sel {
            0 => {
                if let Err(e) = app.confirm_leave(true) {
                    app.status = format!("{e:#}");
                }
            }
            1 => {
                if let Err(e) = app.confirm_leave(false) {
                    app.status = format!("{e:#}");
                }
            }
            _ => {
                app.screen = Screen::ProblemActions;
                app.menu_sel = 0;
            }
        },
        Screen::Settings => match app.menu_sel {
            0 => app.status = format!("config: {}", crate::config::config_path()?.display()),
            1 => {
                app.status = format!(
                    "data={} · workspace={}",
                    app.cfg.data.json_dir.as_deref().unwrap_or("(unset)"),
                    app.cfg.workspace.dir,
                );
            }
            2 => {
                match crate::llm::lifecycle::start_local_llm(&app.cfg) {
                    Ok(st) => app.status = st.detail,
                    Err(e) => app.status = format!("{e:#}"),
                }
            }
            3 => {
                match crate::llm::lifecycle::stop_local_llm(&app.cfg) {
                    Ok(st) => app.status = st.detail,
                    Err(e) => app.status = format!("{e:#}"),
                }
            }
            4 => {
                let st = crate::llm::lifecycle::status(&app.cfg);
                app.status = format!("{} · {}", st.detail, st.base_url);
            }
            5 => {
                app.session = Session::reset()?;
                app.status = "session reset".into();
            }
            _ => {
                app.screen = Screen::Main;
                app.menu_sel = 0;
            }
        },
        Screen::Help => {
            app.screen = Screen::Main;
            app.menu_sel = 0;
        }
        Screen::InputId | Screen::InputListName | Screen::Message | Screen::CoachChat | Screen::AsciiAnim => {}
    }
    Ok(false)
}
fn show_session_stats(app: &mut App) -> Result<()> {
    use crate::stats::{self, Aggregate};
    let rows = if let Some(name) = &app.session.active_list {
        index::list_problem_rows(&app.conn, name, SearchSort::Question)?
    } else {
        // Queue entries are `dataset/task_id`, so each is resolved in its own
        // corpus rather than searched for in whichever tab is open.
        app.session
            .queue
            .iter()
            .filter_map(|key| {
                let (dataset_id, task_id) = dataset::split_key(key);
                let dataset = dataset::get(dataset_id).ok()?;
                loader::resolve_in(&app.conn, dataset, task_id).ok()
            })
            .collect()
    };
    let agg: Aggregate = stats::aggregate_for_display(&rows, &app.session);
    app.message_lines = vec![
        format!("problems in scope: {}", agg.total),
        format!("Easy {} · Medium {} · Hard {}", agg.easy, agg.medium, agg.hard),
        format!(
            "session: {} passed · {} failed · {} loaded · {} not started",
            agg.passed, agg.failed, agg.loaded, agg.untested
        ),
        format!("queue: {} problems", app.session.queue.len()),
        format!("test cases (sum): {}", agg.total_cases),
    ];
    app.message_scroll = 0;
    app.screen = Screen::Message;
    app.back_screen = Screen::StartSession;
    Ok(())
}
