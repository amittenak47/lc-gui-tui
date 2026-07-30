//! Terminal ASCII morph — the idea behind
//! [ascii-morph](https://github.com/tholman/ascii-morph), in Rust for ratatui.
//!
//! The browser library tweens between two ASCII pictures in a `<pre>`/canvas.
//! Here we do the same thing against a list of **keyframes** the coach (or a
//! demo) supplies:
//!
//! 1. Pad every frame to a shared width × height (spaces).
//! 2. Between keyframe *i* and *i+1*, for each cell pick A or B by a stable
//!    hash of `(row, col)` vs progress `t ∈ [0,1]` — a dissolve morph.
//! 3. The TUI ticks `AsciiPlayer` on a timer and redraws the current canvas.
//!
//! Models should emit **semantic keyframes** (array values, highlights), not
//! morph math. [`frames_from_array_steps`] turns those into ASCII; the player
//! handles time.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// One still the agent (or a demo) authored.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AsciiKeyframe {
    /// Short caption under the picture (e.g. "swap i=1 and i=2").
    #[serde(default)]
    pub label: String,
    /// Rows of equal-ish width; we pad when morphing.
    pub lines: Vec<String>,
}

/// What a coach tool would send: title + ordered keyframes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AsciiAnimProgram {
    #[serde(default)]
    pub title: String,
    pub frames: Vec<AsciiKeyframe>,
}

/// Live playback state for the TUI.
#[derive(Debug, Clone)]
pub struct AsciiPlayer {
    pub program: AsciiAnimProgram,
    /// Index of the keyframe we are morphing *from*.
    from: usize,
    /// 0.0..=1.0 progress toward the next keyframe.
    t: f32,
    /// Wall time for the current segment.
    segment_started: Instant,
    /// How long each morph takes.
    pub morph_ms: u64,
    /// Hold on the last frame (loop restarts after this).
    pub hold_ms: u64,
    pub looping: bool,
    finished_hold_started: Option<Instant>,
}

impl AsciiPlayer {
    pub fn new(program: AsciiAnimProgram) -> Self {
        Self {
            program,
            from: 0,
            t: 0.0,
            segment_started: Instant::now(),
            morph_ms: 450,
            hold_ms: 700,
            looping: true,
            finished_hold_started: None,
        }
    }

    pub fn restart(&mut self) {
        self.from = 0;
        self.t = 0.0;
        self.segment_started = Instant::now();
        self.finished_hold_started = None;
    }

    /// Advance time. Call once per UI frame (~30–60 Hz).
    pub fn tick(&mut self) {
        let n = self.program.frames.len();
        if n == 0 {
            return;
        }
        if n == 1 {
            self.t = 1.0;
            return;
        }

        if self.from + 1 >= n {
            // Holding on the final frame.
            let hold = self.finished_hold_started.get_or_insert_with(Instant::now);
            if self.looping && hold.elapsed() >= Duration::from_millis(self.hold_ms) {
                self.restart();
            }
            self.t = 1.0;
            return;
        }

        let elapsed = self.segment_started.elapsed().as_millis() as f32;
        let dur = self.morph_ms.max(1) as f32;
        self.t = (elapsed / dur).clamp(0.0, 1.0);

        if self.t >= 1.0 {
            self.from += 1;
            self.t = 0.0;
            self.segment_started = Instant::now();
            if self.from + 1 >= n {
                self.finished_hold_started = Some(Instant::now());
                self.t = 1.0;
            }
        }
    }

    /// Canvas for the current instant (morphed between two keyframes).
    pub fn current_lines(&self) -> Vec<String> {
        let frames = &self.program.frames;
        if frames.is_empty() {
            return vec!["(empty animation)".into()];
        }
        if frames.len() == 1 || self.from + 1 >= frames.len() {
            return frames[self.from.min(frames.len() - 1)].lines.clone();
        }
        morph_frames(&frames[self.from], &frames[self.from + 1], self.t)
    }

    pub fn current_label(&self) -> &str {
        let frames = &self.program.frames;
        if frames.is_empty() {
            return "";
        }
        // Show the destination label once we are mostly there.
        let idx = if self.t >= 0.5 {
            (self.from + 1).min(frames.len() - 1)
        } else {
            self.from.min(frames.len() - 1)
        };
        frames[idx].label.as_str()
    }

    pub fn progress_hint(&self) -> String {
        let n = self.program.frames.len().max(1);
        let at = (self.from + 1).min(n);
        format!("frame {at}/{n}  t={:.2}", self.t)
    }
}

/// Dissolve morph between two ASCII stills (ascii-morph's core idea).
///
/// Each cell gets a stable threshold from `(row, col)`. When `t` crosses it,
/// the cell flips from A to B — staggered so the picture “melts” rather than
/// hard-cuts.
pub fn morph_frames(a: &AsciiKeyframe, b: &AsciiKeyframe, t: f32) -> Vec<String> {
    let (a_grid, b_grid, rows, cols) = normalize_pair(a, b);
    let t = t.clamp(0.0, 1.0);
    let mut out = Vec::with_capacity(rows);
    for r in 0..rows {
        let mut line = String::with_capacity(cols);
        for c in 0..cols {
            // t==0 → all A; t==1 → all B; otherwise dissolve by stable threshold.
            let ch = if t <= 0.0 {
                a_grid[r][c]
            } else if t >= 1.0 {
                b_grid[r][c]
            } else if t >= cell_threshold(r, c) {
                b_grid[r][c]
            } else {
                a_grid[r][c]
            };
            line.push(ch);
        }
        out.push(line);
    }
    out
}

