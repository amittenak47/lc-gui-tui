// Manual review harness. Run Vite and open /scripts/viz-review.html.
// Uses production components and renderer; no model, account, or saved user data.
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Timeline } from "../src/viz/Timeline";
import { SceneOverlay, type SceneOverlayHandle } from "../src/canvas/SceneOverlay";
import { ShapePreview } from "../src/canvas/ShapePreview";
import { SHAPES } from "../src/templates/shapes";
import { renderViz } from "../src/viz/render";
import { convertToExcalidrawElements } from "../src/canvas/convertSkeletons";
import { parseVizProgram } from "../src/viz/schema";
import "../src/styles.css";

const programs = [
  { viz: "array", id: "two-pointers", title: "Find a pair that sums to 9", frames: [
    { label: "Start at both ends", cells: [2, 7, 11, 15], pointers: { left: 0, right: 3 }, highlight: [0, 3], note: "2 + 15 is too large. Move the right pointer inward." },
    { label: "Narrow the search", cells: [2, 7, 11, 15], pointers: { left: 0, right: 2 }, highlight: [0, 2], note: "2 + 11 is still greater than 9. Keep moving right inward." },
    { label: "Pair found", cells: [2, 7, 11, 15], pointers: { left: 0, right: 1 }, highlight: [0, 1], note: "2 + 7 = 9. The answer is at indices 0 and 1." },
  ] },
  { viz: "trie", id: "trie", title: "Words share a prefix", frames: [
    { label: "Insert app", cells: [{ ch: "" }, { ch: "a" }, { ch: "p" }, { ch: "p", end: true }], entries: [[0, 1], [1, 2], [2, 3]], highlight: [3], note: "The terminal marker means app is a complete word." },
    { label: "Extend to apple", cells: [{ ch: "" }, { ch: "a" }, { ch: "p" }, { ch: "p", end: true }, { ch: "l" }, { ch: "e", end: true }], entries: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]], highlight: [4, 5], note: "Keep app as a word while adding the l → e suffix." },
  ] },
  { viz: "unionfind", id: "sets", title: "Join two sets", frames: [
    { label: "Separate roots", cells: [0, 1, 2, 3], entries: [0, 0, 0, 0], highlight: [1, 2] },
    { label: "Union 1 and 2", cells: [0, 1, 1, 3], entries: [0, 1, 0, 0], highlight: [1, 2], note: "Node 2 now points to root 1." },
  ] },
  { viz: "calltree", id: "calls", title: "Follow recursive calls", frames: [
    { label: "Enter fib(3)", cells: [{ fn: "fib", args: [3] }], highlight: [0] },
    { label: "Expand the two branches", cells: [{ fn: "fib", args: [3] }, { fn: "fib", args: [2] }, { fn: "fib", args: [1] }], entries: [[0, 1], [0, 2]], highlight: [1, 2] },
  ] },
].map((p) => parseVizProgram(p)!);

function Review() {
  const [chosen, setChosen] = useState(0);
  const [shape, setShape] = useState(SHAPES[0]);
  const [mods, setMods] = useState(shape.defaults);
  const [dark, setDark] = useState(false);
  const overlay = useRef<SceneOverlayHandle>(null);
  const board = useRef<HTMLDivElement>(null);
  const elements = useRef<unknown[]>([]);
  const program = programs[chosen];
  return <main className="review" style={dark ? { "--panel": "#242424", "--bg": "#181818", "--ink": "#eee", "--muted": "#aaa", "--line": "#444" } as React.CSSProperties : undefined}>
    <header><div><small>WHITEBOARD / INTERACTION REVIEW</small><h1>Think it through, one step at a time.</h1><p>Play a trace. Follow what changes. Make room for your own ideas.</p></div><button onClick={() => setDark(!dark)}>Toggle theme</button></header>
    <div className="review-layout"><section><nav>{programs.map((p, i) => <button key={p.id} className={i === chosen ? "selected" : ""} onClick={() => setChosen(i)}>{p.viz}</button>)}</nav>
      <div ref={board} className="review-board"><SceneOverlay ref={overlay} getElements={() => elements.current} getViewport={() => ({ scrollX: 0, scrollY: 0, zoom: 1, width: board.current?.clientWidth ?? 600, height: 560 })} /></div>
      <div className="review-player"><Timeline program={program} onFrame={(i) => { elements.current = convertToExcalidrawElements(renderViz(program, i, { x: 32, y: 32 }), { regenerateIds: false }); overlay.current?.redraw(); }} /></div>
    </section><aside><h2>Your shape library</h2><p>Shared layouts, ready to draw.</p><div className="review-shapes">{SHAPES.map((s) => <button key={s.id} className={`lc-shape${s === shape ? " selected" : ""}`} onClick={() => { setShape(s); setMods(s.defaults); }}><ShapePreview shape={s} /><span>{s.label}</span></button>)}</div><h2>{shape.label}</h2><ShapePreview shape={shape} mods={mods} large />{shape.fields.map((field) => <label className="lc-shape-field" key={field.key}>{field.label}<input aria-label={field.label} type={field.kind === "int" ? "number" : "text"} min={field.min} max={field.max} value={mods[field.key]} onChange={(event) => setMods({ ...mods, [field.key]: event.target.value })} /></label>)}</aside></div>
  </main>;
}

const style = document.createElement("style");
style.textContent = `body{margin:0;background:#f4f3f0;font-family:system-ui;color:#252525}.review{--panel:#fff;--bg:#faf9f6;--ink:#252525;--muted:#72706b;--line:#e3e0d9;--accent:#b75c39;--chrome-edge:#e3e0d9;--surface:#fff;max-width:1280px;margin:auto;padding:40px;background:var(--bg);color:var(--ink)}.review header{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}.review small{font-size:10px;letter-spacing:.16em;color:var(--muted)}.review h1{font-size:29px;font-weight:550;letter-spacing:-.7px;margin:10px 0}.review p{font-size:13px;color:var(--muted)}.review-layout{display:grid;grid-template-columns:minmax(0,1fr) 292px;gap:28px}.review nav{display:flex;gap:7px;margin-bottom:12px;flex-wrap:wrap}.review button{cursor:pointer;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink);padding:8px 12px}.review button.selected{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,var(--panel))}.review-board{height:560px;position:relative;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}.review-player{max-width:440px;margin:18px auto 0}.review aside{padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:14px}.review h2{font-size:16px;font-weight:600;margin:0 0 6px}.review-shapes{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:16px 0 20px}.review .lc-shape{padding:6px;font-size:11px}.review .lc-shape-field{margin-top:12px}@media(max-width:700px){.review{padding:18px}.review header{display:block}.review h1{font-size:24px}.review-layout{grid-template-columns:1fr}.review-board{height:560px}.review-shapes{grid-template-columns:repeat(3,1fr)}}`;
document.head.appendChild(style);
createRoot(document.getElementById("root")!).render(<Review />);
