//! Compatibility gate: can RustPython run `templates/run_tests.py` the way
//! CPython does for every indexed dataset?
//!
//! Corpus solutions are redacted, so this does not replay thousands of answers.
//! It checks the runner boots, a stub fails as JSON (not a VM crash), and a few
//! hand-written fixtures pass — one shape per adapter:
//! LeetCode (`class Solution` + keyword cases), KodCode (module-level `def` +
//! pytest-looking `test_*`), MS Python/Q (object `{s: …}` cases + `True`/`False`),
//! DeepSeek (`test_input = {…}` rewritten to `check(candidate)`), LC+Tests
//! (bare `def` wrapped in `class Solution` + assert list).

use rustpython::{InterpreterBuilder, InterpreterBuilderExt};
use serde::Deserialize;
use std::fs;
use std::path::Path;
use whiteboard::datasets::{deepseek_leetcode, leetcode_with_tests, ms_python_q};
use whiteboard::generator::RUN_TESTS_PY;
use whiteboard::problem::Problem;

#[derive(Debug, Deserialize)]
struct CaseLine {
    #[serde(default)]
    #[allow(dead_code)]
    case: u32,
    #[serde(default)]
    pass: bool,
    #[serde(default)]
    suite: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    actual: Option<String>,
}

struct RunOut {
    exit: i32,
    stdout: String,
    stderr: String,
    lines: Vec<CaseLine>,
}

fn write_workspace(dir: &Path, solution: &str, meta: &str) {
    fs::create_dir_all(dir.join(".lc")).expect("meta dir");
    fs::write(dir.join("run_tests.py"), RUN_TESTS_PY).expect("runner");
    fs::write(dir.join("solution.py"), solution).expect("solution");
    fs::write(dir.join(".lc").join("meta.json"), meta).expect("meta");
}

fn write_from_problem(dir: &Path, problem: &Problem, solution: &str) {
    let cases: Vec<serde_json::Value> = problem
        .input_output
        .iter()
        .map(|c| serde_json::json!({"input": c.input, "output": c.output}))
        .collect();
    let meta = serde_json::json!({
        "task_id": problem.task_id,
        "entry_point": problem.entry_point,
        "cases": cases,
        "test": problem.test,
    });
    write_workspace(dir, solution, &meta.to_string());
}

fn driver_source(workdir: &Path, extra_argv: &[&str]) -> String {
    let here = workdir.to_string_lossy().replace('\\', "/");
    let extras = extra_argv
        .iter()
        .map(|s| format!(", {s:?}"))
        .collect::<String>();
    format!(
        r#"
import io, os, runpy, sys, traceback
HERE = r"{here}"
os.chdir(HERE)
sys.argv = ["run_tests.py"{extras}]
out, err = io.StringIO(), io.StringIO()
sys.stdout, sys.stderr = out, err
code = 0
try:
    runpy.run_path(os.path.join(HERE, "run_tests.py"), run_name="__main__")
except SystemExit as e:
    if isinstance(e.code, int):
        code = e.code
    elif e.code:
        code = 1
except Exception:
    err.write(traceback.format_exc())
    code = 1
open(os.path.join(HERE, "_rp_stdout.txt"), "w", encoding="utf-8").write(out.getvalue())
open(os.path.join(HERE, "_rp_stderr.txt"), "w", encoding="utf-8").write(err.getvalue())
open(os.path.join(HERE, "_rp_exit.txt"), "w", encoding="utf-8").write(str(code))
"#
    )
}

fn with_python_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .name("rustpython".into())
        .stack_size(32 * 1024 * 1024)
        .spawn(f)
        .expect("spawn rustpython thread")
        .join()
        .unwrap_or_else(|_| panic!("rustpython thread panicked"))
}

fn run_runner(dir: &Path, extra_argv: &[&str]) -> RunOut {
    let driver = driver_source(dir, extra_argv);
    let dir = dir.to_path_buf();
    with_python_stack(move || {
    let interp = InterpreterBuilder::new().init_stdlib().build();
    interp.enter(|vm| {
        if let Err(exc) = vm.run_simple_string(&driver) {
            let mut buf = String::new();
            let _ = vm.write_exception_inner(&mut buf, &exc);
            panic!("RustPython failed before the runner finished:\n{buf}");
        }
    });

    let stdout = fs::read_to_string(dir.join("_rp_stdout.txt")).unwrap_or_default();
    let stderr = fs::read_to_string(dir.join("_rp_stderr.txt")).unwrap_or_default();
    let exit: i32 = fs::read_to_string(dir.join("_rp_exit.txt"))
        .unwrap_or_else(|_| "1".into())
        .trim()
        .parse()
        .unwrap_or(1);
    let lines: Vec<CaseLine> = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line).unwrap_or_else(|err| panic!("bad JSONL `{line}`: {err}"))
        })
        .collect();
    RunOut {
        exit,
        stdout,
        stderr,
        lines,
    }
    })
}

