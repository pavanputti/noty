// Google sign-in and Drive API helpers. Only the `drive.file` scope is used:
// Noty can see and change the files it created, and nothing else in your Drive.

export const GOOGLE_SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"];
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface GoogleTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface GoogleUser {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

export function googleAuthUrl(env: Env, state: string, forceConsent: boolean): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${env.PUBLIC_URL}/auth/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  // Google only returns a refresh token on the consent screen, so we ask for it
  // the first time, or whenever the stored one is missing.
  u.searchParams.set("prompt", forceConsent ? "consent" : "select_account");
  return u.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = (await res.json()) as GoogleTokens & { error?: string; error_description?: string };
  if (!res.ok) throw new GoogleAuthError(data.error ?? "token_error", data.error_description);
  return data;
}

export class GoogleAuthError extends Error {
  constructor(
    public code: string,
    description?: string,
  ) {
    super(description ?? code);
  }
}

export const exchangeCode = (env: Env, code: string) =>
  tokenRequest({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: `${env.PUBLIC_URL}/auth/callback`,
    grant_type: "authorization_code",
  });

export const refreshAccessToken = (env: Env, refreshToken: string) =>
  tokenRequest({
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

export const hasDriveScope = (scope: string) => scope.split(" ").includes(DRIVE_FILE_SCOPE);

export async function fetchGoogleUser(accessToken: string): Promise<GoogleUser> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google userinfo failed: ${res.status}`);
  return res.json();
}

// ---------- Drive ----------

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
}

export class Drive {
  constructor(private token: () => Promise<string>) {}

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.token()}`);
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) throw new Error(`Drive ${init.method ?? "GET"} failed (${res.status}): ${await res.text()}`);
    return res;
  }

  async find(name: string, parent?: string, mimeType?: string): Promise<DriveFile | null> {
    const q = [`name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`, "trashed = false"];
    if (parent) q.push(`'${parent}' in parents`);
    if (mimeType) q.push(`mimeType = '${mimeType}'`);
    const res = await this.call(`${API}/files?` + new URLSearchParams({ q: q.join(" and "), fields: "files(id,name,mimeType)" }));
    const { files } = (await res.json()) as { files: DriveFile[] };
    return files[0] ?? null;
  }

  async list(parent: string): Promise<DriveFile[]> {
    const res = await this.call(
      `${API}/files?` +
        new URLSearchParams({
          q: `'${parent}' in parents and trashed = false`,
          fields: "files(id,name,mimeType,modifiedTime)",
          pageSize: "1000",
        }),
    );
    return ((await res.json()) as { files: DriveFile[] }).files;
  }

  async folder(name: string, parent?: string): Promise<string> {
    const existing = await this.find(name, parent, FOLDER);
    if (existing) return existing.id;
    const res = await this.call(`${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: parent ? [parent] : undefined }),
    });
    return ((await res.json()) as { id: string }).id;
  }

  /** Creates a file, or replaces the content of `fileId` if given. Returns the file id. */
  async upload(opts: { name: string; parent: string; mimeType: string; body: BodyInit; fileId?: string }): Promise<string> {
    if (opts.fileId) {
      try {
        await this.call(`${UPLOAD}/files/${opts.fileId}?uploadType=media&fields=id`, {
          method: "PATCH",
          headers: { "Content-Type": opts.mimeType },
          body: opts.body,
        });
        await this.call(`${API}/files/${opts.fileId}?fields=id`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: opts.name }),
        });
        return opts.fileId;
      } catch (e) {
        // The file was deleted or trashed in Drive: fall through and create a fresh one.
        if (!String(e).includes("(404)")) throw e;
      }
    }
    const boundary = "noty" + crypto.randomUUID();
    const meta = JSON.stringify({ name: opts.name, parents: [opts.parent], mimeType: opts.mimeType });
    const bytes = new Uint8Array(await new Response(opts.body).arrayBuffer());
    const enc = new TextEncoder();
    const body = new Blob([
      enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
      enc.encode(`--${boundary}\r\nContent-Type: ${opts.mimeType}\r\n\r\n`),
      bytes,
      enc.encode(`\r\n--${boundary}--`),
    ]);
    const res = await this.call(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return ((await res.json()) as { id: string }).id;
  }

  /** Upload for larger files (Drive's simple upload is limited to 5 MB): one resumable session, sent in one go. */
  async uploadLarge(opts: { name: string; parent: string; mimeType: string; body: Blob; fileId?: string }): Promise<string> {
    const start = async (fileId?: string) => {
      const url = fileId ? `${UPLOAD}/files/${fileId}?uploadType=resumable&fields=id` : `${UPLOAD}/files?uploadType=resumable&fields=id`;
      const meta = fileId ? { name: opts.name } : { name: opts.name, parents: [opts.parent], mimeType: opts.mimeType };
      const res = await this.call(url, {
        method: fileId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": opts.mimeType, "X-Upload-Content-Length": String(opts.body.size) },
        body: JSON.stringify(meta),
      });
      return res.headers.get("Location")!;
    };
    let session: string;
    try {
      session = await start(opts.fileId);
    } catch (e) {
      if (!opts.fileId || !String(e).includes("(404)")) throw e;
      session = await start(); // the old copy was deleted in Drive: make a new one
    }
    const res = await fetch(session, { method: "PUT", headers: { "Content-Type": opts.mimeType }, body: opts.body });
    if (!res.ok) throw new Error(`Drive upload failed (${res.status}): ${await res.text()}`);
    return ((await res.json()) as { id: string }).id;
  }

  download(fileId: string): Promise<Response> {
    return this.call(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
  }

  async trash(fileId: string): Promise<void> {
    await this.call(`${API}/files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    }).catch(() => {});
  }
}
