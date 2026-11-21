// Connects to the LIVE MCP server the way an assistant does (register, sign in with the owner
// password from .dev.vars, Allow, token), then checks its tools match the list shown in the app.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
const root = new URL("..", import.meta.url);
const B = process.argv[2] ?? readFileSync(new URL("wrangler.jsonc", root), "utf8").match(/"PUBLIC_URL":\s*"([^"]*)"/)[1];
const pw = readFileSync(new URL(".dev.vars", root), "utf8").match(/^ADMIN_PASSWORD=(.*)$/m)[1].trim();
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function req(method, path, body, headers = {}) {
  const res = await fetch(path.startsWith("http") ? path : B + path, { method, body, redirect: "manual", headers: { ...(jar.size ? { Cookie: cookieHeader() } : {}), ...headers } });
  for (const sc of res.headers.getSetCookie()) {
    const [kv] = sc.split(";");
    const [k, v] = kv.split("=");
    if (/Max-Age=0/i.test(sc)) jar.delete(k);
    else jar.set(k, v);
  }
  return res;
}
const form = (o) => ({ body: new URLSearchParams(o).toString(), type: "application/x-www-form-urlencoded" });
const reg = await (await req("POST", "/oauth/register", JSON.stringify({ client_name: "Noty self-check", redirect_uris: ["http://localhost:9999/cb"], token_endpoint_auth_method: "none" }), { "Content-Type": "application/json" })).json();
const ver = randomBytes(32).toString("base64url");
const chal = createHash("sha256").update(ver).digest("base64url");
const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://localhost:9999/cb", code_challenge: chal, code_challenge_method: "S256", state: "s", scope: "notes", resource: B + "/mcp" });
let r = await req("GET", "/authorize?" + q);
const next = new URL(r.headers.get("location"), B).searchParams.get("next");
let f = form({ password: pw, next });
r = await req("POST", "/login/password", f.body, { "Content-Type": f.type, Origin: B });
r = await req("GET", r.headers.get("location"));
let loc;
if (r.status === 302) loc = r.headers.get("location");
else {
  const handle = (await r.text()).match(/name="handle" value="([^"]+)"/)[1];
  f = form({ handle, decision: "approve" });
  r = await req("POST", "/authorize", f.body, { "Content-Type": f.type, Origin: B });
  loc = r.headers.get("location");
}
const code = new URL(loc).searchParams.get("code");
f = form({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/cb", client_id: reg.client_id, code_verifier: ver, resource: B + "/mcp" });
const { access_token } = await (await req("POST", "/oauth/token", f.body, { "Content-Type": f.type })).json();
jar.clear();
let id = 0;
async function mcp(method, params = {}) {
  const res = await req("POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" });
  let t = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("event-stream")) t = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
  return JSON.parse(t);
}
await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "self-check", version: "1" } });
const tools = (await mcp("tools/list")).result.tools.map((t) => t.name).sort();
const listed = [...readFileSync(new URL("src/shared/tools.ts", root), "utf8").matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]).sort();
console.log(`live server offers ${tools.length} tools; the app lists ${listed.length}`);
const same = JSON.stringify(tools) === JSON.stringify(listed);
console.log(same ? "MATCH: every live tool is listed in the app" : `MISMATCH: server-only ${tools.filter((t) => !listed.includes(t))}, app-only ${listed.filter((t) => !tools.includes(t))}`);
const ln = (await mcp("tools/call", { name: "list_notebooks", arguments: {} })).result;
console.log(`live list_notebooks call: ${ln.isError ? "FAILED" : "works"}`);
process.exit(same && !ln.isError ? 0 : 1);
