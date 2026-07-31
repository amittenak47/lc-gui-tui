use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

use crate::ascii_morph::AsciiAnimProgram;
use crate::index::ProblemRow;
use crate::session::ProblemState;

use super::app::{App, ListPickPurpose, Screen};
use super::{LC_BANNER, PAGE_SIZE};

pub(crate) fn draw(f: &mut Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(8),
            Constraint::Min(6),
            Constraint::Length(3),
        ])
        .split(f.area());

    draw_banner(f, chunks[0]);
    match app.screen {
        Screen::Browse => draw_browse(f, chunks[1], app),
        Screen::Message => draw_message(f, chunks[1], app),
        Screen::CoachChat => draw_coach_chat(f, chunks[1], app),
        Screen::AsciiAnim => draw_ascii_anim(f, chunks[1], app),
        Screen::InputId => draw_input(f, chunks[1], app, "add by id", "Enter problem id / slug / question #:"),
        Screen::InputListName => {
            draw_input(f, chunks[1], app, "new list", "Enter list name:")
        }
        _ => draw_menu(f, chunks[1], app),
    }
    draw_footer(f, chunks[2], app);
}

fn draw_banner(f: &mut Frame, area: Rect) {
    let block = Paragraph::new(LC_BANNER).block(
        Block::default()
            .borders(Borders::ALL)
            .title("LC — LeetCode practice harness"),
    );
    f.render_widget(block, area);
}

fn draw_menu(f: &mut Frame, area: Rect, app: &App) {
    let (title, items) = menu_items(app);
    let lines: Vec<Line> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let style = if i == app.menu_sel {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            Line::from(Span::styled(format!("  {item}"), style))
        })
        .collect();

    if app.screen == Screen::Main && !app.session.queue.is_empty() {
        let mut extra = lines;
        extra.push(Line::from(""));
        extra.push(Line::from(Span::styled(
            format!(
                "  session: {} in queue · {} touched",
                app.session.queue.len(),
                app.session.problems.len()
            ),
            Style::default().fg(Color::DarkGray),
        )));
        let block = Paragraph::new(extra).block(Block::default().borders(Borders::ALL).title(title));
        f.render_widget(block, area);
    } else {
        let block = Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(title));
        f.render_widget(block, area);
    }
}

fn menu_items(app: &App) -> (&'static str, Vec<String>) {
    match app.screen {
        Screen::Main => (
            "main menu",
            vec![
                "Start new session".into(),
                "Browse problems".into(),
                "Settings".into(),
                "Help".into(),
                "ASCII morph demo".into(),
                "Quit".into(),
            ],
        ),
        Screen::StartSession => (
            "start session",
            vec![
                "Browse / search problems".into(),
                "Randomize".into(),
                "Use existing list".into(),
                "Add problem by id".into(),
                "Session stats".into(),
                "Back".into(),
            ],
        ),
        Screen::ChooseProblems => (
            "choose problems",
            vec![
                "Browse / search (paginated)".into(),
                "Add by id".into(),
                "Filter by difficulty".into(),
                "Back".into(),
            ],
        ),
        Screen::DifficultyPick => (
            "difficulty",
            vec![
                "Any".into(),
                "Easy".into(),
                "Medium".into(),
                "Hard".into(),
            ],
        ),
        Screen::ListPick => {
            let mut items: Vec<String> = app.list_names.iter().cloned().collect();
            items.push("Create new list…".into());
            items.push("Back".into());
            let title = match app.list_pick_purpose {
                ListPickPurpose::LoadSession => "pick a list",
                ListPickPurpose::AddTask { .. } => "add to list",
                ListPickPurpose::AddRandom => "random add to list",
            };
            (title, items)
        }
        Screen::ProblemActions => (
            "problem",
            vec![
                format!(
                    "Open in Canvas - {}",
                    app.selected_problem
                        .as_ref()
                        .map(|r| r.task_id.as_str())
                        .unwrap_or("?")
                ),
                "Open in IDE".into(),
                "Edit solution (vim / $EDITOR)".into(),
                "Open workspace folder".into(),
                "Load workspace (stay in TUI)".into(),
                "Run tests".into(),
                "Coach chat".into(),
                "Submit locally (save)".into(),
                "Add to list".into(),
                "Back".into(),
            ],
        ),
        Screen::LeaveConfirm => {
            let (save, discard) = if app.leave_solved {
                ("Save attempt", "Clear attempt")
            } else {
                ("Save progress", "Discard")
            };
            (
                if app.leave_solved {
                    "save this attempt?"
                } else {
                    "save your progress?"
                },
                vec![save.into(), discard.into(), "Cancel".into()],
            )
        },
        Screen::Settings => (
            "settings",
            vec![
                "Show config path".into(),
                "Show paths (data / workspace / python)".into(),
                "Start local LLM".into(),
                "Stop local LLM".into(),
                "LLM status".into(),
                "Reset session".into(),
                "Back".into(),
            ],
        ),
        Screen::Help => (
            "help",
            vec![
                "CLI: lc stats · lc session reset · lc config · lc index · lc list · lc search --sort question".into(),
            ],
        ),
        _ => ("", vec![]),
    }
}