#[test]
fn rustpython_imports_runner_stdlib() {
    with_python_stack(|| {
        let interp = InterpreterBuilder::new().init_stdlib().build();
        interp.enter(|vm| {
            let src = r#"
import argparse, ast, importlib.util, io, json, os, sys, traceback
from contextlib import redirect_stdout
from typing import List, Optional
import collections, functools, heapq, itertools, math, bisect, re, string
assert hasattr(ast, "literal_eval")
assert hasattr(importlib.util, "spec_from_file_location")
xs = []
heapq.heappush(xs, 1)
assert heapq.heappop(xs) == 1
"#;
            if let Err(exc) = vm.run_simple_string(src) {
                let mut buf = String::new();
                let _ = vm.write_exception_inner(&mut buf, &exc);
                panic!("RustPython could not import the modules run_tests.py uses:\n{buf}");
            }
        });
    });
}

#[test]
fn stub_solution_fails_cleanly_not_a_crash() {
    let dir = tempfile::tempdir().unwrap();
    write_workspace(
        dir.path(),
        r#"
class Solution:
    def twoSum(self, nums, target):
        pass
"#,
        r#"{
  "task_id": "two-sum",
  "entry_point": "twoSum",
  "cases": [
    {"input": "nums = [2, 7, 11, 15], target = 9", "output": "[0, 1]"}
  ]
}"#,
    );
    let out = run_runner(dir.path(), &[]);
    assert!(
        !out.lines.is_empty(),
        "runner produced no JSONL\nstdout:\n{}\nstderr:\n{}",
        out.stdout,
        out.stderr
    );
    assert!(!out.lines[0].pass, "stub must fail the case: {:?}", out.lines);
    assert_eq!(out.exit, 1);
    assert!(
        out.lines[0].error.is_some() || out.lines[0].actual.is_some(),
        "expected a recorded miss, not a silent crash: {:?}",
        out.lines
    );
}

#[test]
fn design_class_entry_is_callable_without_init_args() {
    let dir = tempfile::tempdir().unwrap();
    write_workspace(
        dir.path(),
        r#"
class KthLargest:
    def __init__(self, k, nums):
        pass
    def add(self, val):
        pass
"#,
        r#"{
  "task_id": "kth-largest",
  "entry_point": "add",
  "cases": [
    {"input": "val = 3", "output": "4"}
  ]
}"#,
    );
    let out = run_runner(dir.path(), &[]);
    assert!(
        !out.lines.is_empty(),
        "runner produced no JSONL\nstdout:\n{}\nstderr:\n{}",
        out.stdout,
        out.stderr
    );
    let err = out.lines[0].error.as_deref().unwrap_or("");
    assert!(
        !err.contains("entry point"),
        "must find KthLargest.add, not missing-entry: {err}"
    );
    assert!(!out.lines[0].pass, "stub must fail the case: {:?}", out.lines);
}

#[test]
fn two_sum_fixture_passes() {
    let dir = tempfile::tempdir().unwrap();
    write_workspace(
        dir.path(),
        r#"
class Solution:
    def twoSum(self, nums, target):
        seen = {}
        for i, n in enumerate(nums):
            need = target - n
            if need in seen:
                return [seen[need], i]
            seen[n] = i
"#,
        r#"{
  "task_id": "two-sum",
  "entry_point": "twoSum",
  "cases": [
    {"input": "nums = [2, 7, 11, 15], target = 9", "output": "[0, 1]"},
    {"input": "nums = [3, 2, 4], target = 6", "output": "[1, 2]"}
  ]
}"#,
    );
    let out = run_runner(dir.path(), &[]);
    assert_eq!(out.stderr, "", "stderr: {}", out.stderr);
    assert_eq!(out.lines.len(), 2, "stdout:\n{}", out.stdout);
    assert!(out.lines.iter().all(|line| line.pass), "{:?}", out.lines);
    assert_eq!(out.exit, 0);
}

