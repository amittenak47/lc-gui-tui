/**
 * Selection-block annotations and live coach threads against the writer's
 * textbooks.
 *
 * Ink is already covered by `textbookInk.local.test.mjs`. This file extracts
 * real page text, plants several footnote panels (notes, links, thread
 * pointers), measures how that JSON and packed coach context scale, then —
 * when the harness and the LLM are up — sends a quoted ask the same way the
 * document pad does.
 *
 * PDFs stay in Downloads. Missing files, a down daemon, or an unreachable LLM
 * skip the matching case so CI without those still passes.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { withConversationContext } from "./coachContext";
import { MARK_CONTEXT_BUDGET_CHARS, packFootnoteContext } from "./coachMarkContext";
import {
  addFootnote,
  numberFootnotes,
  orderScopes,
  sanitizeFootnotes,
  threadTitleFrom,
} from "../util/docFootnotes";

const DOWNLOADS = join(homedir(), "Downloads");
const DAEMON = "http://127.0.0.1:7878";
/** Must match `clip(..., 4000)` in `src/llm/coach/prompts/ask.rs`. */
const DAEMON_ASK_CLIP_CHARS = 4000;

const TEXTBOOKS = [
  {
    id: "kleinberg",
    name: "Kleinberg, Jon - Algorithm design _ monograph (2005, Tsinghua University Press) - libgen.li.pdf",
  },
  {
    id: "dasgupta",
    name: "Sanjoy Dasgupta, Christos H. Papadimitriou, Umesh Vazirani - Algorithms (2011, McGraw-Hill) - libgen.li.pdf",
  },
];

function utf8Bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function pageStream(content) {
  const parts = [];
  for (const item of content.items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    parts.push(item.str);
    if (item.hasEOL) parts.push("\n");
  }
  return parts.join("").replace(/[ \t]+\n/g, "\n").trim();
}

function quoteFrom(stream, min = 48, max = 220) {
  const flat = stream.replace(/\s+/g, " ").trim();
  if (flat.length < min) return null;
  let end = Math.min(max, flat.length);
  const space = flat.lastIndexOf(" ", end);
  if (space >= min) end = space;
  return { start: 0, end, excerpt: flat.slice(0, end), stream: flat };
}

function samplePageIds(numPages) {
  const wanted = new Set([1, 2, 10, 50, Math.floor(numPages / 2), numPages - 1, numPages]);
  for (let page = 40; page < numPages; page += 40) wanted.add(page);
  return [...wanted]
    .filter((page) => page >= 1 && page <= numPages)
    .sort((a, b) => a - b);
}

function denseMark(page, quote, index) {
  const now = 1_700_000_000_000 + index;
  const block = quote.stream.slice(0, Math.min(1200, quote.stream.length));
  return {
    id: `fn-p${page}-${index}`,
    kind: "note",
    anchor: { kind: "text", start: quote.start, end: quote.end, scope: `p${page}` },
    excerpt: quote.excerpt,
    createdAt: now,
    blockText: block,
    title: `p${page} panel`,
    notes: [
      { id: `n-${page}-a`, text: `Why this paragraph on page ${page}?`, createdAt: now, updatedAt: now },
      { id: `n-${page}-b`, text: "Compare with the earlier definition.", createdAt: now, updatedAt: now },
    ],
    userLinks: [
      { url: "https://en.wikipedia.org/wiki/Algorithm", title: "Algorithm" },
    ],
    threads: [
      { rootId: `thread-p${page}`, title: `Earlier ask about page ${page}`, createdAt: now },
    ],
    color: "#3b82f6",
  };
}

async function probeLiveCoach() {
  try {
    const health = await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(4000) });
    if (!health.ok) return { ok: false, reason: `health ${health.status}` };
    const body = await health.json();
    if (body.requires_token) {
      return { ok: false, reason: "daemon requires a pairing token" };
    }
    const llm = await fetch(`${DAEMON}/llm/status`, { signal: AbortSignal.timeout(12000) });
    if (!llm.ok) return { ok: false, reason: `llm/status ${llm.status}` };
    const status = await llm.json();
    if (!status.running) {
      return { ok: false, reason: status.detail || "local LLM not reachable" };
    }
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: String(cause?.message ?? cause) };
  }
}

