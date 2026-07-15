use anyhow::{bail, Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::{execute, terminal::ClearType};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use std::io;
use std::path::Path;
use std::time::Duration;

use crate::config::Config;
use crate::index::{self, ProblemRow, SearchSort};
use crate::session::{ProblemState, Session};
use crate::{generator, llm, loader, problem, runner};

type TuiTerminal = Terminal<CrosstermBackend<io::Stdout>>;

const PAGE_SIZE: u32 = 15;

const LC_BANNER: &str = r#"
 ██╗      ██████╗
 ██║     ██╔════╝
 ██║     ██║     
 ██║     ██║     
 ███████╗╚██████╗
 ╚══════╝ ╚═════╝
"#;

pub fn run(cfg: &Config) -> Result<()> {
    let mut terminal = setup_terminal()?;
    let result = run_app(&mut terminal, cfg);
    restore_terminal(&mut terminal)?;
    result
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Screen {
    Main,
    StartSession,
    ChooseProblems,
    DifficultyPick,
    ListPick,
    Browse,
    ProblemActions,
    InputId,
    Settings,
    Help,
    Message,
}

struct BrowseFilter {
    difficulty: Option<String>,
    tag_index: usize,
    list_name: Option<String>,
    slug_query: Option<String>,
}

struct App {
    cfg: Config,
    session: Session,
    conn: rusqlite::Connection,
    screen: Screen,
    menu_sel: usize,
    status: String,
    all_tags: Vec<String>,
    browse: BrowseFilter,
    browse_sort: SearchSort,
    browse_page: u32,
    browse_sel: usize,
    browse_rows: Vec<ProblemRow>,
    browse_total: u32,
    list_names: Vec<String>,
    selected_problem: Option<ProblemRow>,
    input_buf: String,
    message_lines: Vec<String>,
    message_scroll: usize,
    difficulty_pick_for: Screen,
    back_screen: Screen,
}

impl App {
    fn new(cfg: Config) -> Result<Self> {
        let conn = index::open_db()?;
        let all_tags = index::all_tags(&conn)?;
        Ok(Self {
            cfg,
            session: Session::load_or_new()?,
            conn,
            screen: Screen::Main,
            menu_sel: 0,
            status: String::new(),
            all_tags,
            browse: BrowseFilter {
                difficulty: None,
                tag_index: 0,
                list_name: None,
                slug_query: None,
            },
            browse_sort: SearchSort::Question,
            browse_page: 0,
            browse_sel: 0,
            browse_rows: Vec::new(),
            browse_total: 0,
            list_names: Vec::new(),
            selected_problem: None,
            input_buf: String::new(),
            message_lines: Vec::new(),
            message_scroll: 0,
            difficulty_pick_for: Screen::ChooseProblems,
            back_screen: Screen::Main,
        })
    }

    fn reload_browse_page(&mut self) -> Result<()> {
        let tag_owned = self
            .current_tag_filter()
            .map(|s| s.to_string());
        let tag = tag_owned.as_deref();
        let offset = self.browse_page * PAGE_SIZE;
        self.browse_total = if let Some(name) = &self.browse.list_name {
            index::list_problem_rows(&self.conn, name, self.browse_sort)?.len() as u32
        } else {
            index::search_count(
                &self.conn,
                self.browse.difficulty.as_deref(),
                tag,
                self.browse.slug_query.as_deref(),
            )?
        };

        self.browse_rows = if let Some(name) = &self.browse.list_name {
            let all = index::list_problem_rows(&self.conn, name, self.browse_sort)?;
            all.into_iter()
                .skip(offset as usize)
                .take(PAGE_SIZE as usize)
                .collect()
        } else {
            index::search_page(
                &self.conn,
                self.browse.difficulty.as_deref(),
                tag,
                self.browse.slug_query.as_deref(),
                self.browse_sort,
                PAGE_SIZE,
                offset,
            )?
        };

        if self.browse_sel >= self.browse_rows.len() {
            self.browse_sel = self.browse_rows.len().saturating_sub(1);
        }
        Ok(())
    }

    fn current_tag_filter(&self) -> Option<&str> {
        if self.browse.tag_index == 0 {
            None
        } else {
            self.all_tags
                .get(self.browse.tag_index - 1)
                .map(|s| s.as_str())
        }
    }

    fn tag_label(&self) -> String {
        if self.browse.tag_index == 0 {
            "all tags".into()
        } else {
            self.all_tags
                .get(self.browse.tag_index - 1)
                .cloned()
                .unwrap_or_else(|| "?".into())
        }
    }

    fn cycle_tag(&mut self) -> Result<()> {
        let max = self.all_tags.len();
        self.browse.tag_index = if max == 0 {
            0
        } else {
            (self.browse.tag_index + 1) % (max + 1)
        };
        self.browse_page = 0;
        self.browse_sel = 0;
        self.reload_browse_page()?;
        self.status = format!("tag filter: {}", self.tag_label());
        Ok(())
    }

    fn cycle_sort(&mut self) -> Result<()> {
        self.browse_sort = match self.browse_sort {
            SearchSort::Question => SearchSort::Difficulty,
            SearchSort::Difficulty => SearchSort::Cases,
            SearchSort::Cases => SearchSort::Tags,
            SearchSort::Tags => SearchSort::TaskId,
            SearchSort::TaskId => SearchSort::Question,
        };
        self.reload_browse_page()?;
        self.status = format!("sort: {}", self.browse_sort.label());
        Ok(())
    }

    fn open_browse(&mut self, filter: BrowseFilter, from: Screen) -> Result<()> {
        self.browse = filter;
        self.browse_page = 0;
        self.browse_sel = 0;
        self.back_screen = from;
        self.screen = Screen::Browse;
        self.reload_browse_page()?;
        Ok(())
    }

    fn pick_random(&mut self) -> Result<()> {
        let row = index::random_one(
            &self.conn,
            self.browse.difficulty.as_deref(),
            self.current_tag_filter(),
        )?
        .ok_or_else(|| anyhow::anyhow!("no problem matches those filters"))?;
        self.selected_problem = Some(row.clone());
        let _ = self.session.add_to_queue(&row.task_id);
        self.screen = Screen::ProblemActions;
        self.menu_sel = 0;
        self.status = format!("random: {}", row.task_id);
        Ok(())
    }

    fn resolve_input_id(&mut self) -> Result<()> {
        let id = self.input_buf.trim().to_string();
        if id.is_empty() {
            bail!("enter a problem id");
        }
        let row = loader::resolve(&self.conn, &id)?;
        self.session.add_to_queue(&row.task_id)?;
        self.selected_problem = Some(row);
        self.input_buf.clear();
        self.screen = Screen::ProblemActions;
        self.menu_sel = 0;
        self.status = "added to session".into();
        Ok(())
    }

    fn work_on_problem(&mut self) -> Result<()> {
        let row = self.selected_problem.clone().context("no problem")?;
        let json_path = Path::new(&row.json_path);
        let prob = problem::load_task(json_path, &row.task_id)?;
        let dir = generator::generate(&self.cfg, &prob, json_path, false)?;
        self.session.mark_loaded(&row.task_id)?;
        self.session = Session::load_or_new()?;
        generator::open_in_editor(&dir);
        self.status = format!("workspace: {}", dir.display());
        Ok(())
    }

    fn run_tests(&mut self) -> Result<()> {
        let row = self.selected_problem.clone().context("no problem")?;
        let dir = self.cfg.workspace_dir().join(&row.task_id);
        if !dir.join(".lc").join("meta.json").exists() {
            bail!("load workspace first (Work on problem)");
        }
        let all_passed =
            runner::cmd_test_quiet(&self.cfg, Some(&row.task_id), None, false)?;
        self.session = Session::load_or_new()?;
        self.status = if all_passed {
            format!("{} — all tests passed", row.task_id)
        } else if let Some(run) = runner::load_last_run()? {
            let p = run.results.iter().filter(|r| r.pass).count();
            format!("{} — {p}/{} passed", row.task_id, run.results.len())
        } else {
            "tests finished".into()
        };
        Ok(())
    }

    fn submit_locally(&mut self) -> Result<()> {
        let row = self.selected_problem.clone().context("no problem")?;
        let dir = self.cfg.workspace_dir().join(&row.task_id);
        if !dir.join("solution.py").exists() {
            bail!("no solution yet — use Work on problem first");
        }
        let (passed, total, all_passed) = if let Some(run) = runner::load_last_run()? {
            if run.task_id == row.task_id {
                let p = run.results.iter().filter(|r| r.pass).count() as u32;
                let t = run.results.len() as u32;
                (p, t, p == t && t > 0)
            } else {
                (0, 0, false)
            }
        } else {
            (0, 0, false)
        };
        index::record_submission(
            &self.conn,
            &row.task_id,
            &dir.display().to_string(),
            passed,
            total,
            all_passed,
        )?;
        self.status = format!(
            "saved submission for {} ({passed}/{total})",
            row.task_id
        );
        Ok(())
    }

    fn ai_overview(&mut self) -> Result<()> {
        let row = self.selected_problem.clone().context("no problem")?;
        let json_path = Path::new(&row.json_path);
        let prob = problem::load_task(json_path, &row.task_id)?;
        let desc = prob.problem_description.unwrap_or_default();
        let starter = prob.starter_code.unwrap_or_default();
        let user = format!(
            "Give a concise tutoring overview of this LeetCode problem (approach hints, \
             key patterns, pitfalls). Do NOT write a full solution.\n\n\
             task_id: {}\n\
             difficulty: {}\n\
             tags: {}\n\n\
             ---\n{desc}\n\n---\nStarter:\n{starter}",
            row.task_id,
            row.difficulty.as_deref().unwrap_or("?"),
            row.tags.join(", ")
        );
        let provider = llm::make_provider(&self.cfg, None)?;
        self.status = format!("asking {}…", provider.label());
        let answer = provider.chat(
            "You are a concise LeetCode tutor. Hint and teach; never dump a full solution.",
            &user,
        )?;
        self.message_lines = answer.lines().map(|l| l.to_string()).collect();
        self.message_scroll = 0;
        self.screen = Screen::Message;
        Ok(())
    }

    fn view_solution(&mut self) -> Result<()> {
        let row = self.selected_problem.clone().context("no problem")?;
        let path = self.cfg.workspace_dir().join(&row.task_id).join("solution.py");
        let text = if path.exists() {
            std::fs::read_to_string(&path)?
        } else {
            format!(
                "(no solution.py yet — choose Work on problem for {})\n",
                row.task_id
            )
        };
        self.message_lines = text.lines().map(|l| l.to_string()).collect();
        self.message_scroll = 0;
        self.screen = Screen::Message;
        Ok(())
    }
}

fn run_app(terminal: &mut TuiTerminal, cfg: &Config) -> Result<()> {
    let mut app = App::new(cfg.clone())?;
    app.status = "WASD navigate · Enter select · Esc back · q quit".into();

    loop {
        terminal.draw(|f| draw(f, &mut app))?;
        if event::poll(Duration::from_millis(150))? {
            if let Event::Key(key) = event::read()? {
                if handle_key(&mut app, key)? {
                    break;
                }
            }
        }
    }
    Ok(())
}

fn handle_key(app: &mut App, key: KeyEvent) -> Result<bool> {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return Ok(true);
    }

    if app.screen == Screen::InputId {
        return handle_input_id(app, key);
    }
    if app.screen == Screen::Message {
        return handle_message(app, key);
    }

    match key.code {
        KeyCode::Char('q') if app.screen == Screen::Main => return Ok(true),
        KeyCode::Esc => {
            app.screen = match app.screen {
                Screen::Main => return Ok(true),
                Screen::StartSession => Screen::Main,
                Screen::ChooseProblems | Screen::DifficultyPick | Screen::ListPick => {
                    Screen::StartSession
                }
                Screen::Browse => app.back_screen,
                Screen::ProblemActions => Screen::Browse,
                Screen::Settings | Screen::Help => Screen::Main,
                Screen::InputId => Screen::ChooseProblems,
                Screen::Message => app.back_screen,
            };
            app.menu_sel = 0;
        }
        KeyCode::Char('w') | KeyCode::Up => menu_up(app),
        KeyCode::Char('s') | KeyCode::Down => menu_down(app),
        KeyCode::Enter => {
            if activate(app)? {
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
        KeyCode::Char('o') if app.screen == Screen::Browse => app.cycle_sort()?,
        _ => {}
    }
    Ok(false)
}

fn handle_input_id(app: &mut App, key: KeyEvent) -> Result<bool> {
    match key.code {
        KeyCode::Esc => {
            app.input_buf.clear();
            app.screen = Screen::ChooseProblems;
        }
        KeyCode::Enter => {
            if let Err(e) = app.resolve_input_id() {
                app.status = format!("{e:#}");
            }
        }
        KeyCode::Backspace => {
            app.input_buf.pop();
        }
        KeyCode::Char(c) => app.input_buf.push(c),
        _ => {}
    }
    Ok(false)
}

fn handle_message(app: &mut App, key: KeyEvent) -> Result<bool> {
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
        Screen::Main => 5,
        Screen::StartSession => 5,
        Screen::ChooseProblems => 5,
        Screen::DifficultyPick => 4,
        Screen::ListPick => app.list_names.len() + 1,
        Screen::Browse => app.browse_rows.len(),
        Screen::ProblemActions => 6,
        Screen::Settings => 4,
        Screen::Help => 1,
        Screen::InputId | Screen::Message => 0,
    }
}

fn activate(app: &mut App) -> Result<bool> {
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
            4 => return Ok(true),
            _ => return Ok(false),
        },
        Screen::StartSession => match app.menu_sel {
            0 => {
                app.screen = Screen::ChooseProblems;
                app.menu_sel = 0;
            }
            1 => {
                app.screen = Screen::DifficultyPick;
                app.difficulty_pick_for = Screen::StartSession;
                app.menu_sel = 0;
            }
            2 => {
                app.list_names = index::list_names(&app.conn)?;
                app.screen = Screen::ListPick;
                app.menu_sel = 0;
            }
            3 => show_session_stats(app)?,
            _ => {
                app.screen = Screen::Main;
                app.menu_sel = 0;
            }
        },
        Screen::ChooseProblems => match app.menu_sel {
            0 => {
                app.input_buf.clear();
                app.screen = Screen::InputId;
            }
            1 => {
                app.screen = Screen::DifficultyPick;
                app.difficulty_pick_for = Screen::ChooseProblems;
                app.menu_sel = 0;
            }
            2 => {
                app.open_browse(
                    BrowseFilter {
                        difficulty: None,
                        tag_index: 1.min(app.all_tags.len()),
                        list_name: None,
                        slug_query: None,
                    },
                    Screen::ChooseProblems,
                )?;
            }
            3 => {
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
            if app.menu_sel >= app.list_names.len() {
                app.screen = Screen::StartSession;
                app.menu_sel = 0;
                return Ok(false);
            }
            let name = app.list_names[app.menu_sel].clone();
            app.session.set_active_list(Some(name.clone()))?;
            app.session = Session::load_or_new()?;
            let rows = index::list_problem_rows(&app.conn, &name, SearchSort::Question)?;
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
                if let Err(e) = app.work_on_problem() {
                    app.status = format!("{e:#}");
                }
            }
            1 => {
                if let Err(e) = app.run_tests() {
                    app.status = format!("{e:#}");
                }
            }
            2 => {
                if let Err(e) = app.ai_overview() {
                    app.status = format!("{e:#}");
                }
            }
            3 => {
                if let Err(e) = app.view_solution() {
                    app.status = format!("{e:#}");
                }
            }
            4 => {
                if let Err(e) = app.submit_locally() {
                    app.status = format!("{e:#}");
                }
            }
            _ => {
                app.screen = Screen::Browse;
                app.menu_sel = 0;
            }
        },
        Screen::Settings => match app.menu_sel {
            0 => app.status = format!("config: {}", crate::config::config_path()?.display()),
            1 => app.status = "run `lc index` from a shell to rebuild the corpus".into(),
            2 => {
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
        Screen::InputId | Screen::Message => {}
    }
    Ok(false)
}

fn draw(f: &mut Frame, app: &mut App) {
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
        Screen::InputId => draw_input(f, chunks[1], app),
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
                "Quit".into(),
            ],
        ),
        Screen::StartSession => (
            "start session",
            vec![
                "Choose problems".into(),
                "Randomize".into(),
                "Use existing list".into(),
                "Session stats".into(),
                "Back".into(),
            ],
        ),
        Screen::ChooseProblems => (
            "choose problems",
            vec![
                "Add by id".into(),
                "Filter by difficulty".into(),
                "Filter by tag (cycle with t in browse)".into(),
                "Browse all (paginated)".into(),
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
            items.push("Back".into());
            ("pick a list", items)
        }
        Screen::ProblemActions => (
            "problem",
            vec![
                format!(
                    "Work on problem — {}",
                    app.selected_problem
                        .as_ref()
                        .map(|r| r.task_id.as_str())
                        .unwrap_or("?")
                ),
                "Run tests".into(),
                "AI overview".into(),
                "View my solution".into(),
                "Submit locally (save)".into(),
                "Back".into(),
            ],
        ),
        Screen::Settings => (
            "settings",
            vec![
                "Show config path".into(),
                "Index corpus (shell)".into(),
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
        "browse · page {page}/{max_page} · {} total · tag: {} · sort: {}",
        app.browse_total,
        app.tag_label(),
        app.browse_sort.label()
    );

    let mut lines = Vec::new();
    lines.push(Line::from(Span::styled(
        "  q#    task_id                          diff    cases  st",
        Style::default().add_modifier(Modifier::BOLD),
    )));

    for (i, row) in app.browse_rows.iter().enumerate() {
        let st = match app.session.progress(&row.task_id) {
            None => "-",
            Some(p) => match p.state {
                ProblemState::Loaded => "ld",
                ProblemState::Passed => "ok",
                ProblemState::Failed => "xx",
            },
        };
        let label = format!(
            "  {:<5} {:<32} {:<7} {:>5}  {st}",
            row.question_id.as_deref().unwrap_or(""),
            trunc(&row.task_id, 32),
            row.difficulty.as_deref().unwrap_or(""),
            row.test_count,
        );
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
        lines.push(Line::from("  (no matches — try t to cycle tag filter)"));
    }

    let block = Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(title));
    f.render_widget(block, area);
}

fn draw_input(f: &mut Frame, area: Rect, app: &App) {
    let text = format!("Enter problem id / slug / question #:\n\n  {}", app.input_buf);
    let block = Paragraph::new(text).block(
        Block::default()
            .borders(Borders::ALL)
            .title("add by id"),
    );
    f.render_widget(block, area);
}

fn draw_message(f: &mut Frame, area: Rect, app: &App) {
    let visible: Vec<Line> = app
        .message_lines
        .iter()
        .skip(app.message_scroll)
        .take(area.height.saturating_sub(2) as usize)
        .map(|l| Line::from(l.as_str()))
        .collect();
    let block = Paragraph::new(visible)
        .wrap(Wrap { trim: false })
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("output (w/s scroll · Enter/Esc back)"),
        );
    f.render_widget(block, area);
}