#[test]
fn heapq_fixture_passes() {
    let dir = tempfile::tempdir().unwrap();
    write_workspace(
        dir.path(),
        r#"
import heapq

class Solution:
    def lastStoneWeight(self, stones):
        heap = [-s for s in stones]
        heapq.heapify(heap)
        while len(heap) > 1:
            a = -heapq.heappop(heap)
            b = -heapq.heappop(heap)
            if a != b:
                heapq.heappush(heap, -(a - b))
        return -heap[0] if heap else 0
"#,
        r#"{
  "task_id": "last-stone-weight",
  "entry_point": "lastStoneWeight",
  "cases": [
    {"input": "stones = [2, 7, 4, 1, 8, 1]", "output": "1"},
    {"input": "stones = [1]", "output": "1"}
  ]
}"#,
    );
    let out = run_runner(dir.path(), &[]);
    assert_eq!(out.stderr, "", "stderr: {}", out.stderr);
    assert!(
        out.lines.iter().all(|line| line.pass),
        "stdout:\n{}\nlines: {:?}",
        out.stdout,
        out.lines
    );
    assert_eq!(out.exit, 0);
}

#[test]
fn listnode_class_and_full_suite_pass() {
    let dir = tempfile::tempdir().unwrap();
    write_workspace(
        dir.path(),
        r#"
class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

class Solution:
    def reverseList(self, head):
        prev = None
        cur = head
        while cur:
            nxt = cur.next
            cur.next = prev
            prev = cur
            cur = nxt
        return prev
"#,
        r#"{
  "task_id": "reverse-linked-list",
  "entry_point": "reverseList",
  "cases": [],
  "test": "from solution import ListNode\n\ndef from_list(vals):\n    dummy = ListNode(0)\n    cur = dummy\n    for v in vals:\n        cur.next = ListNode(v)\n        cur = cur.next\n    return dummy.next\n\ndef to_list(node):\n    out = []\n    while node:\n        out.append(node.val)\n        node = node.next\n    return out\n\ndef check(candidate):\n    assert to_list(candidate(from_list([1, 2, 3, 4, 5]))) == [5, 4, 3, 2, 1]\n    assert to_list(candidate(from_list([]))) == []\n"
}"#,
    );
    let out = run_runner(dir.path(), &["--full"]);
    assert_eq!(out.stderr, "", "stderr: {}", out.stderr);
    assert_eq!(out.lines.len(), 1, "stdout:\n{}", out.stdout);
    assert!(out.lines[0].suite, "expected the full-suite JSON line");
    assert!(
        out.lines[0].pass,
        "suite failed: {:?} error={}",
        out.lines[0].actual,
        out.lines[0].error.as_deref().unwrap_or("")
    );
    assert_eq!(out.exit, 0);
}

#[test]
fn full_suite_solution_ctor_uses_class_from_module() {
    let dir = tempfile::tempdir().unwrap();
    write_workspace(
        dir.path(),
        r#"
class Solution:
    def __init__(self, m, n):
        self.m = m
        self.n = n
    def flip(self):
        return [0, 0]
"#,
        r#"{
  "task_id": "flip",
  "entry_point": "flip",
  "cases": [],
  "test": "def check(candidate):\n    assert Solution(1, 1).flip() == [0, 0]\n"
}"#,
    );
    let out = run_runner(dir.path(), &["--full"]);
    assert_eq!(out.stderr, "", "stderr: {}", out.stderr);
    assert_eq!(out.lines.len(), 1, "stdout:\n{}", out.stdout);
    assert!(out.lines[0].suite, "expected the full-suite JSON line");
    assert!(
        out.lines[0].pass,
        "suite failed: {:?} error={}",
        out.lines[0].actual,
        out.lines[0].error.as_deref().unwrap_or("")
    );
    assert_eq!(out.exit, 0);
}

#[test]
fn full_suite_solution_ctor_stub_is_assertion_not_nameerror() {
    let dir = tempfile::tempdir().unwrap();
    write_workspace(
        dir.path(),
        r#"
class Solution:
    def __init__(self, m=0, n=0):
        pass
    def flip(self):
        pass
"#,
        r#"{
  "task_id": "flip",
  "entry_point": "flip",
  "cases": [],
  "test": "def check(candidate):\n    assert Solution(1, 1).flip() == [0, 0]\n"
}"#,
    );
    let out = run_runner(dir.path(), &["--full"]);
    assert_eq!(out.lines.len(), 1, "stdout:\n{}", out.stdout);
    assert!(out.lines[0].suite);
    assert!(!out.lines[0].pass, "stub must fail the assert");
    let err = out.lines[0].error.as_deref().unwrap_or("");
    assert!(
        !err.contains("NameError"),
        "Solution must be visible in check(); got:\n{err}"
    );
    assert!(
        err.contains("AssertionError"),
        "expected a failed assert, not a crash:\n{err}"
    );
}

