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
///
/// Values and `^` markers are **centered** in each cell so the caret sits
/// under the middle of the slot (not left-biased against a right-aligned number).
pub fn render_array(values: &[i32], highlight: &[usize], label: &str) -> AsciiKeyframe {
    let labels: Vec<String> = values.iter().map(|v| v.to_string()).collect();
    render_cells(&labels, highlight, label)
}

/// Same layout as [`render_array`], for string cell labels (viz tool output).
pub fn render_cells(labels: &[String], highlight: &[usize], label: &str) -> AsciiKeyframe {
    let n = labels.len();
    let cell_w = labels
        .iter()
        .map(|v| v.chars().count())
        .max()
        .unwrap_or(1)
        .max(2);

    let mut index_row = String::from(" idx ");
    let mut value_row = String::from(" val ");
    let mut mark_row = String::from("     ");

    for i in 0..n {
        let num = center_in(labels.get(i).map(|s| s.as_str()).unwrap_or(""), cell_w);
        let idx = center_in(&i.to_string(), cell_w);
        let mark = if highlight.contains(&i) {
            center_in("^", cell_w)
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

fn center_in(text: &str, width: usize) -> String {
    let len = text.chars().count();
    if len >= width {
        return text.chars().take(width).collect();
    }
    let pad = width - len;
    let left = pad / 2;
    let right = pad - left;
    format!("{}{}{}", " ".repeat(left), text, " ".repeat(right))
}

/// Turn a viz tool program into ASCII keyframes the TUI can morph.
///
/// Supports linear cell-based kinds (`array`, `stack`, `queue`, `linkedlist`,
/// `heap`). Hashmap / graph / tree layouts stay on the canvas viz path for now.
pub fn from_viz_program(program: &crate::llm::tools::VizProgram) -> Option<AsciiAnimProgram> {
    let kind = program.kind.as_str();
    if !matches!(
        kind,
        "array" | "stack" | "queue" | "linkedlist" | "heap"
    ) {
        return None;
    }

    let mut frames = Vec::new();
    for frame in &program.frames {
        let labels: Vec<String> = frame.cells.iter().map(value_as_label).collect();
        if labels.is_empty() || labels.iter().all(|s| s.is_empty()) {
            continue;
        }
        let label = if frame.label.trim().is_empty() {
            frame.note.trim()
        } else if frame.note.trim().is_empty() {
            frame.label.trim()
        } else {
            // Keep one line under the picture.
            frame.label.trim()
        };
        frames.push(render_cells(&labels, &frame.highlight, label));
    }
    if frames.is_empty() {
        return None;
    }
    Some(AsciiAnimProgram {
        title: if program.title.trim().is_empty() {
            format!("{kind} trace")
        } else {
            program.title.clone()
        },
        frames,
    })
}

fn value_as_label(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "·".into(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
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
    fn array_render_centers_caret_in_cell() {
        let frame = render_array(&[3, 1, 2], &[1], "probe");
        assert_eq!(frame.label, "probe");
        let mark = &frame.lines[2];
        let val = &frame.lines[1];
        assert!(mark.contains('^'));
        // cell_w >= 2; caret is centered, so for width 2 it is "^ " (left half of center).
        // Values are also centered — caret column lines up with the value slot.
        let caret = mark.find('^').unwrap();
        let one = val.find('1').unwrap();
        assert_eq!(
            caret, one,
            "caret should sit under the highlighted value\n{val}\n{mark}"
        );
    }

    #[test]
    fn from_viz_program_builds_array_keyframes() {
        use crate::llm::tools::{VizFrame, VizProgram};
        let program = VizProgram {
            kind: "array".into(),
            id: "demo".into(),
            title: "two sum scan".into(),
            frames: vec![
                VizFrame {
                    label: "start".into(),
                    cells: vec![serde_json::json!(2), serde_json::json!(7), serde_json::json!(11)],
                    highlight: vec![0],
                    ..Default::default()
                },
                VizFrame {
                    label: "advance".into(),
                    cells: vec![serde_json::json!(2), serde_json::json!(7), serde_json::json!(11)],
                    highlight: vec![1],
                    ..Default::default()
                },
            ],
        };
        let anim = from_viz_program(&program).expect("array converts");
        assert_eq!(anim.title, "two sum scan");
        assert_eq!(anim.frames.len(), 2);
        assert!(anim.frames[0].lines[1].contains('2'));
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
