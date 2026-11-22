// Noty: one Worker that serves the web editor, its API, Google sign-in, and the MCP server.

import { AuthorizationError, CimdFetchError, OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { env as workerEnv } from "cloudflare:workers";
import { Hono } from "hono";
import type { Block } from "../shared/blocks";
import { exchangeCode, fetchGoogleUser, googleAuthUrl, hasDriveScope } from "./google";
import { type AuthProps, mcpHandler } from "./mcp";
import {
  clearSessionCookie,
  clearStateCookie,
  getSession,
  randomToken,
  readCookie,
  type Session,
  sessionCookie,
  stateCookie,
} from "./session";
import { type InkStroke, NeedsSignInError, type PdfBox } from "./vault";

export { Vault } from "./vault";

type AppEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
type Ctx = { Bindings: AppEnv; Variables: { session: Session } };

const app = new Hono<Ctx>();
const vaultFor = (env: Env, uid: string) => env.VAULT.get(env.VAULT.idFromName(uid));

const isLocal = (env: Env) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.PUBLIC_URL);
const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
/** Google is offered only when its keys are set and it isn't switched off (GOOGLE_SIGNIN=off hides it until Google Cloud is ready). */
const googleConfigured = (env: Env) =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && !env.GOOGLE_CLIENT_ID.startsWith("your-")) && (env.GOOGLE_SIGNIN ?? "").trim().toLowerCase() !== "off";
const passwordConfigured = (env: Env) => (env.ADMIN_PASSWORD ?? "").length >= 10;

/**
 * One owner per deployment. Signing in with the admin password, or with Google as OWNER_EMAIL,
 * both open the owner's notebooks. Other Google accounts in ALLOWED_EMAILS get their own.
 */
const OWNER_UID = "owner";
const isOwnerEmail = (env: Env, email: string) => list(env.OWNER_EMAIL).includes(email.toLowerCase());
/** SIGNUPS=open: anyone with a Google account can sign in and gets their own private notebooks. */
const openSignups = (env: Env) => (env.SIGNUPS ?? "").trim().toLowerCase() === "open";
const googleAllowed = (env: Env, email: string) => {
  if (isOwnerEmail(env, email) || list(env.ALLOWED_EMAILS).includes(email.toLowerCase())) return true;
  if (openSignups(env)) return true;
  // With no list at all, only a local test copy lets anyone in.
  return !list(env.OWNER_EMAIL).length && !list(env.ALLOWED_EMAILS).length && isLocal(env);
};

/** Only same-site relative paths may be used as post-login destinations. */
const safeNext = (n: string | undefined) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/");

// ---------- sign-in page: admin password and/or Google ----------

function signInPage(env: Env, next: string, error = "") {
  const google = googleConfigured(env);
  const pw = passwordConfigured(env);
  const dev = env.DEV_LOGIN === "1" && isLocal(env);
  const nextQ = encodeURIComponent(next);
  const body = `
    ${pw ? `<form method="post" action="/login/password" class="pw">
      <input type="hidden" name="next" value="${esc(next)}">
      <div class="field">
        <label for="pw">Password</label>
        <input id="pw" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required autofocus>
      </div>
      <button class="btn-primary" type="submit">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>
        Sign in
      </button>
    </form>` : ""}
    ${pw && google ? `<div class="divider"><span>or</span></div>` : ""}
    ${google ? `<a class="btn-google" href="/login/google?next=${nextQ}"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>Continue with Google</a>` : ""}
    ${google && openSignups(env) ? `<p class="note">New here? Signing in with Google creates your own private notebooks.</p>` : ""}
    ${dev ? `<a class="btn-dev" href="/login/dev?next=${nextQ}">🧪 Local test sign-in</a>` : ""}
    ${!pw && !google && !dev ? `<p class="note" style="text-align:left">Set <code style="background:var(--border);padding:1px 5px;border-radius:4px;font-size:.85em">ADMIN_PASSWORD</code> or the Google keys in <code style="background:var(--border);padding:1px 5px;border-radius:4px;font-size:.85em">.dev.vars</code>, then deploy again.</p>` : ""}`;
  return new Response(loginShell(error, body), {
    status: error ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Cache-Control": "no-store" },
  });
}