#[test]
fn kodcode_module_level_cases_pass() {
    let dir = tempfile::tempdir().unwrap();
    let meta = serde_json::json!({
        "task_id": "running-max-45219-c",
        "entry_point": "running_max",
        "cases": [
            {"input": "[1, 3, 2]", "output": "[1, 3, 3]"},
            {"input": "[]", "output": "[]"}
        ],
        "test": "from solution import running_max\n\ndef test_running_max():\n    assert running_max([1, 3, 2]) == [1, 3, 3]\n\ndef test_empty():\n    assert running_max([]) == []\n"
    });
    write_workspace(
        dir.path(),
        r#"
def running_max(values):
    out = []
    m = None
    for v in values:
        m = v if m is None or v > m else m
        out.append(m)
    return out
"#,
        &meta.to_string(),
    );
    let out = run_runner(dir.path(), &[]);
    assert_eq!(out.stderr, "", "stderr: {}", out.stderr);
    assert_eq!(out.lines.len(), 2, "stdout:\n{}", out.stdout);
    assert!(out.lines.iter().all(|line| line.pass), "{:?}", out.lines);
    assert_eq!(out.exit, 0);
}

#[test]
fn kodcode_stub_fails_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let meta = serde_json::json!({
        "task_id": "running-max-45219-c",
        "entry_point": "running_max",
        "cases": [
            {"input": "[1, 3, 2]", "output": "[1, 3, 3]"}
        ]
    });
    write_workspace(
        dir.path(),
        "def running_max(values):\n    pass\n",
        &meta.to_string(),
    );
    let out = run_runner(dir.path(), &[]);
    assert!(
        !out.lines.is_empty(),
        "stdout:\n{}\nstderr:\n{}",
        out.stdout,
        out.stderr
    );
    assert!(!out.lines[0].pass);
    assert_eq!(out.exit, 1);
}

#[test]
fn kodcode_pytest_style_full_suite_passes() {
    let dir = tempfile::tempdir().unwrap();
    let meta = serde_json::json!({
        "task_id": "running-max-45219-c",
        "entry_point": "running_max",
        "cases": [],
        "test": "from solution import running_max\n\ndef test_running_max():\n    assert running_max([1, 3, 2]) == [1, 3, 3]\n\ndef test_empty():\n    assert running_max([]) == []\n"
    });
    write_workspace(
        dir.path(),
        r#"
def running_max(values):
    out, m = [], None
    for v in values:
        m = v if m is None or v > m else m
        out.append(m)
    return out
"#,
        &meta.to_string(),
    );
    let out = run_runner(dir.path(), &["--full"]);
    assert_eq!(out.stderr, "", "stderr: {}", out.stderr);
    assert_eq!(out.lines.len(), 1, "stdout:\n{}", out.stdout);
    assert!(out.lines[0].suite);
    assert!(
        out.lines[0].pass,
        "suite failed: {:?} error={}",
        out.lines[0].actual,
        out.lines[0].error.as_deref().unwrap_or("")
    );
    assert_eq!(out.exit, 0);
}

#[test]
fn kodcode_pytest_import_is_a_full_suite_miss() {
    let dir = tempfile::tempdir().unwrap();
    let meta = serde_json::json!({
        "task_id": "running-max-45219-c",
        "entry_point": "running_max",
        "cases": [],
        "test": "import pytest\nfrom solution import running_max\n\n@pytest.mark.parametrize('vals, expected', [([1, 3, 2], [1, 3, 3])])\ndef test_running_max(vals, expected):\n    assert running_max(vals) == expected\n"
    });
    write_workspace(
        dir.path(),
        "def running_max(values):\n    return values\n",
        &meta.to_string(),
    );
    let out = run_runner(dir.path(), &["--full"]);
    assert_eq!(
        out.lines.len(),
        1,
        "stdout:\n{}\nstderr:\n{}",
        out.stdout,
        out.stderr
    );
    assert!(out.lines[0].suite);
    assert!(
        !out.lines[0].pass,
        "pytest is not on the runner path; this must fail cleanly, not crash"
    );
    let err = out.lines[0].error.as_deref().unwrap_or("");
    assert!(
        err.contains("pytest") || err.contains("ModuleNotFoundError") || err.contains("ImportError"),
        "expected a pytest import miss, got: {err}"
    );
}

