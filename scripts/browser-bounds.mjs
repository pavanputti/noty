// Ink stays on the page: strokes can't start beside a PDF page, between pages, or outside the
// notebook's writing column, and strokes dragged off the edge are kept inside it.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
const pdfPath = process.argv[2];
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9337;
const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(tmpdir() + "/cdp-")}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const waiting = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed"); return r.result.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(expr)) return; } catch {} await sleep(150); } throw new Error("timeout: " + expr); };
let fails = 0; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails++; };
const ev = (type, x, y, pointerType) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType, force: 0.6 });
async function drag(points, pointerType = "pen") { await ev("mousePressed", ...points[0], pointerType); for (const p of points.slice(1)) await ev("mouseMoved", ...p, pointerType); await ev("mouseReleased", ...points.at(-1), pointerType); }
const decode = (d) => { const n = d.split(",").map(Number); for (let i = 3; i < n.length; i++) n[i] += n[i - 3]; return n; };
const line = (x0, y0, x1, y1, n = 16) => Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1)]);
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
  const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page");
  ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)[m.error ? "rej" : "res"](m.error ?? m.result); waiting.delete(m.id); } };
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://localhost:8787/login/dev?next=/" });
  await until(`!!document.querySelector('.library')`);

  // ---------- PDF ----------
  const b64 = readFileSync(pdfPath).toString("base64");
  const pid = await evaluate(`(async () => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); const f = new FormData(); f.append('file', new Blob([u], {type:'application/pdf'}), 'Bounds test.pdf'); return (await (await fetch('/api/pdfs', {method:'POST', body:f})).json()).id; })()`);
  await send("Page.navigate", { url: `http://localhost:8787/p/${pid}` });
  await until(`document.querySelectorAll('.pdf-canvas').length > 0`);
  await sleep(800);
  const ink = () => evaluate(`fetch('/api/pdfs/${pid}').then(r=>r.json()).then(async x => { const a = x.inkAnchors; if (!a.length) return []; const s = await fetch('/api/notebooks/${pid}/ink?anchors=' + a.join(',')).then(r=>r.json()); return a.flatMap(k => s[k].map(st => ({ anchor: k, d: st.d }))); })`);
  const r0 = await evaluate(`(() => { document.querySelector('[data-page="0"]').scrollIntoView({block:'center'}); const r = document.querySelector('[data-page="0"]').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  await sleep(400);
  const [L, T, W, H] = await evaluate(`(() => { const r = document.querySelector('[data-page="0"]').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  await drag(line(L - 18, T + 200, L - 18, T + 320)); // beside the page (left margin)
  await sleep(700);
  check((await ink()).length === 0, "PDF: a stroke started beside the page draws nothing");
  await drag(line(L + W + 6, T + 200, L + W + 6, T + 300)); // right of the page
  await sleep(700);
  check((await ink()).length === 0, "PDF: a stroke started right of the page draws nothing");
  await drag(line(L + 100, T + H + 8, L + 300, T + H + 8)); // the gap between page 1 and page 2
  await sleep(700);
  check((await ink()).length === 0, "PDF: a stroke started in the gap between pages draws nothing");
  await drag(line(L + 120, T + 300, L - 140, T + 380)); // on the page, dragged off the left edge
  await sleep(900);
  const s1 = await ink();
  const p1 = decode(s1[0]?.d ?? "0,0,0");
  const xs = []; for (let i = 0; i < p1.length; i += 3) xs.push(p1[i]);
  check(s1.length === 1 && Math.min(...xs) >= 0 && Math.max(...xs) <= 1000, `PDF: a stroke dragged off the edge stays on the page (x from ${Math.min(...xs)} to ${Math.max(...xs)} of 0–1000)`);
  const clipped = await evaluate(`getComputedStyle(document.querySelector('.ink-svg')).overflow`);
  check(clipped === "hidden", "PDF: ink is clipped at the page edge");

  // ---------- notebook ----------
  const nid = await evaluate(`(async () => {
    const nb = await (await fetch('/api/notebooks', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Bounds ' + Date.now()})})).json();
    const blocks = [{id:'p', type:'paragraph', props:{}, content:[{type:'text', text:'Some text', styles:{}}], children:[]}, {id:'pg', type:'page', props:{height:1414, style:'dotted', size:'a4'}, children:[]}];
    await fetch('/api/notebooks/' + nb.id, {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({upserts: blocks, deletes: [], order: ['p','pg'], baseVersion: 1, clientId: 'seed'})});
    return nb.id; })()`);
  await send("Page.navigate", { url: `http://localhost:8787/n/${nid}` });
  await until(`!!document.querySelector('.nb-page')`);
  await sleep(800);
  const nink = () => evaluate(`fetch('/api/notebooks/${nid}/ink?anchors=p,pg').then(r=>r.json()).then(x => [...x.p, ...x.pg])`);
  await evaluate(`document.querySelector('[data-id="pg"]').scrollIntoView({block:'center'}); true`);
  await sleep(400);
  const [nl, nt, nw] = await evaluate(`(() => { const r = document.querySelector('[data-node-type="blockOuter"][data-id="pg"]').getBoundingClientRect(); return [r.left, r.top, r.width]; })()`);
  const my = 450; // middle of the screen: on the page, below the sticky toolbar
  await drag(line(nl - 20, my - 60, nl - 20, my + 60)); // the margin left of the writing column
  await sleep(700);
  check((await nink()).length === 0, "notebook: a stroke started in the side margin draws nothing");
  await drag(line(nl + 80, my, nl - 200, my + 50)); // on the page, off the left edge
  await sleep(900);
  const n1 = await nink();
  const q = decode(n1[0]?.d ?? "0,0,0");
  const nx = []; for (let i = 0; i < q.length; i += 3) nx.push(q[i]);
  check(n1.length === 1 && Math.min(...nx) >= 0, `notebook: a stroke dragged off the edge stays in the column (min x ${Math.min(...nx)})`);
} catch (e) { console.log("FAIL error:", e.message); fails++; }
finally { console.log(fails ? `\n${fails} failed.` : "\nAll boundary checks passed."); ws?.close(); proc.kill(); process.exit(fails ? 1 : 0); }
