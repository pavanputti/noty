#!/usr/bin/env node
// One-command deploy to Cloudflare (free plan):
//   1. creates the KV namespace if needed
//   2. builds and deploys, and records your workers.dev address in wrangler.jsonc
//   3. uploads the settings from .dev.vars as encrypted Worker secrets (never printed)
//   4. deploys again so everything uses the final address
// Run it with: npm run deploy

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const CONFIG = join(root, "wrangler.jsonc");
const LOCAL_ONLY = new Set(["PUBLIC_URL", "DEV_LOGIN"]);

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const wrangler = (...args) => run("npx", ["wrangler", ...args]);
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
const step = (msg) => console.log(`\n→ ${msg}`);

// ---- settings ----
let vars;
try {
  vars = Object.fromEntries(
    readFileSync(join(root, ".dev.vars"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
} catch {
  fail("No .dev.vars file. Copy .dev.vars.example to .dev.vars and fill it in.");
}
const google = vars.GOOGLE_CLIENT_ID && !vars.GOOGLE_CLIENT_ID.startsWith("your-") && vars.GOOGLE_CLIENT_SECRET && !vars.GOOGLE_CLIENT_SECRET.startsWith("your-");
const password = (vars.ADMIN_PASSWORD ?? "").length >= 10 && vars.ADMIN_PASSWORD !== "choose-a-long-password";
if (!password && !google) fail("Set ADMIN_PASSWORD (10+ characters) or the Google keys in .dev.vars, so you can sign in.");
if (!vars.COOKIE_SECRET || vars.COOKIE_SECRET.length < 32 || vars.COOKIE_SECRET.startsWith("change-me")) fail("Set COOKIE_SECRET in .dev.vars to a random string of 32+ characters (openssl rand -base64 32).");
if (google && !vars.OWNER_EMAIL && !vars.ALLOWED_EMAILS) fail("Google sign-in is set up: also set OWNER_EMAIL in .dev.vars to your Google address, so only you can sign in.");

// ---- Cloudflare login ----
step("Checking your Cloudflare login");
const who = wrangler("whoami");
if (!who.ok || /not authenticated/i.test(who.out)) fail("Not logged in to Cloudflare. Run: npx wrangler login");

let config = readFileSync(CONFIG, "utf8");

// ---- KV namespace ----
if (config.includes("REPLACE_WITH_YOUR_KV_ID")) {
  step("Creating storage for assistant logins (KV namespace)");
  let id = wrangler("kv", "namespace", "create", "OAUTH_KV").out.match(/"?id"?\s*[:=]\s*"([0-9a-f]{32})"/)?.[1];
  if (!id) {
    const list = wrangler("kv", "namespace", "list");
    try {
      id = JSON.parse(list.out.slice(list.out.indexOf("["))).find((n) => /OAUTH_KV/.test(n.title))?.id;
    } catch {}
  }
  if (!id) fail("Couldn't create the KV namespace. Run `npx wrangler kv namespace create OAUTH_KV` and paste its id into wrangler.jsonc.");
  config = config.replace("REPLACE_WITH_YOUR_KV_ID", id);
  writeFileSync(CONFIG, config);
  console.log("  done");
}

// ---- build + deploy ----
const deploy = () => {
  step("Building and deploying");
  const b = run("npx", ["vite", "build"]);
  if (!b.ok) fail("Build failed:\n" + b.out);
  const d = wrangler("deploy");
  if (!d.ok) fail("Deploy failed:\n" + d.out);
  return d.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
};

let url = deploy();
if (!url) fail("Deployed, but couldn't find the workers.dev address in the output. Set PUBLIC_URL in wrangler.jsonc by hand.");
const current = config.match(/"PUBLIC_URL":\s*"([^"]*)"/)?.[1];
const urlChanged = current !== url;
if (urlChanged) {
  config = config.replace(/"PUBLIC_URL":\s*"[^"]*"/, `"PUBLIC_URL": "${url}"`);
  writeFileSync(CONFIG, config);
}

// ---- secrets (written to a private temp file, never printed) ----
step("Uploading your settings as encrypted secrets");
const secrets = Object.fromEntries(Object.entries(vars).filter(([k, v]) => !LOCAL_ONLY.has(k) && !v.startsWith("your-")));
const dir = mkdtempSync(join(tmpdir(), "noty-"));
const file = join(dir, "secrets.json");
try {
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  const s = wrangler("secret", "bulk", file);
  if (!s.ok) fail("Uploading secrets failed:\n" + s.out.replace(/"[^"]{20,}"/g, '"…"'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`  uploaded: ${Object.keys(secrets).join(", ")}`);

// ---- final deploy with the real address ----
url = deploy() ?? url;

console.log(`
✓ Noty is live: ${url}

  Sign in:     ${password ? "with your admin password (in .dev.vars)" : ""}${password && google ? " or " : ""}${google ? "with Google" : ""}
  MCP address: ${url}/mcp   (paste this into Claude, ChatGPT, Gemini CLI…)
${google ? `
  In Google Cloud → your OAuth client → Authorised redirect URIs, make sure this is listed:
    ${url}/auth/callback
` : `
  Google Drive copy is off. To turn it on later: add the Google keys to .dev.vars,
  add ${url}/auth/callback as a redirect URI in Google Cloud, and run npm run deploy again.
`}`);