#[test]
fn ms_python_q_object_cases_and_check_suite() {
    let raw = serde_json::json!({
        "problem_id": "check-if-word-is-valid-after-substitutions",
        "leetcode_id": 1003,
        "difficulty": "Medium",
        "tags": ["Stack", "String"],
        "problem_description": "Given a string s, determine if it is valid.",
        "test_cases": [
            {"input": {"s": "aaabbbccc"}, "expected_output": false},
            {"input": {"s": "abc"}, "expected_output": true}
        ],
        "metadata": {
            "entry_point": "Solution().isValid",
            "starter_code": "class Solution:\n    def isValid(self, s: str) -> bool:\n        ",
            "test": "def check(candidate):\n    assert candidate(\"abc\") is True\n"
        }
    });
    let problem = ms_python_q::normalize(&raw).expect("ms-python-q sample");
    assert_eq!(problem.entry_point.as_deref(), Some("isValid"));
    assert_eq!(problem.input_output.len(), 2);

    let dir = tempfile::tempdir().unwrap();
    write_from_problem(
        dir.path(),
        &problem,
        r#"
class Solution:
    def isValid(self, s):
        return s == "abc"
"#,
    );
    let cases = run_runner(dir.path(), &[]);
    assert_eq!(cases.stderr, "", "stderr: {}", cases.stderr);
    assert_eq!(cases.lines.len(), 2, "stdout:\n{}", cases.stdout);
    assert!(cases.lines.iter().all(|line| line.pass), "{:?}", cases.lines);
    assert_eq!(cases.exit, 0);

    let full = run_runner(dir.path(), &["--full"]);
    assert!(full.lines[0].suite);
    assert!(
        full.lines[0].pass,
        "check suite: {:?} err={}",
        full.lines[0].actual,
        full.lines[0].error.as_deref().unwrap_or("")
    );
}

