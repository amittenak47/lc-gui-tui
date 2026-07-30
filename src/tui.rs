use anyhow::{bail, Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
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
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::attempt;
use crate::config::Config;
use crate::dataset::{self, Dataset, DATASETS};
use crate::index::{self, ProblemRow, SearchSort};
use crate::llm::{ChatMessage, ChatRequest};
use crate::session::{ProblemState, Session};
use crate::{generator, lists, llm, loader, problem, runner};

type TuiTerminal = Terminal<CrosstermBackend<io::Stdout>>;

const PAGE_SIZE: u32 = 15;

const COACH_SYSTEM: &str = "You are a concise LeetCode tutor in a terminal coach chat. \
Hint and teach; never dump a full working solution the student can paste. \
When a Tests message appears in the thread, treat it as ground truth about the last run.";

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
    CoachChat,
    LeaveConfirm,
    InputId,
    InputListName,
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

#[derive(Clone)]
enum ListPickPurpose {
    LoadSession,
    AddTask { task_id: String },
    AddRandom,
}

struct App {
    cfg: Config,
    /// Which problem set is being browsed. `G` cycles it; the GUI shows the
    /// same choice as the tab strip over the table.
    dataset: &'static Dataset,
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
    browse_search_active: bool,
    browse_search_buf: String,
    list_pick_purpose: ListPickPurpose,
    /// TUI coach thread (mirrors `.lc/agent.tui.json`).
    coach_messages: Vec<serde_json::Value>,
    coach_scroll: usize,
    /// Cached solved flag for the leave-confirm labels.
    leave_solved: bool,
}

impl App {
    fn new(cfg: Config) -> Result<Self> {
        let conn = index::open_db()?;
        let dataset = dataset::default();
        let all_tags = index::all_tags(&conn, dataset)?;
        Ok(Self {
            cfg,
            dataset,
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
            browse_search_active: false,
            browse_search_buf: String::new(),
            list_pick_purpose: ListPickPurpose::LoadSession,
            coach_messages: Vec::new(),
            coach_scroll: 0,
            leave_solved: false,
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
                self.dataset,
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
                self.dataset,
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

    /// Step to the next problem set. Filters are corpus-specific — a KodCode
    /// tag means nothing in the LeetCode tables — so they reset with the tab.
    fn cycle_dataset(&mut self) -> Result<()> {
        let index = DATASETS
            .iter()
            .position(|d| d.id == self.dataset.id)
            .unwrap_or(0);
        self.dataset = &DATASETS[(index + 1) % DATASETS.len()];
        self.all_tags = index::all_tags(&self.conn, self.dataset)?;
        self.browse.tag_index = 0;
        self.browse.list_name = None;
        self.browse_page = 0;
        self.browse_sel = 0;
        self.reload_browse_page()?;
        self.status = format!(
            "dataset: {} ({} problems)",
            self.dataset.label, self.browse_total
        );
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

    fn cycle_difficulty(&mut self) -> Result<()> {
        self.browse.difficulty = match self.browse.difficulty.as_deref() {
            None => Some("Easy".into()),
            Some("Easy") => Some("Medium".into()),
            Some("Medium") => Some("Hard".into()),
            _ => None,
        };
        self.browse_page = 0;
        self.browse_sel = 0;
        self.reload_browse_page()?;
        self.status = format!(
            "difficulty: {}",
            self.browse
                .difficulty
                .as_deref()
                .unwrap_or("any")
        );
        Ok(())
    }

    fn difficulty_label(&self) -> &str {
        self.browse.difficulty.as_deref().unwrap_or("any")
    }

    fn apply_browse_search(&mut self) -> Result<()> {
        let q = self.browse_search_buf.trim().to_string();
        self.browse.slug_query = if q.is_empty() { None } else { Some(q) };
        self.browse_page = 0;
        self.browse_sel = 0;
        self.browse_search_active = false;
        self.reload_browse_page()?;
        self.status = match &self.browse.slug_query {
            Some(q) => format!("search: {q}"),
            None => "search cleared".into(),
        };
        Ok(())
    }

    fn open_browse(&mut self, filter: BrowseFilter, from: Screen) -> Result<()> {
        self.browse = filter;
        self.browse_page = 0;
        self.browse_sel = 0;
        self.browse_search_active = false;
        self.browse_search_buf = self
            .browse
            .slug_query
            .clone()
            .unwrap_or_default();
        self.back_screen = from;
        self.screen = Screen::Browse;
        self.reload_browse_page()?;
        Ok(())
    }

    fn pick_random(&mut self) -> Result<()> {
        let row = index::random_one(
            &self.conn,
            self.dataset,
            self.browse.difficulty.as_deref(),
            self.current_tag_filter(),
            self.browse.slug_query.as_deref(),
        )?
        .ok_or_else(|| anyhow::anyhow!("no problem matches those filters"))?;
        self.selected_problem = Some(row.clone());
        let _ = self.session.add_to_queue(&row.key());
        self.screen = Screen::ProblemActions;
        self.menu_sel = 0;
        self.status = format!("random: {}", row.task_id);
        Ok(())
    }

    fn open_list_pick(&mut self, purpose: ListPickPurpose, back: Screen) -> Result<()> {
        self.list_names = index::list_names(&self.conn)?;
        self.list_pick_purpose = purpose;
        self.back_screen = back;
        self.screen = Screen::ListPick;
        self.menu_sel = 0;
        Ok(())
    }

    fn add_task_to_list(&mut self, list_name: &str, task_id: &str) -> Result<()> {
        let n = lists::add_tasks(&self.conn, list_name, &[task_id.to_string()])?;
        self.status = if n > 0 {
            format!("added {task_id} to list {list_name:?}")
        } else {
            format!("{task_id} already in list {list_name:?}")
        };
        Ok(())
    }

    fn random_add_to_list(&mut self, list_name: &str) -> Result<()> {
        let row = index::random_one(
            &self.conn,
            self.dataset,
            self.browse.difficulty.as_deref(),
            self.current_tag_filter(),
            self.browse.slug_query.as_deref(),
        )?
        .ok_or_else(|| anyhow::anyhow!("no problem matches current filters"))?;
        let n = lists::add_tasks(&self.conn, list_name, &[row.task_id.clone()])?;
        self.status = if n > 0 {
            format!("random add: {} → list {list_name:?}", row.task_id)
        } else {
            format!("random pick {} already in list {list_name:?}", row.task_id)
        };
        Ok(())
    }

    fn resolve_input_list_name(&mut self) -> Result<()> {
        let name = self.input_buf.trim().to_string();
        if name.is_empty() {
            bail!("enter a list name");
        }
        let _ = lists::create(&self.conn, &name)?;
        self.input_buf.clear();
        match self.list_pick_purpose.clone() {
            ListPickPurpose::LoadSession => {
                self.list_names = index::list_names(&self.conn)?;
                self.screen = Screen::ListPick;
            }
            ListPickPurpose::AddTask { task_id } => {
                self.add_task_to_list(&name, &task_id)?;
                self.screen = self.back_screen;
            }
            ListPickPurpose::AddRandom => {
                self.random_add_to_list(&name)?;
                self.screen = self.back_screen;
            }
        }
        Ok(())
    }

    fn resolve_input_id(&mut self) -> Result<()> {
        let id = self.input_buf.trim().to_string();
        if id.is_empty() {
            bail!("enter a problem id");
        }
        let row = loader::resolve_in(&self.conn, self.dataset, &id)?;
        self.session.add_to_queue(&row.key())?;
        self.selected_problem = Some(row);
        self.input_buf.clear();
        self.screen = Screen::ProblemActions;
        self.menu_sel = 0;
        self.status = "added to session".into();
        Ok(())
    }

    /// `target`: "canvas" | "ide" | "tui"
    fn open_problem_target(&mut self, target: &str) -> Result<()> {
        let row = self.selected_problem.clone().context("no problem")?;
        let json_path = Path::new(&row.json_path);
        let prob = problem::load_task_for(self.dataset, json_path, &row.task_id)?;
        let dir = generator::generate(&self.cfg, self.dataset, &prob, json_path, false)?;
        self.session.mark_loaded(&row.key())?;
        let _ = self.session.add_to_queue(&row.key());
        self.session = Session::load_or_new()?;
        match target {
            "ide" => {
                generator::open_in_editor_quiet(&dir);
                self.status = format!("opened in IDE · {}", dir.display());
            }
            "canvas" => {
                let port = self.cfg.serve.port;
                let url = format!(
                    "http://127.0.0.1:{port}/?task={}&dataset={}",
                    row.task_id, self.dataset.id
                );
                self.status = format!(
                    "canvas: open whiteboard at {url} (run `lc serve` if needed) · {}",
                    dir.display()
                );
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("cmd")
                        .args(["/C", "start", "", &url])
                        .spawn();
                }
                #[cfg(not(windows))]
                {
                    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
                }
            }
            _ => {
                self.status = format!("workspace ready (TUI) · {}", dir.display());
            }
        }
        Ok(())
    }

    fn run_tests(&mut self, kind: &str) -> Result<()> {
        let row = self.selected_problem.clone().context("no problem")?;
        let dir = self.ensure_workspace()?;
        let all_passed =
            runner::cmd_test_quiet_in(&self.cfg, self.dataset, Some(&row.task_id), None, false)?;
        self.session = Session::load_or_new()?;
        if let Some(run) = runner::load_last_run()? {
            if run.task_id == row.task_id {
                let report = runner::format_test_report(&run.results, kind);
                self.push_coach_app_message(&dir, report)?;
            }
        }
        if all_passed {
            let _ = attempt::mark_solved(&dir);
        }
        self.status = if all_passed {
            format!("{} - all tests passed", row.task_id)
        } else if let Some(run) = runner::load_last_run()? {
            let p = run.results.iter().filter(|r| r.pass).count();
            format!("{} - {p}/{} passed", row.task_id, run.results.len())
        } else {
            "tests finished".into()
        };
        Ok(())
    }

    fn submit_locally(&mut self) -> Result<()> {
        let row = self.selected_problem.clone().context("no problem")?;
        let dir = self.ensure_workspace()?;
        // Match GUI: submit also runs tests and posts into the coach thread.
        self.run_tests("submit")?;
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
            self.dataset,
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

    fn workspace_dir(&self) -> Result<PathBuf> {
        let row = self.selected_problem.as_ref().context("no problem")?;
        Ok(self.dataset.workspace_dir(&self.cfg, &row.task_id))
    }

    fn ensure_workspace(&mut self) -> Result<PathBuf> {
        let row = self.selected_problem.clone().context("no problem")?;
        let json_path = Path::new(&row.json_path);
        let prob = problem::load_task_for(self.dataset, json_path, &row.task_id)?;
        let dir = generator::generate(&self.cfg, self.dataset, &prob, json_path, false)?;
        self.session.mark_loaded(&row.key())?;
        let _ = self.session.add_to_queue(&row.key());
        self.session = Session::load_or_new()?;
        Ok(dir)
    }

    fn edit_solution(&mut self, terminal: &mut TuiTerminal) -> Result<()> {
        let dir = self.ensure_workspace()?;
        let path = dir.join("solution.py");
        with_suspended_tui(terminal, || generator::open_in_terminal_editor(&path))?;
        self.status = format!("edited {}", path.display());
        Ok(())
    }

    fn open_workspace_folder(&mut self) -> Result<()> {
        let dir = self.ensure_workspace()?;
        generator::open_workspace_folder(&dir);
        self.status = format!("opened folder {}", dir.display());
        Ok(())
    }

    fn open_coach_chat(&mut self) -> Result<()> {
        let dir = self.ensure_workspace()?;
        self.coach_messages = attempt::read_tui_agent(&dir)?.messages;
        self.coach_scroll = 0;
        self.input_buf.clear();
        self.screen = Screen::CoachChat;
        self.status = "coach: type a question · Enter send · Esc back · w/s scroll".into();
        Ok(())
    }

    fn persist_coach(&self, dir: &Path) -> Result<()> {
        attempt::write_tui_agent(dir, self.coach_messages.clone())?;
        Ok(())
    }

    fn push_coach_app_message(&mut self, dir: &Path, content: String) -> Result<()> {
        self.coach_messages = attempt::read_tui_agent(dir)?.messages;
        self.coach_messages.push(coach_message("app", content));
        self.persist_coach(dir)?;
        Ok(())
    }

    fn send_coach_message(&mut self, terminal: &mut TuiTerminal) -> Result<()> {
        let text = self.input_buf.trim().to_string();
        if text.is_empty() {
            return Ok(());
        }
        let row = self.selected_problem.clone().context("no problem")?;
        let dir = self.ensure_workspace()?;
        self.coach_messages.push(coach_message("user", text.clone()));
        self.input_buf.clear();
        self.persist_coach(&dir)?;

        self.status = "asking the coach…".into();
        terminal.draw(|f| draw(f, self))?;

        let reply = match self.ask_coach(&row, &dir) {
            Ok(answer) => answer,
            Err(err) => format!("(coach error)\n{err:#}"),
        };
        self.coach_messages.push(coach_message("assistant", reply));
        self.persist_coach(&dir)?;
        self.status = "coach replied · Esc back".into();
        hard_refresh(terminal)?;
        Ok(())
    }

    fn ask_coach(&self, row: &ProblemRow, dir: &Path) -> Result<String> {
        let json_path = Path::new(&row.json_path);
        let prob = problem::load_task_for(self.dataset, json_path, &row.task_id)?;
        let desc = prob.problem_description.unwrap_or_default();
        let solution = std::fs::read_to_string(dir.join("solution.py")).unwrap_or_default();
        let mut messages = vec![ChatMessage::system(COACH_SYSTEM)];
        let context = format!(
            "task_id: {}\ndataset: {}\ndifficulty: {}\ntags: {}\n\n--- problem ---\n{desc}\n\n--- solution.py ---\n{solution}",
            row.task_id,
            self.dataset.id,
            row.difficulty.as_deref().unwrap_or("?"),
            row.tags.join(", "),
        );
        for msg in &self.coach_messages {
            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
            match role {
                "user" => messages.push(ChatMessage::user(content.to_string())),
                "assistant" => messages.push(ChatMessage::assistant(content.to_string())),
                "app" => messages.push(ChatMessage::user(format!("[Tests]\n{content}"))),
                _ => {}
            }
        }
        // Workspace snapshot as the first user turn after system.
        messages.insert(1, ChatMessage::user(context));
        let provider = llm::make_provider(&self.cfg, None)?;
        let reply = provider.chat_ex(&ChatRequest::new(messages))?;
        Ok(reply.content)
    }

    fn workspace_needs_leave_prompt(&self) -> bool {
        let Ok(dir) = self.workspace_dir() else {
            return false;
        };
        dir.join(".lc").exists()
    }

    fn begin_leave_confirm(&mut self) -> Result<()> {
        let dir = self.workspace_dir()?;
        let state = attempt::read_state(&dir).unwrap_or_default();
        self.leave_solved = state.solved;
        self.screen = Screen::LeaveConfirm;
        self.menu_sel = 0;
        self.status = if self.leave_solved {
            "this attempt is solved - choose save or clear".into()
        } else {
            "save progress or discard before leaving".into()
        };
        Ok(())
    }

    fn confirm_leave(&mut self, save: bool) -> Result<()> {
        let row = self.selected_problem.clone().context("no problem")?;
        let dir = self.workspace_dir()?;
        let json_path = Path::new(&row.json_path);
        let prob = problem::load_task_for(self.dataset, json_path, &row.task_id)?;
        let starter = generator::code_body(&prob);
        let state = attempt::read_state(&dir).unwrap_or_default();
        let solved = state.solved;
        // Flush TUI coach before finish archives/clears it.
        let _ = self.persist_coach(&dir);
        attempt::finish(&dir, solved, save, Some(&starter))?;
        self.coach_messages.clear();
        self.screen = Screen::Browse;
        self.menu_sel = 0;
        self.status = if save {
            "saved - back to browse".into()
        } else {
            "discarded - back to browse".into()
        };
        Ok(())
    }
}

fn coach_message(role: &str, content: String) -> serde_json::Value {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    serde_json::json!({
        "id": format!("tui-{at}-{}", rand::random::<u32>()),
        "role": role,
        "content": content,
        "at": at,
    })
}

fn run_app(terminal: &mut TuiTerminal, cfg: &Config) -> Result<()> {
    let mut app = App::new(cfg.clone())?;
    app.status = "WASD navigate · Enter select · Esc back · q quit".into();

    loop {
        terminal.draw(|f| draw(f, &mut app))?;
        if event::poll(Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                if handle_key(&mut app, terminal, key)? {
                    break;
                }
            }
        }
    }
    Ok(())
}

fn handle_key(app: &mut App, terminal: &mut TuiTerminal, key: KeyEvent) -> Result<bool> {
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
            app.screen = Screen::ProblemActions;
            app.menu_sel = 0;
            app.input_buf.clear();
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
        KeyCode::Char('w') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.coach_scroll = app.coach_scroll.saturating_sub(1);
        }
        KeyCode::Char('s') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.coach_scroll = app.coach_scroll.saturating_add(1);
        }
        KeyCode::Up => {
            app.coach_scroll = app.coach_scroll.saturating_sub(1);
        }
        KeyCode::Down => {
            app.coach_scroll = app.coach_scroll.saturating_add(1);
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.input_buf.push(c);
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
        Screen::StartSession => 6,
        Screen::ChooseProblems => 3,
        Screen::DifficultyPick => 4,
        Screen::ListPick => app.list_names.len() + 2,
        Screen::Browse => app.browse_rows.len(),
        Screen::ProblemActions => 10,
        Screen::LeaveConfirm => 3,
        Screen::Settings => 7,
        Screen::Help => 1,
        Screen::InputId | Screen::InputListName | Screen::Message | Screen::CoachChat => 0,
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
            4 => return Ok(true),
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
                    "data={} · workspace={} · python={}",
                    app.cfg.data.json_dir.as_deref().unwrap_or("(unset)"),
                    app.cfg.workspace.dir,
                    app.cfg.python.executable
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
        Screen::InputId | Screen::InputListName | Screen::Message | Screen::CoachChat => {}
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
        Screen::CoachChat => draw_coach_chat(f, chunks[1], app),
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

fn draw_coach_chat(f: &mut Frame, area: Rect, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(4), Constraint::Length(3)])
        .split(area);

    let mut lines: Vec<Line> = Vec::new();
    if app.coach_messages.is_empty() {
        lines.push(Line::from(Span::styled(
            "(empty thread - ask about the problem, your solution, or a failing test)",
            Style::default().fg(Color::DarkGray),
        )));
    }
    for msg in &app.coach_messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("?");
        let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let (label, style) = match role {
            "user" => ("You", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            "assistant" => ("Coach", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
            "app" => ("Tests", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            _ => ("?", Style::default().fg(Color::DarkGray)),
        };
        lines.push(Line::from(Span::styled(label, style)));
        for line in content.lines() {
            lines.push(Line::from(format!("  {line}")));
        }
        lines.push(Line::from(""));
    }

    let height = chunks[0].height.saturating_sub(2) as usize;
    let max_scroll = lines.len().saturating_sub(height.max(1));
    let scroll = app.coach_scroll.min(max_scroll);
    let visible: Vec<Line> = lines.into_iter().skip(scroll).take(height.max(1)).collect();

    let thread = Paragraph::new(visible)
        .wrap(Wrap { trim: false })
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("coach chat (Up/Down scroll · Esc back)"),
        );
    f.render_widget(thread, chunks[0]);

    let composer = Paragraph::new(format!("> {}_", app.input_buf)).block(
        Block::default()
            .borders(Borders::ALL)
            .title("message · Enter send"),
    );
    f.render_widget(composer, chunks[1]);
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
        Screen::CoachChat => "type · Enter send · Up/Down scroll · Esc back",
        Screen::LeaveConfirm => "W/S choose · Enter confirm · Esc cancel",
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

/// Leave the alternate screen, run `f`, then restore and hard-refresh.
fn with_suspended_tui<T>(
    terminal: &mut TuiTerminal,
    f: impl FnOnce() -> Result<T>,
) -> Result<T> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        crossterm::cursor::Show
    )?;
    terminal.show_cursor()?;

    let result = f();

    enable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        EnterAlternateScreen,
        crossterm::cursor::Hide
    )?;
    hard_refresh(terminal)?;
    drain_pending_keys();
    result
}

fn hard_refresh(terminal: &mut TuiTerminal) -> Result<()> {
    let size = terminal.size()?;
    let _ = terminal.resize(Rect::new(0, 0, size.width, size.height));
    terminal.clear()?;
    Ok(())
}

fn drain_pending_keys() {
    while event::poll(Duration::from_millis(0)).unwrap_or(false) {
        let _ = event::read();
    }
}
