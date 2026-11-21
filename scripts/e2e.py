"""End-to-end test: OAuth (DCR + PKCE + consent) then every MCP tool. Run against `npm run dev` with DEV_LOGIN=1 and fresh local state (rm -rf .wrangler/state)."""
import base64, hashlib, json, os, pathlib, re, sys, urllib.parse, urllib.request

BASE = "http://localhost:8787"
cookies: dict[str, str] = {}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)


def req(method, path, body=None, headers=None):
    url = path if path.startswith("http") else BASE + path
    h = dict(headers or {})
    if cookies:
        h["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    data = body.encode() if isinstance(body, str) else body
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        resp = opener.open(r)
    except urllib.error.HTTPError as e:
        resp = e
    for sc in resp.headers.get_all("Set-Cookie") or []:
        k, v = sc.split(";", 1)[0].split("=", 1)
        if "Max-Age=0" in sc:
            cookies.pop(k, None)
        else:
            cookies[k] = v
    return resp.status, dict(resp.headers), resp.read().decode()


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        sys.exit(1)


# 1. dynamic client registration
s, _, b = req("POST", "/oauth/register", json.dumps({"client_name": "E2E Test Assistant", "redirect_uris": ["http://localhost:9999/cb"], "token_endpoint_auth_method": "none"}), {"Content-Type": "application/json"})
check(s == 201, f"register client ({s})")
client_id = json.loads(b)["client_id"]

# 2. authorize: not signed in -> /login
verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
q = urllib.parse.urlencode({"response_type": "code", "client_id": client_id, "redirect_uri": "http://localhost:9999/cb", "code_challenge": challenge, "code_challenge_method": "S256", "state": "xyz", "scope": "notes", "resource": BASE + "/mcp"})
s, h, _ = req("GET", "/authorize?" + q)
check(s == 302 and h["Location"].startswith("/login?next="), f"authorize redirects to login ({s} {h.get('Location','')[:40]})")

# 3. sign-in page offers the password; dev login (local only), back to authorize -> consent page
login_next = h["Location"]
s, _, page_html = req("GET", login_next)
check(s == 200 and 'name="password"' in page_html and "/login/dev?next=" in page_html, "sign-in page offers password (and local test sign-in)")
s, h, _ = req("GET", login_next.replace("/login?", "/login/dev?"))
check(s == 302 and "noty_session" in cookies, "dev login sets session")
s, h, page = req("GET", h["Location"])
check(s == 200 and "Allow E2E Test Assistant?" in page, "consent page shows client name")
check(h.get("X-Frame-Options") == "DENY", "consent page can't be framed")
handle = re.search(r'name="handle" value="([^"]+)"', page).group(1)

# 4. approve
s, h, _ = req("POST", "/authorize", urllib.parse.urlencode({"handle": handle, "decision": "approve"}), {"Content-Type": "application/x-www-form-urlencoded", "Origin": BASE})
loc = h.get("Location", "")
check(s == 302 and loc.startswith("http://localhost:9999/cb?"), f"approve redirects to client ({s})")
code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)["code"][0]

# 5. token
s, _, b = req("POST", "/oauth/token", urllib.parse.urlencode({"grant_type": "authorization_code", "code": code, "redirect_uri": "http://localhost:9999/cb", "client_id": client_id, "code_verifier": verifier, "resource": BASE + "/mcp"}), {"Content-Type": "application/x-www-form-urlencoded"})
check(s == 200, f"token exchange ({s}) {b[:120] if s != 200 else ''}")
token = json.loads(b)["access_token"]

# 6. MCP calls
saved_cookies = dict(cookies)
cookies.clear()
rid = 0