#[test]
fn deepseek_leetcode_kwargs_cases_and_rewritten_check() {
    let raw = serde_json::json!({
        "title": "minimum-number-of-pushes-to-type-word-i",
        "meta": {
            "questionFrontendId": "3014",
            "difficulty": "Easy",
            "categoryTitle": "Algorithms"
        },
        "prompt": "\"\"\"\nYou are given a string word.\n\"\"\"\nclass Solution:\n    def minimumPushes(self, word: str) -> int:\n        ",
        "test": "\nmy_solution = Solution()\n\ntest_input = { \"word\": \"abcde\" }\nassert my_solution.minimumPushes(**test_input) == 5\n\ntest_input = { \"word\": \"xycdefghij\" }\nassert my_solution.minimumPushes(**test_input) == 12\n"
    });
    let problem = deepseek_leetcode::normalize(&raw).expect("deepseek sample");
    assert_eq!(problem.input_output[0].input, "word = \"abcde\"");
    assert!(problem
        .test
        .as_deref()
        .unwrap()
        .starts_with("def check(candidate):"));

    let dir = tempfile::tempdir().unwrap();
    write_from_problem(
        dir.path(),
        &problem,
        r#"
from collections import Counter

class Solution:
    def minimumPushes(self, word):
        freq = sorted(Counter(word).values(), reverse=True)
        return sum(f * (i // 8 + 1) for i, f in enumerate(freq))
"#,
    );
    let cases = run_runner(dir.path(), &[]);
    assert_eq!(cases.stderr, "", "stderr: {}", cases.stderr);
    assert_eq!(cases.lines.len(), 2, "stdout:\n{}", cases.stdout);
    assert!(cases.lines.iter().all(|line| line.pass), "{:?}", cases.lines);
    assert_eq!(cases.exit, 0);

    let full = run_runner(dir.path(), &["--full"]);
    assert!(full.lines[0].suite);
    assert!(
        full.lines[0].pass,
        "rewritten check: {:?} err={}",
        full.lines[0].actual,
        full.lines[0].error.as_deref().unwrap_or("")
    );
}

#[test]
fn leetcode_with_tests_wrapped_def_and_assert_suite() {
    let raw = serde_json::json!({
        "content": "```python\ndef max_beauty(items, queries):\n    return []\n```\n\nBuild a prefix of max beauty per price.",
        "level": "Hard",
        "function": "def max_beauty(items: List[Tuple[int, int]], queries: List[int]) -> List[int]",
        "valid_tests": [
            "assert max_beauty([(1, 2), (2, 3), (3, 4)], [1, 2, 3]) == [2, 3, 4]",
            "assert max_beauty([(1, 5), (2, 3), (3, 1)], [1, 2, 3]) == [5, 5, 5]"
        ]
    });
    let problem = leetcode_with_tests::normalize(&raw).expect("lc+tests sample");
    assert_eq!(problem.entry_point.as_deref(), Some("max_beauty"));
    assert!(problem
        .starter_code
        .as_deref()
        .unwrap()
        .contains("class Solution:"));

    let dir = tempfile::tempdir().unwrap();
    write_from_problem(
        dir.path(),
        &problem,
        r#"
class Solution:
    def max_beauty(self, items, queries):
        items = sorted(items)
        best = []
        m = 0
        for price, beauty in items:
            m = max(m, beauty)
            best.append((price, m))
        out = []
        for q in queries:
            ans = 0
            for price, m in best:
                if price <= q:
                    ans = m
            out.append(ans)
        return out
"#,
    );
    let cases = run_runner(dir.path(), &[]);
    assert_eq!(cases.stderr, "", "stderr: {}", cases.stderr);
    assert_eq!(cases.lines.len(), 2, "stdout:\n{}", cases.stdout);
    assert!(cases.lines.iter().all(|line| line.pass), "{:?}", cases.lines);
    assert_eq!(cases.exit, 0);

    let full = run_runner(dir.path(), &["--full"]);
    assert!(full.lines[0].suite);
    assert!(
        full.lines[0].pass,
        "assert suite: {:?} err={}",
        full.lines[0].actual,
        full.lines[0].error.as_deref().unwrap_or("")
    );
}

/// `{ "flag": True }` is valid Python, not JSON. Sample-case extraction skips it;
/// the rewritten `--full` suite still has to run that assert.
#[test]
fn deepseek_python_true_dict_is_a_full_suite_not_a_sample_case() {
    let raw = serde_json::json!({
        "title": "flag-problem",
        "prompt": "\"\"\"flag\"\"\"\nclass Solution:\n    def f(self, flag: bool) -> int:\n        ",
        "test": "\nmy_solution = Solution()\n\ntest_input = { \"flag\": True }\nassert my_solution.f(**test_input) == 1\n"
    });
    let problem = deepseek_leetcode::normalize(&raw).expect("deepseek True-dict");
    assert!(
        problem.input_output.is_empty(),
        "Python True is not JSON; this case must not become a sample"
    );
    assert!(problem
        .test
        .as_deref()
        .unwrap()
        .contains("assert candidate(**test_input) == 1"));

    let dir = tempfile::tempdir().unwrap();
    write_from_problem(
        dir.path(),
        &problem,
        r#"
class Solution:
    def f(self, flag):
        return 1 if flag else 0
"#,
    );
    // Empty `cases` makes the runner fall through to the full suite even
    // without `--full` — same path as a DeepSeek row whose dicts are all
    // Python-only spellings.
    let out = run_runner(dir.path(), &[]);
    assert_eq!(out.lines.len(), 1, "stdout:\n{}\nstderr:\n{}", out.stdout, out.stderr);
    assert!(out.lines[0].suite);
    assert!(
        out.lines[0].pass,
        "True-dict suite: {:?} err={}",
        out.lines[0].actual,
        out.lines[0].error.as_deref().unwrap_or("")
    );
}

/// Same two-sum fixture through the production `runner::execute_run_tests` path
/// (`cmd_test_inner` uses this, not the compat-test driver).
#[test]
fn production_execute_run_tests_two_sum() {
    let dir = tempfile::tempdir().unwrap();
    write_workspace(
        dir.path(),
        r#"
class Solution:
    def twoSum(self, nums, target):
        seen = {}
        for i, n in enumerate(nums):
            need = target - n
            if need in seen:
                return [seen[need], i]
            seen[n] = i
"#,
        r#"{
  "task_id": "two-sum",
  "entry_point": "twoSum",
  "cases": [
    {"input": "nums = [2, 7, 11, 15], target = 9", "output": "[0, 1]"},
    {"input": "nums = [3, 2, 4], target = 6", "output": "[1, 2]"}
  ]
}"#,
    );
    let (results, _stdout, stderr) =
        whiteboard::runner::execute_run_tests(dir.path(), &[]).expect("execute_run_tests");
    assert_eq!(stderr, "", "stderr: {stderr}");
    assert_eq!(results.len(), 2, "{results:?}");
    assert!(results.iter().all(|r| r.pass), "{results:?}");
}