fn draw_browse(f: &mut Frame, area: Rect, app: &App) {
    let max_page = app.browse_total.saturating_sub(1) / PAGE_SIZE + 1;
    let page = app.browse_page + 1;
    let title = format!(
        "browse [{}] · page {page}/{max_page} · {} total · diff: {} · tag: {} · sort: {}{}",
        app.dataset.label,
        app.browse_total,
        app.difficulty_label(),
        app.tag_label(),
        app.browse_sort.label(),
        app.browse
            .slug_query
            .as_ref()
            .map(|q| format!(" · q: {q}"))
            .unwrap_or_default(),
    );

    let block = Block::default().borders(Borders::ALL).title(title);
    let inner = block.inner(area);
    let inner_w = inner.width as usize;
    let (q_w, task_w, diff_w, cases_w) = browse_col_widths(inner_w);

    let mut lines = Vec::new();
    if app.browse_search_active {
        lines.push(Line::from(Span::styled(
            pad_line(
                &format!("search: {}_", app.browse_search_buf),
                inner_w,
            ),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )));
    }
    lines.push(Line::from(Span::styled(
        format_browse_header(q_w, task_w, diff_w, cases_w, inner_w),
        Style::default().add_modifier(Modifier::BOLD),
    )));

    for (i, row) in app.browse_rows.iter().enumerate() {
        let st = match app.session.progress(&row.key()) {
            None => "-",
            Some(p) => match p.state {
                ProblemState::Loaded => "ld",
                ProblemState::Passed => "ok",
                ProblemState::Failed => "xx",
            },
        };
        let label = format_browse_row(row, st, q_w, task_w, diff_w, cases_w, inner_w);
        let style = if i == app.browse_sel {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(Span::styled(label, style)));
    }

    if app.browse_rows.is_empty() {
        lines.push(Line::from(pad_line(
            "(no matches — try t to cycle tag filter)",
            inner_w,
        )));
    }

    f.render_widget(Paragraph::new(lines).block(block), area);
}

/// Distribute horizontal space: fixed cols for q#, diff, cases, st; task_id gets the rest.
fn browse_col_widths(inner_w: usize) -> (usize, usize, usize, usize) {
    let q_w = 6usize;
    let diff_w = 8usize;
    let cases_w = 7usize;
    let st_w = 3usize;
    let gutters = 6usize;
    let task_w = inner_w
        .saturating_sub(q_w + diff_w + cases_w + st_w + gutters)
        .max(12);
    (q_w, task_w, diff_w, cases_w)
}

fn format_browse_header(
    q_w: usize,
    task_w: usize,
    diff_w: usize,
    cases_w: usize,
    inner_w: usize,
) -> String {
    pad_line(
        &format!(
            "{:<q_w$} {:<task_w$} {:<diff_w$} {:>cases_w$}  st",
            "q#", "task_id", "diff", "cases"
        ),
        inner_w,
    )
}

fn format_browse_row(
    row: &ProblemRow,
    st: &str,
    q_w: usize,
    task_w: usize,
    diff_w: usize,
    cases_w: usize,
    inner_w: usize,
) -> String {
    pad_line(
        &format!(
            "{:<q_w$} {:<task_w$} {:<diff_w$} {:>cases_w$}  {st}",
            row.question_id.as_deref().unwrap_or(""),
            trunc(&crate::generator::title_from_slug(&row.task_id), task_w),
            row.difficulty.as_deref().unwrap_or(""),
            row.test_count,
        ),
        inner_w,
    )
}

fn pad_line(line: &str, width: usize) -> String {
    if line.len() >= width {
        line.to_string()
    } else {
        format!("{line}{}", " ".repeat(width - line.len()))
    }
}

fn draw_input(f: &mut Frame, area: Rect, app: &App, title: &str, prompt: &str) {
    let text = format!("{prompt}\n\n  {}", app.input_buf);
    let block = Paragraph::new(text).block(
        Block::default()
            .borders(Borders::ALL)
            .title(title),
    );
    f.render_widget(block, area);
}

