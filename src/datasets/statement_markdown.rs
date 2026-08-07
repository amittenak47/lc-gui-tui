//! Lay out a run-on problem statement so it reads as markdown.
//!
//! Corpus descriptions frequently arrive as a single paragraph with
//! `Example`/`Input`/`Output` jammed together mid-sentence and exponents
//! flattened by whatever scraped them (`10^4` → `104`). That is unreadable on
//! the board, in the TUI pager, in an offline pack, and in a coach prompt.
//!
//! This is a port of `app/src/util/statementMarkdown.ts`, stage for stage and
//! in the same order, so the two cannot disagree about what a statement looks
//! like. The frontend keeps its copy as a display-time safety net for packs and
//! caches that were written before this existed — which is why every stage here
//! is **idempotent**: running the pipeline over its own output is a no-op, so
//! the two normalizers stack harmlessly.
//!
//! Written by hand rather than with a regex crate. The TypeScript leans on
//! lookbehind (`(?<!\n)`), which the `regex` crate does not support at all, and
//! `lc` has no regex dependency to inherit.

/// Tags whose presence means the statement is HTML rather than markdown.
const HTML_TAGS: [&str; 5] = ["p", "br", "sup", "li", "strong"];

/// Decoded in this order, matching the TypeScript object's insertion order —
/// `&amp;lt;` resolving to `&lt;` rather than `<` depends on it.
const HTML_ENTITIES: [(&str, &str); 7] = [
    ("&lt;", "<"),
    ("&gt;", ">"),
    ("&amp;", "&"),
    ("&quot;", "\""),
    ("&#39;", "'"),
    ("&apos;", "'"),
    ("&nbsp;", " "),
];

/// The labels that open a section of a LeetCode-style statement. `Example N`
/// is handled separately because it carries a number.
const SECTION_LABELS: [&str; 7] = [
    "Input",
    "Output",
    "Explanation",
    "Constraints",
    "Note",
    "Follow-up",
    "Follow up",
];

/// Prepare a raw corpus statement for a markdown renderer.
///
/// Safe to run on text that is already well formed, and safe to run twice.
pub fn normalize_statement_markdown(raw: &str) -> String {
    let mut text = normalize_newlines(raw);

    if looks_like_html(&text) {
        text = tidy_html(&text);
    }

    text = break_before_section_labels(&text);
    text = break_label_content(&text);
    text = convert_exponents(&text);
    text = split_constraint_items(&text);
    text = fix_constraint_prose(&text);
    text = normalize_newlines(&text);

    text.trim().to_string()
}

// ---------------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------------

