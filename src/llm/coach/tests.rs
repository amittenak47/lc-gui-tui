use super::*;
use crate::generator::WorkspaceMeta;
use crate::problem::IoCase;

fn meta_with_cases(n: usize) -> WorkspaceMeta {
        WorkspaceMeta {
            dataset: crate::dataset::DEFAULT_DATASET.into(),
            task_id: "two-sum".into(),
            question_id: Some("1".into()),
            difficulty: Some("Easy".into()),
            tags: vec!["Array".into()],
            entry_point: Some("twoSum".into()),
            json_path: "corpus.jsonl".into(),
            cases: (0..n)
                .map(|i| IoCase {
                    input: format!("nums = [{i}]"),
                    output: format!("[{i}]"),
                })
                .collect(),
            test: None,
        }
    }

    #[test]
    fn extract_json_survives_fences_and_chatter() {
        let raw = "Sure! Here you go:\n```json\n{\"verdict\": \"on_track\"}\n```\nHope that helps.";
        assert_eq!(extract_json(raw), Some("{\"verdict\": \"on_track\"}"));
    }

    #[test]
    fn extract_json_ignores_braces_inside_strings() {
        let raw = r#"{"nudge": "try a set like {1,2}", "closeness": "warm"}"#;
        assert_eq!(extract_json(raw), Some(raw));
    }

    #[test]
    fn valid_case_index_is_backfilled_from_the_corpus() {
        // The model cites a real index but misquotes the contents.
        let raw = r#"{"verdict": "subtly_wrong",
                      "counterexample": {"case_index": 2, "input": "MADE UP",
                                         "expected": "ALSO MADE UP",
                                         "why_your_approach_fails": "duplicate values"}}"#;
        let review = parse_review(raw, &meta_with_cases(4).cases).unwrap();
        let cited = review.counterexample.expect("kept");
        assert_eq!(cited.case_index, 2);
        assert_eq!(cited.case_number, 3, "case_number is 1-based for `lc test --case`");
        assert_eq!(cited.input, "nums = [2]", "input came from the corpus, not the model");
        assert_eq!(cited.expected, "[2]");
        assert!(review.counterexample_rejected.is_none());
    }

    #[test]
    fn fabricated_case_index_is_rejected() {
        let raw = r#"{"verdict": "wrong_track",
                      "counterexample": {"case_index": 99, "input": "nums = [1,2,3]",
                                         "expected": "[0,1]",
                                         "why_your_approach_fails": "invented"}}"#;
        let review = parse_review(raw, &meta_with_cases(4).cases).unwrap();
        assert!(review.counterexample.is_none(), "hallucinated case must not survive");
        let note = review.counterexample_rejected.expect("rejection is reported");
        assert!(note.contains("99") && note.contains('4'), "note names the bad index: {note}");
    }

    #[test]
    fn typed_pseudocode_reaches_the_prompt_and_is_marked_exact() {
        let meta = meta_with_cases(2);
        let board = BoardSnapshot {
            pseudocode: Some("for i, x in enumerate(nums):\n    seen[x] = i".into()),
            ..Default::default()
        };
        assert!(!board.is_empty(), "pseudocode alone is enough to review");

        let prompt = build_review_prompt(&meta, None, &board);
        assert!(prompt.contains("seen[x] = i"));
        assert!(
            prompt.contains("exact, not recognized"),
            "the coach must not second-guess typed text the way it does OCR"
        );
    }

    /// The trace second pass reads the whole approach, not just the ink — a
    /// pseudocode-only board used to reach it looking blank.
    #[test]
    fn the_trace_prompt_sees_typed_pseudocode_too() {
        let meta = meta_with_cases(3);
        let typed_only = BoardSnapshot {
            pseudocode: Some("nums.sort()\ni, j = 0, len(nums)-1".into()),
            ..Default::default()
        };
        let prompt = build_trace_prompt(&meta, &typed_only, &meta.cases[0], 1);
        assert!(prompt.contains("nums.sort()"), "typed approach must reach the trace");
        assert!(!prompt.contains("nothing legible"));

        let both = BoardSnapshot {
            recognized_text: "two pointers".into(),
            pseudocode: Some("i, j = 0, n-1".into()),
            ..Default::default()
        };
        assert_eq!(both.approach_text(), "two pointers\n\ni, j = 0, n-1");

        // And an actually-blank board says so rather than inviting a guess.
        let blank = build_trace_prompt(&meta, &BoardSnapshot::default(), &meta.cases[0], 1);
        assert!(blank.contains("nothing legible"));
    }

    /// A browser build sends no transcribed ink at all, so a board full of
    /// hand-drawn boxes arrives with an empty `recognized_text`. The prompt has
    /// to point the coach at the layout instead of letting it announce a blank
    /// board and demand they go implement something.
    #[test]
    fn an_untranscribed_board_is_described_by_its_layout_not_called_blank() {
        let meta = meta_with_cases(2);
        let drawn = BoardSnapshot {
            scene_structure: Some(serde_json::json!([
                {"id": "aaa", "type": "rectangle", "x": 10, "y": 10, "w": 80, "h": 40},
                {"id": "bbb", "type": "arrow", "x": 90, "y": 30, "w": 60, "h": 4},
            ])),
            ..Default::default()
        };
        assert!(drawn.has_visual_evidence());
        let prompt = build_review_prompt(&meta, None, &drawn);
        assert!(prompt.contains("does not transcribe ink"));
        assert!(prompt.contains("Do NOT tell them the board is blank"));

        // Nothing at all still reads as nothing at all.
        let nothing = BoardSnapshot::default();
        assert!(!nothing.has_visual_evidence());
        let prompt = build_review_prompt(&meta, None, &nothing);
        assert!(prompt.contains("no recognized handwriting yet"));
        assert!(!prompt.contains("does not transcribe ink"));
    }

    /// A sparse early board should get interview opening help, not a failure grade.
    #[test]
    fn the_review_prompt_asks_for_opening_hints_on_a_sparse_board() {
        assert!(REVIEW_SYSTEM_PROMPT.contains("sparse"));
        assert!(REVIEW_SYSTEM_PROMPT.contains("start coding"));
        assert!(REVIEW_SYSTEM_PROMPT.contains("problem-specific"));
        assert!(REVIEW_SYSTEM_PROMPT.contains("Do NOT hunt for criticism"));
        assert!(REVIEW_SYSTEM_PROMPT.contains("Prefer the whiteboard layout"));
    }

    fn sufficient_claim() -> Claim {
        Claim {
            understood_approach: "trailing zeros mean the double reversal cannot round-trip".into(),
            key_steps: vec![
                "reverse the digits once".into(),
                "note that a trailing zero is lost and cannot come back".into(),
            ],
            claim_sufficient: true,
            why_sufficient_or_not: "The zero-loss argument settles every input the problem allows."
                .into(),
            unresolved: vec![],
            confirming_question: "Which input would you run to see the zero disappear?".into(),
        }
    }

    /// The gate the whole redesign turns on. A claim that decides the answer must
    /// clear it; a model that answers the field without reading a board must not.
    #[test]
    fn the_sufficiency_gate_needs_a_real_named_approach() {
        assert!(sufficient_claim().decides_the_answer());

        // Terse but real: two words is a legitimate approach name.
        assert!(Claim {
            understood_approach: "two pointers".into(),
            claim_sufficient: true,
            ..Default::default()
        }
        .decides_the_answer());

        for junk in ["yes", "ok", "sort", "   "] {
            assert!(
                !Claim {
                    understood_approach: junk.into(),
                    claim_sufficient: true,
                    ..Default::default()
                }
                .decides_the_answer(),
                "{junk:?} is not a claim that can short-circuit a student to on_track"
            );
        }

        // And saying so is not optional: an unsufficient claim never gates out.
        assert!(!Claim {
            claim_sufficient: false,
            ..sufficient_claim()
        }
        .decides_the_answer());
    }

    /// A model that answers "this is enough" *and* lists what is missing is
    /// contradicting itself; the parser keeps the answer and drops the list.
    #[test]
    fn a_sufficient_claim_cannot_also_carry_unresolved_items() {
        let raw = r#"{"understood_approach": "count trailing zeros",
                      "key_steps": ["  reverse once  ", "", "spot the lost zero"],
                      "claim_sufficient": true,
                      "why_sufficient_or_not": "the argument decides it",
                      "unresolved": ["they have not written the reversal loop"],
                      "confirming_question": "which case shows it?"}"#;
        let claim = parse_claim(raw).unwrap();
        assert!(claim.unresolved.is_empty(), "sufficient means nothing is left open");
        assert_eq!(claim.key_steps, vec!["reverse once", "spot the lost zero"]);
        assert!(claim.decides_the_answer());

        // When it says no, the list survives — that is what stage 3 reads.
        let insufficient = parse_claim(
            r#"{"understood_approach": "reverse the digits", "claim_sufficient": false,
                "unresolved": ["nothing decides what happens on overflow"]}"#,
        )
        .unwrap();
        assert_eq!(insufficient.unresolved.len(), 1);

        // A reply that names no approach is not a claim at all.
        assert!(parse_claim(r#"{"claim_sufficient": true}"#).is_err());
    }

    /// Acceptance criterion 1: the correct insight-only board. It reaches the
    /// student as `on_track` with no gaps, and nothing in the card is a fresh
    /// judgement — every line is copied from the claim.
    #[test]
    fn the_on_track_card_is_built_from_the_claim_and_invents_nothing() {
        let claim = sufficient_claim();
        let review = on_track_review_from_claim(&claim);

        assert_eq!(review.verdict, Verdict::OnTrack);
        assert!(review.gaps.is_empty(), "an on-track board has no gaps to list");
        assert!(review.counterexample.is_none(), "and nothing to cite against it");
        assert!(!review.offer_bridge, "nor a reason to offer the reference");
        assert_eq!(review.understood_approach, claim.understood_approach);
        assert_eq!(review.socratic_question, claim.confirming_question);
        assert_eq!(review.rating.correctness, 5);
        assert_eq!(review.layout_verdict, Some(Verdict::OnTrack));
        // The reason it is sufficient, then the steps, read back as strengths.
        assert_eq!(review.strengths[0], claim.why_sufficient_or_not);
        assert!(review.strengths.contains(&claim.key_steps[1]));

        // With no question offered, the card still asks something specific.
        let quiet = on_track_review_from_claim(&Claim {
            confirming_question: String::new(),
            ..claim
        });
        assert!(quiet.socratic_question.contains("trailing zeros"));
    }

    #[test]
    fn format_review_card_is_plain_text_without_json() {
        let review = on_track_review_from_claim(&sufficient_claim());
        let text = format_review_card(&review);
        assert!(text.contains("Verdict: on track"));
        assert!(text.contains("Approach:"));
        assert!(text.contains("Next:"));
        assert!(!text.contains('{'), "no raw JSON for the TUI");
    }

    /// Stage 1 describes; it is given nothing to have an opinion about. No
    /// statement, no sample cases, no code dock — and a system prompt that says
    /// so out loud.
    #[test]
    fn the_perceive_stage_sees_the_board_and_nothing_to_judge_it_against() {
        let meta = meta_with_cases(3);
        let board = BoardSnapshot {
            recognized_text: "reverse digits, zeros vanish".into(),
            pseudocode: Some("def solve(): pass  # HALF TYPED".into()),
            png: Some("base64".into()),
            ..Default::default()
        };
        let prompt = build_perceive_prompt(&meta, &board);

        assert!(prompt.contains("reverse digits, zeros vanish"));
        assert!(!prompt.contains("HALF TYPED"), "the code dock is not board evidence");
        assert!(!prompt.contains("- [0] input:"), "no cases to reason from");
        assert!(!prompt.contains("## Statement"));
        assert!(PERCEIVE_SYSTEM_PROMPT.contains("You do not judge it"));
        assert!(PERCEIVE_SYSTEM_PROMPT.contains("No verdict, no gaps"));

        assert!(parse_perception(r#"{"observations": [], "transcribed_notes": []}"#).is_err());
        let seen = parse_perception(
            r#"{"observations": ["  a box labelled n  ", ""], "illegible": ["bottom right"]}"#,
        )
        .unwrap();
        assert_eq!(seen.observations, vec!["a box labelled n"]);
        assert!(!seen.is_blank());
    }

    /// Stage 2 gets the problem, the cases, and stage 1's description — but still
    /// not the code dock, so a stubby `solution.py` cannot seed the claim it is
    /// later judged against.
    #[test]
    fn the_claim_stage_reads_the_board_and_the_perception_but_not_the_code() {
        let meta = meta_with_cases(3);
        let board = BoardSnapshot {
            recognized_text: "reverse digits".into(),
            pseudocode: Some("def solve(): pass  # HALF TYPED".into()),
            ..Default::default()
        };
        let perception = Perception {
            observations: vec!["two boxes joined by an arrow".into()],
            transcribed_notes: vec!["120 -> 021".into()],
            illegible: vec!["a smudge under the arrow".into()],
        };

        let prompt = build_claim_prompt(&meta, Some("Reverse an integer."), &board, Some(&perception));
        assert!(prompt.contains("Reverse an integer."));
        assert!(prompt.contains("- [0] input:"), "stage 2 may cite from the cases later");
        assert!(prompt.contains("two boxes joined by an arrow"));
        assert!(prompt.contains("120 -> 021"));
        assert!(prompt.contains("do not assume these are empty or wrong"));
        assert!(!prompt.contains("HALF TYPED"));
        assert!(prompt.contains("\"claim_sufficient\""));

        // On a text-only build there is no perception section at all.
        let text_only = build_claim_prompt(&meta, None, &board, None);
        assert!(!text_only.contains("an earlier pass looked at the image"));
        assert!(text_only.contains("reverse digits"));

        assert!(CLAIM_SYSTEM_PROMPT.contains("An insight that removes work counts"));
        assert!(CLAIM_SYSTEM_PROMPT.contains("are NOT reasons to answer false"));
    }

    /// Stage 3a is the only stage allowed to look for what is missing, and it is
    /// handed the claim rather than the board's raw ink to re-interpret.
    #[test]
    fn the_verdict_stage_is_handed_a_frozen_claim() {
        let meta = meta_with_cases(3);
        let claim = Claim {
            claim_sufficient: false,
            why_sufficient_or_not: "nothing says what happens when the input is negative".into(),
            unresolved: vec!["negative inputs".into()],
            ..sufficient_claim()
        };
        let prompt = build_verdict_prompt(&meta, None, &BoardSnapshot::default(), &claim);

        assert!(prompt.contains("frozen — read it as given"));
        assert!(prompt.contains("trailing zeros mean the double reversal cannot round-trip"));
        assert!(prompt.contains("does this already decide the answer? no"));
        assert!(prompt.contains("- not decided by the board yet:"));
        assert!(prompt.contains("negative inputs"));
        assert!(prompt.contains("- [2] input:"), "a counterexample needs real indices");

        assert!(VERDICT_SYSTEM_PROMPT.contains("The claim is fixed"));
        assert!(VERDICT_SYSTEM_PROMPT.contains("never pad the list"));
        assert!(VERDICT_SYSTEM_PROMPT.contains("must be null"));
    }

    /// The code pass asks whether the code matches the claim. It is never asked
    /// what approach the stub suggests — that question is how half-typed tablet
    /// code used to talk the coach out of a correct board.
    #[test]
    fn the_code_pass_is_conditioned_on_the_claim() {
        let meta = meta_with_cases(2);
        let board = BoardSnapshot {
            pseudocode: Some("def solve(n):\n    pass".into()),
            app_messages: vec!["Run tests — 1/2 passed".into()],
            ..Default::default()
        };
        let prompt =
            build_claim_code_review_prompt(&meta, None, &board, &sufficient_claim());

        assert!(prompt.contains("Does this code implement the claim above?"));
        assert!(prompt.contains("The claim the board makes"));
        assert!(prompt.contains("def solve(n):"));
        assert!(prompt.contains("1/2 passed"), "test results are facts the pass may cite");
        assert!(CLAIM_CODE_SYSTEM_PROMPT.contains("The claim is the specification"));
        assert!(CLAIM_CODE_SYSTEM_PROMPT.contains("are not gaps"));
    }

    /// Acceptance criterion 2: Lazy implements the claim, and the code dock is
    /// not the source of truth.
    #[test]
    fn lazy_fill_implements_the_frozen_claim() {
        let meta = meta_with_cases(2);
        let board = BoardSnapshot {
            recognized_text: "zeros vanish".into(),
            pseudocode: Some("# WRONG OLD ATTEMPT".into()),
            ..Default::default()
        };
        let claim = sufficient_claim();

        let with_claim = build_lazy_fill_prompt(&meta, None, &board, Some(&claim));
        assert!(with_claim.contains("full working Python for the claim above"));
        assert!(with_claim.contains("reverse the digits once"));
        assert!(!with_claim.contains("WRONG OLD ATTEMPT"), "the dock is not the truth here");

        // No review yet for this board: fall back to reading the drawing.
        let without = build_lazy_fill_prompt(&meta, None, &board, None);
        assert!(without.contains("Interpret the drawing"));
        assert!(!without.contains("The claim the board makes"));
        assert!(!without.contains("WRONG OLD ATTEMPT"));

        assert!(LAZY_FILL_SYSTEM_PROMPT.contains("it is the specification"));
    }

    #[test]
    fn merge_prefers_on_track_board_over_thin_code() {
        let layout = ReviewResponse {
            understood_approach: "trailing zeros break double reversal".into(),
            verdict: Verdict::OnTrack,
            strengths: vec!["key insight".into()],
            gaps: vec![],
            ..Default::default()
        };
        let code = ReviewResponse {
            understood_approach: "stub".into(),
            verdict: Verdict::SubtlyWrong,
            gaps: vec!["does not implement the actual reversal logic".into()],
            offer_bridge: true,
            ..Default::default()
        };
        let merged = merge_layout_and_code_reviews(layout, code);
        assert_eq!(merged.verdict, Verdict::OnTrack);
        assert!(merged.gaps.iter().all(|g| !g.contains("reversal logic")));
        assert!(!merged.offer_bridge);
        assert_eq!(merged.layout_verdict, Some(Verdict::OnTrack));
        assert_eq!(merged.code_verdict, Some(Verdict::SubtlyWrong));
    }

    /// "Run tests" posts its results into the thread and they ride along with
    /// the next question, so asking "why did case 3 fail?" needs no
    /// copy-paste — and the coach must read them as fact, not as a claim.
    #[test]
    fn test_results_reach_the_prompt_as_the_apps_own_channel() {
        let meta = meta_with_cases(3);
        let board = BoardSnapshot {
            recognized_text: "two pointers".into(),
            app_messages: vec![
                "Run tests — 2/3 passed\n\ncase 3: nums = [2]\n  expected: [2]\n  got: []".into(),
            ],
            ..Default::default()
        };
        let prompt = build_review_prompt(&meta, None, &board);
        assert!(prompt.contains("From the app (not the student)"));
        assert!(prompt.contains("2/3 passed"));
        assert!(prompt.contains("Treat them as fact"));

        // And a board with no run says nothing about one.
        let quiet = build_review_prompt(&meta, None, &BoardSnapshot::default());
        assert!(!quiet.contains("From the app"));
    }

    #[test]
    fn a_board_with_neither_ink_nor_pseudocode_is_empty() {
        assert!(BoardSnapshot::default().is_empty());
        assert!(BoardSnapshot {
            pseudocode: Some("   ".into()),
            ..Default::default()
        }
        .is_empty());
    }

    #[test]
    fn a_cited_case_is_resolved_from_the_corpus_or_dropped() {
        let cases = meta_with_cases(3).cases;
        let good = serde_json::json!({"case_index": 1, "why": "duplicates"});
        let citation = validate_citation(&good, &cases).expect("kept");
        assert_eq!(citation.case_number, 2);
        assert_eq!(citation.input, "nums = [1]");
        assert_eq!(citation.expected, "[1]");
        assert_eq!(citation.why, "duplicates");

        // Out of range, negative, and missing all drop rather than render.
        for bad in [
            serde_json::json!({"case_index": 3, "why": "invented"}),
            serde_json::json!({"case_index": -1, "why": "invented"}),
            serde_json::json!({"why": "no index at all"}),
        ] {
            assert!(validate_citation(&bad, &cases).is_none(), "{bad} should drop");
        }
    }

    #[test]
    fn highlight_keeps_only_ids_present_on_the_board() {
        let board = BoardSnapshot {
            scene_structure: Some(serde_json::json!([
                {"id": "el_44abc", "type": "text", "text": "O(n)"},
                {"id": "el_55def", "type": "text", "text": "hash"}
            ])),
            ..Default::default()
        };
        let good = serde_json::json!({
            "ids": ["el_44abc", "missing", "el_55"],
            "tone": "warning",
            "note": "inner loop rescans"
        });
        let highlight = validate_highlight(&good, &board).expect("partially valid");
        assert_eq!(highlight.ids, vec!["el_44abc", "el_55"]);
        assert!(validate_highlight(
            &serde_json::json!({"ids": ["nope"], "note": "x"}),
            &board
        )
        .is_none());
    }

    #[test]
    fn the_viz_prompt_forbids_coordinates_and_numbers_the_cases() {
        let meta = meta_with_cases(2);
        let prompt = build_viz_prompt(&meta, None, &BoardSnapshot::default(), "show the scan");
        assert!(prompt.contains("show the scan"));
        assert!(prompt.contains("- [0] input:"));
        assert!(VIZ_SYSTEM_PROMPT.contains("must not guess coordinates"));
        assert!(VIZ_SYSTEM_PROMPT.contains("about three frames"));
    }

    /// Observed from granite-4.1-8b: it emitted `why_your_approach_fails`
    /// twice, and strict serde threw away an otherwise-good review.
    #[test]
    fn a_duplicated_field_does_not_cost_the_whole_review() {
        let raw = r#"{
            "understood_approach": "sort then two pointers",
            "verdict": "wrong_track",
            "counterexample": {"case_index": 1,
                               "why_your_approach_fails": "first attempt",
                               "why_your_approach_fails": "second attempt"}
        }"#;
        let review = parse_review(raw, &meta_with_cases(4).cases).expect("survives duplicates");
        assert_eq!(review.verdict, Verdict::WrongTrack);
        let cited = review.counterexample.expect("citation kept");
        assert_eq!(
            cited.why_your_approach_fails, "second attempt",
            "a duplicate field is last-wins, not fatal"
        );
    }

    /// The second pass exists because a model given a dozen cases cites one and
    /// then traces a different, invented input. Its prompt therefore shows the
    /// cited case and nothing else.
    #[test]
    fn the_trace_prompt_shows_one_case_and_no_others() {
        let meta = meta_with_cases(8);
        let board = BoardSnapshot {
            recognized_text: "sort then two pointers".into(),
            ..Default::default()
        };
        let prompt = build_trace_prompt(&meta, &board, &meta.cases[5], 6);

        assert!(prompt.contains("case 6"));
        assert!(prompt.contains("nums = [5]"), "the cited case is present");
        for other in [0, 1, 2, 3, 4, 6, 7] {
            assert!(
                !prompt.contains(&format!("nums = [{other}]")),
                "case {other} must not be visible — that is the wandering room this removes"
            );
        }
        assert!(prompt.contains("sort then two pointers"), "their approach is present");
        assert!(TRACE_SYSTEM_PROMPT.contains("Do not mention any other input"));
    }

    #[test]
    fn a_trace_reply_is_read_and_an_empty_one_rejected() {
        assert_eq!(
            parse_trace(r#"{"trace": "  sorting gives [0,0,3,4]  "}"#).unwrap(),
            "sorting gives [0,0,3,4]"
        );
        assert!(parse_trace(r#"{"trace": "   "}"#).is_err());
        assert!(parse_trace("no json here").is_err());
    }

    #[test]
    fn unknown_verdict_degrades_instead_of_failing() {
        let review = parse_review(r#"{"verdict": "kinda_ok", "rating": {"correctness": 9}}"#, &[])
            .unwrap();
        assert_eq!(review.verdict, Verdict::Unclear);
        assert_eq!(review.rating.correctness, 5, "ratings are clamped to 0-5");
    }

    #[test]
    fn ratings_accept_floats_and_numeric_strings() {
        let review = parse_review(
            r#"{"verdict":"unclear","rating":{"correctness":2.0,"complexity":"3","clarity":1}}"#,
            &[],
        )
        .unwrap();
        assert_eq!(review.rating.correctness, 2);
        assert_eq!(review.rating.complexity, 3);
        assert_eq!(review.rating.clarity, 1);
    }

    #[test]
    fn review_prompt_numbers_the_cases_it_allows_citing() {
        let meta = meta_with_cases(3);
        let prompt = build_review_prompt(&meta, Some("Find two numbers."), &BoardSnapshot::default());
        assert!(prompt.contains("- [0] input:"));
        assert!(prompt.contains("- [2] input:"));
        assert!(!prompt.contains("- [3] input:"));
    }

    /// Structural half of the reveal gate: review / ambient / staged / viz /
    /// board / shared / trace must not mention the reveal path. Only `bridge.rs`
    /// (Mode C + Lazy) may.
    #[test]
    fn the_review_and_ambient_builders_cannot_reach_a_reveal() {
        let unprivileged = [
            include_str!("board.rs"),
            include_str!("shared.rs"),
            include_str!("review.rs"),
            include_str!("staged.rs"),
            include_str!("ambient.rs"),
            include_str!("trace.rs"),
            include_str!("viz.rs"),
        ]
        .concat();

        for forbidden in ["SolutionReveal", "UserConsent", "reveal::", "completion"] {
            assert!(
                !unprivileged.contains(forbidden),
                "unprivileged coach modules must not mention {forbidden:?}"
            );
        }
        // And the privileged half does, so the test is actually discriminating.
        let bridge = include_str!("bridge.rs");
        assert!(
            bridge.contains("SolutionReveal"),
            "bridge.rs must still reference SolutionReveal"
        );
    }

    /// Behavioural half: feed the builders a problem whose corpus record has a
    /// reference solution and confirm none of it can appear.
    #[test]
    fn no_prompt_built_from_workspace_meta_can_carry_a_solution() {
        let record = r#"{"task_id": "two-sum", "difficulty": "Easy",
            "problem_description": "Find two numbers.",
            "completion": "SECRET_SOLUTION_BODY", "response": "SECRET_RESPONSE",
            "query": "SECRET_QUERY",
            "input_output": [{"input": "nums = [2,7]", "output": "[0,1]"}]}"#;
        let problem: crate::problem::Problem = serde_json::from_str(record).unwrap();
        let meta = WorkspaceMeta {
            dataset: crate::dataset::DEFAULT_DATASET.into(),
            task_id: problem.task_id.clone(),
            question_id: problem.question_id.clone(),
            difficulty: problem.difficulty.clone(),
            tags: problem.tags.clone(),
            entry_point: problem.entry_point.clone(),
            json_path: "corpus.jsonl".into(),
            cases: problem.input_output.clone(),
            test: problem.test.clone(),
        };
        let board = BoardSnapshot {
            recognized_text: "sort then two pointers".into(),
            ..Default::default()
        };
        let description = problem.problem_description.as_deref();

        let review = build_review_prompt(&meta, description, &board);
        let ambient = build_ambient_prompt(&meta, description, &board, &[], 0);
        for prompt in [&review, &ambient] {
            assert!(prompt.contains("Find two numbers."), "statement still gets through");
            assert!(!prompt.contains("SECRET"), "solution text leaked into a prompt");
        }
    }

    #[test]
    fn ambient_prompt_escalates_and_does_not_repeat_itself() {
        let meta = meta_with_cases(2);
        let said = vec!["Have you considered the sorted order?".to_string()];
        let prompt = build_ambient_prompt(&meta, None, &BoardSnapshot::default(), &said, 3);
        assert!(prompt.contains("Already said (do not repeat)"));
        assert!(prompt.contains("sorted order"));
        assert!(prompt.contains("Cite one concrete sample case"));
    }
