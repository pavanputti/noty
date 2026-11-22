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
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* ── BASE RESET ── */
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100vh}
body{
  display:flex;
  align-items:center;
  justify-content:center;
  font:15px/1.6 "Plus Jakarta Sans",system-ui,-apple-system,sans-serif;
  padding:24px 16px;
  background-color:var(--bg);
  background-image:var(--pattern);
  background-size:var(--pat-size,auto);
  background-position:center;
  color:var(--ink);
  transition:background-color .4s cubic-bezier(.16,1,.3,1),color .3s ease;
  position:relative;
}

/* ── 16 PATTERN THEMES (LIGHT & DARK ARCHITECTURAL & TEXTURAL PATTERNS) ── */

/* 1. Blueprint (Architectural precision drafting) */
[data-t="blueprint"]{
  --bg:#0A1B38;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'%3E%3Cpath d='M0 40V0h40' fill='none' stroke='%233B82F6' stroke-width='1' stroke-opacity='0.22'/%3E%3Cpath d='M0 10h40M0 20h40M0 30h40M10 0v40M20 0v40M30 0v40' fill='none' stroke='%2360A5FA' stroke-width='0.5' stroke-opacity='0.1'/%3E%3C/svg%3E");
  --pat-size:40px 40px;
  --card:rgba(12, 28, 58, 0.84);
  --border:rgba(96, 165, 250, 0.28);
  --ink:#F0F6FF;
  --muted:#93C5FD;
  --accent:#3B82F6;
  --ring:rgba(59, 130, 246, 0.3);
  --card-shadow:0 24px 50px -12px rgba(2, 10, 25, 0.65);
  color-scheme:dark;
}

/* 2. Graph Paper (Engineering & mathematical notebooks) */
[data-t="graph"]{
  --bg:#F8FAF9;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M0 24V0h24' fill='none' stroke='%232563EB' stroke-width='0.75' stroke-opacity='0.14'/%3E%3C/svg%3E");
  --pat-size:24px 24px;
  --card:rgba(255, 255, 255, 0.94);
  --border:#DDE3EA;
  --ink:#142033;
  --muted:#57677D;
  --accent:#2563EB;
  --ring:rgba(37, 99, 235, 0.18);
  --card-shadow:0 20px 45px -10px rgba(37, 99, 235, 0.1);
  color-scheme:light;
}