def mcp(method, params=None):
    global rid
    rid += 1
    s, h, b = req("POST", "/mcp", json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}), {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"})
    if s != 200:
        print(s, b[:500])
        sys.exit(1)
    if "text/event-stream" in h.get("Content-Type", ""):
        b = "\n".join(l[5:].strip() for l in b.splitlines() if l.startswith("data:"))
    return json.loads(b)


init = mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1"}})
check("result" in init and init["result"]["serverInfo"]["name"] == "Noty", "initialize")
check("add_question" in (init["result"].get("instructions") or ""), "server instructions sent")
tools = [t["name"] for t in mcp("tools/list")["result"]["tools"]]
print("     tools:", ", ".join(tools))
listed = re.findall(r'name: "([a-z_]+)"', (pathlib.Path(__file__).parent.parent / "src/shared/tools.ts").read_text())
check(sorted(listed) == sorted(tools), f"every tool the server offers is listed in the app ({len(tools)} tools)")


def call(name, args):
    r = mcp("tools/call", {"name": name, "arguments": args})["result"]
    text = r["content"][0]["text"]
    print(f"     {name}: {text[:110]}")
    return r, text


r, t = call("add_note", {"notebook": "DSA", "title": "Binary search", "content": "Works on **sorted** arrays.\n- Halve the range each step\n- O(log n)\n```mermaid\nflowchart LR\n  A[lo..hi] --> B{mid}\n```"})
check(not r.get("isError") and '"DSA" (new notebook)' in t, "add_note creates notebook")
r, t = call("add_question", {"notebook": "dsa notes", "question": "What is a hash map?", "answer": "Stores key→value pairs using a **hash function**.", "key_points": ["Average O(1) get/put", "Collisions: chaining or probing"], "diagram": "flowchart LR\n  key --> hash --> bucket --> value"})
check(not r.get("isError") and '"DSA"' in t and "new notebook" not in t, "add_question matches 'dsa notes' to DSA")
r, t = call("add_key_points", {"notebook": "DSA", "points": ["Sort first", "Watch off-by-one"], "title": "Exam tips"})
check(not r.get("isError"), "add_key_points")
r, t = call("add_diagram", {"notebook": "Work", "mermaid": "```mermaid\nsequenceDiagram\n  You->>AI: add note\n```", "caption": "Flow"})
check(not r.get("isError"), "add_diagram")
r, t = call("add_image", {"notebook": "DSA", "base64": "data:text/plain;base64,aGk="})
check(r.get("isError") and "not an image" in t, "add_image rejects non-images")
r, t = call("add_table", {"notebook": "DSA", "columns": ["Structure", "Lookup", "Insert"], "rows": [["Array", "O(1)", "O(n)"], ["Hash map", "O(1)", "O(1)"]], "color": "green", "title": "Costs"})
check(not r.get("isError"), "add_table")
r, t = call("add_callout", {"notebook": "DSA", "kind": "definition", "title": "Hash", "text": "A function mapping keys to **buckets**."})
check(not r.get("isError"), "add_callout")
r, t = call("add_mind_map", {"notebook": "DSA", "center": "Data structures", "branches": [{"label": "Linear", "children": [{"label": "Array"}, {"label": "List"}]}, {"label": "Trees"}]})
check(not r.get("isError"), "add_mind_map (nested branches)")
r, t = call("add_map", {"notebook": "Trips", "title": "Kerala", "places": [{"name": "Kochi", "lat": 9.93, "lng": 76.27, "note": "Fort Kochi"}, {"name": "Munnar", "lat": 10.09, "lng": 77.06}]})
check(not r.get("isError"), "add_map")
r, t = call("add_note", {"notebook": "DSA", "content": "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> [!warning] Off-by-one errors"})
check(not r.get("isError"), "add_note with table + callout markdown")
r, t = call("list_notebooks", {})
check("DSA" in t and "Work" in t, "list_notebooks")
r, t = call("read_notebook", {"notebook": "DSA"})
check("❓ What is a hash map?" in t and "**sorted**" in t and "```mermaid" in t and "Exam tips" in t and "| Hash map | O(1) | O(1) |" in t and "**Definition: Hash**" in t and "root((Data structures))" in t, "read_notebook returns markdown")
r, t = call("search_notes", {"query": "collisions"})
check("[DSA]" in t, "search_notes")

# 7. web API sees the same notebook (with the editor's session)
cookies.update(saved_cookies)
s, _, b = req("GET", "/api/notebooks")
books = json.loads(b)
dsa = next(n for n in books if n["name"] == "DSA")
s, _, b = req("GET", f"/api/notebooks/{dsa['id']}")
nb = json.loads(b)
types = [x["type"] for x in nb["blocks"]]
print("     block types:", types)
check(types[:1] == ["heading"] and all(x in types for x in ["question", "keyPoints", "diagram", "table", "callout"]), "blocks have visual types")
tables = [x for x in nb["blocks"] if x["type"] == "table"]
check(tables[0]["content"]["rows"][0]["cells"][0]["props"]["backgroundColor"] == "green", "table header is coloured")
check(any(x["type"] == "callout" and x["props"]["kind"] == "warning" for x in nb["blocks"]), "markdown callout converted")
check(all(x["id"] in nb["aiBlocks"] for x in nb["blocks"]), "every assistant block is marked")
check(nb["aiBlocks"][nb["blocks"][0]["id"]]["by"] == "E2E Test Assistant", "marked with the assistant's name")

# 8. block-by-block merging
def put(patch):
    return req("PUT", f"/api/notebooks/{dsa['id']}", json.dumps({**patch, "clientId": "t"}), {"Content-Type": "application/json", "Origin": BASE})
def get_nb():
    return json.loads(req("GET", f"/api/notebooks/{dsa['id']}")[2])

nb = get_nb()
ids = [x["id"] for x in nb["blocks"]]
b0, b1 = nb["blocks"][0], nb["blocks"][1]
base = nb["version"]
# Device A edits block 0 (up to date)
a0 = json.loads(json.dumps(b0)); a0["content"] = [{"type": "text", "text": "Edited on laptop", "styles": {}}]
s, _, _ = put({"upserts": [a0], "deletes": [], "order": ids, "baseVersion": base})
check(s == 200, "device A saves an edit")
# An assistant appends meanwhile
cookies.clear()
call("add_note", {"notebook": "DSA", "content": "Added while both devices were open"})
cookies.update(saved_cookies)
# Device B is stale (base): edits block 1 and deletes the last block it knew about
b1e = json.loads(json.dumps(b1)); b1e["content"] = [{"type": "text", "text": "Edited on iPad", "styles": {}}]
s, _, _ = put({"upserts": [b1e], "deletes": [ids[-1]], "order": [i for i in ids if i != ids[-1]], "baseVersion": base})
check(s == 200, "device B saves a stale edit")
after = get_nb()
txt = json.dumps(after["blocks"])
check("Edited on laptop" in txt and "Edited on iPad" in txt, "both devices' edits kept")
check("Added while both devices were open" in txt, "assistant's note kept")
check(ids[-1] not in [x["id"] for x in after["blocks"]], "device B's deletion applied")
check("Added while both devices were open" in json.dumps(after["blocks"][-1]), "assistant's note is last")

# Empty trailing lines are skipped: new content goes right after the last real line
order = [x["id"] for x in after["blocks"]]
empty = {"id": "empty-tail", "type": "paragraph", "props": {}, "content": [], "children": []}
put({"upserts": [empty], "deletes": [], "order": order + ["empty-tail"], "baseVersion": after["version"]})
cookies.clear()
call("add_key_points", {"notebook": "DSA", "points": ["After the last line"]})
cookies.update(saved_cookies)
fin = get_nb()
check(fin["blocks"][-1]["id"] == "empty-tail" and fin["blocks"][-2]["type"] == "keyPoints", "append goes before the trailing empty line")

# Handwriting: ink on a page and on an assistant's block; assistant content lands after the last written page
order = [x["id"] for x in fin["blocks"]]
p1 = {"id": "page-1", "type": "page", "props": {"height": 1414}, "children": []}
p2 = {"id": "page-2", "type": "page", "props": {"height": 1414}, "children": []}
s, _, _ = put({"upserts": [p1, p2], "deletes": [], "order": order + ["page-1", "page-2"], "baseVersion": fin["version"]})
check(s == 200, "blank pages added")
ai_block = fin["blocks"][-2]["id"]
def ink(body):
    return req("POST", f"/api/notebooks/{dsa['id']}/ink", json.dumps({**body, "clientId": "t"}), {"Content-Type": "application/json", "Origin": BASE})
s, _, _ = ink({"add": [{"anchor": "page-1", "stroke": {"id": "s1", "c": "blue", "s": 5, "d": "100,100,50,5,5,0,5,5,0"}}, {"anchor": ai_block, "stroke": {"id": "s2", "c": "red", "s": 5, "d": "10,10,50,20,0,0"}}]})
check(s == 200, "ink saved")
nbi = get_nb()
check(set(nbi["inkAnchors"]) == {"page-1", ai_block}, "notebook lists which blocks have handwriting")
s, _, b = req("GET", f"/api/notebooks/{dsa['id']}/ink?anchors=page-1,{ai_block},nothing")
got = json.loads(b)
check(len(got["page-1"]) == 1 and got["page-1"][0]["d"].startswith("100,100") and len(got[ai_block]) == 1 and got["nothing"] == [], "ink loads per block")
cookies.clear()
call("add_note", {"notebook": "DSA", "content": "After the handwriting"})
r, t = call("read_notebook", {"notebook": "DSA"})
check("Handwritten page" in t and "has handwritten notes" in t, "read_notebook mentions handwriting")
cookies.update(saved_cookies)
ids2 = [x["id"] for x in get_nb()["blocks"]]
i1 = ids2.index("page-1")
check("After the handwriting" in json.dumps(get_nb()["blocks"][i1 + 1]) and ids2[-1] == "page-2", "assistant content goes after the last written page, before blank ones")
s, _, _ = ink({"remove": [{"anchor": "page-1", "id": "s1"}]})
s, _, b = req("GET", f"/api/notebooks/{dsa['id']}/ink?anchors=page-1")
check(json.loads(b)["page-1"] == [] and "page-1" not in get_nb()["inkAnchors"], "erased stroke is gone")
s, _, _ = req("POST", f"/api/notebooks/{dsa['id']}/ink", json.dumps({"add": [], "remove": []}), {"Content-Type": "application/json", "Origin": "https://evil.example"})
check(s == 403, "cross-site ink write refused")

# 9. cross-site write is refused
s, _, _ = req("PUT", f"/api/notebooks/{dsa['id']}", json.dumps({"upserts": [], "deletes": [], "order": [], "baseVersion": 0}), {"Content-Type": "application/json", "Origin": "https://evil.example"})
check(s == 403, "cross-site write refused")

# 10. bad token refused
s, _, _ = req("POST", "/mcp", "{}", {"Authorization": "Bearer nope", "Content-Type": "application/json"})
check(s == 401, "bad token refused")

# 10b. assistant study tools: summarize, flashcards, read and convert handwriting
cookies.clear()
call("add_note", {"notebook": "Hand", "title": "Cell biology", "content": "Mitochondria make **ATP**."})
cookies.update(saved_cookies)
hb = json.loads(req("GET", "/api/notebooks")[2])
hand = next(n for n in hb if n["name"] == "Hand")
hnb = json.loads(req("GET", f"/api/notebooks/{hand['id']}")[2])
hids = [x["id"] for x in hnb["blocks"]]
pg = {"id": "hand-page", "type": "page", "props": {"height": 1414, "style": "lined", "size": "a4"}, "children": []}
req("PUT", f"/api/notebooks/{hand['id']}", json.dumps({"upserts": [pg], "deletes": [], "order": hids + ["hand-page"], "baseVersion": hnb["version"], "clientId": "t"}), {"Content-Type": "application/json", "Origin": BASE})
def enc(pts):
    out = []
    for i, (x, y) in enumerate(pts):
        out += [x, y, 50] if i == 0 else [x - pts[i-1][0], y - pts[i-1][1], 0]
    return ",".join(map(str, out))
strokes = [{"anchor": "hand-page", "stroke": {"id": f"h{k}", "c": "ink", "s": 6, "d": enc([(100 + k * 60 + j * 4, 200 + (j % 5) * 8) for j in range(12)])}} for k in range(6)]
req("POST", f"/api/notebooks/{hand['id']}/ink", json.dumps({"add": strokes, "clientId": "t"}), {"Content-Type": "application/json", "Origin": BASE})
cookies.clear()
res = mcp("tools/call", {"name": "read_handwriting", "arguments": {"notebook": "Hand"}})["result"]
imgs = [c for c in res["content"] if c["type"] == "image"]
check("Handwritten page 1" in res["content"][0]["text"] and len(imgs) == 1 and imgs[0]["mimeType"] == "image/png", "read_handwriting lists the page and returns a picture")
png = base64.b64decode(imgs[0]["data"])
import struct, zlib
w, hgt = struct.unpack(">II", png[16:24])
check(png[:8] == b"\x89PNG\r\n\x1a\n" and w == 900 and 1200 < hgt < 1300, f"the picture is a valid PNG of the page ({w}x{hgt})")
# the image actually contains dark ink pixels
raw = zlib.decompress(b"".join(png[i+8:i+8+struct.unpack(">I", png[i:i+4])[0]] for i in [j for j in range(8, len(png)) if png[j+4:j+8] == b"IDAT"]))
dark = sum(1 for k in range(0, len(raw), 3) if raw[k] < 120)
check(dark > 200, f"the picture shows the handwriting ({dark} dark pixels)")
r, t = call("summarize_notebook", {"notebook": "Hand"})
check("Mitochondria" in t and "Handwriting (1)" in t, "summarize_notebook returns the content and points out the handwriting")
r, t = call("summarize_notebook", {"notebook": "Hand", "save_summary": "Mitochondria produce ATP for the cell.", "title": "Cells"})
check(not r.get("isError") and "Summary added" in t, "summarize_notebook saves a summary when asked")
r, t = call("make_flashcards", {"notebook": "Hand", "title": "Cells", "cards": [{"front": "What makes ATP?", "back": "Mitochondria"}, {"front": "ATP stands for?", "back": "Adenosine triphosphate"}]})
check(not r.get("isError") and "2 cards" in t, "make_flashcards adds a deck")
r, t = call("convert_handwriting", {"notebook": "Hand", "item": 1, "text": "Glycolysis happens in the cytoplasm."})
check(not r.get("isError") and "Typed text added" in t, "convert_handwriting accepts the typed version")
cookies.update(saved_cookies)
after = json.loads(req("GET", f"/api/notebooks/{hand['id']}")[2])
types = [x["type"] for x in after["blocks"]]
txt = json.dumps(after["blocks"])
check("Glycolysis happens" in txt and "hand-page" not in [x["id"] for x in after["blocks"]] and "hand-page" not in after["inkAnchors"], "typed text replaced the handwritten page")
check("flashcards" in types and any(x["type"] == "callout" and x["props"]["kind"] == "summary" for x in after["blocks"]), "flashcards and summary are in the notebook")
cookies.clear()
r, t = call("read_notebook", {"notebook": "Hand"})
check("🃏 Cells" in t and "What makes ATP?" in t, "read_notebook shows the flashcards")
cookies.update(saved_cookies)

# 10c. search: names, every word must match, PDFs for you but never for assistants
s, _, b = req("GET", "/api/search?q=" + urllib.parse.quote("hand"))
r = json.loads(b)
check(any(n["name"] == "Hand" for n in r["notebooks"]), "search finds a notebook by its name")
s, _, b = req("GET", "/api/search?q=" + urllib.parse.quote("mitochondria atp"))
r = json.loads(b)
check(len(r["hits"]) > 0 and all("mitochondria" in h["snippet"].lower() and "atp" in h["snippet"].lower() for h in r["hits"]), "every word must match (and the preview shows the match)")
s, _, b = req("GET", "/api/search?q=" + urllib.parse.quote("mitochondria zebra"))
check(len(json.loads(b)["hits"]) == 0, "no result when one of the words isn't there")
boundary = "noty" + os.urandom(6).hex()
pdf_bytes = b"%PDF-1.4\n% tiny test file\n%%EOF\n"
body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"Secret syllabus.pdf\"\r\nContent-Type: application/pdf\r\n\r\n").encode() + pdf_bytes + f"\r\n--{boundary}--\r\n".encode()
s, _, b = req("POST", "/api/pdfs", body, {"Content-Type": f"multipart/form-data; boundary={boundary}", "Origin": BASE})
pdf_id = json.loads(b)["id"]
req("PUT", f"/api/pdfs/{pdf_id}/text", json.dumps({"pages": ["intro", "the zygomorphic flower appears here"]}), {"Content-Type": "application/json", "Origin": BASE})
req("PUT", f"/api/pdfs/{pdf_id}/boxes", json.dumps({"boxes": [{"id": "x1", "page": 0, "x": .1, "y": .1, "w": .3, "text": "remember zygomorphic", "size": 14, "color": "ink"}], "clientId": "t"}), {"Content-Type": "application/json", "Origin": BASE})
s, _, b = req("GET", "/api/search?q=zygomorphic")
r = json.loads(b)
pages = sorted((h["page"], bool(h.get("note"))) for h in r["hits"] if h["kind"] == "pdf")
check(pages == [(1, True), (2, False)], f"search finds words on PDF pages and in PDF text boxes, with page numbers ({pages})")
s, _, b = req("GET", "/api/search?q=" + urllib.parse.quote("secret syllabus"))
check(any(p["id"] == pdf_id for p in json.loads(b)["pdfs"]), "search finds a PDF by its name")
cookies.clear()
r, t = call("search_notes", {"query": "zygomorphic"})
check("Nothing found" in t, "assistants' search never sees PDF content")
r, t = call("search_notes", {"query": "secret syllabus"})
check("Nothing found" in t, "assistants' search never sees PDF names")
r, t = call("search_notes", {"query": "hand"})
check('Notebook "Hand"' in t, "assistants' search finds notebooks by name")
cookies.update(saved_cookies)

