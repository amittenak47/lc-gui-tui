use anyhow::Result;
use crossterm::event::{self, DisableMouseCapture, EnableMouseCapture, Event, MouseEventKind};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::{execute, terminal::ClearType};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Rect;
use ratatui::Terminal;
use std::io;
use std::time::Duration;

use crate::config::Config;

mod app;
mod ascii_morph;
mod coach;
mod draw;
mod input;

use input::handle_key;

pub(crate) use app::{App, Screen};
pub(crate) use draw::draw;

pub(crate) type TuiTerminal = Terminal<CrosstermBackend<io::Stdout>>;

pub(crate) const PAGE_SIZE: u32 = 15;

pub(crate) const LC_BANNER: &str = r#"
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

fn run_app(terminal: &mut TuiTerminal, cfg: &Config) -> Result<()> {
    let mut app = App::new(cfg.clone())?;
    app.status = "WASD navigate · Enter select · Esc back · q quit".into();

    loop {
        // Drive morph playback even when no key is pressed.
        if matches!(app.screen, Screen::AsciiAnim | Screen::CoachChat) {
            if let Some(player) = app.ascii_player.as_mut() {
                player.tick();
            }
        }
        terminal.draw(|f| draw(f, &mut app))?;
        // ~30 FPS while animating; idle menus can poll longer.
        let wait = if matches!(app.screen, Screen::AsciiAnim | Screen::CoachChat)
            && app.ascii_player.is_some()
        {
            Duration::from_millis(33)
        } else if app.screen == Screen::AsciiAnim {
            Duration::from_millis(33)
        } else {
            Duration::from_millis(50)
        };
        if event::poll(wait)? {
            match event::read()? {
                Event::Key(key) => {
                    if handle_key(&mut app, terminal, key)? {
                        break;
                    }
                }
                Event::Mouse(mouse) if app.screen == Screen::CoachChat => match mouse.kind {
                    MouseEventKind::ScrollUp => {
                        app.coach_scroll = app.coach_scroll.saturating_sub(3);
                    }
                    MouseEventKind::ScrollDown => {
                        app.coach_scroll = app.coach_scroll.saturating_add(3);
                    }
                    _ => {}
                },
                Event::Mouse(mouse) if app.screen == Screen::Message => match mouse.kind {
                    MouseEventKind::ScrollUp => {
                        app.message_scroll = app.message_scroll.saturating_sub(3);
                    }
                    MouseEventKind::ScrollDown => {
                        app.message_scroll = app.message_scroll.saturating_add(3);
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    }
    Ok(())
}

fn setup_terminal() -> Result<TuiTerminal> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableMouseCapture,
        crossterm::cursor::Hide
    )?;
    Ok(Terminal::new(CrosstermBackend::new(stdout))?)
}

fn restore_terminal(terminal: &mut TuiTerminal) -> Result<()> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        LeaveAlternateScreen,
        crossterm::cursor::Show,
        crossterm::terminal::Clear(ClearType::All)
    )?;
    terminal.show_cursor()?;
    Ok(())
}

/// Leave the alternate screen, run `f`, then restore and hard-refresh.
pub(crate) fn with_suspended_tui<T>(
    terminal: &mut TuiTerminal,
    f: impl FnOnce() -> Result<T>,
) -> Result<T> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        LeaveAlternateScreen,
        crossterm::cursor::Show
    )?;
    terminal.show_cursor()?;

    let result = f();

    enable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        EnterAlternateScreen,
        EnableMouseCapture,
        crossterm::cursor::Hide
    )?;
    hard_refresh(terminal)?;
    drain_pending_keys();
    result
}

pub(crate) fn hard_refresh(terminal: &mut TuiTerminal) -> Result<()> {
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