function loginShell(error: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Noty</title><link rel="icon" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
/* ── THEMES ── */
[data-t="dawn"]     {--bg:#FDF6EE;--card:#FFFFFF;--ink:#2C1810;--muted:#9C7B6E;--border:#EDD9CC;--accent:#C0622F;--accent2:#E8956A;--ring:rgba(192,98,47,.18)}
[data-t="glacier"]  {--bg:#EEF4FA;--card:#FFFFFF;--ink:#152840;--muted:#527A9B;--border:#C8DFF0;--accent:#1E6BA8;--accent2:#3B8FD4;--ring:rgba(30,107,168,.18)}
[data-t="sage"]     {--bg:#EEF3EE;--card:#FFFFFF;--ink:#192A1E;--muted:#587A5F;--border:#C4DAC6;--accent:#2E7D45;--accent2:#4EA86A;--ring:rgba(46,125,69,.18)}
[data-t="lavender"] {--bg:#F2F0FA;--card:#FFFFFF;--ink:#231B40;--muted:#7467A0;--border:#D3CCEE;--accent:#5B44B0;--accent2:#8571D4;--ring:rgba(91,68,176,.18)}
[data-t="rose"]     {--bg:#FAF0F3;--card:#FFFFFF;--ink:#3A1020;--muted:#A05070;--border:#EEC8D4;--accent:#C0325A;--accent2:#E0607E;--ring:rgba(192,50,90,.18)}
[data-t="slate"]    {--bg:#EEF0F5;--card:#FFFFFF;--ink:#1A2035;--muted:#606880;--border:#CDD2E0;--accent:#3A4F7A;--accent2:#5F7AAD;--ring:rgba(58,79,122,.18)}
[data-t="amber"]    {--bg:#FBF5E8;--card:#FFFFFF;--ink:#2A1A00;--muted:#8A6A1A;--border:#E8D5A0;--accent:#B87800;--accent2:#E09B00;--ring:rgba(184,120,0,.18)}
[data-t="teal"]     {--bg:#EBF5F5;--card:#FFFFFF;--ink:#0E2A2A;--muted:#3A7070;--border:#B8DADA;--accent:#0F7070;--accent2:#259494;--ring:rgba(15,112,112,.18)}
[data-t="midnight"] {--bg:#0F111A;--card:#181C28;--ink:#E0E4F0;--muted:#7880A0;--border:#262C40;--accent:#6B8FFF;--accent2:#90AEFF;--ring:rgba(107,143,255,.2);color-scheme:dark}
[data-t="charcoal"] {--bg:#141618;--card:#1E2125;--ink:#D8DCE8;--muted:#70788C;--border:#2A2E35;--accent:#A0AACC;--accent2:#C0CAEE;--ring:rgba(160,170,204,.2);color-scheme:dark}
[data-t="forest"]   {--bg:#0D1710;--card:#141F17;--ink:#C8E0CC;--muted:#527A58;--border:#1E3022;--accent:#4DB870;--accent2:#70D890;--ring:rgba(77,184,112,.2);color-scheme:dark}
[data-t="plum"]     {--bg:#130D1C;--card:#1C1428;--ink:#E0D0F4;--muted:#8060A8;--border:#2A1E3E;--accent:#A87AE0;--accent2:#C8A0FF;--ring:rgba(168,122,224,.2);color-scheme:dark}
[data-t="crimson"]  {--bg:#160A0A;--card:#201212;--ink:#F0D8D8;--muted:#A05050;--border:#301818;--accent:#E05050;--accent2:#FF7878;--ring:rgba(224,80,80,.2);color-scheme:dark}
[data-t="ocean"]    {--bg:#060E1A;--card:#0C1828;--ink:#C0D8F0;--muted:#3A6090;--border:#102030;--accent:#3A8FD4;--accent2:#60AEFF;--ring:rgba(58,143,212,.2);color-scheme:dark}
[data-t="sand"]     {--bg:#F5F0E8;--card:#FDFAF5;--ink:#2A2010;--muted:#8A7860;--border:#E0D4BC;--accent:#8A6840;--accent2:#B08A5A;--ring:rgba(138,104,64,.18)}

*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--ink);font:15px/1.6 "Inter",system-ui,sans-serif;padding:20px;transition:background .4s,color .4s}

/* subtle mesh gradient bg */
.bg-mesh{position:fixed;inset:0;pointer-events:none;z-index:0;background:radial-gradient(ellipse 80% 60% at 20% 20%,rgba(var(--accent-rgb,.06),0.06) 0%,transparent 60%),radial-gradient(ellipse 60% 80% at 80% 80%,rgba(var(--accent-rgb,.04),0.04) 0%,transparent 60%);opacity:.7}

.wrap{position:relative;z-index:1;width:100%;max-width:400px}

/* card */
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:36px 32px 28px;box-shadow:0 2px 4px rgba(0,0,0,.04),0 8px 32px rgba(0,0,0,.06)}

/* brand */
.brand{display:flex;align-items:center;gap:11px;margin-bottom:24px}
.brand-mark{width:40px;height:40px;border-radius:10px;background:var(--accent);display:grid;place-items:center;flex-shrink:0;box-shadow:0 2px 8px var(--ring)}
.brand-mark svg{color:#fff;width:20px;height:20px}
.brand-name{font-size:1.5rem;font-weight:700;letter-spacing:-.03em;line-height:1.1;color:var(--ink)}
.brand-sub{font-size:.72rem;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;margin-top:1px}

/* headline */
.headline{font-size:1.1rem;font-weight:600;color:var(--ink);margin-bottom:6px;letter-spacing:-.01em}
.sub{font-size:.88rem;color:var(--muted);margin-bottom:26px;line-height:1.55}

/* error */
.err{background:rgba(220,50,50,.1);border:1px solid rgba(220,50,50,.25);color:#c82020;padding:10px 14px;border-radius:10px;font-size:.85rem;margin-bottom:18px;display:flex;align-items:flex-start;gap:8px}
[data-t="midnight"] .err,[data-t="charcoal"] .err,[data-t="forest"] .err,[data-t="plum"] .err,[data-t="crimson"] .err,[data-t="ocean"] .err{color:#ff8080}

/* label */
.field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.field label{font-size:.78rem;font-weight:600;color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
.field input{font:inherit;font-size:.93rem;padding:11px 14px;border:1.5px solid var(--border);border-radius:10px;background:var(--bg);color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s}
.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--ring)}

/* primary btn */
.btn-primary{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:11px 20px;background:var(--accent);color:#fff;font:inherit;font-size:.93rem;font-weight:600;border:none;border-radius:10px;cursor:pointer;transition:opacity .15s,transform .1s,box-shadow .15s;box-shadow:0 2px 8px var(--ring);letter-spacing:.01em;margin-top:4px}
.btn-primary:hover{opacity:.88;box-shadow:0 4px 16px var(--ring)}
.btn-primary:active{transform:scale(.98);opacity:.95}

/* divider */
.divider{display:flex;align-items:center;gap:12px;margin:18px 0;color:var(--muted);font-size:.8rem}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--border)}

/* google btn */
.btn-google{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:11px 20px;background:var(--card);color:var(--ink);font:inherit;font-size:.93rem;font-weight:500;border:1.5px solid var(--border);border-radius:10px;cursor:pointer;text-decoration:none;transition:border-color .15s,box-shadow .15s,background .15s}
.btn-google:hover{border-color:var(--accent);box-shadow:0 2px 12px var(--ring)}

/* dev btn */
.btn-dev{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:9px 16px;background:transparent;color:var(--muted);font:inherit;font-size:.82rem;border:1px dashed var(--border);border-radius:9px;cursor:pointer;text-decoration:none;margin-top:12px;transition:color .15s,border-color .15s}
.btn-dev:hover{color:var(--ink);border-color:var(--muted)}

.note{font-size:.78rem;color:var(--muted);text-align:center;margin-top:12px;line-height:1.55}

/* ── THEME PICKER ── */
.theme-bar{margin-top:20px;padding-top:18px;border-top:1px solid var(--border)}
.theme-label{font-size:.72rem;font-weight:600;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px}
.theme-grid{display:flex;flex-wrap:wrap;gap:7px}
.swatch{width:26px;height:26px;border-radius:50%;border:2px solid transparent;cursor:pointer;transition:transform .15s,box-shadow .15s;position:relative;flex-shrink:0}
.swatch:hover{transform:scale(1.2)}
.swatch.active{border-color:var(--accent);box-shadow:0 0 0 2px var(--ring),0 0 0 4px var(--card)}
.swatch[title]:hover::after{content:attr(title);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--ink);color:var(--card);font-size:.7rem;white-space:nowrap;padding:3px 7px;border-radius:5px;pointer-events:none;font-family:"Inter",sans-serif;font-weight:500;letter-spacing:.01em}
</style>
</head>
<body data-t="glacier">
<div class="bg-mesh" aria-hidden="true"></div>
<div class="wrap">
  <div class="card">
    <div class="brand">
      <div class="brand-mark">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 5h16M4 9h10M4 13h16M4 17h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </div>
      <div>
        <div class="brand-name">Noty</div>
        <div class="brand-sub">AI Notebooks</div>
      </div>
    </div>

    <div class="headline">Welcome back</div>
    <p class="sub">Sign in to your notebooks</p>

    ${error ? `<div class="err" role="alert"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" flex-shrink="0" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>${esc(error)}</div>` : ""}
    ${body}

    <!-- theme picker -->
    <div class="theme-bar">
      <div class="theme-label">Theme</div>
      <div class="theme-grid" id="swatches"></div>
    </div>
  </div>
</div>

<script>
(function(){
  var THEMES=[
    {id:"dawn",     color:"#C0622F", name:"Dawn"},
    {id:"glacier",  color:"#1E6BA8", name:"Glacier"},
    {id:"sage",     color:"#2E7D45", name:"Sage"},
    {id:"lavender", color:"#5B44B0", name:"Lavender"},
    {id:"rose",     color:"#C0325A", name:"Rose"},
    {id:"slate",    color:"#3A4F7A", name:"Slate"},
    {id:"amber",    color:"#B87800", name:"Amber"},
    {id:"teal",     color:"#0F7070", name:"Teal"},
    {id:"sand",     color:"#8A6840", name:"Sand"},
    {id:"midnight", color:"#6B8FFF", name:"Midnight"},
    {id:"charcoal", color:"#A0AACC", name:"Charcoal"},
    {id:"forest",   color:"#4DB870", name:"Forest"},
    {id:"plum",     color:"#A87AE0", name:"Plum"},
    {id:"crimson",  color:"#E05050", name:"Crimson"},
    {id:"ocean",    color:"#3A8FD4", name:"Ocean"},
  ];

  var saved = localStorage.getItem("noty:login-theme") || "glacier";
  document.body.setAttribute("data-t", saved);

  var grid = document.getElementById("swatches");
  THEMES.forEach(function(th){
    var s = document.createElement("button");
    s.className = "swatch" + (th.id === saved ? " active" : "");
    s.style.background = th.color;
    s.title = th.name;
    s.setAttribute("aria-label", th.name + " theme");
    s.addEventListener("click", function(){
      document.body.setAttribute("data-t", th.id);
      localStorage.setItem("noty:login-theme", th.id);
      document.querySelectorAll(".swatch").forEach(function(el){ el.classList.remove("active"); });
      s.classList.add("active");
    });
    grid.appendChild(s);
  });
})();
</script>
</body></html>`;
}

app.get("/login", (c) => signInPage(c.env, safeNext(c.req.query("next"))));

// Local-only shortcut to try things before any sign-in is set up (DEV_LOGIN=1 and a localhost PUBLIC_URL).
app.get("/login/dev", async (c) => {
  if (!(c.env.DEV_LOGIN === "1" && isLocal(c.env))) return c.notFound();
  c.header("Set-Cookie", await sessionCookie(c.env, { uid: "dev-user", email: "dev@localhost", name: "Local tester" }));
  return c.redirect(safeNext(c.req.query("next")));
});

// ---------- admin password ----------

async function sameSecret(a: string, b: string) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

app.post("/login/password", async (c) => {
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.env.PUBLIC_URL).origin && origin !== new URL(c.req.url).origin) return c.text("Bad origin", 403);
  const form = await c.req.formData();
  const next = safeNext(String(form.get("next") ?? "/"));
  if (!passwordConfigured(c.env)) return signInPage(c.env, next, "Password sign-in isn't set up on this Noty.");

  // Slow down guessing: 8 wrong tries per 15 minutes from one address.
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  const key = `pwfail:${ip}`;
  const fails = Number((await c.env.OAUTH_KV.get(key)) ?? 0);
  if (fails >= 8) return signInPage(c.env, next, "Too many wrong passwords. Wait 15 minutes and try again.");

  if (!(await sameSecret(String(form.get("password") ?? ""), c.env.ADMIN_PASSWORD))) {
    await c.env.OAUTH_KV.put(key, String(fails + 1), { expirationTtl: 900 });
    return signInPage(c.env, next, "That password isn't right.");
  }
  await c.env.OAUTH_KV.delete(key);
  const email = list(c.env.OWNER_EMAIL)[0] ?? "owner";
  c.header("Set-Cookie", await sessionCookie(c.env, { uid: OWNER_UID, email, name: "Owner" }));
  return c.redirect(next);
});

// ---------- Google: sign in, or connect Drive to the account you're signed in to ----------

app.get("/login/google", async (c) => {
  if (!googleConfigured(c.env)) return signInPage(c.env, "/", "Google sign-in isn't set up on this Noty yet.");
  const next = safeNext(c.req.query("next"));
  // link=1: you're already signed in (e.g. with the password) and want your notebooks copied to this Google Drive.
  const session = c.req.query("link") === "1" ? await getSession(c.req.raw, c.env) : null;
  const state = randomToken();
  await c.env.OAUTH_KV.put(`login:${state}`, JSON.stringify({ next, linkUid: session?.uid }), { expirationTtl: 600 });
  c.header("Set-Cookie", stateCookie(c.env, state));
  return c.redirect(googleAuthUrl(c.env, state, c.req.query("consent") === "1" || Boolean(session)));
});

app.get("/auth/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const saved = state && (await c.env.OAUTH_KV.get<{ next: string; linkUid?: string }>(`login:${state}`, "json"));
  if (!saved || readCookie(c.req.raw, "noty_state") !== state)
    return page(c.env, "Sign-in expired", `<p>That sign-in link has expired or was opened in another browser.</p><p><a class="btn" href="/login">Sign in again</a></p>`, 400);
  await c.env.OAUTH_KV.delete(`login:${state}`);
  c.header("Set-Cookie", clearStateCookie(c.env), { append: true });
  const retry = (consent: boolean) => `/login/google?${consent ? "consent=1&" : ""}${saved.linkUid ? "link=1&" : ""}next=${encodeURIComponent(saved.next)}`;

  if (c.req.query("error"))
    return page(c.env, "Google sign-in cancelled", `<p>Nothing was changed.</p><p><a class="btn" href="${retry(false)}">Try again</a> <a class="btn quiet" href="/">Back to Noty</a></p>`, 400);

  const tokens = await exchangeCode(c.env, c.req.query("code") ?? "");
  if (!hasDriveScope(tokens.scope))
    return page(
      c.env,
      "Drive access needed",
      `<p>Noty keeps a copy of your notebooks in a <strong>Noty</strong> folder in your Google Drive. On the Google screen, tick the box that lets Noty see and edit the files it creates.</p><p><a class="btn" href="${retry(true)}">Try again</a></p>`,
      403,
    );
  const user = await fetchGoogleUser(tokens.access_token);

  // Connecting Drive to the account already signed in.
  let uid: string;
  if (saved.linkUid) {
    const session = await getSession(c.req.raw, c.env);
    if (!session || session.uid !== saved.linkUid) return page(c.env, "Sign in first", `<p>Sign in to Noty, then connect Google Drive.</p><p><a class="btn" href="/login">Sign in</a></p>`, 401);
    if (session.uid !== OWNER_UID && session.email.toLowerCase() !== user.email.toLowerCase())
      return page(c.env, "Different Google account", `<p>Choose ${esc(session.email)} on the Google screen.</p><p><a class="btn" href="${retry(false)}">Try again</a></p>`, 403);
    uid = session.uid;
  } else {
    if (!googleAllowed(c.env, user.email))
      return page(c.env, "Not allowed", `<p>${esc(user.email)} can't sign in to this Noty. The owner can add it to <code>OWNER_EMAIL</code> or <code>ALLOWED_EMAILS</code>.</p>`, 403);
    uid = isOwnerEmail(c.env, user.email) ? OWNER_UID : user.sub;
  }

  const { hasRefreshToken } = await vaultFor(c.env, uid).setGoogleAuth({
    email: user.email,
    name: user.name,
    picture: user.picture,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
  });
  // Google only issues a refresh token on its consent screen. Without one, notes an
  // assistant sends while you're away couldn't be copied to Drive, so ask once more.
  if (!hasRefreshToken) return c.redirect(retry(true));

  if (!saved.linkUid)
    c.header("Set-Cookie", await sessionCookie(c.env, { uid, email: user.email, name: uid === OWNER_UID ? "Owner" : user.name, picture: user.picture }), { append: true });
  return c.redirect(saved.next);
});

app.post("/logout", (c) => {
  c.header("Set-Cookie", clearSessionCookie(c.env));
  return c.redirect("/");
});

// ---------- MCP authorization: "Allow <assistant> to use Noty?" ----------

app.get("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    const session = await getSession(c.req.raw, c.env);
    const url = new URL(c.req.url);
    if (!session) return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);

    const details = await oauth.describeConsent(request);
    const remember = { secret: c.env.COOKIE_SECRET, subject: session.uid };
    if (await oauth.isConsentRemembered(c.req.raw, request, remember)) {
      const { redirectTo } = await oauth.completeAuthorization({
        request,
        userId: session.uid,
        metadata: { clientName: details.clientName },
        scope: request.scope.length ? request.scope : ["notes"],
        props: { userId: session.uid, email: session.email, clientName: details.clientName } satisfies AuthProps,
      });
      return c.redirect(redirectTo);
    }

    const consent = await oauth.beginConsent(request);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    const name = esc(details.clientName);
    const origin = details.clientDomain
      ? `Published by <strong>${esc(details.clientDomain)}</strong>.`
      : `This app named itself “${name}”; that name isn't verified.`;
    const body = `
      <p class="lede"><strong>${name}</strong> wants to add to and read your Noty notebooks, signed in as ${esc(session.email)}.</p>
      <p class="fine">${origin} Access goes to <strong>${esc(details.redirectHost)}</strong>.</p>
      ${details.redirectIsLoopback ? `<p class="warn">This sends access to a program on your computer. Continue only if you just connected Noty from it.</p>` : ""}
      <form method="post">
        <input type="hidden" name="handle" value="${esc(consent.handle)}">
        <div class="actions">
          <button class="btn" name="decision" value="approve">Allow</button>
          <button class="btn quiet" name="decision" value="deny">Don't allow</button>
        </div>
      </form>`;
    return new Response(shell(`Allow ${name}?`, `<h1>Allow ${name}?</h1>${body}`), { headers: consent.headers });
  } catch (e) {
    return authError(c.env, e);
  }
});

app.post("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const session = await getSession(c.req.raw, c.env);
    if (!session) return c.redirect("/login");
    const form = await c.req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(c.req.raw, handle, {
      scope: ["notes"],
      remember: { secret: c.env.COOKIE_SECRET, subject: session.uid },
    });
    const details = await oauth.describeConsent(approved.request);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: session.uid,
      metadata: { clientName: details.clientName },
      scope: approved.request.scope,
      props: { userId: session.uid, email: session.email, clientName: details.clientName } satisfies AuthProps,
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    return authError(c.env, e);
  }
});

function authError(env: Env, e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
  if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
    const msg = e instanceof AuthorizationError ? e.description : "This app could not be verified.";
    return page(env, "Can't connect", `<p>${esc(msg ?? "This connection request isn't valid.")}</p><p>Start connecting again from your assistant.</p>`, 400);
  }
  throw e;
}

// ---------- Web API (session cookie) ----------

const api = new Hono<Ctx>();

api.use("*", async (c, next) => {
  const s = await getSession(c.req.raw, c.env);
  if (!s) return c.json({ error: "signed_out" }, 401);
  // Reject cross-site writes: the session cookie is SameSite=Lax, and this blocks the rest.
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.env.PUBLIC_URL).origin && origin !== new URL(c.req.url).origin)
      return c.json({ error: "bad_origin" }, 403);
  }
  c.set("session", s);
  await next();
});

api.onError((e, c) => {
  if (e instanceof NeedsSignInError || (e as Error).message?.includes("sign in")) return c.json({ error: "needs_google", message: (e as Error).message }, 401);
  console.error(e);
  return c.json({ error: "server", message: (e as Error).message }, 500);
});

api.get("/me", async (c) => {
  const s = c.get("session");
  const drive = await vaultFor(c.env, s.uid).driveStatus();
  return c.json({ email: s.email, name: s.name, picture: s.picture, mcpUrl: `${c.env.PUBLIC_URL}/mcp`, drive, googleAvailable: googleConfigured(c.env) });
});

api.get("/notebooks", async (c) => c.json(await vaultFor(c.env, c.get("session").uid).listNotebooks()));

api.post("/notebooks", async (c) => {
  const { name, topic } = await c.req.json<{ name: string; topic?: string }>();
  return c.json(await vaultFor(c.env, c.get("session").uid).createNotebook(String(name ?? ""), typeof topic === "string" ? topic : undefined));
});

api.get("/topics", async (c) => c.json(await vaultFor(c.env, c.get("session").uid).topics()));

api.get("/notebooks/:id", async (c) => {
  const nb = await vaultFor(c.env, c.get("session").uid).getNotebookWithInk(c.req.param("id"));
  return nb ? c.json(nb) : c.json({ error: "not_found" }, 404);
});

api.put("/notebooks/:id", async (c) => {
  const body = await c.req.json<{ upserts: Block[]; deletes: string[]; order: string[]; baseVersion: number; clientId: string }>();
  if (!Array.isArray(body.upserts) || !Array.isArray(body.deletes) || !Array.isArray(body.order)) return c.json({ error: "bad_request" }, 400);
  const r = await vaultFor(c.env, c.get("session").uid).applyPatch(
    c.req.param("id"),
    { upserts: body.upserts, deletes: body.deletes.map(String), order: body.order.map(String), baseVersion: Number(body.baseVersion) || 0 },
    String(body.clientId ?? ""),
  );
  return r ? c.json(r) : c.json({ error: "not_found" }, 404);
});

// Handwriting: fetched per block as it scrolls into view, saved a few strokes at a time.
api.get("/notebooks/:id/ink", async (c) => {
  const anchors = (c.req.query("anchors") ?? "").split(",").filter(Boolean).slice(0, 200);
  return c.json(await vaultFor(c.env, c.get("session").uid).getInk(c.req.param("id"), anchors));
});

api.post("/notebooks/:id/ink", async (c) => {
  const body = await c.req.json<{ add?: { anchor: string; stroke: InkStroke }[]; remove?: { anchor: string; id: string }[]; clientId?: string }>();
  const add = (body.add ?? []).slice(0, 500).filter((a) => a && typeof a.anchor === "string" && a.stroke && typeof a.stroke.id === "string" && typeof a.stroke.d === "string" && a.stroke.d.length < 200_000);
  const remove = (body.remove ?? []).slice(0, 2000).filter((r) => r && typeof r.anchor === "string" && typeof r.id === "string");
  const clean = add.map(({ anchor, stroke }) => ({
    anchor: anchor.slice(0, 64),
    stroke: { id: stroke.id.slice(0, 64), c: String(stroke.c ?? "ink").slice(0, 16), s: Math.min(64, Math.max(1, Number(stroke.s) || 6)), ...(stroke.t === "h" ? { t: "h" as const } : {}), d: stroke.d },
  }));
  const ok = await vaultFor(c.env, c.get("session").uid).applyInk(c.req.param("id"), clean, remove, String(body.clientId ?? ""));
  return ok ? c.json({ ok }) : c.json({ error: "not_found" }, 404);
});

api.patch("/notebooks/:id", async (c) => {
  const body = await c.req.json<{ name?: string; icon?: string; cover?: string; favorite?: boolean; topic?: string; font?: string }>();
  const r = await vaultFor(c.env, c.get("session").uid).updateNotebook(c.req.param("id"), {
    topic: typeof body.topic === "string" ? body.topic : undefined,
    name: typeof body.name === "string" ? body.name : undefined,
    icon: typeof body.icon === "string" ? body.icon : undefined,
    cover: typeof body.cover === "string" ? body.cover : undefined,
    favorite: typeof body.favorite === "boolean" ? body.favorite : undefined,
    font: typeof body.font === "string" ? body.font : undefined,
  });
  return r ? c.json(r) : c.json({ error: "not_found" }, 404);
});

// Trash, page history, backlinks
api.get("/trash", async (c) => c.json(await vaultFor(c.env, c.get("session").uid).listTrash()));
api.post("/trash/:id/restore", async (c) => {
  const r = await vaultFor(c.env, c.get("session").uid).restoreNotebook(c.req.param("id"));
  return r ? c.json(r) : c.json({ error: "not_found" }, 404);
});
api.delete("/trash/:id", async (c) => c.json({ ok: await vaultFor(c.env, c.get("session").uid).purgeNotebook(c.req.param("id")) }));
api.get("/notebooks/:id/history", async (c) => c.json(await vaultFor(c.env, c.get("session").uid).listHistory(c.req.param("id"))));
api.get("/notebooks/:id/history/:ts", async (c) => {
  const b = await vaultFor(c.env, c.get("session").uid).getSnapshot(c.req.param("id"), Number(c.req.param("ts")));
  return b ? c.json({ blocks: b }) : c.json({ error: "not_found" }, 404);
});
api.post("/notebooks/:id/history/:ts/restore", async (c) => {
  const r = await vaultFor(c.env, c.get("session").uid).restoreSnapshot(c.req.param("id"), Number(c.req.param("ts")));
  return r ? c.json(r) : c.json({ error: "not_found" }, 404);
});
api.get("/notebooks/:id/backlinks", async (c) => c.json(await vaultFor(c.env, c.get("session").uid).backlinks(c.req.param("id"))));

api.delete("/notebooks/:id", async (c) => c.json({ ok: await vaultFor(c.env, c.get("session").uid).deleteNotebook(c.req.param("id")) }));

api.get("/notebooks/:id/live", async (c) => {
  const url = new URL("https://vault/ws");
  url.searchParams.set("nb", c.req.param("id"));
  return vaultFor(c.env, c.get("session").uid).fetch(new Request(url, c.req.raw));
});

api.get("/search", async (c) => c.json(await vaultFor(c.env, c.get("session").uid).search(c.req.query("q") ?? "", { includePdfs: true })));

api.post("/upload", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "no_file" }, 400);
  if (file.size > 10 * 1024 * 1024) return c.json({ error: "too_large", message: "Files must be 10 MB or smaller." }, 413);
  const url = await vaultFor(c.env, c.get("session").uid).uploadImage(await file.arrayBuffer(), file.type || "application/octet-stream", file.name);
  return c.json({ url });
});

