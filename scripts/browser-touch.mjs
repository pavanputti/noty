// iPad-style input: real touch events (finger, palm) mixed with pen events.
// - In Pen mode a finger doesn't draw (it scrolls / taps), unless "Finger draws" is on.
// - Palm rejection: a touch that lands while the Pencil is writing is ignored.
// - The Pencil writes even in Type mode; a finger tap in Type mode puts the cursor in the text.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9338;
const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(tmpdir() + "/cdp-")}`, "--window-size=834,1194", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const waiting = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed"); return r.result.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(expr)) return; } catch {} await sleep(150); } throw new Error("timeout: " + expr); };
let fails = 0; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails++; };
const pen = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen", force: 0.5 });
const touch = (type, points) => send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 8, radiusY: 8, force: 1 })) });
async function fingerDrag(from, to, n = 10) {
  await touch("touchStart", [from]);
  for (let i = 1; i <= n; i++) await touch("touchMove", [[from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n]]);
  await touch("touchEnd", []);
}
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
  const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page");
  ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)[m.error ? "rej" : "res"](m.error ?? m.result); waiting.delete(m.id); } };
  await send("Runtime.enable");
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: "http://localhost:8787/login/dev?next=/" });
  await until(`!!document.querySelector('.library')`);
  const id = await evaluate(`(async () => {
    const nb = await (await fetch('/api/notebooks', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Touch ' + Date.now()})})).json();
    const blocks = [{id:'p', type:'paragraph', props:{}, content:[{type:'text', text:'Tap here to type', styles:{}}], children:[]}, {id:'pg', type:'page', props:{height:1414, style:'dotted', size:'a4'}, children:[]}];
    await fetch('/api/notebooks/' + nb.id, {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({upserts: blocks, deletes: [], order: ['p','pg'], baseVersion: 1, clientId: 'seed'})});
    return nb.id; })()`);
  await send("Page.navigate", { url: `http://localhost:8787/n/${id}` });
  await until(`!!document.querySelector('.nb-page')`);
  await sleep(700);
  const strokes = () => evaluate(`fetch('/api/notebooks/${id}/ink?anchors=p,pg').then(r=>r.json()).then(x => x.p.length + x.pg.length)`);
  check((await evaluate(`[...document.querySelectorAll('.ink-mode.on')].map(b => b.textContent.trim()).join()`)) === "Pen", "on a touch screen (iPad) the Pen is selected from the start");
  await evaluate(`document.querySelector('[data-id="pg"]').scrollIntoView({block:'center'}); true`);
  await sleep(400);
  const [L, W] = await evaluate(`(() => { const r = document.querySelector('[data-node-type="blockOuter"][data-id="pg"]').getBoundingClientRect(); return [r.left, r.width]; })()`);
  const Y = 600;

  // finger in Pen mode: no ink
  await fingerDrag([L + 100, Y], [L + 300, Y + 40]);
  await sleep(800);
  check((await strokes()) === 0, "a finger swipe in Pen mode doesn't draw (only the Pencil writes)");

  // palm rejection: the palm lands while the Pencil is writing
  await pen("mousePressed", L + 100, Y);
  for (let i = 1; i <= 5; i++) await pen("mouseMoved", L + 100 + i * 12, Y + (i % 2 ? 6 : -6));
  await touch("touchStart", [[L + 260, Y + 120]]);           // palm comes down
  await touch("touchMove", [[L + 300, Y + 160]]);
  for (let i = 6; i <= 12; i++) await pen("mouseMoved", L + 100 + i * 12, Y + (i % 2 ? 6 : -6));
  await touch("touchEnd", []);
  await pen("mouseReleased", L + 100 + 12 * 12, Y);
  await sleep(900);
  check((await strokes()) === 1, "palm resting on the screen while writing is ignored (exactly one stroke saved)");

  // Finger draws on: a finger now draws
  await evaluate(`document.querySelector('.ink-more-wrap .ink-icon').click(); true`);
  await evaluate(`[...document.querySelectorAll('.ink-more-item')].find(b => b.textContent.startsWith('Finger draws')).click(); true`);
  await evaluate(`document.querySelector('.ink-more-wrap .ink-icon').click(); true`);
  await fingerDrag([L + 120, Y + 200], [L + 320, Y + 230]);
  await sleep(900);
  check((await strokes()) === 2, "with “Finger draws” on, a finger draws");
  await evaluate(`document.querySelector('.ink-more-wrap .ink-icon').click(); true`);
  await evaluate(`[...document.querySelectorAll('.ink-more-item')].find(b => b.textContent.startsWith('Finger draws')).click(); true`);
  await evaluate(`document.querySelector('.ink-more-wrap .ink-icon').click(); true`);

  // Type mode: the Pencil still writes; a finger tap puts the cursor in the text
  await evaluate(`[...document.querySelectorAll('.ink-mode')].find(b => b.textContent.trim() === 'Type').click(); true`);
  await pen("mousePressed", L + 100, Y + 300);
  for (let i = 1; i <= 10; i++) await pen("mouseMoved", L + 100 + i * 14, Y + 300 + (i % 2 ? 6 : -6));
  await pen("mouseReleased", L + 240, Y + 300);
  await sleep(900);
  check((await strokes()) === 3, "in Type mode the Pencil still writes");
  await evaluate(`document.querySelector('[data-id="p"]').scrollIntoView({block:'center'}); true`);
  await sleep(400);
  const [tx, ty] = await evaluate(`(() => { const r = document.querySelector('[data-id="p"] .bn-inline-content').getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()`);
  await touch("touchStart", [[tx, ty]]);
  await touch("touchEnd", []);
  await sleep(500);
  check(await evaluate(`!!document.activeElement?.closest('.bn-editor')`), "in Type mode a finger tap puts the cursor in the text");
  check((await strokes()) === 3, "and the tap doesn't draw");
} catch (e) { console.log("FAIL error:", e.message); fails++; }
finally { console.log(fails ? `\n${fails} failed.` : "\nAll touch checks passed."); ws?.close(); proc.kill(); process.exit(fails ? 1 : 0); }
