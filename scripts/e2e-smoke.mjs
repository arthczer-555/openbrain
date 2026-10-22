// End-to-end smoke test of the chatbot, without a test framework: starts `openbrain demo`
// on a free port, drives a headless Chrome through the DevTools protocol (Node's built-in WebSocket), and
// checks the path a user takes: ask, read the answer, open a source, flag it, see it in the admin.
// Usage: npm run e2e   (CHROME_PATH=/path/to/chrome when Chrome is not in a standard place)

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 8800 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${port}`;
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.log("no Chrome found: set CHROME_PATH");
  process.exit(1);
}

// 1. The demo server (Acme, demo model, open local auth, UI through Vite).
const store = mkdtempSync(path.join(tmpdir(), "ob-e2e-"));
const server = spawn(process.execPath, ["--import", "tsx", "packages/cli/src/main.ts", "demo", "--port", String(port)], {
  env: { ...process.env, OPENBRAIN_CLI: "1", OPENBRAIN_DEMO_DELAY_MS: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; i < 120 && !serverLog.includes("is running at"); i++) await sleep(250);
if (!serverLog.includes("is running at")) {
  console.log(serverLog);
  server.kill();
  process.exit(1);
}

// 2. Headless Chrome over the DevTools protocol.
const cdpPort = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(path.join(tmpdir(), "ob-chrome-"));
const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
let targets = [];
for (let i = 0; i < 60 && targets.length === 0; i++) {
  try {
    targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).filter((t) => t.type === "page");
  } catch {
    await sleep(200);
  }
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const waitFor = async (expression, timeoutMs = 15_000) => {
  for (let t = 0; t < timeoutMs; t += 200) {
    if (await evaluate(expression)) return true;
    await sleep(200);
  }
  return false;
};
const go = async (url) => {
  await send("Page.navigate", { url });
  await sleep(1200);
};

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await go(`${base}/`);
  check(await waitFor("!!document.querySelector('#ask') && !!document.querySelector('.welcome')", 30_000), "chat loads on its empty state");
  check(await evaluate("!document.querySelector('.suggestion')"), "no suggested questions (D19)");
  await evaluate(`(() => { const el = document.querySelector('#ask'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, 'How do I add a user in the internal tool?'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  await evaluate("document.querySelector('button[type=submit]').click()");
  check(await waitFor("!!document.querySelector('.answer-actions')"), "an answer is streamed to the end");
  check(await evaluate("document.querySelectorAll('.prose button.cite').length > 0"), "the answer carries citation chips");
  check(await evaluate("/searched/.test(document.querySelector('.steps')?.textContent ?? '')"), "the search step is shown");

  await evaluate("document.querySelector('.prose button.cite').click()");
  check(await waitFor("!!document.querySelector('.source-panel h2')"), "a citation opens its passage");
  check(await evaluate("document.querySelector('.source-panel a.btn')?.href.startsWith('https://www.notion.so/')"), "the source links to its Notion page");

  await evaluate("document.querySelector(\"button[aria-label='Not helpful']\").click()");
  check(await waitFor("!!document.querySelector('.feedback-box')"), "thumbs down asks for an optional comment");

  await evaluate(`(() => { const el = document.querySelector('#ask'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, 'zorblax quantum flux capacitor?'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  await evaluate("document.querySelector('button[type=submit]').click()");
  check(await waitFor("/not documented yet/i.test(document.querySelector('.callout')?.textContent ?? '')"), "an unknown question says it is not documented");

  await go(`${base}/admin`);
  check(await waitFor("document.querySelectorAll('table.data tbody tr').length >= 2"), "the admin lists the flagged questions");
  const signals = await evaluate("[...document.querySelectorAll('.signal')].map((s) => s.textContent).join(',')");
  check(/Thumbs down/.test(signals) && /No answer/.test(signals), "both signals are there (thumbs down, no answer)");

  await go(`${base}/kb?page=internal-tools/accounts`);
  check(await waitFor("/Add teammate/.test(document.querySelector('.kb-page')?.textContent ?? '')"), "the knowledge browser renders a page");

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await go(`${base}/`);
  check(await waitFor("!!document.querySelector('.mobile-bar')"), "mobile layout");
  check((await evaluate("document.documentElement.scrollWidth")) <= 390, "no horizontal scroll at 390 px");

  check(errors.length === 0, `no JavaScript exception${errors.length ? `: ${errors[0]}` : ""}`);
} finally {
  ws.close();
  const chromeExit = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  server.kill();
  await Promise.race([chromeExit, sleep(3000)]);
  // The demo writes its local store under examples/acme/.openbrain (gitignored); the temp profiles go away.
  for (const dir of [profile, store]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A leftover temp folder is harmless.
    }
  }
}

console.log(failures.length === 0 ? "\nend-to-end smoke test passed" : `\n${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