api.get("/files/:fileId", async (c) =>
  vaultFor(c.env, c.get("session").uid).fetch(new Request(`https://vault/file/${encodeURIComponent(c.req.param("fileId"))}`)),
);

// ---------- PDFs (yours only; not offered to assistants) ----------

api.get("/pdfs", async (c) => c.json(await vaultFor(c.env, c.get("session").uid).listPdfs()));

api.post("/pdfs", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "no_file" }, 400);
  if (file.size > 25 * 1024 * 1024) return c.json({ error: "too_large", message: "PDFs must be 25 MB or smaller." }, 413);
  const r = await vaultFor(c.env, c.get("session").uid).uploadPdf(file.name, await file.arrayBuffer());
  return "error" in r ? c.json({ error: "bad_pdf", message: r.error }, 400) : c.json(r);
});

api.get("/pdfs/:id", async (c) => {
  const r = await vaultFor(c.env, c.get("session").uid).getPdf(c.req.param("id"));
  return r ? c.json(r) : c.json({ error: "not_found" }, 404);
});

api.get("/pdfs/:id/file", async (c) => vaultFor(c.env, c.get("session").uid).fetch(new Request(`https://vault/pdf/${encodeURIComponent(c.req.param("id"))}`)));

api.put("/pdfs/:id/thumb", async (c) => {
  const buf = await c.req.arrayBuffer();
  const pages = Number(c.req.query("pages")) || undefined;
  const ok = await vaultFor(c.env, c.get("session").uid).setPdfThumb(c.req.param("id"), buf, pages);
  return ok ? c.json({ ok }) : c.json({ error: "bad_thumb" }, 400);
});