/* 3. Bullet Journal (Warm dot-matrix stationery) */
[data-t="dots"]{
  --bg:#F5F3EF;
  --pattern:radial-gradient(circle, #786C5E 1.25px, transparent 1.25px);
  --pat-size:20px 20px;
  --card:rgba(255, 255, 255, 0.95);
  --border:#E5E0D8;
  --ink:#28231D;
  --muted:#7A7065;
  --accent:#855836;
  --ring:rgba(133, 88, 54, 0.18);
  --card-shadow:0 20px 45px -10px rgba(70, 50, 30, 0.08);
  color-scheme:light;
}

/* 4. Ruled Legal Pad (Classic lined paper with margin) */
[data-t="notebook"]{
  --bg:#FAF9F5;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100%25' height='28'%3E%3Cline x1='0' y1='27' x2='100%25' y2='27' stroke='%233B82F6' stroke-width='0.75' stroke-opacity='0.18'/%3E%3C/svg%3E");
  --pat-size:100% 28px;
  --card:rgba(255, 255, 255, 0.96);
  --border:#E8E4DA;
  --ink:#1F242E;
  --muted:#667085;
  --accent:#1D4ED8;
  --ring:rgba(29, 78, 216, 0.16);
  --card-shadow:0 20px 45px -10px rgba(0, 0, 0, 0.06);
  color-scheme:light;
}

/* 5. Topography (Alpine contour elevation maps) */
[data-t="topo"]{
  --bg:#0F241C;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Cpath d='M0 20 Q20 5 40 20 T80 20M0 40 Q25 15 50 40 T80 40M0 60 Q20 45 40 60 T80 60M0 80 Q30 55 60 80 T80 80' fill='none' stroke='%2334D399' stroke-width='1' stroke-opacity='0.22'/%3E%3C/svg%3E");
  --pat-size:80px 80px;
  --card:rgba(18, 42, 33, 0.86);
  --border:rgba(52, 211, 153, 0.28);
  --ink:#ECFDF5;
  --muted:#A7F3D0;
  --accent:#10B981;
  --ring:rgba(16, 185, 129, 0.3);
  --card-shadow:0 24px 50px -12px rgba(5, 20, 14, 0.7);
  color-scheme:dark;
}

/* 6. Seigaiha Waves (Zen Japanese fan ripples) */
[data-t="waves"]{
  --bg:#EDF4F5;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='24' viewBox='0 0 48 24'%3E%3Cpath d='M0 24 A24 24 0 0 1 48 24 M6 24 A18 18 0 0 1 42 24 M12 24 A12 12 0 0 1 36 24 M18 24 A6 6 0 0 1 30 24' fill='none' stroke='%230E7490' stroke-width='1' stroke-opacity='0.16'/%3E%3Cpath d='M24 12 A24 24 0 0 1 72 12 M-24 12 A24 24 0 0 1 24 12' fill='none' stroke='%230E7490' stroke-width='1' stroke-opacity='0.16'/%3E%3C/svg%3E");
  --pat-size:48px 24px;
  --card:rgba(255, 255, 255, 0.94);
  --border:#CFE0E5;
  --ink:#112E38;
  --muted:#496F7B;
  --accent:#0891B2;
  --ring:rgba(8, 145, 178, 0.18);
  --card-shadow:0 20px 45px -10px rgba(8, 145, 178, 0.12);
  color-scheme:light;
}

/* 7. Isometric Cubes (3D spatial geometry) */
[data-t="isometric"]{
  --bg:#121620;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='97' viewBox='0 0 56 97'%3E%3Cg fill='none' stroke='%23818CF8' stroke-width='0.8' stroke-opacity='0.2'%3E%3Cpath d='M28 0L0 16.2v32.3L28 64.8l28-16.3V16.2L28 0z'/%3E%3Cpath d='M28 0v32.4L0 48.5M28 32.4l28 16.1'/%3E%3Cpath d='M28 64.8v32.2L0 80.8M28 97l28-16.2V48.5'/%3E%3C/g%3E%3C/svg%3E");
  --pat-size:56px 97px;
  --card:rgba(22, 28, 42, 0.86);
  --border:rgba(129, 140, 248, 0.28);
  --ink:#EEF2FF;
  --muted:#A5B4FC;
  --accent:#6366F1;
  --ring:rgba(99, 102, 241, 0.3);
  --card-shadow:0 24px 50px -12px rgba(8, 11, 18, 0.7);
  color-scheme:dark;
}

/* 8. Art Deco Trellis (Vintage geometric diamonds) */
[data-t="artdeco"]{
  --bg:#201714;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36' viewBox='0 0 36 36'%3E%3Cpath d='M18 0 L36 18 L18 36 L0 18 Z' fill='none' stroke='%23F59E0B' stroke-width='1' stroke-opacity='0.22'/%3E%3Ccircle cx='18' cy='18' r='3' fill='%23F59E0B' fill-opacity='0.2'/%3E%3C/svg%3E");
  --pat-size:36px 36px;
  --card:rgba(38, 28, 24, 0.88);
  --border:rgba(245, 158, 11, 0.26);
  --ink:#FFFBEB;
  --muted:#FDE68A;
  --accent:#D97706;
  --ring:rgba(217, 119, 6, 0.3);
  --card-shadow:0 24px 50px -12px rgba(18, 10, 8, 0.7);
  color-scheme:dark;
}

/* 9. Constellation (Celestial night & stars) */
[data-t="cosmos"]{
  --bg:#0A0C16;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100' viewBox='0 0 100 100'%3E%3Cg fill='%2393C5FD' fill-opacity='0.7'%3E%3Ccircle cx='15' cy='20' r='1.5'/%3E%3Ccircle cx='48' cy='12' r='1'/%3E%3Ccircle cx='80' cy='35' r='1.5'/%3E%3Ccircle cx='35' cy='65' r='1'/%3E%3Ccircle cx='70' cy='82' r='2'/%3E%3Ccircle cx='92' cy='75' r='1'/%3E%3C/g%3E%3Cpath d='M15 20L48 12M80 35L70 82L92 75' stroke='%2360A5FA' stroke-width='0.6' stroke-opacity='0.2' fill='none'/%3E%3C/svg%3E");
  --pat-size:100px 100px;
  --card:rgba(16, 20, 36, 0.86);
  --border:rgba(147, 197, 253, 0.24);
  --ink:#F8FAFC;
  --muted:#94A3B8;
  --accent:#38BDF8;
  --ring:rgba(56, 189, 248, 0.3);
  --card-shadow:0 24px 50px -12px rgba(3, 4, 10, 0.8);
  color-scheme:dark;
}

/* 10. Honeycomb (Biomimetic hexagonal cells) */
[data-t="honeycomb"]{
  --bg:#1A140B;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='42' height='72' viewBox='0 0 42 72'%3E%3Cpath d='M0 12 L21 0 L42 12 L42 36 L21 48 L0 36 Z M0 48 L21 36 L42 48 L42 72 L21 84 L0 72 Z' fill='none' stroke='%23EAB308' stroke-width='0.8' stroke-opacity='0.22'/%3E%3C/svg%3E");
  --pat-size:42px 72px;
  --card:rgba(34, 26, 15, 0.88);
  --border:rgba(234, 179, 8, 0.28);
  --ink:#FEFCE8;
  --muted:#FEF08A;
  --accent:#CA8A04;
  --ring:rgba(202, 138, 4, 0.3);
  --card-shadow:0 24px 50px -12px rgba(12, 8, 4, 0.7);
  color-scheme:dark;
}

/* 11. Circuit Matrix (Cybernetic microtraces) */
[data-t="circuit"]{
  --bg:#071613;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60' viewBox='0 0 60 60'%3E%3Cpath d='M0 30h20l10-10h30M20 30l10 10h15M45 40v15M30 0v10M0 50h15l5 5' fill='none' stroke='%232DD4BF' stroke-width='1' stroke-opacity='0.22'/%3E%3Ccircle cx='30' cy='10' r='2' fill='%232DD4BF' fill-opacity='0.3'/%3E%3Ccircle cx='45' cy='55' r='2' fill='%232DD4BF' fill-opacity='0.3'/%3E%3C/svg%3E");
  --pat-size:60px 60px;
  --card:rgba(10, 30, 26, 0.86);
  --border:rgba(45, 212, 191, 0.28);
  --ink:#F0FDFA;
  --muted:#99F6E4;
  --accent:#14B8A6;
  --ring:rgba(20, 184, 166, 0.3);
  --card-shadow:0 24px 50px -12px rgba(2, 12, 10, 0.75);
  color-scheme:dark;
}

/* 12. Herringbone (Refined diagonal textile weave) */
[data-t="herringbone"]{
  --bg:#EEF1F6;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'%3E%3Cpath d='M0 10 L20 0 L40 10 M0 30 L20 20 L40 30 M20 20 v20 M20 0 v20' fill='none' stroke='%23475569' stroke-width='0.9' stroke-opacity='0.15'/%3E%3C/svg%3E");
  --pat-size:40px 40px;
  --card:rgba(255, 255, 255, 0.94);
  --border:#D4DBE5;
  --ink:#1E293B;
  --muted:#5A6B82;
  --accent:#334155;
  --ring:rgba(51, 65, 85, 0.18);
  --card-shadow:0 20px 45px -10px rgba(51, 65, 85, 0.1);
  color-scheme:light;
}

/* 13. Arabesque Lattice (Moroccan geometry) */
[data-t="moroccan"]{
  --bg:#1A1126;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'%3E%3Cpath d='M24 0 C16 12 16 12 0 24 C16 36 16 36 24 48 C32 36 32 36 48 24 C32 12 32 12 24 0 Z' fill='none' stroke='%23C084FC' stroke-width='0.9' stroke-opacity='0.22'/%3E%3C/svg%3E");
  --pat-size:48px 48px;
  --card:rgba(34, 22, 50, 0.86);
  --border:rgba(192, 132, 252, 0.28);
  --ink:#FAF5FF;
  --muted:#E9D5FF;
  --accent:#A855F7;
  --ring:rgba(168, 85, 247, 0.3);
  --card-shadow:0 24px 50px -12px rgba(12, 6, 20, 0.7);
  color-scheme:dark;
}

/* 14. Terrazzo (Scandinavian flecked stone) */
[data-t="terrazzo"]{
  --bg:#F4EFEB;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60' viewBox='0 0 60 60'%3E%3Cpath d='M10 12 L14 10 L12 16 Z' fill='%23C27856' fill-opacity='0.28'/%3E%3Cpath d='M45 15 L50 18 L48 22 L42 20 Z' fill='%234F7061' fill-opacity='0.25'/%3E%3Cpath d='M25 40 L30 38 L32 44 L26 45 Z' fill='%23384558' fill-opacity='0.24'/%3E%3Ccircle cx='18' cy='48' r='2' fill='%23C27856' fill-opacity='0.28'/%3E%3Ccircle cx='52' cy='48' r='2.5' fill='%23B88746' fill-opacity='0.28'/%3E%3C/svg%3E");
  --pat-size:60px 60px;
  --card:rgba(255, 255, 255, 0.94);
  --border:#E5DED5;
  --ink:#2C241E;
  --muted:#736458;
  --accent:#995D3F;
  --ring:rgba(153, 93, 63, 0.18);
  --card-shadow:0 20px 45px -10px rgba(100, 70, 50, 0.1);
  color-scheme:light;
}

/* 15. Sine Wave Aurora (Fluid Nordic stream curves) */
[data-t="aurora"]{
  --bg:#0A1C24;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='60' viewBox='0 0 100 60'%3E%3Cpath d='M0 30 Q25 10 50 30 T100 30 M0 45 Q25 25 50 45 T100 45 M0 15 Q25 -5 50 15 T100 15' fill='none' stroke='%2322D3EE' stroke-width='1' stroke-opacity='0.22'/%3E%3C/svg%3E");
  --pat-size:100px 60px;
  --card:rgba(14, 35, 46, 0.86);
  --border:rgba(34, 211, 238, 0.28);
  --ink:#ECFEFF;
  --muted:#A5F3FC;
  --accent:#06B6D4;
  --ring:rgba(6, 182, 212, 0.3);
  --card-shadow:0 24px 50px -12px rgba(4, 12, 18, 0.75);
  color-scheme:dark;
}

/* 16. Carbon Matrix (High-performance micro-twill) */
[data-t="carbon"]{
  --bg:#121418;
  --pattern:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Crect width='8' height='8' fill='%231B1E24'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%231B1E24'/%3E%3Cline x1='0' y1='0' x2='8' y2='8' stroke='%23282C36' stroke-width='0.75'/%3E%3Cline x1='8' y1='8' x2='16' y2='16' stroke='%23282C36' stroke-width='0.75'/%3E%3C/svg%3E");
  --pat-size:16px 16px;
  --card:rgba(24, 27, 34, 0.88);
  --border:rgba(148, 163, 184, 0.24);
  --ink:#F1F5F9;
  --muted:#94A3B8;
  --accent:#64748B;
  --ring:rgba(100, 116, 139, 0.28);
  --card-shadow:0 24px 50px -12px rgba(4, 5, 8, 0.8);
  color-scheme:dark;
}

/* ── FROSTED CARD & LAYOUT ── */
.wrap{
  position:relative;
  z-index:2;
  width:100%;
  max-width:420px;
  animation:cardFade .4s ease-out;
}
@keyframes cardFade{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}

.card{
  background:var(--card);
  border:1.5px solid var(--border);
  border-radius:24px;
  padding:36px 32px 28px;
  box-shadow:var(--card-shadow);
  backdrop-filter:blur(22px);
  -webkit-backdrop-filter:blur(22px);
  transition:background-color .3s,border-color .3s,box-shadow .3s;
}

/* Header & Brand */
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.brand{display:flex;align-items:center;gap:12px}
.brand-mark{
  width:42px;
  height:42px;
  border-radius:12px;
  background:var(--accent);
  display:grid;
  place-items:center;
  box-shadow:0 4px 12px var(--ring);
  transition:background-color .3s;
}
.brand-mark svg{width:22px;height:22px;color:#fff}
.brand-name{font-size:1.55rem;font-weight:700;letter-spacing:-.03em;color:var(--ink);line-height:1}
.brand-sub{font-size:.74rem;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;margin-top:2px}

.theme-pill{
  font-family:"JetBrains Mono",monospace;
  font-size:.72rem;
  padding:4px 9px;
  background:rgba(128,128,128,.1);
  border:1px solid var(--border);
  border-radius:20px;
  color:var(--muted);
  display:inline-flex;
  align-items:center;
  gap:5px;
}

.headline{font-size:1.15rem;font-weight:600;color:var(--ink);margin-bottom:6px;letter-spacing:-.015em}
.sub{font-size:.88rem;color:var(--muted);margin-bottom:24px;line-height:1.5}

/* Error banner */
.err{
  background:rgba(239, 68, 68, 0.12);
  border:1px solid rgba(239, 68, 68, 0.3);
  color:#EF4444;
  padding:11px 14px;
  border-radius:12px;
  font-size:.86rem;
  margin-bottom:18px;
  display:flex;
  align-items:center;
  gap:8px;
}
[data-t="blueprint"] .err,[data-t="topo"] .err,[data-t="isometric"] .err,[data-t="artdeco"] .err,[data-t="cosmos"] .err,[data-t="honeycomb"] .err,[data-t="circuit"] .err,[data-t="moroccan"] .err,[data-t="aurora"] .err,[data-t="carbon"] .err{color:#FCA5A5}

/* Form controls */
.field{display:flex;flex-direction:column;gap:7px;margin-bottom:14px}
.field label{font-size:.78rem;font-weight:600;color:var(--muted);letter-spacing:.04em;text-transform:uppercase}
.field input{
  font:inherit;
  font-size:.95rem;
  padding:12px 16px;
  border:1.5px solid var(--border);
  border-radius:12px;
  background:rgba(128,128,128,.05);
  color:var(--ink);
  outline:none;
  transition:border-color .15s,box-shadow .15s,background-color .15s;
}
.field input:focus{
  border-color:var(--accent);
  box-shadow:0 0 0 3.5px var(--ring);
  background:transparent;
}

/* Buttons */
.btn-primary{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  width:100%;
  padding:12px 22px;
  background:var(--accent);
  color:#fff;
  font:inherit;
  font-size:.95rem;
  font-weight:600;
  border:none;
  border-radius:12px;
  cursor:pointer;
  transition:transform .12s,opacity .15s,box-shadow .15s;
  box-shadow:0 4px 14px var(--ring);
  margin-top:6px;
}
.btn-primary:hover{opacity:.92;box-shadow:0 6px 20px var(--ring)}
.btn-primary:active{transform:scale(.98)}

.divider{display:flex;align-items:center;gap:12px;margin:18px 0;color:var(--muted);font-size:.82rem}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--border)}

.btn-google{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:10px;
  width:100%;
  padding:11px 20px;
  background:rgba(128,128,128,.06);
  color:var(--ink);
  font:inherit;
  font-size:.93rem;
  font-weight:500;
  border:1.5px solid var(--border);
  border-radius:12px;
  cursor:pointer;
  text-decoration:none;
  transition:border-color .15s,box-shadow .15s,background-color .15s;
}
.btn-google:hover{border-color:var(--accent);background:rgba(128,128,128,.1);box-shadow:0 2px 12px var(--ring)}

.btn-dev{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  width:100%;
  padding:9px 16px;
  background:transparent;
  color:var(--muted);
  font:inherit;
  font-size:.82rem;
  border:1px dashed var(--border);
  border-radius:10px;
  cursor:pointer;
  text-decoration:none;
  margin-top:12px;
  transition:color .15s,border-color .15s;
}
.btn-dev:hover{color:var(--ink);border-color:var(--muted)}

.note{font-size:.8rem;color:var(--muted);text-align:center;margin-top:12px;line-height:1.55}

/* ── PATTERN THEME PICKER ── */
.theme-section{
  margin-top:22px;
  padding-top:18px;
  border-top:1px solid var(--border);
}
.theme-header{
  display:flex;
  align-items:center;
  justify-content:space-between;
  margin-bottom:12px;
}
.theme-title{
  font-size:.76rem;
  font-weight:600;
  color:var(--muted);
  letter-spacing:.05em;
  text-transform:uppercase;
  display:flex;
  align-items:center;
  gap:6px;
}
.theme-current-desc{
  font-size:.74rem;
  color:var(--muted);
  font-weight:500;
}

.theme-grid{
  display:grid;
  grid-template-columns:repeat(8, 1fr);
  gap:8px;
}
@media(max-width:440px){
  .theme-grid{grid-template-columns:repeat(4, 1fr);gap:10px}
}

.pat-swatch{
  aspect-ratio:1;
  border-radius:10px;
  border:2px solid transparent;
  cursor:pointer;
  transition:transform .16s cubic-bezier(.34,1.56,.64,1),border-color .15s,box-shadow .15s;
  position:relative;
  outline:none;
  background-size:cover;
  background-position:center;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.15);
}
.pat-swatch:hover{
  transform:scale(1.18);
  z-index:10;
}
.pat-swatch.active{
  border-color:var(--accent);
  box-shadow:0 0 0 2.5px var(--ring),inset 0 0 0 1px rgba(255,255,255,.4);
  transform:scale(1.08);
}
.pat-swatch::after{
  content:attr(data-name);
  position:absolute;
  bottom:calc(100% + 8px);
  left:50%;
  transform:translateX(-50%) scale(.85);
  opacity:0;
  background:#0F172A;
  color:#F8FAFC;
  font-size:.7rem;
  font-family:"Plus Jakarta Sans",sans-serif;
  font-weight:500;
  white-space:nowrap;
  padding:4px 8px;
  border-radius:6px;
  pointer-events:none;
  transition:opacity .15s,transform .15s;
  box-shadow:0 4px 12px rgba(0,0,0,.35);
  z-index:20;
}
.pat-swatch:hover::after{
  opacity:1;
  transform:translateX(-50%) scale(1);
}
</style>
</head>
<body data-t="blueprint">
<div class="wrap">
  <div class="card">
    <div class="header">
      <div class="brand">
        <div class="brand-mark">
          <svg viewBox="0 0 24 24" fill="none"><path d="M4 5h16M4 9h10M4 13h16M4 17h10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
        </div>
        <div>
          <div class="brand-name">Noty</div>
          <div class="brand-sub">AI Notebooks</div>
        </div>
      </div>
      <div class="theme-pill" id="theme-badge">📐 Blueprint</div>
    </div>

    <div class="headline">Welcome back</div>
    <p class="sub">Open your notebooks & continue with AI</p>

    ${error ? `<div class="err" role="alert"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>${esc(error)}</div>` : ""}
    ${body}

    <!-- 16 Pattern Themes Gallery -->
    <div class="theme-section">
      <div class="theme-header">
        <div class="theme-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          Pattern Texture
        </div>
        <div class="theme-current-desc" id="theme-sub">Architectural grid</div>
      </div>
      <div class="theme-grid" id="patterns-grid"></div>
    </div>
  </div>