fn draw_message(f: &mut Frame, area: Rect, app: &mut App) {
    let height = area.height.saturating_sub(2) as usize;
    let max_scroll = app.message_lines.len().saturating_sub(height.max(1));
    if app.message_scroll > max_scroll {
        app.message_scroll = max_scroll;
    }
    let visible: Vec<Line> = app
        .message_lines
        .iter()
        .skip(app.message_scroll)
        .take(height.max(1))
        .map(|l| Line::from(l.as_str()))
        .collect();
    let block = Paragraph::new(visible).block(
        Block::default()
            .borders(Borders::ALL)
            .title("output (w/s scroll · Enter/Esc back)"),
    );
    f.render_widget(block, area);
}

fn draw_coach_chat(f: &mut Frame, area: Rect, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(4), Constraint::Length(5)])
        .split(area);

    let inner_w = chunks[0].width.saturating_sub(2) as usize;
    let composer_w = chunks[1].width.saturating_sub(2) as usize;
    let height = chunks[0].height.saturating_sub(2) as usize;

    let active_id = app.ascii_msg_id.clone();
    let live_lines = app.ascii_player.as_ref().map(|p| {
        (
            p.program.title.clone(),
            p.current_lines(),
            p.current_label().to_string(),
            p.progress_hint(),
        )
    });

    let mut lines: Vec<Line> = Vec::new();
    if app.coach_messages.is_empty() {
        for part in wrap_to_width(
            "(empty thread — ask about the problem, or Ctrl+D then ask to get an ASCII morph)",
            inner_w,
        ) {
            lines.push(Line::from(Span::styled(
                part,
                Style::default().fg(Color::DarkGray),
            )));
        }
    }
    for msg in &app.coach_messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("?");
        let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let (label, header_fg, bubble_bg) = match role {
            "user" => (
                "You",
                Color::Cyan,
                Color::Rgb(38, 48, 62),
            ),
            "assistant" => (
                "Coach",
                Color::Green,
                Color::Rgb(38, 52, 42),
            ),
            "app" => (
                "Tests",
                Color::Yellow,
                Color::Rgb(52, 48, 38),
            ),
            _ => ("?", Color::DarkGray, Color::Rgb(40, 40, 40)),
        };
        let header = Style::default()
            .fg(header_fg)
            .bg(bubble_bg)
            .add_modifier(Modifier::BOLD);
        let body = Style::default().fg(Color::White).bg(bubble_bg);
        let pad = inner_w.saturating_sub(2);

        lines.push(Line::from(Span::styled(
            format!(" {label} "),
            header,
        )));
        for line in content.lines() {
            for part in wrap_to_width(line, pad) {
                lines.push(Line::from(Span::styled(format!(" {part} "), body)));
            }
        }

        let is_live = active_id.as_deref() == Some(id) && live_lines.is_some();
        if is_live {
            if let Some((title, frame, step, hint)) = live_lines.as_ref() {
                lines.push(Line::from(Span::styled(" ", body)));
                lines.push(Line::from(Span::styled(
                    format!(" ▸ {title} "),
                    Style::default()
                        .fg(Color::Magenta)
                        .bg(bubble_bg)
                        .add_modifier(Modifier::BOLD),
                )));
                for row in frame {
                    lines.push(Line::from(Span::styled(
                        format!(" {row} "),
                        Style::default().fg(Color::Green).bg(bubble_bg),
                    )));
                }
                lines.push(Line::from(Span::styled(
                    format!(" {step} "),
                    Style::default().fg(Color::Yellow).bg(bubble_bg),
                )));
                lines.push(Line::from(Span::styled(
                    format!(" {hint} "),
                    Style::default().fg(Color::DarkGray).bg(bubble_bg),
                )));
            }
        } else if let Some(anim) = msg
            .get("ascii_anim")
            .and_then(|v| serde_json::from_value::<AsciiAnimProgram>(v.clone()).ok())
        {
            if let Some(last) = anim.frames.last() {
                lines.push(Line::from(Span::styled(" ", body)));
                lines.push(Line::from(Span::styled(
                    format!(" ▸ {} ", anim.title),
                    Style::default().fg(Color::DarkGray).bg(bubble_bg),
                )));
                for row in &last.lines {
                    lines.push(Line::from(Span::styled(
                        format!(" {row} "),
                        Style::default().fg(Color::DarkGray).bg(bubble_bg),
                    )));
                }
                if !last.label.is_empty() {
                    lines.push(Line::from(Span::styled(
                        format!(" {} ", last.label),
                        Style::default().fg(Color::DarkGray).bg(bubble_bg),
                    )));
                }
            }
        }
        lines.push(Line::from(""));
    }

    let max_scroll = lines.len().saturating_sub(height.max(1));
    if app.coach_scroll > max_scroll {
        app.coach_scroll = max_scroll;
    }
    let scroll = app.coach_scroll;
    let visible: Vec<Line> = lines.into_iter().skip(scroll).take(height.max(1)).collect();

    let draw_tag = if app.coach_draw { " · draw ON" } else { "" };
    let thread = Paragraph::new(visible).block(
        Block::default()
            .borders(Borders::ALL)
            .title(format!("coach chat{draw_tag} (Ctrl+D toggle draw · Esc back)")),
    );
    f.render_widget(thread, chunks[0]);

    let composer_body: Vec<Line> = if app.input_buf.is_empty() {
        vec![Line::from(Span::styled("> _", Style::default().fg(Color::DarkGray)))]
    } else {
        let mut out = Vec::new();
        for part in wrap_to_width(&format!("> {}", app.input_buf), composer_w) {
            out.push(Line::from(part));
        }
        out.push(Line::from(Span::styled("_", Style::default().fg(Color::DarkGray))));
        out
    };
    let composer = Paragraph::new(composer_body).block(
        Block::default()
            .borders(Borders::ALL)
            .title("message · Enter send · Ctrl+D draw"),
    );
    f.render_widget(composer, chunks[1]);
}
fn draw_ascii_anim(f: &mut Frame, area: Rect, app: &App) {
    let Some(player) = app.ascii_player.as_ref() else {
        f.render_widget(
            Paragraph::new("(no animation loaded)").block(
                Block::default()
                    .borders(Borders::ALL)
                    .title("ascii morph"),
            ),
            area,
        );
        return;
    };

    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::from(Span::styled(
        player.program.title.clone(),
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(""));
    for row in player.current_lines() {
        lines.push(Line::from(Span::styled(
            row,
            Style::default().fg(Color::Green),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        player.current_label().to_string(),
        Style::default().fg(Color::Yellow),
    )));
    lines.push(Line::from(Span::styled(
        player.progress_hint(),
        Style::default().fg(Color::DarkGray),
    )));
    lines.push(Line::from(""));
    lines.push(Line::from(
        "This is the ascii-morph idea in Rust: dissolve between keyframes.",
    ));
    lines.push(Line::from(
        "A coach would emit array steps; we morph the ASCII between them.",
    ));

    f.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .title("ascii morph · Space restart · Esc back"),
        ),
        area,
    );
}

