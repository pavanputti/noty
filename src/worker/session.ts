// Signed session cookie for the web app (HMAC-SHA256, no server-side storage).

export interface Session {
  uid: string;
  email: string;
  name?: string;
  picture?: string;
  exp: number;
}

const COOKIE = "noty_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function key(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
}

const secure = (env: Env) => (env.PUBLIC_URL.startsWith("https://") ? "; Secure" : "");

export async function sessionCookie(env: Env, s: Omit<Session, "exp">): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ ...s, exp: Date.now() + MAX_AGE * 1000 })));
  const sig = b64url(await crypto.subtle.sign("HMAC", await key(env.COOKIE_SECRET), new TextEncoder().encode(payload)));
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure(env)}`;
}

export const clearSessionCookie = (env: Env) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(env)}`;

export async function getSession(req: Request, env: Env): Promise<Session | null> {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await key(env.COOKIE_SECRET), fromB64url(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const s = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Session;
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export const stateCookie = (env: Env, state: string) =>
  `noty_state=${state}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure(env)}`;
export const clearStateCookie = (env: Env) => `noty_state=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${secure(env)}`;

export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}
