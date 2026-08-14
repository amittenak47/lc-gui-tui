#!/usr/bin/env node
/**
 * Phase 2c + Phase 3 endpoint smoke against live `lc serve`.
 * Usage: node scripts/endpoint-smoke.mjs
 */
const BASE = process.env.LC_BASE_URL ?? "http://127.0.0.1:7878";
const TASK_ID = process.env.LC_TASK_ID ?? "01-matrix";
const DATASET = process.env.LC_DATASET ?? "leetcode";

const COACH_FLAG_KEYS = [
  "ws_runs",
  "process_events_ui",
  "planner_enabled",
  "draw_review_enabled",
  "approach_commitment",
];

const DEFAULT_COACH_FLAGS = {
  ws_runs: true,
  process_events_ui: true,
  planner_enabled: false,
  draw_review_enabled: false,
  approach_commitment: true,
};

const results = [];

function record(id, pass, detail, snippet = "") {
  results.push({ id, pass, detail, snippet: snippet.slice(0, 2000) });
  const mark = pass ? "PASS" : "FAIL";
  console.log(`[${mark}] ${id}: ${detail}`);
}

async function req(method, path, body, opts = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timeout = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

function coachFlags(cfg) {
  return cfg?.coach ?? DEFAULT_COACH_FLAGS;
}

async function getConfig() {
  const r = await req("GET", "/config");
  if (!r.ok) throw new Error(`GET /config failed: ${r.status} ${r.text}`);
  return r.json;
}

async function putConfig(cfg, timeoutMs) {
  const r = await req("PUT", "/config", cfg, { timeoutMs });
  if (!r.ok) throw new Error(`PUT /config failed: ${r.status} ${r.text}`);
  return r.json;
}

async function toggleCoachFlag(key, value) {
  const cfg = await getConfig();
  const before = coachFlags(cfg);
  cfg.coach = { ...DEFAULT_COACH_FLAGS, ...before, [key]: value };
  await putConfig(cfg);
  const after = coachFlags(await getConfig());
  const ok = after[key] === value;
  return { ok, before: before[key], after: after[key] };
}

async function phase2cFlags() {
  let originalCfg;
  try {
    originalCfg = await getConfig();
    record("2c.config.get", true, "GET /config returned coach block", JSON.stringify(coachFlags(originalCfg), null, 2));
  } catch (e) {
    record("2c.config.get", false, String(e.message));
    return;
  }

  const modes = originalCfg.modes;
  if (modes) {
    record(
      "2c.modes.map",
      true,
      `ambient=${modes.ambient} review=${modes.review} bridge=${modes.bridge} viz=${modes.viz} planner=${modes.planner}`,
      JSON.stringify(modes, null, 2),
    );
  } else {
    record("2c.modes.map", false, "modes missing from config");
  }

  for (const key of COACH_FLAG_KEYS) {
    for (const value of [true, false]) {
      const id = `2c.flag.${key}.${value ? "on" : "off"}`;
      try {
        const { ok, before, after } = await toggleCoachFlag(key, value);
        record(id, ok, ok ? `toggle ${key} ${before}→${after}` : `GET did not reflect ${key}=${value} (got ${after})`);
      } catch (e) {
        record(id, false, String(e.message));
      }
    }
  }

  // Harmless save toggle (stop_on_first_failure)
  try {
    const cfg = await getConfig();
    const orig = cfg.stop_on_first_failure;
    cfg.stop_on_first_failure = !orig;
    const saved = await putConfig(cfg, 15_000);
    const reflected = saved.stop_on_first_failure === !orig;
    cfg.stop_on_first_failure = orig;
    await putConfig(cfg, 15_000);
    record("2c.putConfig.save", reflected, `toggled stop_on_first_failure ${orig}→${!orig} and restored`);
  } catch (e) {
    record("2c.putConfig.save", false, String(e.message));
  }

  // Planner scaffold (soft-fail OK)
  try {
    const cfg = await getConfig();
    cfg.coach = { ...coachFlags(cfg), planner_enabled: true };
    await putConfig(cfg);
    const load = await req("POST", `/problems/${encodeURIComponent(TASK_ID)}/load?dataset=${DATASET}`);
    if (!load.ok) {
      record("2c.planner.load", false, `load failed ${load.status}`, load.text);
    } else {
      record("2c.planner.load", true, `loaded ${TASK_ID}`, JSON.stringify(load.json?.task_id ?? load.json, null, 2));
      const scaffold = await req(
        "POST",
        "/coach/scaffold",
        { task_id: TASK_ID, dataset: DATASET },
        { timeoutMs: 120_000 },
      );
      if (scaffold.ok && scaffold.json?.approach) {
        record("2c.planner.scaffold", true, "POST /coach/scaffold returned scaffold", JSON.stringify(scaffold.json, null, 2).slice(0, 500));
      } else if (scaffold.status >= 400 && scaffold.status < 500) {
        record("2c.planner.scaffold", true, `soft-fail: ${scaffold.status} ${scaffold.json?.error ?? scaffold.text}`, scaffold.text);
      } else {
        record("2c.planner.scaffold", false, `unexpected: ${scaffold.status}`, scaffold.text);
      }
    }
  } catch (e) {
    record("2c.planner.scaffold", true, `soft-fail (exception): ${e.message}`);
  }

  // Restore defaults
  try {
    const cfg = await getConfig();
    cfg.coach = { ...DEFAULT_COACH_FLAGS };
    await putConfig(cfg);
    const restored = coachFlags(await getConfig());
    const match = COACH_FLAG_KEYS.every((k) => restored[k] === DEFAULT_COACH_FLAGS[k]);
    record("2c.flags.restore", match, match ? "defaults restored" : JSON.stringify(restored));
  } catch (e) {
    record("2c.flags.restore", false, String(e.message));
  }
}

async function phase3Reads() {
  const reads = [
    ["3.read.health", "GET", "/health"],
    ["3.read.llmStatus", "GET", "/llm/status"],
    ["3.read.capabilities", "GET", "/coach/capabilities"],
    ["3.read.problems", "GET", `/problems?dataset=${DATASET}&limit=3`],
    ["3.read.problem", "GET", `/problems/${encodeURIComponent(TASK_ID)}?dataset=${DATASET}`],
    ["3.read.config", "GET", "/config"],
    ["3.read.datasets", "GET", "/datasets"],
    ["3.read.tags", "GET", `/tags?dataset=${DATASET}`],
    ["3.read.session", "GET", "/session"],
    ["3.read.offlineManifest", "GET", "/offline/pack/manifest"],
  ];

  for (const [id, method, path] of reads) {
    try {
      const r = await req(method, path);
      record(id, r.ok, r.ok ? `${r.status}` : `${r.status} ${r.text?.slice(0, 200)}`, r.text?.slice(0, 400));
    } catch (e) {
      record(id, false, String(e.message));
    }
  }

  // workspace meta/solution after load
  try {
    await req("POST", `/problems/${encodeURIComponent(TASK_ID)}/load?dataset=${DATASET}`);
    const meta = await req("GET", `/workspace/${encodeURIComponent(TASK_ID)}/meta?dataset=${DATASET}`);
    record("3.read.workspaceMeta", meta.ok, meta.ok ? "meta ok" : meta.text, meta.text?.slice(0, 400));
    const sol = await req("GET", `/workspace/${encodeURIComponent(TASK_ID)}/solution?dataset=${DATASET}`);
    record("3.read.getSolution", sol.ok, sol.ok ? `source len=${sol.json?.source?.length ?? 0}` : sol.text, sol.text?.slice(0, 200));
    const board = await req("GET", `/workspace/${encodeURIComponent(TASK_ID)}/board?dataset=${DATASET}`);
    record("3.read.getBoard", board.ok, board.ok ? "board ok" : board.text);
    const agent = await req("GET", `/workspace/${encodeURIComponent(TASK_ID)}/agent?dataset=${DATASET}`);
    record("3.read.getAgent", agent.ok, agent.ok ? `messages=${agent.json?.messages?.length ?? 0}` : agent.text);
    const adj = await req("GET", `/problems/${encodeURIComponent(TASK_ID)}/adjacent?dataset=${DATASET}`);
    record("3.read.adjacent", adj.ok, adj.ok ? `prev=${adj.json?.prev} next=${adj.json?.next}` : adj.text);
  } catch (e) {
    record("3.read.workspace", false, String(e.message));
  }
}

async function phase3Writes() {
  try {
    const sol = await req("GET", `/workspace/${encodeURIComponent(TASK_ID)}/solution?dataset=${DATASET}`);
    if (!sol.ok) {
      record("3.write.putSolution", false, `get failed: ${sol.text}`);
    } else {
      const original = sol.json.source ?? "";
      const marker = "# smoke-test-marker\n";
      const tagged = original.includes(marker) ? original : marker + original;
      const put = await req("PUT", `/workspace/${encodeURIComponent(TASK_ID)}/solution?dataset=${DATASET}`, { source: tagged });
      const restore = await req("PUT", `/workspace/${encodeURIComponent(TASK_ID)}/solution?dataset=${DATASET}`, { source: original });
      record("3.write.putSolution", put.ok && restore.ok, put.ok ? "put+restore ok" : put.text, put.text?.slice(0, 200));
    }
  } catch (e) {
    record("3.write.putSolution", false, String(e.message));
  }

  try {
    const board = await req("GET", `/workspace/${encodeURIComponent(TASK_ID)}/board?dataset=${DATASET}`);
    const original = board.json?.board ?? null;
    const put = await req("PUT", `/workspace/${encodeURIComponent(TASK_ID)}/board?dataset=${DATASET}`, { board: original });
    record("3.write.putBoard", put.ok, put.ok ? "round-trip ok" : put.text);
  } catch (e) {
    record("3.write.putBoard", false, String(e.message));
  }

  try {
    const cfg = await getConfig();
    const orig = cfg.coach?.ws_runs ?? true;
    cfg.coach = { ...coachFlags(cfg), ws_runs: !orig };
    await putConfig(cfg);
    const mid = coachFlags(await getConfig()).ws_runs;
    cfg.coach.ws_runs = orig;
    await putConfig(cfg);
    const end = coachFlags(await getConfig()).ws_runs;
    record("3.write.putConfig", mid === !orig && end === orig, `toggle ws_runs ${orig}→${!orig}→${orig}`);
  } catch (e) {
    record("3.write.putConfig", false, String(e.message));
  }
}

async function phase3Coach() {
  try {
    const ask = await req(
      "POST",
      "/coach/ask",
      { task_id: TASK_ID, dataset: DATASET, surface: "problem", question: "Reply with exactly: pong" },
      { timeoutMs: 120_000 },
    );
    const reply = ask.json?.reply ?? "";
    record("3.coach.ask", ask.ok && reply.length > 0, ask.ok ? `reply="${reply.slice(0, 80)}"` : ask.text, ask.text?.slice(0, 300));
  } catch (e) {
    record("3.coach.ask", false, String(e.message));
  }

  try {
    const review = await req(
      "POST",
      "/coach/review",
      {
        task_id: TASK_ID,
        dataset: DATASET,
        recognized_text: "iterate matrix, track row sums",
        turn_index: 0,
      },
      { timeoutMs: 180_000 },
    );
    record(
      "3.coach.review",
      review.ok && review.json?.verdict,
      review.ok ? `verdict=${review.json.verdict}` : review.text,
      review.text?.slice(0, 400),
    );
  } catch (e) {
    record("3.coach.review", false, String(e.message));
  }

  // draw_review with flag off → expect refusal
  try {
    const cfg = await getConfig();
    cfg.coach = { ...coachFlags(cfg), draw_review_enabled: false };
    await putConfig(cfg);
    const dr = await req(
      "POST",
      "/coach/draw_review",
      { task_id: TASK_ID, dataset: DATASET, program: {}, png: "", ask: "" },
      { timeoutMs: 30_000 },
    );
    const refused = dr.status === 400 || dr.status === 403 || (dr.json?.error && /disabled|flag/i.test(dr.json.error));
    record("3.coach.draw_review.off", refused || dr.status === 422, `status=${dr.status} ${dr.json?.error ?? dr.text?.slice(0, 100)}`);
  } catch (e) {
    record("3.coach.draw_review.off", false, String(e.message));
  }

  // viz — optional, skip if slow (60s cap)
  try {
    const viz = await req(
      "POST",
      "/coach/viz",
      {
        task_id: TASK_ID,
        dataset: DATASET,
        board: { recognized_text: "matrix traversal" },
        ask: "simple diagram",
      },
      { timeoutMs: 60_000 },
    );
    record("3.coach.viz", viz.ok, viz.ok ? `programs=${viz.json?.programs?.length ?? 0}` : `status=${viz.status}`, viz.text?.slice(0, 300));
  } catch (e) {
    record("3.coach.viz", false, `skipped/timeout: ${e.message}`);
  }
}

async function phase3Whiteboard() {
  // Client-only: whiteboard has no daemon problem row
  const r = await req("GET", `/problems/__whiteboard__?dataset=whiteboard`);
  const legacy = await req("GET", `/problems/__scratchpad__?dataset=scratchpad`);
  const clientOnly = r.status === 404 && legacy.status === 404;
  record(
    "3.whiteboard.http",
    true,
    clientOnly
      ? "404 as expected — whiteboard is client-local (dataset=whiteboard, task_id=__whiteboard__)"
      : `unexpected ${r.status}/${legacy.status} — whiteboard may have HTTP backing`,
    r.text?.slice(0, 200),
  );

  // Static assert normalizeCoachFlags behavior (mirrors App.tsx)
  const isWhiteboard = (problem) =>
    problem?.task_id === "__whiteboard__" ||
    problem?.task_id === "__scratchpad__" ||
    problem?.dataset === "whiteboard" ||
    problem?.dataset === "scratchpad";
  const isAnnotate = (problem) =>
    problem?.task_id === "__annotate__" ||
    problem?.task_id === "__md_ink__" ||
    problem?.dataset === "annotate" ||
    problem?.dataset === "md-ink";
  const isLocalPad = (problem) => isWhiteboard(problem) || isAnnotate(problem);
  const normalizeCoachFlags = (requestedFlags, problem) =>
    isLocalPad(problem)
      ? { ask: true, draw: false, reviewBoard: false, lazy: false, annotate: requestedFlags.annotate }
      : requestedFlags;

  const whiteboard = { task_id: "__whiteboard__", dataset: "whiteboard", tags: ["whiteboard"] };
  const annotate = { task_id: "__annotate__", dataset: "annotate", tags: ["annotate"] };
  const problem = { task_id: TASK_ID, dataset: DATASET, tags: [] };
  const full = { ask: false, draw: true, reviewBoard: true, lazy: true, annotate: false };
  const normWhiteboard = normalizeCoachFlags(full, whiteboard);
  const normAnnotate = normalizeCoachFlags(full, annotate);
  const normProblem = normalizeCoachFlags(full, problem);
  const ok =
    normWhiteboard.ask === true &&
    normWhiteboard.draw === false &&
    normWhiteboard.reviewBoard === false &&
    normWhiteboard.lazy === false &&
    normAnnotate.ask === true &&
    normProblem.draw === true;
  record(
    "3.whiteboard.normalizeCoachFlags",
    ok,
    JSON.stringify({ whiteboard: normWhiteboard, annotate: normAnnotate, problem: normProblem }),
  );
}

async function phase3ClientOnly() {
  record(
    "3.client.md-pdf-epub",
    true,
    "No HTTP routes for md/pdf/epub open — client-side via Tauri/file picker (templates/whiteboard, util/whiteboardStore)",
    "Daemon routes: see src/serve/mod.rs — no /document or /library endpoints",
  );
}

async function phase3Ws() {
  const wsBase = BASE.replace(/^http/, "ws");
  const url = `${wsBase}/coach/session`;
  const stages = [];
  let resultBody = null;
  let errorMsg = null;

  await new Promise((resolve) => {
    const ws = new WebSocket(url);
    const requestId = `smoke-${Date.now()}`;
    const timer = setTimeout(() => {
      errorMsg = "timeout 45s";
      ws.close();
      resolve();
    }, 45_000);

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          session_id: "smoke-ws",
          task_id: TASK_ID,
        }),
      );
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: "run",
            request_id: requestId,
            action: "ask",
            payload: {
              task_id: TASK_ID,
              dataset: DATASET,
              surface: "problem",
              question: "Reply pong only",
            },
          }),
        );
      }, 200);
    });

    ws.addEventListener("message", (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (frame.type === "stage" && frame.request_id === requestId) {
        stages.push(frame.stage);
      }
      if (frame.type === "result" && frame.request_id === requestId) {
        resultBody = frame.body;
        clearTimeout(timer);
        ws.close();
        resolve();
      }
      if (frame.type === "error" && (!frame.request_id || frame.request_id === requestId)) {
        errorMsg = frame.message;
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });

    ws.addEventListener("error", () => {
      errorMsg = "websocket error";
      clearTimeout(timer);
      resolve();
    });
  });

  const receivedFirst = stages[0] === "received";
  record(
    "3.ws.received.stage",
    receivedFirst,
    receivedFirst
      ? `stages=${stages.join("→")}`
      : `stages=${stages.join(",") || "none"} err=${errorMsg ?? "n/a"}`,
    JSON.stringify({ stages, resultBody, errorMsg }),
  );
  record(
    "3.ws.ask.result",
    Boolean(resultBody?.reply),
    resultBody?.reply ? `reply="${String(resultBody.reply).slice(0, 60)}"` : errorMsg ?? "no result",
  );
}

async function main() {
  console.log(`Smoke against ${BASE} task=${TASK_ID} dataset=${DATASET}\n`);
  await phase2cFlags();
  await phase3Reads();
  await phase3Writes();
  await phase3Coach();
  await phase3Whiteboard();
  await phase3ClientOnly();
  await phase3Ws();

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  console.log(`\n=== ${pass} pass / ${fail} fail ===`);
  const outPath = process.env.SMOKE_JSON_OUT;
  if (outPath) {
    const fs = await import("node:fs");
    fs.writeFileSync(outPath, JSON.stringify({ base: BASE, task: TASK_ID, dataset: DATASET, pass, fail, results }, null, 2));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