api.get("/pdfs/:id/thumb", async (c) => {
  const img = await vaultFor(c.env, c.get("session").uid).getPdfThumb(c.req.param("id"));
  return img ? new Response(img, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } }) : c.json({ error: "not_found" }, 404);
});

api.put("/pdfs/:id/text", async (c) => {
  const { pages } = await c.req.json<{ pages: string[] }>();
  if (!Array.isArray(pages)) return c.json({ error: "bad_request" }, 400);
  const ok = await vaultFor(c.env, c.get("session").uid).setPdfText(c.req.param("id"), pages);
  return ok ? c.json({ ok }) : c.json({ error: "not_found" }, 404);
});

api.put("/pdfs/:id/boxes", async (c) => {
  const { boxes, clientId } = await c.req.json<{ boxes: PdfBox[]; clientId: string }>();
  if (!Array.isArray(boxes)) return c.json({ error: "bad_request" }, 400);
  const ok = await vaultFor(c.env, c.get("session").uid).saveBoxes(c.req.param("id"), boxes, String(clientId ?? ""));
  return ok ? c.json({ ok }) : c.json({ error: "not_found" }, 404);
});

api.patch("/pdfs/:id", async (c) => {
  const { name, topic } = await c.req.json<{ name?: string; topic?: string }>();
  const r = await vaultFor(c.env, c.get("session").uid).updatePdf(c.req.param("id"), {
    name: typeof name === "string" ? name : undefined,
    topic: typeof topic === "string" ? topic : undefined,
  });
  return r ? c.json(r) : c.json({ error: "not_found" }, 404);
});