fn draw_footer(f: &mut Frame, area: Rect, app: &App) {
    let keys = match app.screen {
        Screen::Browse => "W/S select · A/D page · T tag · O sort · Enter open · Esc back",
        Screen::InputId => "type id · Enter confirm · Esc cancel",
        Screen::Message => "W/S scroll · Enter/Esc back",
        Screen::Main => "W/S move · Enter select · Q quit",
        _ => "W/S move · Enter select · Esc back",
    };
    let block = Paragraph::new(format!("{}\n{}", app.status, keys)).block(
        Block::default().borders(Borders::ALL).title("status"),
    );
    f.render_widget(block, area);
}

fn show_session_stats(app: &mut App) -> Result<()> {
    use crate::stats::{self, Aggregate};
    let rows = if let Some(name) = &app.session.active_list {
        index::list_problem_rows(&app.conn, name, SearchSort::Question)?
    } else {
        index::search_page(
            &app.conn,
            None,
            None,
            None,
            SearchSort::Question,
            1,
            0,
        )?;
        // use count only for empty queue display - get full queue scope
        app.session
            .queue
            .iter()
            .filter_map(|tid| {
                index::search(
                    &app.conn,
                    None,
                    None,
                    Some(tid),
                    1,
                    false,
                    SearchSort::TaskId,
                )
                .ok()
                .and_then(|v| v.into_iter().next())
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

fn trunc(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max.saturating_sub(1)])
    }
}

fn setup_terminal() -> Result<TuiTerminal> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, crossterm::cursor::Hide)?;
    Ok(Terminal::new(CrosstermBackend::new(stdout))?)
}

fn restore_terminal(terminal: &mut TuiTerminal) -> Result<()> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        crossterm::cursor::Show,
        crossterm::terminal::Clear(ClearType::All)
    )?;
    terminal.show_cursor()?;
    Ok(())
}