</div>

<script>
(function(){
  var PATTERNS = [
    {id:"blueprint",   icon:"📐", name:"Blueprint",   desc:"Architectural drafting grid", bg:"#0A1B38", preview:"radial-gradient(#3B82F6 1px, #0A1B38 1px)"},
    {id:"graph",       icon:"📊", name:"Graph Paper", desc:"Engineering millimeter grid", bg:"#F8FAF9", preview:"linear-gradient(#2563EB 0.75px, transparent 0.75px), linear-gradient(90deg, #2563EB 0.75px, #F8FAF9 0.75px)"},
    {id:"dots",        icon:"📓", name:"Bullet Dot",  desc:"Minimalist dot matrix",      bg:"#F5F3EF", preview:"radial-gradient(#786C5E 1.2px, #F5F3EF 1.2px)"},
    {id:"notebook",    icon:"📝", name:"Ruled Notes", desc:"Classic lined stationery",   bg:"#FAF9F5", preview:"linear-gradient(#3B82F6 1px, #FAF9F5 1px)"},
    {id:"topo",        icon:"🗺️", name:"Topography",  desc:"Alpine elevation contours",  bg:"#0F241C", preview:"radial-gradient(#34D399 1.5px, #0F241C 1.5px)"},
    {id:"waves",       icon:"🌊", name:"Seigaiha",    desc:"Zen Japanese wave arches",   bg:"#EDF4F5", preview:"radial-gradient(circle at 50% 0, #0E7490 2px, #EDF4F5 2px)"},
    {id:"isometric",   icon:"🧊", name:"Isometric",   desc:"3D wireframe spatial mesh",  bg:"#121620", preview:"linear-gradient(60deg, #818CF8 1px, transparent 1px)"},
    {id:"artdeco",     icon:"💎", name:"Art Deco",    desc:"Vintage luxury diamond lattice",bg:"#201714", preview:"linear-gradient(45deg, #F59E0B 1px, #201714 1px)"},
    {id:"cosmos",      icon:"✨", name:"Constellation",desc:"Deep starry celestial map",  bg:"#0A0C16", preview:"radial-gradient(#93C5FD 1.5px, #0A0C16 1.5px)"},
    {id:"honeycomb",   icon:"🐝", name:"Honeycomb",   desc:"Natural hexagonal lattice",  bg:"#1A140B", preview:"linear-gradient(30deg, #EAB308 1px, #1A140B 1px)"},
    {id:"circuit",     icon:"⚡", name:"Circuit",     desc:"Cybernetic printed traces",  bg:"#071613", preview:"linear-gradient(90deg, #2DD4BF 1px, #071613 1px)"},
    {id:"herringbone", icon:"👔", name:"Herringbone", desc:"Tailored chevron twill",    bg:"#EEF1F6", preview:"linear-gradient(45deg, #475569 1px, #EEF1F6 1px)"},
    {id:"moroccan",    icon:"🕌", name:"Moroccan",    desc:"Arabesque geometric tiles",  bg:"#1A1126", preview:"radial-gradient(#C084FC 1.5px, #1A1126 1.5px)"},
    {id:"terrazzo",    icon:"🏺", name:"Terrazzo",    desc:"Nordic speckled stone flecks",bg:"#F4EFEB", preview:"radial-gradient(#C27856 2px, #F4EFEB 2px)"},
    {id:"aurora",      icon:"🌌", name:"Aurora",      desc:"Fluid sinusoidal wave flows",bg:"#0A1C24", preview:"linear-gradient(135deg, #0A1C24, #083344)"},
    {id:"carbon",      icon:"🏁", name:"Carbon",      desc:"High-tech carbon weave",     bg:"#121418", preview:"linear-gradient(45deg, #1B1E24 25%, #121418 25%)"},
  ];

  var saved = localStorage.getItem("noty:login-pattern-theme") || "blueprint";
  if (!PATTERNS.some(function(p){ return p.id === saved; })) saved = "blueprint";

  var bodyEl = document.body;
  var badgeEl = document.getElementById("theme-badge");
  var subEl = document.getElementById("theme-sub");

  function apply(th){
    bodyEl.setAttribute("data-t", th.id);
    localStorage.setItem("noty:login-pattern-theme", th.id);
    if(badgeEl) badgeEl.textContent = th.icon + " " + th.name;
    if(subEl) subEl.textContent = th.desc;

    document.querySelectorAll(".pat-swatch").forEach(function(el){
      if(el.getAttribute("data-id") === th.id) el.classList.add("active");
      else el.classList.remove("active");
    });
  }

  var grid = document.getElementById("patterns-grid");
  PATTERNS.forEach(function(th){
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pat-swatch" + (th.id === saved ? " active" : "");
    btn.setAttribute("data-id", th.id);
    btn.setAttribute("data-name", th.icon + " " + th.name);
    btn.setAttribute("aria-label", th.name + " pattern: " + th.desc);
    btn.style.backgroundColor = th.bg;
    btn.style.backgroundImage = th.preview;
    btn.style.backgroundSize = "14px 14px";
    btn.addEventListener("click", function(){ apply(th); });
    grid.appendChild(btn);
  });

  var initial = PATTERNS.find(function(p){ return p.id === saved; }) || PATTERNS[0];
  apply(initial);
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
