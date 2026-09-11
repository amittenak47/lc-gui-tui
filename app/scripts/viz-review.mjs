// Local browser review with Chrome's DevTools protocol; no extra dependencies.
// Usage: node scripts/viz-review.mjs (Vite must serve 127.0.0.1:1427).
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const out = resolve(".tmp-viz-review");
await mkdir(out, { recursive: true });
const profile = resolve(out, `chrome-profile-${process.pid}`);
const chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--disable-crash-reporter",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { windowsHide: true, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let socket;
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { await sleep(100); }
  }
  if (!port) throw new Error("Chrome did not start");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, reject) => { socket.onopen = r; socket.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  const errors = [];
  const openTrace = [];
  const network = [];
  const requests = new Map();
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails);
    if (msg.method === "Network.requestWillBeSent") requests.set(msg.params.requestId, msg.params.request.url);
    if (msg.method === "Network.loadingFinished" || msg.method === "Network.loadingFailed") requests.delete(msg.params.requestId);
    if (msg.method === "Network.loadingFailed") network.push(msg.params);
    if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) network.push(msg.params.response);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") network.push(msg.params.args);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.args[0]?.value?.startsWith?.("[lc:open]")) openTrace.push(msg.params.args.map(arg => arg.value));
    const request = pending.get(msg.id);
    if (request) { pending.delete(msg.id); msg.error ? request.reject(new Error(JSON.stringify(msg.error))) : request.resolve(msg.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const screenshot = async (name) => {
    const { cssContentSize } = await send("Page.getLayoutMetrics");
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } });
    await writeFile(resolve(out, `${name}.png`), Buffer.from(data, "base64"));
  };
  const press = async (selector, hold = 0) => {
    let point;
    for (let i = 0; i < 100; i++) {
      point = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        return r.width && r.height && el.contains(document.elementFromPoint(x, y)) ? {x,y} : null;
      })()`);
      if (point) break;
      await sleep(100);
    }
    if (!point) {
      await screenshot("unreachable-control");
      throw new Error(`Control not reachable: ${selector}; ${await evaluate('document.body.innerText')}`);
    }
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    if (hold) await sleep(hold);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    await sleep(250);
  };
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1050, deviceScaleFactor: 1, mobile: false });
  const navigation = await send("Page.navigate", { url: "http://127.0.0.1:1427/scripts/viz-review.html" });
  if (navigation.errorText) throw new Error(navigation.errorText);
  for (let i = 0; i < 100; i++) {
    if (await evaluate('Boolean(document.querySelector(".lc-timeline"))')) break;
    await sleep(100);
  }
  if (!await evaluate('Boolean(document.querySelector(".lc-timeline"))')) {
    throw new Error(JSON.stringify({ errors, network, pending: [...requests.values()], page: await evaluate('({url:location.href, body:document.body.innerText})') }));
  }
  await screenshot("desktop-array");
  await evaluate('document.querySelector(`[aria-label="Play"]`).click()');
  await sleep(1400);
  const step = await evaluate('document.querySelector(".lc-timeline-count").textContent');
  if (step !== "Step 2 of 3") throw new Error(`Playback failed: ${step}`);
  await screenshot("desktop-playing");
  await sleep(1300);
  if (!await evaluate('Boolean(document.querySelector(`[aria-label="Replay"]`))')) throw new Error("Playback did not finish");
  for (const name of ["trie", "unionfind", "calltree", "dptable"]) {
    await evaluate(`[...document.querySelectorAll("nav button")].find(b => b.textContent === ${JSON.stringify(name)}).click()`);
    await sleep(350);
    await evaluate('document.querySelector(`[aria-label="Next step"]`)?.click()');
    await sleep(350);
    await screenshot(`desktop-${name}`);
  }
  await evaluate('[...document.querySelectorAll("header button")][0].click()');
  await screenshot("dark-controls");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('[...document.querySelectorAll("header button")][0].click()');
  await sleep(300);
  await screenshot("mobile");
  const overflow = await evaluate('document.documentElement.scrollWidth > innerWidth');
  if (overflow) throw new Error("Mobile page has horizontal overflow");
  // Also smoke-test the actual application shell in an isolated empty profile.
  await send("Page.navigate", { url: "http://127.0.0.1:1427/" });
  for (let i = 0; i < 200; i++) {
    if (await evaluate('Boolean(document.querySelector(".lc-home-chooser"))')) break;
    await sleep(100);
  }
  const homeText = await evaluate('document.querySelector("#root")?.innerText.trim() || ""');
  if (!await evaluate('Boolean(document.querySelector(".lc-home-chooser"))')) throw new Error(`Application did not reach Home: ${JSON.stringify({errors, pending: [...requests.values()], homeText})}`);
  console.log(`Application shell: ${homeText.slice(0, 500)}`);
  await sleep(1500);
  if (await evaluate('Boolean(document.querySelector(`[aria-label$="Continue without LLM"]`))')) await press('[aria-label$="Continue without LLM"]', 600);
  await screenshot("app-home");
  await press('.lc-home-chooser [aria-label^="Whiteboard"]');
  await sleep(2000);
  console.log(`Whiteboard entry: ${await evaluate('document.body.innerText.slice(0, 800)')}`);
  await screenshot("app-whiteboard");
  if (await evaluate('Boolean(document.querySelector(`[aria-label$="Continue without LLM"]`))')) await press('[aria-label$="Continue without LLM"]', 600);
  await press('[aria-label$="New notebook"]', 600);
  for (let i = 0; i < 200; i++) {
    if (await evaluate('Boolean(document.querySelector(`[aria-label="Show toolbar"]`))')) break;
    await sleep(100);
  }
  if (await evaluate('Boolean(document.querySelector(`[aria-label="Show toolbar"]`))')) await press('[aria-label="Show toolbar"]');
  if (!await evaluate('Boolean(document.querySelector(".lc-toolbar"))')) {
    await screenshot("app-notebook-failed");
    const moduleError = await evaluate('import("/src/canvas/Board.tsx").then(() => "loaded", e => String(e))');
    throw new Error(`Notebook did not load: ${JSON.stringify({errors, network, moduleError, openTrace, pending:[...requests.values()], body:await evaluate('document.body.innerText')})}`);
  }
  console.log(`Notebook: ${await evaluate('document.body.innerText.slice(0, 1000)')}`);
  await screenshot("app-notebook");
  await press('.lc-toolbar .lc-shapes-wrap > button');
  await press('.lc-shape-flyout .is-active > button:last-child');
  await screenshot("app-shape-library");
  await press('.lc-shapes .lc-shape');
  await screenshot("app-shape-config");
  await press('.lc-shapes .lc-shape-place');
  await sleep(300);
  if (await evaluate('Boolean(document.querySelector(".lc-shapes"))')) throw new Error("Stamp placement left library open");
  const stampFits = await evaluate(`(() => {
    const r = document.querySelector('.lc-scene-select-box')?.getBoundingClientRect();
    return r && r.width >= 200 && r.x >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
  })()`);
  if (!stampFits) throw new Error("Placed stamp is too small or outside the viewport");
  await screenshot("app-array-stamp");
  const rotation = await evaluate(`(() => {
    const button = document.querySelector('.lc-scene-select-menu [aria-label="Rotate"]');
    if (!button) throw new Error('Placed stamp was not selected');
    const r = button.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...rotation, button: "left", clickCount: 1 });
  const checkAngleCenter = async () => {
    const offset = await evaluate(`(() => {
      const r = document.querySelector('.lc-scene-select-menu [aria-label="Rotate"]').getBoundingClientRect();
      const a = document.querySelector('.lc-scene-select-angle').getBoundingClientRect();
      return Math.hypot(a.x + a.width / 2 - r.x - r.width / 2, a.y + a.height / 2 - r.y - r.height / 2);
    })()`);
    if (offset > 1) throw new Error(`Rotation label drifted ${offset}px from its button`);
  };
  for (const delay of [0, 60, 120]) { await sleep(delay); await checkAngleCenter(); }
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rotation.x + 60, y: rotation.y + 25, button: "left", buttons: 1 });
  await sleep(80);
  await checkAngleCenter();
  await screenshot("app-rotating");
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rotation.x + 60, y: rotation.y + 25, button: "left", clickCount: 1 });
  await sleep(180);
  await screenshot("app-rotated");
  await writeFile(resolve(out, "browser-errors.json"), JSON.stringify(errors, null, 2));
  if (errors.length) throw new Error(`Browser raised ${errors.length} exceptions; see browser-errors.json`);
  console.log(`Visual review passed. Screenshots: ${out}`);
  await send("Browser.close");
} finally {
  socket?.close();
  chrome.kill();
}
