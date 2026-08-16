use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

use super::ascii_morph::{self, AsciiAnimProgram, AsciiPlayer};
use crate::attempt;
use crate::config::Config;
use crate::dataset::{self, Dataset, DATASETS};
use crate::index::{self, ProblemRow, SearchSort};
use crate::llm::coach::{format_review_card, review_submission_text_only, BoardSnapshot};
use crate::llm::make_provider_for_mode;
use crate::session::Session;
use crate::{generator, lists, loader, problem, runner};

use super::coach::{coach_message, coach_message_with_anim, viz_json_fallback, viz_programs_from_reply};
use super::draw::draw;
use super::{hard_refresh, with_suspended_tui, TuiTerminal, PAGE_SIZE};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Screen {
    Main,
    StartSession,
    ChooseProblems,
    DifficultyPick,
    ListPick,
    Browse,
    ProblemActions,
    CoachChat,
    AsciiAnim,
    LeaveConfirm,
    InputId,
    InputListName,
    Settings,
    Help,
    Message,
}

pub(crate) struct BrowseFilter {
    pub(crate) difficulty: Option<String>,
    pub(crate) tag_index: usize,
    pub(crate) list_name: Option<String>,
    pub(crate) slug_query: Option<String>,
}

#[derive(Clone)]
pub(crate) enum ListPickPurpose {
    LoadSession,
    AddTask { task_id: String },
    AddRandom,
}

pub(crate) struct App {
    pub(crate) cfg: Config,
    /// Which problem set is being browsed. `G` cycles it; the GUI shows the
    /// same choice as the tab strip over the table.
    pub(crate) dataset: &'static Dataset,
    pub(crate) session: Session,
    pub(crate) conn: rusqlite::Connection,
    pub(crate) screen: Screen,
    pub(crate) menu_sel: usize,
    pub(crate) status: String,
    pub(crate) all_tags: Vec<String>,
    pub(crate) browse: BrowseFilter,
    pub(crate) browse_sort: SearchSort,
    pub(crate) browse_page: u32,
    pub(crate) browse_sel: usize,
    pub(crate) browse_rows: Vec<ProblemRow>,
    pub(crate) browse_total: u32,
    pub(crate) list_names: Vec<String>,
    pub(crate) selected_problem: Option<ProblemRow>,
    pub(crate) input_buf: String,
    pub(crate) message_lines: Vec<String>,
    pub(crate) message_scroll: usize,
    pub(crate) difficulty_pick_for: Screen,
    pub(crate) back_screen: Screen,
    pub(crate) browse_search_active: bool,
    pub(crate) browse_search_buf: String,
    pub(crate) list_pick_purpose: ListPickPurpose,
    /// TUI coach thread (mirrors `.lc/agent.tui.json`).
    pub(crate) coach_messages: Vec<serde_json::Value>,
    pub(crate) coach_scroll: usize,
    /// Live ASCII morph demo / future coach viz playback.
    pub(crate) ascii_player: Option<AsciiPlayer>,
    /// Message `id` whose bubble currently owns the live player.
    pub(crate) ascii_msg_id: Option<String>,
    /// When true, coach chat also asks the viz model to `animate_trace` and
    /// morphs the result inline under that reply.
    pub(crate) coach_draw: bool,
    /// Cached solved flag for the leave-confirm labels.
    pub(crate) leave_solved: bool,
}