/// Hard-wrap `text` to `width` columns (char count). Empty input yields one blank.
fn wrap_to_width(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut current = String::new();
    let mut cols = 0usize;
    for ch in text.chars() {
        if cols >= width && !current.is_empty() {
            out.push(std::mem::take(&mut current));
            cols = 0;
        }
        current.push(ch);
        cols += 1;
    }
    out.push(current);
    out
}
fn draw_footer(f: &mut Frame, area: Rect, app: &App) {
    let keys = match app.screen {
        Screen::Browse => {
            if app.browse_search_active {
                "typing search · Enter apply · Esc cancel"
            } else {
                "W/S select · A/D page · / search · G dataset · T tag · E diff · O sort · L add list · R random→list · I id"
            }
        }
        Screen::InputId => "type id · Enter confirm · Esc cancel",
        Screen::InputListName => "type list name · Enter confirm · Esc cancel",
        Screen::Message => "W/S scroll · Enter/Esc back",
        Screen::CoachChat => {
            if app.coach_draw {
                "type · Enter send · Ctrl+D draw ON · ↑↓ scroll · Esc back"
            } else {
                "type · Enter send · Ctrl+D draw off · ↑↓ scroll · Esc back"
            }
        },
        Screen::AsciiAnim => "Space/r restart · Esc back",
        Screen::LeaveConfirm => "W/S choose · Enter confirm · Esc cancel",
        Screen::Main => "W/S move · Enter select · Q quit",
        _ => "W/S move · Enter select · Esc back",
    };
    let block = Paragraph::new(format!("{}\n{}", app.status, keys)).block(
        Block::default().borders(Borders::ALL).title("status"),
    );
    f.render_widget(block, area);
}
fn trunc(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max.saturating_sub(1)])
    }
}
