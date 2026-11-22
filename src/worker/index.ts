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
    <p class="lede">Your notebook that you and your AI assistants write in together.</p>
    ${error ? `<p class="warn" role="alert">${esc(error)}</p>` : ""}
    ${
      pw
        ? `<form method="post" action="/login/password" class="pw">
        <input type="hidden" name="next" value="${esc(next)}">
        <label for="pw">Owner password</label>
        <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
        <button class="btn" type="submit">Sign in</button>
      </form>`
        : ""
    }
    ${pw && google ? `<div class="or"><span>or</span></div>` : ""}
    ${google ? `<a class="btn-google" href="/login/google?next=${nextQ}"><svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>Continue with Google</a>` : ""}
    ${google && openSignups(env) ? `<p class="fine">New here? Continuing with Google creates your own private notebooks. Nobody else can see them.</p>` : ""}
    ${dev ? `<a class="btn-dev" href="/login/dev?next=${nextQ}">🧪 Local test sign-in</a>` : ""}
    ${!pw && !google && !dev ? `<p class="setup-msg">⚙️ No sign-in method is set up yet.<br>Set <code>ADMIN_PASSWORD</code> (10+ chars) or the Google keys, then deploy again.</p>` : ""}`;
  return new Response(loginShell(error, body), {
    status: error ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Cache-Control": "no-store" },
  });
}

function loginShell(error: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Noty</title><link rel="icon" href="/favicon.svg">
<script>try{var t=localStorage.getItem("noty:theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
<style>
:root{--paper:#F0F2F7;--sheet:#FFFFFF;--ink:#1D2433;--pencil:#626B7F;--rule:#D9DEE6;--pen:#2050C0;--pen2:#4F7FFF;--hi:#FFE15A;--cat:#1D2433}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--paper:#0D0F14;--sheet:#161920;--ink:#E5E8EE;--pencil:#959DAE;--rule:#2C323D;--pen:#86A6FF;--pen2:#6B8FFF;--hi:#5C4C10;--cat:#E5E8EE}}
:root[data-theme=dark]{--paper:#0D0F14;--sheet:#161920;--ink:#E5E8EE;--pencil:#959DAE;--rule:#2C323D;--pen:#86A6FF;--pen2:#6B8FFF;--hi:#5C4C10;--cat:#E5E8EE;color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:16px/1.6 "Schibsted Grotesk",system-ui,sans-serif;padding:16px;overflow-x:hidden}

/* animated bg dots */
body::before{content:"";position:fixed;inset:0;background-image:radial-gradient(var(--rule) 1px,transparent 1px);background-size:28px 28px;opacity:.6;pointer-events:none;z-index:0}

.card{position:relative;z-index:1;background:var(--sheet);border-radius:20px;max-width:26rem;width:100%;padding:40px 36px 36px;box-shadow:0 4px 6px -1px rgba(0,0,0,.07),0 20px 60px -10px rgba(32,80,192,.12);border:1px solid var(--rule)}

/* logo */
.logo{display:flex;align-items:center;gap:12px;margin-bottom:28px}
.logo-icon{width:44px;height:44px;background:var(--pen);border-radius:12px;display:grid;place-items:center;flex-shrink:0}
.logo-icon svg{color:#fff}
.logo-name{font-size:1.8rem;font-weight:700;letter-spacing:-.04em;line-height:1}
.logo-tag{font-size:.78rem;color:var(--pencil);letter-spacing:.02em;margin-top:2px}

/* tagline */
.lede{color:var(--pencil);font-size:.95rem;margin-bottom:28px;line-height:1.5}

/* error */
.warn{background:var(--hi);color:#1a1200;padding:10px 14px;border-radius:10px;font-size:.88rem;margin-bottom:18px;display:flex;align-items:center;gap:8px}

/* password form */
.pw{display:grid;gap:10px;margin-bottom:16px}
.pw label{font-weight:600;font-size:.85rem;color:var(--pencil);letter-spacing:.03em;text-transform:uppercase}
.pw input{font:inherit;padding:12px 14px;border:1.5px solid var(--rule);border-radius:10px;background:var(--paper);color:var(--ink);transition:border-color .15s,box-shadow .15s;font-size:.95rem}
.pw input:focus{outline:none;border-color:var(--pen);box-shadow:0 0 0 3px rgba(32,80,192,.12)}
.btn{font:inherit;font-weight:700;border:none;border-radius:10px;padding:12px 22px;background:linear-gradient(135deg,var(--pen),var(--pen2));color:#fff;cursor:pointer;font-size:.95rem;width:100%;transition:opacity .15s,transform .1s;letter-spacing:.01em}
.btn:hover{opacity:.9}
.btn:active{transform:scale(.98)}

/* or divider */
.or{display:flex;align-items:center;gap:12px;margin:20px 0;color:var(--pencil);font-size:.85rem}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--rule)}

/* google btn */
.btn-google{display:flex;align-items:center;justify-content:center;gap:10px;font:inherit;font-weight:600;font-size:.95rem;border:1.5px solid var(--rule);border-radius:10px;padding:11px 20px;background:var(--sheet);color:var(--ink);cursor:pointer;text-decoration:none;transition:border-color .15s,box-shadow .15s,background .15s;width:100%}
.btn-google:hover{border-color:var(--pen);box-shadow:0 2px 12px rgba(32,80,192,.1);background:var(--paper)}

/* dev btn */
.btn-dev{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:.85rem;color:var(--pencil);background:transparent;border:1px dashed var(--rule);border-radius:8px;padding:8px 14px;cursor:pointer;text-decoration:none;margin-top:14px;transition:color .15s;width:100%;justify-content:center}
.btn-dev:hover{color:var(--ink);border-color:var(--pencil)}

.fine{color:var(--pencil);font-size:.82rem;margin-top:12px;line-height:1.5;text-align:center}
.setup-msg{color:var(--pencil);font-size:.88rem;padding:14px;background:var(--paper);border-radius:10px;text-align:center;line-height:1.6}
.setup-msg code{font-size:.85em;background:var(--rule);padding:1px 5px;border-radius:4px}

/* ---- CAT ---- */
#noty-cat{position:fixed;pointer-events:none;z-index:9999;width:60px;height:60px;transform:translate(-50%,-80%);transition:left .08s cubic-bezier(.17,.67,.35,1.2),top .08s cubic-bezier(.17,.67,.35,1.2);font-size:52px;line-height:1;user-select:none;filter:drop-shadow(0 2px 4px rgba(0,0,0,.2));will-change:left,top}
#noty-cat .body{position:relative;display:inline-block;animation:catBob 1.2s ease-in-out infinite}
#noty-cat .eyes{position:absolute;top:28px;left:50%;transform:translateX(-50%);display:flex;gap:4px;font-size:12px;line-height:1}
#noty-cat .paw{position:absolute;bottom:-4px;left:50%;transform:translateX(-50%);font-size:14px;animation:pawWave .6s ease-in-out infinite alternate}
@keyframes catBob{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-6px) rotate(3deg)}}
@keyframes pawWave{from{transform:translateX(-50%) rotate(-20deg)}to{transform:translateX(-50%) rotate(20deg)}}
</style>
</head>
<body>

<!-- cursor cat -->
<div id="noty-cat" aria-hidden="true">
  <div class="body">🐱
    <div class="paw">🐾</div>
  </div>
</div>

<div class="card">
  <div class="logo">
    <div class="logo-icon">
      <svg width="24" height="24" fill="none" viewBox="0 0 24 24"><path d="M4 4h16v2H4V4zm0 4h10v2H4V8zm0 4h16v2H4v-2zm0 4h10v2H4v-2z" fill="currentColor"/></svg>
    </div>
    <div>
      <div class="logo-name">Noty</div>
      <div class="logo-tag">AI-powered notebooks</div>
    </div>
  </div>
  <p class="lede">Your notebook — write together with your AI assistants in real time.</p>
  ${error ? `<div class="warn" role="alert">⚠️ ${esc(error)}</div>` : ""}
  ${body}
</div>

<script>
(function(){
  var cat = document.getElementById('noty-cat');
  var mx = window.innerWidth/2, my = window.innerHeight/2;
  var cx = mx, cy = my;
  var frames = ['🐱','😺','😸','🐱','😹'];
  var fi = 0, idle = null;
  var CATS = ['🐱','😺','😸','😻','🙀','😾'];

  document.addEventListener('mousemove', function(e){
    mx = e.clientX; my = e.clientY;
    clearTimeout(idle);
    idle = setTimeout(function(){
      // fall asleep when idle
      cat.querySelector('.body').textContent = '😴';
      cat.querySelector('.body').appendChild(cat.querySelector('.paw'));
    }, 3000);
  });

  // wiggle face on click
  document.addEventListener('click', function(){
    var bodyEl = cat.querySelector('.body');
    var old = bodyEl.firstChild.nodeValue || bodyEl.textContent.trim()[0];
    bodyEl.childNodes[0].nodeValue = '🙀';
    setTimeout(function(){ bodyEl.childNodes[0].nodeValue = '😸'; }, 300);
    setTimeout(function(){ bodyEl.childNodes[0].nodeValue = '🐱'; }, 700);
  });

  // lazy follow with spring/lag
  function loop(){
    var dx = mx - cx, dy = my - cy;
    cx += dx * 0.12;
    cy += dy * 0.12;
    cat.style.left = cx + 'px';
    cat.style.top  = cy + 'px';

    // face direction
    var body = cat.querySelector('.body');
    if(dx > 8) body.style.transform = 'scaleX(1)';
    else if(dx < -8) body.style.transform = 'scaleX(-1)';

    // speed-based expression
    var speed = Math.sqrt(dx*dx+dy*dy);
    var bodyText = body.firstChild.nodeValue || '';
    if(speed > 60) body.firstChild.nodeValue = '🏃';
    else if(speed > 20) body.firstChild.nodeValue = '😺';
    else body.firstChild.nodeValue = '🐱';

    requestAnimationFrame(loop);
  }
  cat.style.left = cx+'px';
  cat.style.top  = cy+'px';
  loop();
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