async function coachAsk(question) {
  const response = await fetch(`${DAEMON}/coach/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      surface: "annotate",
      task_id: ANNOTATE_TASK_ID,
      question,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: text.slice(0, 400) };
  }
  return { ok: response.ok, status: response.status, body: parsed, raw: text };
}

const liveCoach = await probeLiveCoach();
if (!liveCoach.ok) {
  console.info("textbook-marks live coach skipped:", liveCoach.reason);
}

describe("textbook selection marks from Downloads", () => {
  let pdfjs;

  beforeAll(async () => {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
  });

  for (const book of TEXTBOOKS) {
    const path = join(DOWNLOADS, book.name);
    const present = existsSync(path);
    const runLive = book.id === "kleinberg" && liveCoach.ok;

    describe.skipIf(!present)(book.id, () => {
      it(
        "extracts page text, round-trips footnote anchors, and scales many panels",
        async () => {
          const bytes = new Uint8Array(readFileSync(path));
          const doc = await pdfjs.getDocument({ data: bytes }).promise;
          const numPages = doc.numPages;
          expect(numPages).toBeGreaterThan(50);

          orderScopes(Array.from({ length: numPages }, (_, i) => `p${i + 1}`));

          const quotes = [];
          for (const page of samplePageIds(numPages)) {
            const pdfPage = await doc.getPage(page);
            const stream = pageStream(await pdfPage.getTextContent());
            pdfPage.cleanup();
            const quote = quoteFrom(stream);
            if (!quote) continue;
            expect(quote.stream.slice(quote.start, quote.end)).toBe(quote.excerpt);
            quotes.push({ page, quote });
          }
          if (typeof doc.destroy === "function") await doc.destroy();
          else if (typeof doc.cleanup === "function") await doc.cleanup();

          expect(quotes.length).toBeGreaterThanOrEqual(3);

          let footnotes = [];
          for (const [index, { page, quote }] of quotes.entries()) {
            footnotes = addFootnote(footnotes, denseMark(page, quote, index));
          }
          const kept = sanitizeFootnotes(footnotes);
          expect(kept).toHaveLength(quotes.length);
          for (const [index, mark] of kept.entries()) {
            const source = quotes[index];
            expect(mark.anchor.scope).toBe(`p${source.page}`);
            expect(source.quote.stream.slice(mark.anchor.start, mark.anchor.end)).toBe(
              mark.excerpt,
            );
            expect(mark.notes).toHaveLength(2);
            expect(mark.userLinks?.[0].url).toContain("wikipedia");
            expect(mark.threads?.[0].rootId).toBe(`thread-p${source.page}`);
          }

          const numbers = numberFootnotes(kept);
          expect(numbers.get(kept[0].id)).toBe(1);
          expect([...numbers.values()].at(-1)).toBe(kept.length);

          const oneJson = utf8Bytes([kept[0]]);
          const allJson = utf8Bytes(kept);
          const packedOne = packFootnoteContext(kept.slice(0, 1), { numbers });
          const packedThree = packFootnoteContext(kept.slice(0, Math.min(3, kept.length)), {
            numbers,
          });
          const packedAll = packFootnoteContext(kept, { numbers });
          const ifEveryPage = oneJson * numPages;

          expect(packedOne.length).toBeGreaterThan(40);
          expect(packedAll.length).toBeLessThanOrEqual(MARK_CONTEXT_BUDGET_CHARS + 200);
          expect(packedThree.length).toBeLessThanOrEqual(DAEMON_ASK_CLIP_CHARS);

          console.info(`textbook-marks-${book.id}`, {
            pages: numPages,
            sampledWithText: quotes.length,
            panels: kept.length,
            onePanelJsonBytes: oneJson,
            allSampledJsonBytes: allJson,
            ifEveryPageHadOnePanelMB: +(ifEveryPage / 1024 / 1024).toFixed(2),
            packedOneChars: packedOne.length,
            packedThreeChars: packedThree.length,
            packedAllChars: packedAll.length,
            markBudget: MARK_CONTEXT_BUDGET_CHARS,
            daemonAskClip: DAEMON_ASK_CLIP_CHARS,
          });
        },
        180_000,
      );

      it.skipIf(!runLive)(
        "asks the live coach about quoted marks and a follow-up in that thread",
        async () => {
          const bytes = new Uint8Array(readFileSync(path));
          const doc = await pdfjs.getDocument({ data: bytes }).promise;
          const quotes = [];
          for (const page of [1, 50, doc.numPages]) {
            if (page < 1 || page > doc.numPages) continue;
            const pdfPage = await doc.getPage(page);
            const quote = quoteFrom(pageStream(await pdfPage.getTextContent()));
            pdfPage.cleanup();
            if (quote) quotes.push({ page, quote });
          }
          if (typeof doc.destroy === "function") await doc.destroy();
          else if (typeof doc.cleanup === "function") await doc.cleanup();
          expect(quotes.length).toBeGreaterThanOrEqual(2);

          orderScopes(quotes.map((entry) => `p${entry.page}`));
          let marks = [];
          for (const [index, { page, quote }] of quotes.slice(0, 2).entries()) {
            marks = addFootnote(marks, denseMark(page, quote, index));
          }
          const numbers = numberFootnotes(marks);
          const markContext = packFootnoteContext(marks, { numbers });
          const passage = marks[0].excerpt;
          const asked =
            "In one short paragraph, what concept is this quoted passage introducing?";
          const prompt = `${markContext}\n\nFrom the document:\n\n“${passage}”\n\n${asked}`;
          expect(prompt.length).toBeLessThan(DAEMON_ASK_CLIP_CHARS);

          let used = { surface: "annotate" };
          let first = await coachAsk(prompt);
          expect(first.ok, first.raw?.slice?.(0, 400) ?? String(first.status)).toBe(true);
          const reply = String(first.body.reply ?? "").trim();
          expect(reply.length).toBeGreaterThan(20);

          const rootId = "u-live-1";
          const thread = {
            rootId,
            title: threadTitleFrom(asked),
            createdAt: Date.now(),
          };
          marks = marks.map((mark) => ({
            ...mark,
            kind: "coach",
            threadRootId: mark.threadRootId ?? rootId,
            threads: [...(mark.threads ?? []), thread],
          }));
          expect(sanitizeFootnotes(marks).every((mark) => mark.threads?.some((t) => t.rootId === rootId))).toBe(
            true,
          );

          const history = [
            { id: rootId, role: "user", content: asked, at: 1 },
            {
              id: "a-live-1",
              role: "assistant",
              content: reply,
              at: 2,
              replyTo: { id: rootId, role: "user", excerpt: asked.slice(0, 80) },
            },
          ];
          const followUp = withConversationContext(
            "Name the key term from that quote in a few words.",
            history,
            { threadRootId: rootId },
          );
          expect(followUp).toContain("Earlier in this thread");
          expect(followUp).toContain(asked.slice(0, 20));

          const secondPrompt = `${packFootnoteContext(marks, { numbers })}\n\n${followUp}`;
          const second = await coachAsk(secondPrompt);
          expect(second.ok, second.raw?.slice?.(0, 400) ?? String(second.status)).toBe(true);
          const followReply = String(second.body.reply ?? "").trim();
          expect(followReply.length).toBeGreaterThan(8);

          const transcript = [
            ...history,
            { id: "u-live-2", role: "user", content: followUp, at: 3, replyTo: history[1] },
            { id: "a-live-2", role: "assistant", content: followReply, at: 4 },
          ];

          console.info("textbook-marks-live-kleinberg", {
            surface: used.surface,
            promptChars: prompt.length,
            followUpChars: secondPrompt.length,
            firstReplyChars: reply.length,
            followReplyChars: followReply.length,
            transcriptJsonBytes: utf8Bytes(transcript),
            firstReplyPreview: reply.slice(0, 180),
            followPreview: followReply.slice(0, 180),
          });
        },
        180_000,
      );
    });
  }
});