impl App {
    pub(crate) fn new(cfg: Config) -> Result<Self> {
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
            ascii_player: None,
            ascii_msg_id: None,
            coach_draw: false,
            leave_solved: false,
        })
    }

    pub(crate) fn reload_browse_page(&mut self) -> Result<()> {
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

    pub(crate) fn tag_label(&self) -> String {
        if self.browse.tag_index == 0 {
            "all tags".into()
        } else {
            self.all_tags
                .get(self.browse.tag_index - 1)
                .cloned()
                .unwrap_or_else(|| "?".into())
        }
    }

    pub(crate) fn cycle_tag(&mut self) -> Result<()> {
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
    pub(crate) fn cycle_dataset(&mut self) -> Result<()> {
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

    pub(crate) fn cycle_sort(&mut self) -> Result<()> {
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

    pub(crate) fn cycle_difficulty(&mut self) -> Result<()> {
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

    pub(crate) fn difficulty_label(&self) -> &str {
        self.browse.difficulty.as_deref().unwrap_or("any")
    }

    pub(crate) fn apply_browse_search(&mut self) -> Result<()> {
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

    pub(crate) fn open_browse(&mut self, filter: BrowseFilter, from: Screen) -> Result<()> {
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

    pub(crate) fn pick_random(&mut self) -> Result<()> {
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

    pub(crate) fn open_list_pick(&mut self, purpose: ListPickPurpose, back: Screen) -> Result<()> {
        self.list_names = index::list_names(&self.conn)?;
        self.list_pick_purpose = purpose;
        self.back_screen = back;
        self.screen = Screen::ListPick;
        self.menu_sel = 0;
        Ok(())
    }

    pub(crate) fn add_task_to_list(&mut self, list_name: &str, task_id: &str) -> Result<()> {
        let n = lists::add_tasks(&self.conn, list_name, &[task_id.to_string()])?;
        self.status = if n > 0 {
            format!("added {task_id} to list {list_name:?}")
        } else {
            format!("{task_id} already in list {list_name:?}")
        };
        Ok(())
    }

    pub(crate) fn random_add_to_list(&mut self, list_name: &str) -> Result<()> {
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

    pub(crate) fn resolve_input_list_name(&mut self) -> Result<()> {
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

    pub(crate) fn resolve_input_id(&mut self) -> Result<()> {
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
    pub(crate) fn open_problem_target(&mut self, target: &str) -> Result<()> {
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
                self.status = format!(
                    "open the Whiteboard app for {} · {}",
                    row.task_id,
                    dir.display()
                );
            }
            _ => {
                self.status = format!("workspace ready (TUI) · {}", dir.display());
            }
        }
        Ok(())
    }

    pub(crate) fn run_tests(&mut self, kind: &str) -> Result<()> {
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

    pub(crate) fn submit_locally(&mut self) -> Result<()> {
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

    pub(crate) fn workspace_dir(&self) -> Result<PathBuf> {
        let row = self.selected_problem.as_ref().context("no problem")?;
        Ok(self.dataset.workspace_dir(&self.cfg, &row.task_id))
    }

    pub(crate) fn ensure_workspace(&mut self) -> Result<PathBuf> {
        let row = self.selected_problem.clone().context("no problem")?;
        let dir = self.dataset.workspace_dir(&self.cfg, &row.task_id);
        if dir.join(".lc").join("meta.json").exists() {
            self.session.mark_loaded(&row.key())?;
            let _ = self.session.add_to_queue(&row.key());
            self.session = Session::load_or_new()?;
            return Ok(dir);
        }
        let json_path = Path::new(&row.json_path);
        let prob = problem::load_task_for(self.dataset, json_path, &row.task_id)?;
        let dir = generator::generate(&self.cfg, self.dataset, &prob, json_path, false)?;
        self.session.mark_loaded(&row.key())?;
        let _ = self.session.add_to_queue(&row.key());
        self.session = Session::load_or_new()?;
        Ok(dir)
    }

    pub(crate) fn edit_solution(&mut self, terminal: &mut TuiTerminal) -> Result<()> {
        let dir = self.ensure_workspace()?;
        let path = dir.join("solution.py");
        with_suspended_tui(terminal, || generator::open_in_terminal_editor(&path))?;
        self.status = format!("edited {}", path.display());
        Ok(())
    }

    pub(crate) fn open_workspace_folder(&mut self) -> Result<()> {
        let dir = self.ensure_workspace()?;
        generator::open_workspace_folder(&dir);
        self.status = format!("opened folder {}", dir.display());
        Ok(())
    }

    pub(crate) fn open_coach_chat(&mut self) -> Result<()> {
        let dir = self.ensure_workspace()?;
        self.coach_messages = attempt::read_tui_agent(&dir)?.messages;
        self.coach_scroll = 0;
        self.input_buf.clear();
        self.screen = Screen::CoachChat;
        // Resume an animation saved on the latest coach turn, if any.
        self.bind_ascii_from_latest_message();
        self.status = format!(
            "coach: Enter send · d draw={} · Esc back · ↑↓/wheel scroll",
            if self.coach_draw { "on" } else { "off" }
        );
        Ok(())
    }

    fn bind_ascii_from_latest_message(&mut self) {
        self.ascii_player = None;
        self.ascii_msg_id = None;
        for msg in self.coach_messages.iter().rev() {
            if let Some(anim) = msg
                .get("ascii_anim")
                .and_then(|v| serde_json::from_value::<AsciiAnimProgram>(v.clone()).ok())
            {
                if anim.frames.is_empty() {
                    continue;
                }
                let id = msg
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                self.ascii_msg_id = Some(id);
                self.ascii_player = Some(AsciiPlayer::new(anim));
                break;
            }
        }
    }

    pub(crate) fn persist_coach(&self, dir: &Path) -> Result<()> {
        attempt::write_tui_agent(dir, self.coach_messages.clone())?;
        Ok(())
    }

    fn push_coach_app_message(&mut self, dir: &Path, content: String) -> Result<()> {
        self.coach_messages = attempt::read_tui_agent(dir)?.messages;
        self.coach_messages.push(coach_message("app", content));
        self.persist_coach(dir)?;
        Ok(())
    }

    pub(crate) fn send_coach_message(&mut self, terminal: &mut TuiTerminal) -> Result<()> {
        let text = self.input_buf.trim().to_string();
        if text.is_empty() {
            return Ok(());
        }
        let row = self.selected_problem.clone().context("no problem")?;
        let dir = self.ensure_workspace()?;
        self.coach_messages.push(coach_message("user", text.clone()));
        self.input_buf.clear();
        self.persist_coach(&dir)?;

        self.status = if self.coach_draw {
            "asking the coach (+ draw)…".into()
        } else {
            "asking the coach…".into()
        };
        terminal.draw(|f| draw(f, self))?;

        let (reply, anim) = match self.ask_coach(&row, &dir) {
            Ok(pair) => pair,
            Err(err) => (format!("(coach error)\n{err:#}"), None),
        };
        let msg = coach_message_with_anim("assistant", reply, anim.as_ref());
        let msg_id = msg
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        self.coach_messages.push(msg);
        if let Some(program) = anim {
            self.ascii_msg_id = Some(msg_id);
            self.ascii_player = Some(AsciiPlayer::new(program));
            // Jump to the bottom so the live bubble is visible.
            self.coach_scroll = usize::MAX / 4;
        }
        self.persist_coach(&dir)?;
        self.status = if self.coach_draw {
            "coach replied · animation morphs in-thread · Esc back".into()
        } else {
            "coach replied · Esc back".into()
        };
        hard_refresh(terminal)?;
        Ok(())
    }

    fn ask_coach(&self, row: &ProblemRow, dir: &Path) -> Result<(String, Option<AsciiAnimProgram>)> {
        let meta = runner::read_meta(dir)?;
        let json_path = Path::new(&row.json_path);
        let description = problem::load_task_for(self.dataset, json_path, &row.task_id)
            .ok()
            .and_then(|p| p.problem_description);
        let solution = std::fs::read_to_string(dir.join("solution.py")).unwrap_or_default();

        let question = self
            .coach_messages
            .iter()
            .rev()
            .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
            .and_then(|m| m.get("content").and_then(|c| c.as_str()))
            .unwrap_or("")
            .trim();

        let turn_index = self
            .coach_messages
            .iter()
            .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("assistant"))
            .count() as u32;

        let app_messages: Vec<String> = self
            .coach_messages
            .iter()
            .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("app"))
            .filter_map(|m| {
                m.get("content")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string())
            })
            .collect();

        let board = BoardSnapshot {
            recognized_text: if question.is_empty() {
                String::new()
            } else {
                format!("Student question (terminal):\n{question}")
            },
            pseudocode: Some(solution.clone()),
            app_messages,
            turn_index,
            ..Default::default()
        };

        let provider = make_provider_for_mode(&self.cfg, "review")?;
        let outcome = review_submission_text_only(
            &*provider,
            &meta,
            description.as_deref(),
            question,
            &solution,
            &board.app_messages,
            turn_index,
        )?;
        let mut card = format_review_card(&outcome.review);

        let anim = if self.coach_draw {
            match self.ask_ascii_viz(&meta, description.as_deref(), &board, question) {
                Ok(Some(program)) => Some(program),
                Ok(None) => {
                    if let Some(fallback) =
                        ascii_morph::fallback_scan_from_cases("sample-case walk", &meta.cases)
                    {
                        card.push_str("\n\n(draw: showing sample inputs — model trace was empty)");
                        Some(fallback)
                    } else {
                        card.push_str(
                            "\n\n(draw on — no drawable frames; try Ctrl+D off for text-only)",
                        );
                        None
                    }
                }
                Err(err) => {
                    card.push_str(&format!("\n\n(draw failed: {err:#})"));
                    None
                }
            }
        } else {
            None
        };

        Ok((card, anim))
    }

    /// Viz tool loop (same tools as `/coach/viz`), rendered as ASCII morph.
    fn ask_ascii_viz(
        &self,
        meta: &crate::generator::WorkspaceMeta,
        description: Option<&str>,
        board: &BoardSnapshot,
        ask: &str,
    ) -> Result<Option<AsciiAnimProgram>> {
        use crate::llm::coach::{build_viz_prompt, CoachContext, VIZ_SYSTEM_PROMPT};
        use crate::llm::tools::{viz_tools};
        use crate::llm::{ChatMessage, ChatRequest};

        // The terminal coach has no board session to commit an approach in.
        let prompt = build_viz_prompt(meta, description, board, ask, &CoachContext::default());
        let provider = make_provider_for_mode(&self.cfg, "viz")?;
        let messages = vec![
            ChatMessage::system(VIZ_SYSTEM_PROMPT),
            ChatMessage::user(format!(
                "{prompt}\n\nCall `animate_trace` with viz=array (or stack/queue). \
                 Each frame must include full `cells` — the array at that step. \
                 At least 2 frames. One short sentence of prose max."
            )),
        ];

        let reply = match provider.chat_ex(&ChatRequest::new(messages.clone()).with_tools(viz_tools())) {
            Ok(reply) if !reply.tool_calls.is_empty() => reply,
            first => viz_json_fallback(&*provider, &prompt, board, first)?,
        };

        let programs = viz_programs_from_reply(&reply);
        let anim = programs
            .iter()
            .filter(|p| p.frames.len() >= 2)
            .find_map(ascii_morph::from_viz_program)
            .or_else(|| programs.iter().find_map(ascii_morph::from_viz_program));
        Ok(anim)
    }

    pub(crate) fn workspace_needs_leave_prompt(&self) -> bool {
        let Ok(dir) = self.workspace_dir() else {
            return false;
        };
        dir.join(".lc").exists()
    }

    pub(crate) fn begin_leave_confirm(&mut self) -> Result<()> {
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

    pub(crate) fn confirm_leave(&mut self, save: bool) -> Result<()> {
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
        self.ascii_player = None;
        self.ascii_msg_id = None;
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