fn cell_threshold(row: usize, col: usize) -> f32 {
    // Stable (0, 1) — never 0 or 1, so the endpoints stay pure A / pure B.
    let h = row
        .wrapping_mul(374761393)
        .wrapping_add(col.wrapping_mul(668265263));
    0.001 + ((h % 998) as f32) / 1000.0
}

fn normalize_pair(
    a: &AsciiKeyframe,
    b: &AsciiKeyframe,
) -> (Vec<Vec<char>>, Vec<Vec<char>>, usize, usize) {
    let rows = a.lines.len().max(b.lines.len()).max(1);
    let cols = a
        .lines
        .iter()
        .chain(b.lines.iter())
        .map(|l| l.chars().count())
        .max()
        .unwrap_or(1)
        .max(1);
    (pad_grid(&a.lines, rows, cols), pad_grid(&b.lines, rows, cols), rows, cols)
}

fn pad_grid(lines: &[String], rows: usize, cols: usize) -> Vec<Vec<char>> {
    let mut grid = Vec::with_capacity(rows);
    for r in 0..rows {
        let mut row: Vec<char> = lines
            .get(r)
            .map(|l| l.chars().collect())
            .unwrap_or_default();
        if row.len() < cols {
            row.extend(std::iter::repeat(' ').take(cols - row.len()));
        } else {
            row.truncate(cols);
        }
        grid.push(row);
    }
    grid
}

/// Render one array state as a fixed-width ASCII picture.
pub fn render_array(values: &[i32], highlight: &[usize], label: &str) -> AsciiKeyframe {
    let n = values.len();
    let cell_w = values
        .iter()
        .map(|v| v.to_string().len())
        .max()
        .unwrap_or(1)
        .max(2);

    let mut index_row = String::from(" idx ");
    let mut value_row = String::from(" val ");
    let mut mark_row = String::from("     ");

    for i in 0..n {
        let num = format!("{:>width$}", values[i], width = cell_w);
        let idx = format!("{:>width$}", i, width = cell_w);
        let mark = if highlight.contains(&i) {
            format!("{:^width$}", "^", width = cell_w)
        } else {
            " ".repeat(cell_w)
        };
        if i > 0 {
            index_row.push(' ');
            value_row.push(' ');
            mark_row.push(' ');
        }
        index_row.push('|');
        value_row.push('|');
        mark_row.push(' ');
        index_row.push_str(&idx);
        value_row.push_str(&num);
        mark_row.push_str(&mark);
    }
    index_row.push('|');
    value_row.push('|');

    AsciiKeyframe {
        label: label.into(),
        lines: vec![index_row, value_row, mark_row],
    }
}

/// Build an animation from array snapshots `(values, highlights, label)`.
pub fn frames_from_array_steps(steps: &[(Vec<i32>, Vec<usize>, &str)]) -> AsciiAnimProgram {
    AsciiAnimProgram {
        title: "array walk".into(),
        frames: steps
            .iter()
            .map(|(vals, hi, label)| render_array(vals, hi, label))
            .collect(),
    }
}

/// Built-in demo: bubble-sort one pass so you can see the morph in the TUI.
pub fn bubble_sort_demo() -> AsciiAnimProgram {
    let mut a = vec![5, 1, 4, 2, 8];
    let mut steps: Vec<(Vec<i32>, Vec<usize>, &str)> = vec![(
        a.clone(),
        vec![],
        "start — bubble sort, one outer pass",
    )];

    let n = a.len();
    for i in 0..n.saturating_sub(1) {
        for j in 0..n - 1 - i {
            steps.push((a.clone(), vec![j, j + 1], "compare neighbors"));
            if a[j] > a[j + 1] {
                a.swap(j, j + 1);
                steps.push((a.clone(), vec![j, j + 1], "swap"));
            }
        }
    }
    steps.push((a, vec![], "pass done — largest value bubbled right"));

    let mut program = frames_from_array_steps(&steps);
    program.title = "bubble sort (ASCII morph demo)".into();
    program
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn morph_at_zero_matches_a_and_at_one_matches_b() {
        let a = AsciiKeyframe {
            label: "a".into(),
            lines: vec!["AAAA".into(), "AAAA".into()],
        };
        let b = AsciiKeyframe {
            label: "b".into(),
            lines: vec!["BBBB".into(), "BBBB".into()],
        };
        assert_eq!(morph_frames(&a, &b, 0.0), a.lines);
        assert_eq!(morph_frames(&a, &b, 1.0), b.lines);
    }

    #[test]
    fn morph_midway_is_a_mix() {
        let a = AsciiKeyframe {
            label: "a".into(),
            lines: vec!["..........".into()],
        };
        let b = AsciiKeyframe {
            label: "b".into(),
            lines: vec!["XXXXXXXXXX".into()],
        };
        let mid = morph_frames(&a, &b, 0.5);
        let line = &mid[0];
        assert!(line.contains('.'));
        assert!(line.contains('X'));
    }

    #[test]
    fn array_render_marks_highlights() {
        let frame = render_array(&[3, 1, 2], &[1], "probe");
        assert_eq!(frame.label, "probe");
        assert!(frame.lines[1].contains('1'));
        assert!(frame.lines[2].contains('^'));
    }

    #[test]
    fn bubble_demo_has_several_frames() {
        let demo = bubble_sort_demo();
        assert!(demo.frames.len() > 3);
        // Find two consecutive frames whose value rows differ (a real swap).
        let pair = demo.frames.windows(2).find(|w| w[0].lines != w[1].lines);
        let (a, b) = pair.map(|w| (&w[0], &w[1])).expect("demo should change");
        let mid = morph_frames(a, b, 0.5);
        assert_ne!(mid, a.lines);
        assert_ne!(mid, b.lines);
    }
}