# 10d. notebook names: no matching inside words; ask when it's ambiguous
for nm in ["Coursework", "Physics 2", "Physics 3"]:
    req("POST", "/api/notebooks", json.dumps({"name": nm}), {"Content-Type": "application/json", "Origin": BASE})
cookies.clear()
r, t = call("add_note", {"notebook": "course", "content": "goes to a new notebook"})
check(not r.get("isError") and '"course" (new notebook)' in t, "\"course\" doesn't land in \"Coursework\" (a new notebook is made)")
r, t = call("add_note", {"notebook": "physics", "content": "which one?"})
check(r.get("isError") and "Physics 2" in t and "Physics 3" in t, "\"physics\" with two Physics notebooks: the assistant is asked which one")
r, t = call("add_note", {"notebook": "physics 3", "content": "this one"})
check(not r.get("isError") and '"Physics 3"' in t, "the exact name picks the right notebook")
r, t = call("read_notebook", {"notebook": "physics"})
check(r.get("isError") and "Physics 2" in t, "reading an ambiguous name also asks which one")
# images work without Google Drive
png = base64.b64encode(bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000d49444154789c6360f8cfc0f01f0005000201e5f0a7a90000000049454e44ae426082")).decode()
r, t = call("add_image", {"notebook": "course", "base64": png, "mime_type": "image/png", "caption": "dot"})
check(not r.get("isError"), "add_image works without Google Drive")
cookies.update(saved_cookies)
crs = next(n for n in json.loads(req("GET", "/api/notebooks")[2]) if n["name"] == "course")
img = next(b for b in json.loads(req("GET", f"/api/notebooks/{crs['id']}")[2])["blocks"] if b["type"] == "image")
resp = urllib.request.urlopen(urllib.request.Request(BASE + img["props"]["url"], headers={"Cookie": "; ".join(f"{k}={v}" for k, v in cookies.items())}))
raw = resp.read()
check(resp.status == 200 and resp.headers.get("Content-Type") == "image/png" and raw[:8] == b"\x89PNG\r\n\x1a\n" and img["props"]["url"].startswith("/api/files/local-"), "the image is stored in Noty and loads back")

# 10e. Notion-style features
cookies.clear()
r, t = call("add_board", {"notebook": "Projects", "title": "Launch", "columns": [{"name": "To do", "cards": ["Write intro", "Pick colours"]}, {"name": "Doing", "cards": ["Build app"]}, {"name": "Done", "cards": []}]})
check(not r.get("isError") and "3 cards" in t, "add_board adds a task board")
r, t = call("read_notebook", {"notebook": "Projects"})
check("📋 Launch" in t and "Write intro" in t and "**Done** (empty)" in t, "read_notebook shows the board")
cookies.update(saved_cookies)
J = {"Content-Type": "application/json", "Origin": BASE}
nbs = json.loads(req("GET", "/api/notebooks")[2])
proj = next(n for n in nbs if n["name"] == "Projects")
s, _, b = req("PATCH", f"/api/notebooks/{proj['id']}", json.dumps({"icon": "🚀", "cover": "#1F6F78", "favorite": True}), J)
m = json.loads(b)
check(m.get("icon") == "🚀" and m.get("cover") == "#1F6F78" and m.get("favorite") is True, "icon, cover colour and favourite are saved")
s, _, b = req("PATCH", f"/api/notebooks/{proj['id']}", json.dumps({"cover": "javascript:alert(1)"}), J)
check(json.loads(b).get("cover") is None, "a cover that isn't a colour is refused")
# backlinks + table of contents
s, _, b = req("POST", "/api/notebooks", json.dumps({"name": "Index"}), J)
idx = json.loads(b)
blocks = [{"id": "h-a", "type": "heading", "props": {"level": 2}, "content": [{"type": "text", "text": "Part A", "styles": {}}], "children": []},
          {"id": "toc1", "type": "toc", "props": {}, "children": []},
          {"id": "ln1", "type": "nblink", "props": {"target": proj["id"], "title": "Projects", "icon": "🚀"}, "children": []}]
req("PUT", f"/api/notebooks/{idx['id']}", json.dumps({"upserts": blocks, "deletes": [], "order": [x["id"] for x in blocks], "baseVersion": 1, "clientId": "t"}), J)
bl = json.loads(req("GET", f"/api/notebooks/{proj['id']}/backlinks")[2])
check([x["name"] for x in bl] == ["Index"], "Projects shows it's linked from Index (backlinks)")
cookies.clear()
r, t = call("read_notebook", {"notebook": "Index"})
check("**Contents**" in t and "- Part A" in t and "→ Projects" in t, "read_notebook shows the contents list and the notebook link")
cookies.update(saved_cookies)
# page history: restore an earlier version, and the restore can be undone
s, _, b = req("POST", "/api/notebooks", json.dumps({"name": "History test"}), J)
hid = json.loads(b)["id"]
v1 = [{"id": "x1", "type": "paragraph", "props": {}, "content": [{"type": "text", "text": "first version", "styles": {}}], "children": []}]
req("PUT", f"/api/notebooks/{hid}", json.dumps({"upserts": v1, "deletes": [], "order": ["x1"], "baseVersion": 1, "clientId": "t"}), J)
v2 = [{"id": "x1", "type": "paragraph", "props": {}, "content": [{"type": "text", "text": "second version", "styles": {}}], "children": []}]
cur = json.loads(req("GET", f"/api/notebooks/{hid}")[2])
req("PUT", f"/api/notebooks/{hid}", json.dumps({"upserts": v2, "deletes": [], "order": ["x1"], "baseVersion": cur["version"], "clientId": "t"}), J)
hist = json.loads(req("GET", f"/api/notebooks/{hid}/history")[2])
first = hist[-1]["ts"]
snap = json.loads(req("GET", f"/api/notebooks/{hid}/history/{first}")[2])
check("first version" in json.dumps(snap["blocks"]), "history keeps the earlier version")
s, _, _ = req("POST", f"/api/notebooks/{hid}/history/{first}/restore", "", J)
now_ = json.loads(req("GET", f"/api/notebooks/{hid}")[2])
check(s == 200 and "first version" in json.dumps(now_["blocks"]), "restoring a version brings it back")
hist2 = json.loads(req("GET", f"/api/notebooks/{hid}/history")[2])
check(any("second version" in json.dumps(json.loads(req("GET", f"/api/notebooks/{hid}/history/{h['ts']}")[2])["blocks"]) for h in hist2), "the version before the restore is kept, so the restore can be undone")
# trash
s, _, _ = req("DELETE", f"/api/notebooks/{hid}", None, J)
lst = json.loads(req("GET", "/api/notebooks")[2])
trash = json.loads(req("GET", "/api/trash")[2])
check(not any(n["id"] == hid for n in lst) and any(n["id"] == hid for n in trash), "deleting moves a notebook to the Trash")
tr = json.loads(req("GET", f"/api/notebooks/{hid}")[2])
check(tr.get("trashed") is True, "a notebook in the Trash still opens (read-only)")
s, _, _ = req("PUT", f"/api/notebooks/{hid}", json.dumps({"upserts": v2, "deletes": [], "order": ["x1"], "baseVersion": 99, "clientId": "t"}), J)
check(s == 404, "a notebook in the Trash can't be edited")
cookies.clear()
r, t = call("read_notebook", {"notebook": "History test"})
check(r.get("isError"), "assistants can't see notebooks in the Trash")
cookies.update(saved_cookies)
s, _, b = req("POST", f"/api/trash/{hid}/restore", "", J)
check(s == 200 and any(n["id"] == hid for n in json.loads(req("GET", "/api/notebooks")[2])), "restore brings it back from the Trash")
req("DELETE", f"/api/notebooks/{hid}", None, J)
s, _, b = req("DELETE", f"/api/trash/{hid}", None, J)
check(json.loads(b)["ok"] and req("GET", f"/api/notebooks/{hid}")[0] == 404 and not any(n["id"] == hid for n in json.loads(req("GET", "/api/trash")[2])), "delete forever removes it completely")

# 10f. topics (group notebooks and PDFs by subject)
cookies.clear()
r, t = call("create_notebook", {"name": "Cell biology", "topic": "Biology"})
check(not r.get("isError"), "assistants can create a notebook inside a topic")
r, t = call("list_notebooks", {})
check("Cell biology [topic: Biology]" in t, "assistants see each notebook's topic")
r, t = call("create_notebook", {"name": "Diary", "font": "neat"})
check(not r.get("isError"), "assistants can create a notebook in a handwriting font")
r, t = call("set_handwriting", {"notebook": "cell biology", "font": "hand"})
check(not r.get("isError") and "handwriting" in t, "assistants can switch a notebook to handwriting")
r, t = call("set_handwriting", {"notebook": "No such notebook", "font": "hand"})
check(r.get("isError"), "set_handwriting on a missing notebook is an error")
cookies.update(saved_cookies)
J = {"Content-Type": "application/json", "Origin": BASE}
nbs = json.loads(req("GET", "/api/notebooks")[2])
fonts = {n["name"]: n.get("font") for n in nbs}
check(fonts.get("Diary") == "neat" and fonts.get("Cell biology") == "hand", "the handwriting choice is saved on the notebook")
s, _, b = req("PATCH", f"/api/notebooks/{next(n['id'] for n in nbs if n['name'] == 'Cell biology')}", json.dumps({"font": "print"}), J)
check(json.loads(b).get("font") == "print", "a notebook can switch to print")
check(not next(n for n in nbs if n["name"] == "Hand").get("font"), "notebooks without a choice use the default (neat handwriting)")
hnd = next(n for n in nbs if n["name"] == "Hand")
s, _, b = req("PATCH", f"/api/notebooks/{hnd['id']}", json.dumps({"topic": "  Biology  "}), J)
check(json.loads(b).get("topic") == "Biology", "a notebook can be moved into a topic (spaces tidied)")
s, _, b = req("PATCH", f"/api/pdfs/{pdf_id}", json.dumps({"topic": "Exams"}), J)
check(json.loads(b).get("topic") == "Exams", "a PDF can be put in a topic")
check(json.loads(req("GET", "/api/topics")[2]) == ["Biology", "Exams"], "the topic list has every topic in use, A to Z")
s, _, b = req("PATCH", f"/api/notebooks/{hnd['id']}", json.dumps({"topic": ""}), J)
check(json.loads(b).get("topic") is None, "a notebook can be taken out of its topic")

# 11. admin password sign-in (password read from .dev.vars, never printed)
import pathlib
pw = next(l.split("=", 1)[1].strip() for l in (pathlib.Path(__file__).parent.parent / ".dev.vars").read_text().splitlines() if l.startswith("ADMIN_PASSWORD="))
cookies.clear()
form = lambda p: urllib.parse.urlencode({"password": p, "next": "/n/x"})
hdr = {"Content-Type": "application/x-www-form-urlencoded", "Origin": BASE, "CF-Connecting-IP": "203.0.113.7"}
s, _, body = req("POST", "/login/password", form("wrong-password"), hdr)
check(s == 401 and "password isn" in body and "noty_session" not in cookies, "wrong password refused")
s, h, _ = req("POST", "/login/password", form(pw), hdr)
check(s == 302 and h.get("Location") == "/n/x" and "noty_session" in cookies, "right password signs in")
s, _, b = req("GET", "/api/me")
me = json.loads(b)
check(s == 200 and me["drive"]["connected"] is False and "googleAvailable" in me, "password account works without Google (Drive copy off)")
s, _, _ = req("POST", "/login/password", form(pw), {**hdr, "Origin": "https://evil.example"})
check(s == 403, "cross-site password post refused")
cookies.clear()
hdr2 = {**hdr, "CF-Connecting-IP": "203.0.113.99"}
for _ in range(8):
    req("POST", "/login/password", form("nope-nope-nope"), hdr2)
s, _, body = req("POST", "/login/password", form(pw), hdr2)
check("Too many wrong passwords" in body and "noty_session" not in cookies, "locked out after 8 wrong tries, even with the right password")
_dv = (pathlib.Path(__file__).parent.parent / ".dev.vars").read_text()
google_set = not re.search(r"^GOOGLE_CLIENT_ID=your-", _dv, re.M) and not re.search(r"^GOOGLE_SIGNIN=off", _dv, re.M)
s, h, _ = req("GET", "/login/google?next=/")
if google_set:
    check(s == 302 and h.get("Location", "").startswith("https://accounts.google.com/"), "Google keys set: Continue with Google goes to Google")
else:
    check(s == 401 or "set up on this Noty" in _, "Google is hidden/blocked when it isn't set up or is switched off")
    s, _, lp = req("GET", "/login?next=/")
    check("Continue with Google" not in lp, "the sign-in page doesn't offer Google while it's off")

print("\nAll checks passed.")