api.delete("/pdfs/:id", async (c) => c.json({ ok: await vaultFor(c.env, c.get("session").uid).deletePdf(c.req.param("id")) }));

api.get("/pdfs/:id/live", async (c) => {
  const url = new URL("https://vault/ws");
  url.searchParams.set("nb", c.req.param("id"));
  return vaultFor(c.env, c.get("session").uid).fetch(new Request(url, c.req.raw));
});

app.route("/api", api);

// Everything else is the web app (single-page).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// ---------- small server-rendered pages (sign-in errors, consent) ----------

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function shell(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Noty</title><link rel="icon" href="/favicon.svg">
<script>try{var t=localStorage.getItem("noty:theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--paper:#F3F5F7;--sheet:#FFFFFF;--ink:#1D2433;--pencil:#626B7F;--rule:#D9DEE6;--pen:#2050C0;--hi:#FFE15A}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--paper:#12151B;--sheet:#1A1E26;--ink:#E5E8EE;--pencil:#959DAE;--rule:#2C323D;--pen:#86A6FF;--hi:#5C4C10}}
:root[data-theme=dark]{--paper:#12151B;--sheet:#1A1E26;--ink:#E5E8EE;--pencil:#959DAE;--rule:#2C323D;--pen:#86A6FF;--hi:#5C4C10;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:16px/1.55 "Schibsted Grotesk",system-ui,sans-serif;padding:16px}
main{background:var(--sheet);border:1px solid var(--rule);border-left:4px solid var(--pen);border-radius:6px;max-width:30rem;width:100%;padding:28px 28px 24px}
h1{font-size:1.5rem;line-height:1.2;margin:0 0 12px}.lede{margin:0 0 10px}.fine{color:var(--pencil);font-size:.9rem;margin:0 0 16px}
.warn{background:var(--hi);color:var(--ink);padding:8px 10px;border-radius:4px;font-size:.92rem}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.btn{font:inherit;font-weight:600;border:0;border-radius:6px;padding:10px 18px;background:var(--pen);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
.btn.quiet{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1px var(--rule)}.btn:focus-visible{outline:3px solid var(--hi);outline-offset:2px}
code{font-size:.9em}
.mark{font-size:2.2rem;letter-spacing:-.03em;padding-left:12px;border-left:4px solid var(--pen);margin-bottom:14px}
.pw{display:grid;gap:8px;margin:18px 0 4px}.pw label{font-weight:600;font-size:.9rem}
.pw input{font:inherit;padding:10px 12px;border:1px solid var(--rule);border-radius:6px;background:var(--paper);color:var(--ink)}
.pw .btn{justify-self:start;margin-top:4px}.or{color:var(--pencil);font-size:.9rem;margin:14px 0 6px}
</style></head><body><main>${inner}</main></body></html>`;
}

function page(_env: Env, title: string, inner: string, status = 200): Response {
  return new Response(shell(title, `<h1>${esc(title)}</h1>${inner}`), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" },
  });
}

// ---------- OAuth provider wraps everything ----------

export default new OAuthProvider<AppEnv>({
  apiRoute: "/mcp",
  apiHandler: { fetch: (req: Request, env: AppEnv, ctx: ExecutionContext) => mcpHandler(req, env, ctx) },
  defaultHandler: { fetch: (req: Request, env: AppEnv, ctx: ExecutionContext) => app.fetch(req, env, ctx) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ["notes"],
  requiredScopes: ["notes"],
  resourceMetadata: { resource: `${workerEnv.PUBLIC_URL}/mcp` },
});