/// `\r\n` → `\n`, and any run of three or more blank lines down to one.
fn normalize_newlines(raw: &str) -> String {
    let unified = raw.replace("\r\n", "\n");
    let mut out = String::with_capacity(unified.len());
    let mut run = 0usize;
    for ch in unified.chars() {
        if ch == '\n' {
            run += 1;
            if run <= 2 {
                out.push(ch);
            }
        } else {
            run = 0;
            out.push(ch);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/// True when the text opens one of [`HTML_TAGS`].
///
/// The tag name must end at a non-word character, so `<pre>` is not a `<p>`.
fn looks_like_html(text: &str) -> bool {
    for (i, byte) in text.bytes().enumerate() {
        if byte != b'<' {
            continue;
        }
        let rest = &text[i + 1..];
        for tag in HTML_TAGS {
            let Some(after) = strip_prefix_ci(rest, tag) else {
                continue;
            };
            if after.as_bytes().first().is_none_or(|b| !is_word_byte(*b)) {
                return true;
            }
        }
    }
    false
}

/// `<br>` becomes a newline and the common entities are decoded. Other tags are
/// left for the markdown renderer, which passes inline HTML through.
fn tidy_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text.as_bytes()[i] == b'<' {
            if let Some(len) = br_tag_len(text, i) {
                out.push('\n');
                i += len;
                continue;
            }
        }
        let ch = char_at(text, i);
        out.push(ch);
        i += ch.len_utf8();
    }

    for (entity, decoded) in HTML_ENTITIES {
        if out.contains(entity) {
            out = out.replace(entity, decoded);
        }
    }
    out
}

/// Byte length of a `<br>` / `<br/>` / `<br />` tag starting at `at`.
fn br_tag_len(text: &str, at: usize) -> Option<usize> {
    let rest = strip_prefix_ci(&text[at + 1..], "br")?;
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let rest = rest.strip_prefix('>')?;
    Some(text.len() - at - rest.len())
}

// ---------------------------------------------------------------------------
// Section labels
// ---------------------------------------------------------------------------

/// Give every `Example N:` / `Input:` / `Constraints:` … its own paragraph.
///
/// A label already sitting on a line of its own is left alone, and one that
/// only has a single newline in front of it is promoted to a blank line — which
/// together are what make this stage idempotent.
fn break_before_section_labels(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 32);
    let mut i = 0;
    while i < text.len() {
        if let Some(len) = label_starting_at(text, i) {
            match trailing_newlines(&out) {
                0 => out.push_str("\n\n"),
                1 => out.push('\n'),
                _ => {}
            }
            out.push_str(&text[i..i + len]);
            i += len;
            continue;
        }
        let ch = char_at(text, i);
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Move what follows a label onto its own paragraph, so `Input: houses = […]`
/// renders as a heading over its value rather than one long line.
fn break_label_content(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    let mut i = 0;
    let mut at_line_start = true;
    while i < text.len() {
        if at_line_start {
            if let Some(len) = section_label_len(text, i) {
                let rest = &text[i + len..];
                let spaces = rest.len() - rest.trim_start_matches([' ', '\t']).len();
                let value = &rest[spaces..];
                if spaces > 0 && value.starts_with(|c: char| !c.is_whitespace()) {
                    out.push_str(&text[i..i + len]);
                    out.push_str("\n\n");
                    i += len + spaces;
                    at_line_start = false;
                    continue;
                }
            }
        }
        let ch = char_at(text, i);
        out.push(ch);
        i += ch.len_utf8();
        at_line_start = ch == '\n';
    }
    out
}

/// [`section_label_len`], but only when the label is not glued to the tail of
/// a preceding word — `stdInput:` is not a section.
fn label_starting_at(text: &str, at: usize) -> Option<usize> {
    if preceded_by_word_byte(text, at) {
        return None;
    }
    section_label_len(text, at)
}

/// Byte length of the section label at `at`, colon included.
fn section_label_len(text: &str, at: usize) -> Option<usize> {
    let rest = &text[at..];
    // Cheap gate: every label starts with one of these.
    if !rest.starts_with(['E', 'e', 'I', 'i', 'O', 'o', 'C', 'c', 'N', 'n', 'F', 'f']) {
        return None;
    }

    let after_name = if let Some(after) = strip_prefix_ci(rest, "Example") {
        let digits = after.trim_start();
        if digits.len() == after.len() {
            return None; // `Example` and its number need whitespace between them
        }
        let end = digits
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(digits.len());
        if end == 0 {
            return None;
        }
        &digits[end..]
    } else {
        SECTION_LABELS
            .iter()
            .find_map(|label| strip_prefix_ci(rest, label))?
    };

    let after_colon = after_name.strip_prefix(':')?;
    Some(rest.len() - after_colon.len())
}

// ---------------------------------------------------------------------------
// Exponents
// ---------------------------------------------------------------------------

/// Restore the superscripts a scrape flattened.
///
/// Two spellings turn up: `10^4` kept the caret, and `104` lost it. Only a
/// single digit `2`–`9` is treated as a lost exponent, which is what keeps
/// literals like `100` and `1024` intact.
fn convert_exponents(text: &str) -> String {
    convert_flat_exponents(&convert_caret_exponents(text))
}

fn convert_caret_exponents(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i..].starts_with("10^") && !preceded_by_word_byte(text, i) {
            let from = i + 3;
            let end = from
                + text[from..]
                    .find(|c: char| !c.is_ascii_digit())
                    .unwrap_or(text.len() - from);
            if end > from && text.as_bytes().get(end).is_none_or(|b| !is_word_byte(*b)) {
                push_superscript(&mut out, &text[from..end]);
                i = end;
                continue;
            }
        }
        let ch = char_at(text, i);
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn convert_flat_exponents(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i..].starts_with("10") && !preceded_by_word_byte(text, i) {
            let exponent = bytes.get(i + 2).copied().unwrap_or(0);
            if exponent.is_ascii_digit()
                && exponent != b'0'
                && exponent != b'1'
                && bytes.get(i + 3).is_none_or(|b| !is_word_byte(*b))
            {
                push_superscript(&mut out, &text[i + 2..i + 3]);
                i += 3;
                continue;
            }
        }
        let ch = char_at(text, i);
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn push_superscript(out: &mut String, exponent: &str) {
    out.push_str("10<sup>");
    out.push_str(exponent);
    out.push_str("</sup>");
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

const CONSTRAINTS: &str = "Constraints:";

/// Put each bound or identity in the constraints block on its own line.
///
/// Only the constraints body is touched: the scan stops at the next section
/// label so a `Note:` or `Follow-up:` paragraph underneath is not chopped up.
fn split_constraint_items(text: &str) -> String {
    let Some(at) = find_ci(text, CONSTRAINTS) else {
        return text.to_string();
    };

    let before = &text[..at];
    let after_label = text[at + CONSTRAINTS.len()..].trim_start();
    let (body, rest) = match next_section_break(after_label) {
        Some(end) => (&after_label[..end], &after_label[end..]),
        None => (after_label, ""),
    };

    // `1 <= a … 1 <= b`, and `m == mat.length n == mat[i].length`.
    let split = break_runs_before(body.trim(), starts_numeric_bound);
    let split = break_runs_before(&split, starts_identity);

    format!("{before}{CONSTRAINTS}\n\n{split}{rest}")
}

/// Offset of the blank line that opens the next section, if there is one.
fn next_section_break(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    (0..bytes.len().saturating_sub(1)).find(|&i| {
        bytes[i] == b'\n' && bytes[i + 1] == b'\n' && section_label_len(text, i + 2).is_some()
    })
}

/// `1 <= …` / `3 >= …`.
fn starts_numeric_bound(text: &str) -> bool {
    let end = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    if end == 0 {
        return false;
    }
    let rest = text[end..].trim_start();
    rest.starts_with("<=") || rest.starts_with(">=")
}

/// `m == mat.length`.
fn starts_identity(text: &str) -> bool {
    if !text.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
        return false;
    }
    let end = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(text.len());
    text[end..].trim_start().starts_with("==")
}

/// Replace every run of whitespace that `starts_item` accepts the text after
/// with a single newline.
fn break_runs_before(text: &str, starts_item: fn(&str) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let ch = char_at(text, i);
        if !ch.is_whitespace() {
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let run_end = i + (text[i..].len() - text[i..].trim_start().len());
        if starts_item(&text[run_end..]) {
            out.push('\n');
        } else {
            out.push_str(&text[i..run_end]);
        }
        i = run_end;
    }
    out
}

/// Break the sentence a corpus glued onto the end of the last constraint.
fn fix_constraint_prose(text: &str) -> String {
    let Some(at) = find_ci(text, CONSTRAINTS) else {
        return text.to_string();
    };
    let head = &text[..at];
    let tail = break_after_bound(&text[at..]);
    let tail = break_before_all_clause(&tail);
    format!("{head}{tail}")
}

/// A bound followed by the start of a sentence — `… <= 100 Note that …`.
fn break_after_bound(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let ch = char_at(text, i);
        if ch.is_ascii_digit() || ch == '>' {
            let after = &text[i + 1..];
            let spaces = after.len() - after.trim_start().len();
            let mut sentence = after[spaces..].chars();
            if let (true, Some(first), Some(second)) =
                (spaces > 0, sentence.next(), sentence.next())
            {
                if first.is_ascii_uppercase() && second.is_ascii_lowercase() {
                    out.push(ch);
                    out.push_str("\n\n");
                    out.push(first);
                    out.push(second);
                    i += 1 + spaces + first.len_utf8() + second.len_utf8();
                    continue;
                }
            }
        }
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// The trailing `All the integers of houses are unique.` clause.
fn break_before_all_clause(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let ch = char_at(text, i);
        if !ch.is_whitespace() {
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let run_end = i + (text[i..].len() - text[i..].trim_start().len());
        if let Some(len) = all_clause_len(&text[run_end..]) {
            out.push_str("\n\n");
            out.push_str(&text[run_end..run_end + len]);
            i = run_end + len;
            continue;
        }
        out.push_str(&text[i..run_end]);
        i = run_end;
    }
    out
}

/// Byte length of an `All the …` sentence, up to and including its period.
fn all_clause_len(text: &str) -> Option<usize> {
    let rest = strip_word(text, "All")?;
    let rest = strip_word(rest, "the")?;
    let body = rest;
    let mut taken = 0usize;
    for ch in body.chars() {
        if ch == '.' {
            return (taken > 0).then(|| text.len() - body.len() + taken + 1);
        }
        if ch.is_ascii_alphanumeric() || ch == '_' || ch.is_whitespace() || ch == ',' || ch == '\'' {
            taken += ch.len_utf8();
            continue;
        }
        return None;
    }
    None
}

/// `word` followed by at least one space.
fn strip_word<'a>(text: &'a str, word: &str) -> Option<&'a str> {
    let rest = text.strip_prefix(word)?;
    let trimmed = rest.trim_start();
    (trimmed.len() < rest.len()).then_some(trimmed)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn char_at(text: &str, at: usize) -> char {
    text[at..]
        .chars()
        .next()
        .expect("scans only start at a char boundary inside the string")
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn preceded_by_word_byte(text: &str, at: usize) -> bool {
    at > 0 && is_word_byte(text.as_bytes()[at - 1])
}

fn trailing_newlines(text: &str) -> usize {
    text.bytes().rev().take_while(|b| *b == b'\n').count()
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    (0..haystack.len()).find(|&i| {
        haystack
            .get(i..i + needle.len())
            .is_some_and(|s| s.eq_ignore_ascii_case(needle))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A statement that arrived as one paragraph, exponents flattened. This is
    /// the shape the whole module exists for.
    const MASHED: &str = "A real estate developer is planning to place mailboxes on a street. Given an array houses where houses[i] is the location of the ith house on the street and an integer k, return the minimum number of mailboxes that must be placed so that each house receives mail. Example 1: Input: houses = [1,4,8,10,20], k = 3 Output: 5 Explanation: Allocate mailboxes at positions 3, 9, and 20. Constraints: 1 <= houses.length <= 104 1 <= houses[i] <= 10^9 1 <= k <= houses.length All the integers of houses are unique.";

    /// The same statement as a well-formed corpus record.
    const WELL_FORMED: &str = "Given an m x n binary matrix mat, return the distance of the nearest 0 for each cell.\nThe distance between two cells sharing a common edge is 1.\n\nExample 1:\n\nInput: mat = [[0,0,0],[0,1,0],[0,0,0]]\nOutput: [[0,0,0],[0,1,0],[0,0,0]]\n\nConstraints:\n\nm == mat.length\nn == mat[i].length\n1 <= m, n <= 104\nmat[i][j] is either 0 or 1.";

    #[test]
    fn a_mashed_paragraph_gets_its_sections_back() {
        let out = normalize_statement_markdown(MASHED);

        assert!(out.contains("\n\nExample 1: \n\n"), "{out}");
        assert!(out.contains("\n\nInput:\n\nhouses = [1,4,8,10,20], k = 3"), "{out}");
        assert!(out.contains("\n\nOutput:\n\n5"), "{out}");
        assert!(out.contains("\n\nExplanation:\n\nAllocate mailboxes"), "{out}");
        assert!(out.contains("\n\nConstraints:\n\n"), "{out}");
    }

    #[test]
    fn constraints_split_onto_their_own_lines() {
        let out = normalize_statement_markdown(MASHED);

        assert!(out.contains("houses.length <= 10<sup>4</sup>"), "{out}");
        assert!(out.contains("10<sup>4</sup>\n1 <= houses[i]"), "{out}");
        assert!(out.contains("10<sup>9</sup>\n1 <= k <= houses.length"), "{out}");
        assert!(out.contains("\n\nAll the integers of houses are unique."), "{out}");
    }

    /// The frontend runs its own copy of this pipeline over the same text, so
    /// a second pass has to be a no-op.
    #[test]
    fn normalizing_twice_changes_nothing() {
        for raw in [MASHED, WELL_FORMED] {
            let once = normalize_statement_markdown(raw);
            let twice = normalize_statement_markdown(&once);
            assert_eq!(once, twice, "not idempotent for {raw:?}");
        }
    }

    #[test]
    fn a_well_formed_statement_keeps_its_shape() {
        let out = normalize_statement_markdown(WELL_FORMED);

        assert!(out.contains("Example 1:"), "{out}");
        assert!(out.contains("Input:\n\nmat ="), "{out}");
        assert!(out.contains("m == mat.length\nn == mat[i].length"), "{out}");
        assert!(out.contains("10<sup>4</sup>"), "{out}");
        // Prose that merely follows a bound is not a new constraint.
        assert!(out.contains("mat[i][j] is either 0 or 1."), "{out}");
    }

    #[test]
    fn flattened_exponents_come_back_but_round_numbers_do_not() {
        let out = normalize_statement_markdown("Constraints:\n1 <= m, n <= 104");
        assert!(out.contains("10<sup>4</sup>"), "{out}");
        assert!(!out.contains("<= 104"), "{out}");

        let hundred = normalize_statement_markdown("Constraints:\n1 <= n <= 100");
        assert!(hundred.contains("<= 100"), "{hundred}");
        assert!(!hundred.contains("<sup>"), "{hundred}");

        // A longer literal is not an exponent either.
        let literal = normalize_statement_markdown("Constraints:\n1 <= n <= 1024");
        assert!(literal.contains("<= 1024"), "{literal}");
        assert!(!literal.contains("<sup>"), "{literal}");
    }

    #[test]
    fn caret_exponents_convert() {
        let out = normalize_statement_markdown("1 <= houses[i] <= 10^9");
        assert!(out.contains("10<sup>9</sup>"), "{out}");
    }

    #[test]
    fn html_line_breaks_become_newlines() {
        let out = normalize_statement_markdown("<p>Given nums.</p><br>Example 1:<br>Input: x = 1");

        assert!(out.contains("Given nums."), "{out}");
        assert!(out.contains("\n\nExample 1:"), "{out}");
        assert!(out.contains("\n\nInput:\n\nx = 1"), "{out}");
    }

    #[test]
    fn entities_are_decoded_only_when_the_text_is_html() {
        let html = normalize_statement_markdown("<p>1 &lt;= n &lt;= 5 &amp; done</p>");
        assert!(html.contains("1 <= n <= 5 & done"), "{html}");

        // No HTML tag, so an ampersand in prose is left as written.
        let plain = normalize_statement_markdown("Rows &lt;= 5");
        assert!(plain.contains("&lt;="), "{plain}");
    }

    /// `<pre>` is not a `<p>`: the tag name has to end where the label does.
    #[test]
    fn a_longer_tag_is_not_mistaken_for_a_short_one() {
        assert!(!looks_like_html("<pre>code</pre>"));
        assert!(looks_like_html("<p>text</p>"));
        assert!(looks_like_html("a<br/>b"));
    }

    /// A label glued to the end of a word is part of that word.
    #[test]
    fn only_real_section_labels_break_a_line() {
        let out = normalize_statement_markdown("Read stdInput: then stop.");
        assert_eq!(out, "Read stdInput: then stop.");
    }

    /// A `Note:` under the constraints keeps its prose intact.
    #[test]
    fn a_section_after_the_constraints_is_left_alone() {
        let out = normalize_statement_markdown(
            "Constraints:\n\n1 <= n <= 5\n\nNote: The answer is unique and 1 <= k applies.",
        );
        assert!(
            out.contains("Note:\n\nThe answer is unique and 1 <= k applies."),
            "{out}"
        );
    }

    #[test]
    fn empty_and_blank_input_stay_empty() {
        assert_eq!(normalize_statement_markdown(""), "");
        assert_eq!(normalize_statement_markdown("   \n\n  "), "");
    }

    /// The scans index by byte, so a statement with non-ASCII prose must not
    /// panic or corrupt a character.
    #[test]
    fn non_ascii_text_survives() {
        let out = normalize_statement_markdown("Soit n un entier — voir « Example 1: » Input: n = 1");
        assert!(out.contains("Soit n un entier — voir «"), "{out}");
        assert!(out.contains("Input:\n\nn = 1"), "{out}");
    }
}
