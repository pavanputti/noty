import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const dir = tmpdir() + "/";
const APP = new URL("..", import.meta.url).pathname;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9335;
const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(dir + "cdp-")}`, "--window-size=1280,900", "--blink-settings=preferredColorScheme=1", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const waiting = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed"); return r.result.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(expr)) return Date.now() - t; } catch {} await sleep(150); } throw new Error("timeout: " + expr); };
let fails = 0; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails++; };
const ev = (type, x, y, pointerType = "mouse") => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType, force: 0.6 });
async function drag(points, pointerType = "mouse") {
  await ev("mousePressed", ...points[0], pointerType);
  for (const p of points.slice(1)) await ev("mouseMoved", ...p, pointerType);
  await ev("mouseReleased", ...points.at(-1), pointerType);
}
const click = (label) => evaluate(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}) ?? [...document.querySelectorAll("button")].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)})); b.click(); return !!b; })()`);
const decode = (d) => { const n = d.split(",").map(Number); for (let i = 3; i < n.length; i++) n[i] += n[i - 3]; return n; };
const startServer = () => spawn("npx", ["wrangler", "dev", "--port", "8787", "--ip", "127.0.0.1"], { cwd: APP, stdio: "ignore", detached: true });

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
  const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page");
  ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)[m.error ? "rej" : "res"](m.error ?? m.result); waiting.delete(m.id); } };
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://localhost:8787/login/dev?next=/" });
  await until(`!!document.querySelector('.library')`);
  check(await evaluate(`document.querySelectorAll('.books-grid .book').length >= 2`), 'home is a library of books (with New notebook / Upload PDF tiles)');

  // ---------- light / dark mode ----------
  const bg = () => evaluate(`getComputedStyle(document.body).backgroundColor`);
  const lum = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return (r + g + b) / 3; };
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await sleep(200);
  check(lum(await bg()) > 200, "Automatic on a light device: light");
  await evaluate(`document.querySelector('.lib-actions .icon-btn[aria-label^="Appearance"]').click(); true`); // -> Light
  await evaluate(`document.querySelector('.lib-actions .icon-btn[aria-label^="Appearance"]').click(); true`); // -> Dark
  await sleep(200);
  check((await evaluate(`document.documentElement.dataset.theme`)) === "dark" && lum(await bg()) < 60, "choosing Dark switches to dark, even on a light device");
  await send("Page.reload");
  await until(`!!document.querySelector('.library')`);
  check((await evaluate(`document.documentElement.dataset.theme`)) === "dark" && lum(await bg()) < 60, "the choice is remembered after reloading");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await evaluate(`(() => { document.querySelector('.avatar').click(); return true; })()`);
  await until(`!!document.querySelector('.acct-menu .theme-switch')`, 3000);
  await evaluate(`document.querySelector('.acct-menu .theme-switch button[title="Light"]').click(); true`);
  await sleep(200);
  check(lum(await bg()) > 200, "choosing Light on a dark device gives light");
  await evaluate(`document.querySelector('.acct-menu .theme-switch button[title="Automatic"]').click(); true`);
  await sleep(200);
  check((await evaluate(`document.documentElement.dataset.theme`)) === undefined && lum(await bg()) < 60, "Automatic follows the device again (dark)");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await evaluate(`document.querySelector('.avatar').click(); true`);

  // ---------- install as an app ----------
  const sw = await evaluate(`navigator.serviceWorker.ready.then(r => !!r.active)`);
  check(sw, "offline helper (service worker) is installed");
  const man = await evaluate(`fetch('/manifest.webmanifest').then(r => r.json())`);
  check(man.display === "standalone" && man.icons.some((i) => i.sizes === "512x512") && !!(await evaluate(`!!document.querySelector('link[rel=apple-touch-icon]')`)), "app manifest + home-screen icons (installable, full screen)");

  // ---------- a notebook with a page and a flashcard deck ----------
  const id = await evaluate(`(async () => {
    const nb = await (await fetch('/api/notebooks', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Feature test ' + Date.now()})})).json();
    const blocks = [
      {id:'h1', type:'heading', props:{level:2}, content:[{type:'text', text:'Revision', styles:{}}], children:[]},
      {id:'fc', type:'flashcards', props:{title:'Cells', cards: JSON.stringify([{front:'What makes ATP?', back:'Mitochondria'},{front:'Powerhouse of the cell?', back:'Mitochondria'}])}, children:[]},
      {id:'pg', type:'page', props:{height:1414, style:'dotted', size:'a4'}, children:[]},
      {id:'tail', type:'paragraph', props:{}, content:[], children:[]}];
    await fetch('/api/notebooks/' + nb.id, {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({upserts: blocks, deletes: [], order: blocks.map(b => b.id), baseVersion: 1, clientId: 'seed'})});
    return nb.id; })()`);
  await send("Page.navigate", { url: `http://localhost:8787/n/${id}` });
  await until(`!!document.querySelector('.nb-page')`);
  await sleep(600);

  await evaluate(`localStorage.setItem('noty:theme','dark'); document.documentElement.dataset.theme='dark'; dispatchEvent(new Event('noty-theme')); true`);
  await sleep(300);
  const edBg = await evaluate(`getComputedStyle(document.querySelector('.bn-container')).getPropertyValue('--bn-colors-editor-background').trim().toLowerCase()`);
  check(edBg === "#1a1e26", `the editor follows the chosen theme (editor background ${edBg})`);
  await evaluate(`localStorage.removeItem('noty:theme'); delete document.documentElement.dataset.theme; dispatchEvent(new Event('noty-theme')); true`);
  await sleep(200);

  // ---------- flashcards ----------
  check((await evaluate(`document.querySelector('.nb-card-face.front').textContent.includes('What makes ATP?')`)), "flashcard shows the question");
  await evaluate(`document.querySelector('.nb-card').click(); true`);
  check(await evaluate(`document.querySelector('.nb-card').classList.contains('flipped')`), "tapping the card flips it to the answer");
  await click("Next");
  check((await evaluate(`document.querySelector('.nb-cards-count').textContent`)) === "2 of 2", "Next goes to card 2 of 2");

  // ---------- page style ----------
  await evaluate(`(() => { const s = document.querySelector('.nb-page-style select'); s.value = 'lined:letter'; s.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
  await sleep(1200);
  check(await evaluate(`document.querySelector('.nb-page').classList.contains('style-lined')`), "page switches to lined");
  const pgSaved = await evaluate(`fetch('/api/notebooks/${id}').then(r=>r.json()).then(n => n.blocks.find(b => b.id === 'pg').props)`);
  check(pgSaved.style === "lined" && pgSaved.size === "letter" && pgSaved.height === 1294, "page style and Letter size are saved (height 1294)");
  const newPages = await evaluate(`[...document.querySelectorAll('.ink-select option')].map(o => o.textContent).slice(0, 3).join('|')`);
  check(newPages.includes("Dotted, A4"), "toolbar offers a style for new pages");

  // ---------- shapes: a wobbly circle snaps to a clean one ----------
  await click("Shapes");
  await click("Pen");
  await evaluate(`document.querySelector('[data-id="pg"]').scrollIntoView({block:'center'}); true`);
  await sleep(400);
  const [cx, cy, pw] = await evaluate(`(() => { const r = document.querySelector('[data-id="pg"]').getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2, r.width]; })()`);
  const wobbly = Array.from({ length: 60 }, (_, i) => { const a = (i / 59) * Math.PI * 2.05; const r = 90 + (i % 3 - 1) * 6; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
  await drag(wobbly);
  await sleep(1000);
  let strokes = await evaluate(`fetch('/api/notebooks/${id}/ink?anchors=pg').then(r=>r.json()).then(x => x.pg)`);
  const p = decode(strokes[0].d);
  const xs = [], ys = [];
  for (let i = 0; i + 2 < p.length; i += 3) xs.push(p[i]), ys.push(p[i + 1]);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  const rs = xs.map((x, i) => Math.hypot(x - mx, ys[i] - my));
  const rmean = rs.reduce((a, b) => a + b) / rs.length;
  const spread = Math.max(...rs.map((r) => Math.abs(r - rmean)));
  check(strokes.length === 1 && spread < 3, `rough circle snapped to a clean circle (radius varies by ${spread.toFixed(1)} units; the drawing wobbled by about ${(12 * 1000 / pw).toFixed(0)})`);

  // a rough straight line snaps straight
  await drag(Array.from({ length: 30 }, (_, i) => [cx - 200 + i * 10, cy + 180 + (i % 2 ? 3 : -3)]));
  await sleep(900);
  strokes = await evaluate(`fetch('/api/notebooks/${id}/ink?anchors=pg').then(r=>r.json()).then(x => x.pg)`);
  const lp = decode(strokes.at(-1).d);
  // straight = every point lies on the line from the first point to the last
  const [ax, ay, bx, by] = [lp[0], lp[1], lp.at(-3), lp.at(-2)];
  let off = 0;
  for (let i = 0; i + 2 < lp.length; i += 3) off = Math.max(off, Math.abs((by - ay) * lp[i] - (bx - ax) * lp[i + 1] + bx * ay - by * ax) / Math.hypot(bx - ax, by - ay));
  check(off <= 1, `rough line snapped perfectly straight (points off the line by at most ${off.toFixed(2)} units; the drawing zig-zagged by about ${(6 * 1000 / pw).toFixed(0)})`);

  // ---------- lasso: select the circle, recolour, move, delete ----------
  await click("Lasso");
  const loop = Array.from({ length: 40 }, (_, i) => { const a = (i / 39) * Math.PI * 2.1; return [cx + 130 * Math.cos(a), cy + 130 * Math.sin(a)]; });
  await drag(loop);
  await until(`!!document.querySelector('.ink-sel-bar')`, 5000);
  check((await evaluate(`document.querySelector('.ink-sel-count').textContent`)) === "1 stroke", "lasso selects the circle (not the line outside it)");
  const lineId = strokes.at(-1).id;
  const circleId = strokes.find((s) => s.id !== lineId).id;
  await evaluate(`document.querySelector('.ink-sel-bar .ink-swatch[aria-label="Make it red"]').click(); true`);
  await sleep(900);
  strokes = await evaluate(`fetch('/api/notebooks/${id}/ink?anchors=pg').then(r=>r.json()).then(x => x.pg)`);
  check(strokes.find((s) => s.id === circleId).c === "red" && strokes.find((s) => s.id === lineId).c !== "red", "selection recoloured to red (and only the selection)");
  const before = decode(strokes.find((s) => s.id === circleId).d)[0];
  await drag([[cx, cy], [cx + 40, cy], [cx + 100, cy]]);
  await sleep(1000);
  strokes = await evaluate(`fetch('/api/notebooks/${id}/ink?anchors=pg').then(r=>r.json()).then(x => x.pg)`);
  const moved = decode(strokes.find((s) => s.id === circleId).d)[0] - before;
  const expect = Math.round((100 * 1000) / pw);
  check(Math.abs(moved - expect) <= 3, `dragging moves the selection (${moved} units, expected about ${expect})`);
  await evaluate(`[...document.querySelectorAll('.ink-sel-bar button')].find(b => b.textContent.trim() === 'Delete').click(); true`);
  await sleep(900);
  strokes = await evaluate(`fetch('/api/notebooks/${id}/ink?anchors=pg').then(r=>r.json()).then(x => x.pg)`);
  check(strokes.length === 1 && strokes[0].id === lineId, "Delete removes the selected stroke only");
  await click("Undo");
  await sleep(900);
  strokes = await evaluate(`fetch('/api/notebooks/${id}/ink?anchors=pg').then(r=>r.json()).then(x => x.pg)`);
  check(strokes.length === 2, "Undo brings it back");
  // To text: browser can't read handwriting -> explains how to ask the assistant (the circle is now 100px to the right)
  await drag(loop.map(([x, y]) => [x + 100, y]));
  await until(`!!document.querySelector('.ink-sel-bar')`, 5000);
  await click("To text");
  await until(`!!document.querySelector('.dialog')`, 5000);
  const ask = await evaluate(`document.querySelector('.dialog .ask')?.textContent ?? document.querySelector('.dialog').textContent`);
  check(/page 1 of my .Feature test [0-9]+. notes/.test(ask), `To text gives the exact request for the assistant: ${ask}`);
  await click("Close");

  // ---------- colour bugs: highlighter keeps your colour, eraser catches fast swipes ----------
  await click("Highlighter");
  await evaluate(`document.querySelector('.ink-swatch[aria-label="Blue"]').click(); true`);
  check((await evaluate(`[...document.querySelectorAll('.ink-mode.on')].map(b => b.textContent.trim()).join()`)) === "Highlighter", "picking a colour keeps the Highlighter selected");
  const hy = cy + 260;
  await drag(Array.from({ length: 20 }, (_, i) => [cx - 150 + i * 15, hy]));
  await sleep(900);
  strokes = await evaluate(`fetch('/api/notebooks/${id}/ink?anchors=pg').then(r=>r.json()).then(x => x.pg)`);
  const hl = strokes.at(-1);
  check(hl.t === "h" && hl.c === "blue", `highlighter draws in the colour you picked (${hl.c})`);
  await click("Pen");
  const before2 = strokes.length;
  await click("Eraser");
  // one fast swipe straight across the highlight: only two pointer positions, far apart
  await drag([[cx, hy - 60], [cx, hy + 60]]);
  await sleep(900);
  strokes = await evaluate(`fetch('/api/notebooks/${id}/ink?anchors=pg').then(r=>r.json()).then(x => x.pg)`);
  check(strokes.length === before2 - 1 && !strokes.some((x) => x.id === hl.id), "a fast eraser swipe removes the stroke it crosses");
  const pdfInk = await evaluate(`(() => { document.body.insertAdjacentHTML('beforeend', '<div class="pdf-host" id="t-ph"></div>'); const v = getComputedStyle(document.getElementById('t-ph')).getPropertyValue('--draw-ink').trim(); document.getElementById('t-ph').remove(); return v; })()`);
  check(pdfInk.toLowerCase() === "#1d2433", "on PDF pages ink stays dark in every theme (no white-on-white)");
  await click("Type");

  // ---------- search from the library ----------
  await send("Page.navigate", { url: "http://localhost:8787/" });
  await until(`!!document.querySelector('.library')`);
  const setQ = (v) => evaluate(`(() => { const i = document.querySelector('.lib-search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
  const nbName = await evaluate(`fetch('/api/notebooks/${id}').then(r=>r.json()).then(n => n.name)`);
  await setQ(nbName.split(" ").slice(0, 2).join(" ").toLowerCase());
  await sleep(150);
  const names = await evaluate(`[...document.querySelectorAll('#nb-shelf ~ .books-grid .book-name')].map(e => e.textContent)`);
  check(names.length >= 1 && names.every((n) => n.toLowerCase().includes("feature test")), `typing filters notebooks by name straight away (${names.length} shown)`);
  await setQ("powerhouse cell");
  await until(`[...document.querySelectorAll('.found-list button')].length > 0`, 8000);
  check(await evaluate(`document.querySelector('.found-list mark') !== null`), "results show the matching words highlighted");
  await evaluate(`document.querySelector('.found-list button').click(); true`);
  await until(`location.pathname.startsWith('/n/') && location.search.includes('b=fc')`, 8000);
  check(true, "clicking a result opens the notebook at the matching block");
  await send("Page.navigate", { url: `http://localhost:8787/n/${id}` });
  await until(`!!document.querySelector('.nb-page')`);
  await sleep(500);
  await evaluate(`document.querySelector('[data-id="pg"]').scrollIntoView({block:'center'}); true`);

  // ---------- offline: banner ----------
  await send("Network.enable");
  await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await until(`!!document.querySelector('.offline-banner')`, 5000);
  check(true, "offline banner appears when the connection drops");
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click("Type");

  // ---------- offline for real: stop the server, type, reload, start the server ----------
  execSync(`pkill -f "wrangler dev"; pkill -f workerd; true`);
  await sleep(1200);
  const head = await evaluate(`(() => { const el = document.querySelector('[data-content-type="heading"] .bn-inline-content'); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return [r.right - 2, r.top + r.height/2]; })()`);
  await sleep(300);
  const h2 = await evaluate(`(() => { const r = document.querySelector('[data-content-type="heading"] .bn-inline-content').getBoundingClientRect(); return [r.right - 2, r.top + r.height/2]; })()`);
  await ev("mousePressed", ...h2); await ev("mouseReleased", ...h2);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 });
  await send("Input.insertText", { text: " written offline" });
  await sleep(1800);
  check(await evaluate(`!!localStorage.getItem('noty:draft:${id}')`), "with the server unreachable, the change is kept on this device");
  await send("Page.reload");
  await until(`!!document.querySelector('[data-content-type="heading"]')`, 15000);
  await sleep(800);
  check(await evaluate(`document.querySelector('[data-content-type="heading"]').textContent.includes('written offline')`), "after reloading with no server, the app opens and the offline change is still there");
  startServer();
  for (let i = 0; i < 60; i++) { try { await fetch("http://localhost:8787/login"); break; } catch { await sleep(1000); } }
  await until(`fetch('/api/notebooks/${id}').then(r=>r.json()).then(n => JSON.stringify(n.blocks).includes('written offline')).catch(() => false)`, 40000);
  check(true, "when the server is back, the offline change syncs");
  await until(`!localStorage.getItem('noty:draft:${id}')`, 10000);
  check(true, "and the local copy is cleared once synced");

  const shot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(dir + "features.png", Buffer.from(shot.data, "base64"));
} catch (e) { console.log("FAIL error:", e.message); fails++; }
finally { console.log(fails ? `\n${fails} failed.` : "\nAll feature browser checks passed."); ws?.close(); proc.kill(); process.exit(fails ? 1 : 0); }
