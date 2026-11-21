// PDF tests against `npm run dev` (DEV_LOGIN=1): upload, read back, text boxes, ink on pages,
// privacy between accounts, assistants can't see PDFs, delete.
// Usage: node scripts/pdf-test.mjs path/to/file.pdf
import { readFileSync } from "node:fs";

const B = "http://localhost:8787";
const pdfPath = process.argv[2];
if (!pdfPath) throw new Error("Give a PDF path");
const bytes = readFileSync(pdfPath);
const pw = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^ADMIN_PASSWORD=(.*)$/m)[1].trim();
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("noty_session="))?.split(";")[0];
const owner = cookieOf(await fetch(`${B}/login/password`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: B, "CF-Connecting-IP": "198.51.100.2" }, body: new URLSearchParams({ password: pw, next: "/" }) }));
const other = cookieOf(await fetch(`${B}/login/dev?next=/`, { redirect: "manual" }));
const api = (c, path, init = {}) => fetch(B + "/api" + path, { ...init, headers: { Cookie: c, Origin: B, ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
let fails = 0;
const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails++; };

// upload
const form = new FormData();
form.append("file", new Blob([bytes], { type: "application/pdf" }), "Lecture slides.pdf");
const up = await api(owner, "/pdfs", { method: "POST", body: form });
const meta = await up.json();
check(up.status === 200 && meta.name === "Lecture slides" && meta.size === bytes.length, "PDF uploads (name without .pdf, correct size)");
const bad = new FormData();
bad.append("file", new Blob(["hello, not a pdf"], { type: "application/pdf" }), "fake.pdf");
check((await api(owner, "/pdfs", { method: "POST", body: bad })).status === 400, "a file that isn't really a PDF is refused");

// list + read back
const list = await (await api(owner, "/pdfs")).json();
check(list.some((p) => p.id === meta.id), "PDF appears in the owner's PDF list");
const file = await api(owner, `/pdfs/${meta.id}/file`);
const back = Buffer.from(await file.arrayBuffer());
check(file.headers.get("content-type") === "application/pdf" && back.equals(bytes), "the stored PDF comes back byte-for-byte");

// text boxes
const boxes = [{ id: "b1", page: 0, x: 0.1, y: 0.2, w: 0.4, text: "Remember: thylakoid = membranes", size: 16, color: "red" }];
check((await api(owner, `/pdfs/${meta.id}/boxes`, { method: "PUT", body: JSON.stringify({ boxes, clientId: "t" }) })).status === 200, "text box saved");
const got = await (await api(owner, `/pdfs/${meta.id}`)).json();
check(got.boxes.length === 1 && got.boxes[0].text.includes("thylakoid") && got.boxes[0].color === "red", "text box loads back");

// ink on a page
check((await api(owner, `/notebooks/${meta.id}/ink`, { method: "POST", body: JSON.stringify({ add: [{ anchor: "pg2", stroke: { id: "pk1", c: "blue", s: 5, d: "50,50,50,10,10,0" } }], clientId: "t" }) })).status === 200, "handwriting saved on page 3");
const got2 = await (await api(owner, `/pdfs/${meta.id}`)).json();
check(got2.inkAnchors.includes("pg2"), "PDF knows page 3 has handwriting");

// privacy
check((await api(other, `/pdfs/${meta.id}`)).status === 404, "another account can't open the PDF");
check((await api(other, `/pdfs/${meta.id}/file`)).status === 404, "another account can't download the PDF");
check(!(await (await api(other, "/pdfs")).json()).some((p) => p.id === meta.id), "another account doesn't see it in their list");
check((await api(other, `/pdfs/${meta.id}/boxes`, { method: "PUT", body: JSON.stringify({ boxes: [], clientId: "x" }) })).status === 404, "another account can't change its text boxes");
check((await fetch(`${B}/api/pdfs/${meta.id}/file`)).status === 401, "signed-out visitors can't download it");

// assistants don't see PDFs (they only see notebooks)
const nbs = await (await api(owner, "/notebooks")).json();
check(!nbs.some((n) => n.id === meta.id || n.name === "Lecture slides"), "PDF is not listed as a notebook (so assistants can't reach it)");

// rename + delete
check((await (await api(owner, `/pdfs/${meta.id}`, { method: "PATCH", body: JSON.stringify({ name: "Bio lecture" }) })).json()).name === "Bio lecture", "rename works");
check((await (await api(owner, `/pdfs/${meta.id}`, { method: "DELETE" })).json()).ok === true, "delete works");
check((await api(owner, `/pdfs/${meta.id}/file`)).status === 404, "deleted PDF is gone");
const ink = await (await api(owner, `/notebooks/${meta.id}/ink?anchors=pg2`)).json();
check(!ink.pg2?.length, "its handwriting is gone too");
console.log(fails ? `\n${fails} PDF check(s) failed.` : "\nAll PDF checks passed.");
process.exit(fails ? 1 : 0);
