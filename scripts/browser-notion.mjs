// Notion-style features in a real browser: templates, icons, favourites, trash, board,
// table of contents, links between notebooks, page history.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9339;
const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(tmpdir() + "/cdp-")}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const waiting = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed"); return r.result.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(expr)) return; } catch {} await sleep(150); } throw new Error("timeout: " + expr); };
let fails = 0; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails++; };
const clickText = (sel, text) => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!b) throw new Error('no ' + ${JSON.stringify(text)}); b.click(); return true; })()`);
const typeInto = (sel, value) => evaluate(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(i.constructor.prototype, 'value').set; set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
const api = (path, init) => evaluate(`fetch(${JSON.stringify(path)}${init ? ", " + JSON.stringify(init) : ""}).then(r => r.json())`);
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
  const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page");
  ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)[m.error ? "rej" : "res"](m.error ?? m.result); waiting.delete(m.id); } };
  await send("Runtime.enable");
  await send("Page.enable");
  const answers = [];
  const prevOnMessage = ws.onmessage;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true, promptText: answers.shift() ?? "" });
    prevOnMessage(e);
  };
  globalThis.__answers = answers;
  await send("Page.navigate", { url: "http://localhost:8787/login/dev?next=/" });
  await until(`!!document.querySelector('.library')`);
  const stamp = Date.now();

  // ---------- template ----------
  await clickText(".book.new", "New notebook");
  await until(`!!document.querySelector('.templates')`);
  await typeInto(".dialog .field input", `Standup ${stamp}`);
  await clickText(".template", "Meeting notes");
  await clickText(".dialog .btn", "Create notebook");
  await until(`location.pathname.startsWith('/n/') && !!document.querySelector('.bn-editor')`);
  await sleep(800);
  const nbId = await evaluate(`location.pathname.split('/')[2]`);
  const heads = await evaluate(`[...document.querySelectorAll('[data-content-type="heading"]')].map(h => h.textContent)`);
  check(["Agenda", "Notes", "Decisions", "Action items"].every((h) => heads.includes(h)), "new notebook from the Meeting notes template has its sections");
  check((await evaluate(`document.querySelector('.page-icon').textContent.trim()`)) === "💼", "the template's icon is shown next to the title");

  // ---------- icon ----------
  await evaluate(`document.querySelector('.page-icon').click(); true`);
  await until(`!!document.querySelector('.page-icon-pop .emoji-picker')`);
  await clickText(".page-icon-pop .emoji-picker button", "🧪");
  await sleep(600);
  const metaIcon = (await api("/api/notebooks")).find((n) => n.id === nbId)?.icon;
  check(metaIcon === "🧪", "picking an icon saves it");

  // ---------- page history ----------
  await evaluate(`document.querySelector('.ink-more-wrap .ink-icon').click(); true`);
  await clickText(".ink-more-item", "Page history");
  await until(`document.querySelectorAll('.history-list button').length > 0`);
  await until(`document.querySelector('.history-preview').textContent.includes('Agenda')`);
  check(true, "page history lists versions and previews them");
  await clickText(".dialog .btn", "Close");

  // ---------- board, table of contents, link (seeded) ----------
  const other = await api("/api/notebooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `Target ${stamp}` }) });
  const blocks = [
    { id: "h1", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "First part", styles: {} }], children: [] },
    { id: "toc", type: "toc", props: {}, children: [] },
    { id: "brd", type: "board", props: { title: "Tasks", columns: JSON.stringify([{ id: "a", name: "To do", cards: [] }, { id: "b", name: "Done", cards: [] }]) }, children: [] },
    { id: "lnk", type: "nblink", props: { target: "", title: "", icon: "" }, children: [] },
    { id: "h2", type: "heading", props: { level: 3 }, content: [{ type: "text", text: "Second part", styles: {} }], children: [] },
  ];
  const nb2 = await api("/api/notebooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `Blocks ${stamp}` }) });
  await api(`/api/notebooks/${nb2.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ upserts: blocks, deletes: [], order: blocks.map((b) => b.id), baseVersion: 1, clientId: "seed" }) });
  await send("Page.navigate", { url: `http://localhost:8787/n/${nb2.id}` });
  await until(`!!document.querySelector('.nb-board')`);
  await sleep(600);
  check(JSON.stringify(await evaluate(`[...document.querySelectorAll('.nb-toc button')].map(b => b.textContent)`)) === JSON.stringify(["First part", "Second part"]), "table of contents lists the headings");
  // add a card and move it to Done
  await typeInto(".nb-col:first-child .nb-add-card input", "Write the report");
  await evaluate(`document.querySelector('.nb-col:first-child .nb-add-card').requestSubmit(); true`);
  await until(`document.querySelectorAll('.nb-col:first-child .nb-card-item').length === 1`);
  await evaluate(`document.querySelector('.nb-col:first-child .nb-card-actions button[aria-label^="Move to Done"]').click(); true`);
  await until(`document.querySelectorAll('.nb-col:nth-child(2) .nb-card-item').length === 1`);
  await sleep(1200);
  const saved = await api(`/api/notebooks/${nb2.id}`);
  const cols = JSON.parse(saved.blocks.find((b) => b.id === "brd").props.columns);
  check(cols[0].cards.length === 0 && cols[1].cards[0]?.text === "Write the report", "board: a card can be added and moved to Done (and it's saved)");
  // pick a notebook to link, then follow the link
  await until(`[...document.querySelectorAll('.nb-link-pick li button')].some(b => b.textContent.includes('Target ${stamp}'))`);
  await clickText(".nb-link-pick li button", "📓 Target");
  await until(`!!document.querySelector('.nb-link')`);
  await evaluate(`document.querySelector('.nb-link').click(); true`);
  await until(`location.pathname === '/n/${other.id}'`);
  check(true, "a notebook link can be picked and opens that notebook");
  await until(`[...document.querySelectorAll('.backlinks a')].some(a => a.textContent.includes('Blocks ${stamp}'))`, 10000);
  check(true, "the linked notebook shows “Linked from” with a link back");

  // ---------- favourites + trash from the library ----------
  await send("Page.navigate", { url: "http://localhost:8787/" });
  await until(`!!document.querySelector('.library')`);
  const bookSel = (name) => `[...document.querySelectorAll('.book-wrap')].find(w => w.querySelector('.book-name')?.textContent === ${JSON.stringify(name)})`;
  await evaluate(`${bookSel(`Target ${stamp}`)}.querySelector('.book-more').click(); true`);
  await clickText(".book-menu .ink-more-item", "Add to Favorites");
  await until(`!!document.querySelector('#fav-shelf') && [...document.querySelectorAll('#fav-shelf ~ .books-grid .book-name')].some(e => e.textContent === 'Target ${stamp}')`);
  check(true, "Add to Favorites puts it on the Favorites shelf");
  await evaluate(`${bookSel(`Target ${stamp}`)}.querySelector('.book-more').click(); true`);
  await clickText(".book-menu .ink-more-item", "Move to Trash");
  await until(`!${bookSel(`Target ${stamp}`)}`);
  check(true, "Move to Trash removes it from the library");
  await send("Page.navigate", { url: "http://localhost:8787/trash" });
  await until(`[...document.querySelectorAll('.trash-name')].some(e => e.textContent.includes('Target ${stamp}'))`);
  check(await evaluate(`document.querySelector('.trash-list .book-when').textContent.includes('30 days left')`), "the Trash lists it with 30 days left");
  // opening it while in the Trash: read-only banner with Restore
  await send("Page.navigate", { url: `http://localhost:8787/n/${other.id}` });
  await until(`!!document.querySelector('.trash-banner')`);
  check(await evaluate(`document.querySelector('.bn-editor').getAttribute('contenteditable') === 'false'`), "a notebook in the Trash opens read-only with a Restore button");
  await clickText(".trash-banner .btn", "Restore notebook");
  await until(`!document.querySelector('.trash-banner')`);
  const back = (await api("/api/notebooks")).some((n) => n.id === other.id);
  check(back && (await evaluate(`document.querySelector('.bn-editor').getAttribute('contenteditable') === 'true'`)), "Restore brings it back and it's editable again");

  // ---------- topics ----------
  await send("Page.navigate", { url: "http://localhost:8787/" });
  await until(`!!document.querySelector('.library')`);
  globalThis.__answers.push(`Science ${stamp}`);
  await evaluate(`${bookSel(`Blocks ${stamp}`)}.querySelector('.book-more').click(); true`);
  await clickText(".book-menu .ink-more-item", "Topic");
  await clickText(".book-menu .topic-picker .ink-more-item", "New topic");
  await until(`[...document.querySelectorAll('.shelf-title')].some(h => h.textContent.startsWith('Science ${stamp}'))`);
  check(true, "a notebook can be put in a new topic from its menu, and the library groups it under that topic");
  check((await evaluate(`[...document.querySelectorAll('.seg button.on')].map(b => b.textContent).join()`)) === "Topic", "the library is grouped by topic (Group by: Topic)");
  await clickText(".chip", `Science ${stamp}`);
  await sleep(200);
  const shelves = await evaluate(`[...document.querySelectorAll('.shelf-title')].map(h => h.textContent.replace(/\\d+$/, '').trim())`);
  check(shelves.length === 1 && shelves[0].startsWith(`Science ${stamp}`), `the topic chip shows only that topic (${shelves.join(", ")})`);
  await clickText(".book.new", `New notebook in Science ${stamp}`);
  await until(`!!document.querySelector('.templates')`);
  check((await evaluate(`document.querySelectorAll('.dialog .field input')[1].value`)) === `Science ${stamp}`, "“New notebook in <topic>” fills in the topic");
  await typeInto(".dialog .field input", `Chemistry ${stamp}`);
  await clickText(".dialog .btn", "Create notebook");
  await until(`location.pathname.startsWith('/n/')`);
  const chem = (await api("/api/notebooks")).find((n) => n.name === `Chemistry ${stamp}`);
  check(chem?.topic === `Science ${stamp}`, "the new notebook is created inside that topic");
  // PDFs have a menu with Topic too
  const b64 = "JVBERi0xLjQKJSB0aW55CiUlRU9GCg==";
  const pdfId = await evaluate(`(async () => { const bin = atob('${b64}'); const u = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); const f = new FormData(); f.append('file', new Blob([u], {type:'application/pdf'}), 'Exam paper ${stamp}.pdf'); return (await (await fetch('/api/pdfs', {method:'POST', body:f})).json()).id; })()`);
  await send("Page.navigate", { url: "http://localhost:8787/" });
  await until(`!!document.querySelector('.library')`);
  await clickText(".chip", "All");
  await until(`[...document.querySelectorAll('.book-wrap .book-name')].some(e => e.textContent === 'Exam paper ${stamp}')`);
  await evaluate(`${bookSel(`Exam paper ${stamp}`)}.querySelector('.book-more').click(); true`);
  await clickText(".book-menu .ink-more-item", "Topic");
  await clickText(".book-menu .topic-picker .ink-more-item", `Science ${stamp}`);
  await sleep(700);
  check((await api("/api/pdfs")).find((x) => x.id === pdfId)?.topic === `Science ${stamp}`, "a PDF can be put in a topic from its ⋯ menu");
} catch (e) { console.log("FAIL error:", e.message); fails++; }
finally { console.log(fails ? `\n${fails} failed.` : "\nAll Notion-feature checks passed."); ws?.close(); proc.kill(); process.exit(fails ? 1 : 0); }
