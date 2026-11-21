// One Vault per Google account. It is the single writer for that person's notebooks:
// the web editor and every MCP client go through it, it pushes live updates to open
// browser tabs, and it mirrors every notebook into Google Drive / Noty.

import { DurableObject } from "cloudflare:workers";
import { type Block, blocksToMarkdown, blockText, markdownToBlocks } from "../shared/blocks";
import { Drive, GoogleAuthError, refreshAccessToken } from "./google";
import { inkBounds, renderInkPng, toBase64 } from "./render";

export interface NotebookMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  blockCount: number;
  driveJsonId?: string;
  driveMdId?: string;
  /** An emoji shown on the book and next to the title. */
  icon?: string;
  /** Cover colour (hex); empty = automatic. */
  cover?: string;
  favorite?: boolean;
  /** Topic (subject/folder) it's grouped under in the library, e.g. "Biology". */
  topic?: string;
  /** Set while the notebook is in the Trash. */
  deletedAt?: number;
  /** Text style. Empty = the default, neat handwriting. */
  font?: NotebookFont;
}

export const NOTEBOOK_FONTS = ["print", "hand", "neat"] as const;
export type NotebookFont = (typeof NOTEBOOK_FONTS)[number];
const cleanFont = (f: unknown): NotebookFont | undefined => (NOTEBOOK_FONTS as readonly unknown[]).includes(f) ? (f as NotebookFont) : undefined;

export interface Snapshot {
  ts: number;
  blockCount: number;
  hash: number;
}

const TRASH_DAYS = 30;
const SNAPSHOT_EVERY_MS = 10 * 60 * 1000;
const MAX_SNAPSHOTS = 40;
const fnv = (str: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

export interface Notebook {
  id: string;
  name: string;
  blocks: Block[];
  version: number;
  /** Top-level block id → version it was added in by an assistant (used to merge concurrent edits). */
  addedAt: Record<string, number>;
  /** Block id → which assistant added it, so the editor can mark it in the margin. */
  aiBlocks: Record<string, { by: string; at: number }>;
}

interface AuthRecord {
  refreshToken?: string;
  email: string;
  name?: string;
  picture?: string;
}

export class NeedsSignInError extends Error {}

/** One pen stroke. `d` holds the points (delta-encoded x, y, pressure); the server never needs to read it. */
export interface InkStroke {
  id: string;
  c: string;
  s: number;
  t?: "h";
  d: string;
}

export interface PdfMeta {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  driveFileId?: string;
  driveNotesId?: string;
  /** A small picture of page 1 exists (shown as the book cover in the library). */
  thumb?: boolean;
  /** Topic (subject/folder) it's grouped under in the library. */
  topic?: string;
  /** The PDF's page text has been read, so it can be searched. */
  textIndexed?: boolean;
  pages?: number;
}

/** A text box placed on a PDF page. x, y, w are fractions of the page width/height (0–1). */
export interface PdfBox {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  text: string;
  size: number;
  color: string;
}

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const PDF_CHUNK = 1024 * 1024;

export interface SearchResult {
  notebooks: { id: string; name: string; updatedAt: number }[];
  pdfs: { id: string; name: string; updatedAt: number }[];
  hits: { kind: "notebook" | "pdf"; id: string; name: string; snippet: string; blockId?: string; page?: number; note?: boolean }[];
}

export interface EditorPatch {
  upserts: Block[];
  deletes: string[];
  order: string[];
  baseVersion: number;
}

/** Topics are short names; empty means "no topic". */
const cleanTopic = (t?: string) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || undefined;

const isEmptyParagraph = (b: Block) =>
  b.type === "paragraph" && (!Array.isArray(b.content) || b.content.every((c: any) => c.type === "text" && !c.text.trim())) && !b.children?.length;

const MAX_NOTEBOOK_BYTES = 1_900_000; // Durable Object values are capped at 2 MB
const DRIVE_DEBOUNCE_MS = 3_000;
const DRIVE_RETRY_MS = 60_000;

const shortId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const norm = (s: string) => s.toLowerCase().replace(/\bnotes?\b|\bnotebook\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim().slice(0, 120) || "Untitled";

export class Vault extends DurableObject<Env> {
  private accessToken?: { token: string; exp: number };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Handwriting is stored one stroke per row, so a notebook can hold thousands of pages of ink
    // without hitting the 2 MB limit of a single stored value.
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS ink (nb TEXT NOT NULL, id TEXT NOT NULL, anchor TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (nb, id))");
    sql.exec("CREATE INDEX IF NOT EXISTS ink_by_anchor ON ink (nb, anchor)");
    sql.exec("CREATE TABLE IF NOT EXISTS ink_dirty (nb TEXT NOT NULL, anchor TEXT NOT NULL, PRIMARY KEY (nb, anchor))");
    sql.exec("CREATE TABLE IF NOT EXISTS ink_files (nb TEXT NOT NULL, anchor TEXT NOT NULL, file_id TEXT NOT NULL, PRIMARY KEY (nb, anchor))");
    // Uploaded PDFs, stored in 1 MB pieces (a single stored value can't exceed 2 MB).
    sql.exec("CREATE TABLE IF NOT EXISTS pdf_chunks (id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, idx))");
  }

  // ---------- Google account ----------

  async setGoogleAuth(a: AuthRecord & { accessToken: string; expiresIn: number }): Promise<{ hasRefreshToken: boolean }> {
    const prev = await this.ctx.storage.get<AuthRecord>("auth");
    const rec: AuthRecord = {
      email: a.email,
      name: a.name,
      picture: a.picture,
      refreshToken: a.refreshToken ?? prev?.refreshToken,
    };
    await this.ctx.storage.put("auth", rec);
    this.accessToken = { token: a.accessToken, exp: Date.now() + (a.expiresIn - 60) * 1000 };
    if (rec.refreshToken && !(await this.ctx.storage.get("restored"))) {
      await this.restoreFromDrive().catch((e) => console.error("restore failed", e));
    }
    // Resume any Drive copies that were waiting for a sign-in.
    if (rec.refreshToken) {
      // Images added before Drive was connected: copy them now.
      const ids = (await this.ctx.storage.get<string[]>("imgIndex")) ?? [];
      const missing: string[] = [];
      for (const id of ids) if (!(await this.ctx.storage.get(`imgDrive:${id}`))) missing.push(id);
      if (missing.length) {
        const q = new Set((await this.ctx.storage.get<string[]>("imgDirty")) ?? []);
        missing.forEach((i) => q.add(i));
        await this.ctx.storage.put("imgDirty", [...q]);
      }
    }
    const waiting =
      ((await this.ctx.storage.get<string[]>("imgDirty")) ?? []).length +
      ((await this.ctx.storage.get<string[]>("dirty")) ?? []).length +
      ((await this.ctx.storage.get<string[]>("pdfDirty")) ?? []).length +
      this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ink_dirty").one().n;
    if (rec.refreshToken && waiting) await this.ctx.storage.setAlarm(Date.now() + 1000);
    return { hasRefreshToken: Boolean(rec.refreshToken) };
  }

  /** Whether this account's notebooks are being copied to Google Drive, and to which account. */
  async driveStatus(): Promise<{ connected: boolean; email?: string }> {
    const auth = await this.ctx.storage.get<AuthRecord>("auth");
    return { connected: Boolean(auth?.refreshToken), email: auth?.refreshToken ? auth.email : undefined };
  }

  async hasRefreshToken(): Promise<boolean> {
    return Boolean((await this.ctx.storage.get<AuthRecord>("auth"))?.refreshToken);
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.exp > Date.now()) return this.accessToken.token;
    const auth = await this.ctx.storage.get<AuthRecord>("auth");
    if (!auth?.refreshToken) throw new NeedsSignInError(`Google Drive isn't connected. Open ${this.env.PUBLIC_URL} and choose "Connect Google Drive".`);
    try {
      const t = await refreshAccessToken(this.env, auth.refreshToken);
      this.accessToken = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
      return t.access_token;
    } catch (e) {
      if (e instanceof GoogleAuthError && e.code === "invalid_grant") {
        await this.ctx.storage.put("auth", { ...auth, refreshToken: undefined });
        throw new NeedsSignInError(`Google access was revoked or expired. Open ${this.env.PUBLIC_URL} and sign in again.`);
      }
      throw e;
    }
  }

  private drive() {
    return new Drive(() => this.token());
  }

  private async folders(): Promise<{ root: string; images: string }> {
    const cached = await this.ctx.storage.get<{ root: string; images: string }>("folders");
    if (cached) return cached;
    const d = this.drive();
    const root = await d.folder("Noty");
    const images = await d.folder("images", root);
    await this.ctx.storage.put("folders", { root, images });
    return { root, images };
  }

  // ---------- notebooks ----------

  private async index(): Promise<NotebookMeta[]> {
    return (await this.ctx.storage.get<NotebookMeta[]>("index")) ?? [];
  }

  async listNotebooks(): Promise<NotebookMeta[]> {
    return (await this.index()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Finds a notebook by id or by a loose name match ("physics" matches "Physics notes"). */
  /**
   * Finds a notebook from what the user called it. Matches, in order: the id, the exact name,
   * the name ignoring "notes"/"notebook"/case/punctuation ("dsa notes" → "DSA"), then a name that
   * starts with those whole words ("physics" → "Physics 2") if only one does. Never a word inside
   * another word ("work" does not match "Homework"). If several notebooks fit, none is chosen.
   */
  async resolveNotebook(ref: string): Promise<{ meta: NotebookMeta | null; candidates: NotebookMeta[] }> {
    const all = await this.index();
    const r = ref.trim();
    const byId = all.find((n) => n.id === r);
    if (byId) return { meta: byId, candidates: [] };
    const lower = r.toLowerCase();
    const exact = all.filter((n) => n.name.trim().toLowerCase() === lower);
    if (exact.length === 1) return { meta: exact[0], candidates: [] };
    const key = norm(r);
    if (!key) return { meta: null, candidates: [] };
    const same = all.filter((n) => norm(n.name) === key);
    if (same.length === 1) return { meta: same[0], candidates: [] };
    if (same.length > 1) return { meta: null, candidates: same };
    const prefix = all.filter((n) => (norm(n.name) + " ").startsWith(key + " "));
    if (prefix.length === 1) return { meta: prefix[0], candidates: [] };
    return { meta: null, candidates: prefix };
  }

  async findNotebook(ref: string): Promise<NotebookMeta | null> {
    return (await this.resolveNotebook(ref)).meta;
  }

  /** For tools: the notebook, or a clear message (not found / which one?). Returned, not thrown. */
  async requireNotebook(ref: string): Promise<{ meta: NotebookMeta; error?: undefined } | { meta?: undefined; error: string }> {
    const { meta, candidates } = await this.resolveNotebook(ref);
    if (meta) return { meta };
    if (candidates.length) return { error: `"${ref}" could be ${candidates.map((c) => `"${c.name}"`).join(" or ")}. Ask the user which one, then use its exact name.` };
    return { error: `No notebook called "${ref}". Use list_notebooks to see them.` };
  }

  async createNotebook(name: string, topic?: string, font?: string): Promise<NotebookMeta> {
    const clean = name.trim().slice(0, 120) || "Untitled";
    const existing = (await this.index()).find((n) => n.name.trim().toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const now = Date.now();
    const meta: NotebookMeta = { id: shortId(), name: clean, createdAt: now, updatedAt: now, blockCount: 0, topic: cleanTopic(topic), font: cleanFont(font) };
    const nb: Notebook = { id: meta.id, name: clean, blocks: [], version: 1, addedAt: {}, aiBlocks: {} };
    await this.ctx.storage.put({ [`nb:${meta.id}`]: nb, index: [...(await this.index()), meta] });
    await this.markDirty(meta.id);
    return meta;
  }

  async getNotebook(id: string): Promise<Notebook | null> {
    return (await this.ctx.storage.get<Notebook>(`nb:${id}`)) ?? null;
  }

  async renameNotebook(id: string, name: string): Promise<NotebookMeta | null> {
    return this.updateNotebook(id, { name });
  }

  /** Name, icon, cover colour, favourite, font. */
  async updateNotebook(id: string, ch: { name?: string; icon?: string; cover?: string; favorite?: boolean; topic?: string; font?: string }): Promise<NotebookMeta | null> {
    const all = await this.index();
    const meta = all.find((n) => n.id === id);
    if (!meta) return null;
    if (ch.icon !== undefined) meta.icon = [...String(ch.icon)].slice(0, 2).join("") || undefined;
    if (ch.cover !== undefined) meta.cover = /^#[0-9a-fA-F]{6}$/.test(ch.cover) ? ch.cover : undefined;
    if (ch.favorite !== undefined) meta.favorite = Boolean(ch.favorite) || undefined;
    if (ch.topic !== undefined) meta.topic = cleanTopic(ch.topic);
    if (ch.font !== undefined) meta.font = cleanFont(ch.font);
    await this.ctx.storage.put("index", all);
    if (ch.name !== undefined && ch.name.trim() && ch.name.trim() !== meta.name) {
      const nb = (await this.getNotebook(id))!;
      nb.name = ch.name.trim().slice(0, 120);
      return this.store(nb, { type: "renamed", name: nb.name });
    }
    this.broadcast(id, { type: "meta", icon: meta.icon ?? null, cover: meta.cover ?? null, favorite: !!meta.favorite, topic: meta.topic ?? null, font: meta.font ?? null });
    return meta;
  }

  // ----- Trash: deleting moves a notebook here; it can be restored for 30 days -----

  private async trashIndex(): Promise<NotebookMeta[]> {
    return (await this.ctx.storage.get<NotebookMeta[]>("trash")) ?? [];
  }

  async listTrash(): Promise<NotebookMeta[]> {
    await this.purgeOldTrash();
    return (await this.trashIndex()).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  }

  async deleteNotebook(id: string): Promise<boolean> {
    const all = await this.index();
    const meta = all.find((n) => n.id === id);
    if (!meta) return false;
    meta.deletedAt = Date.now();
    await this.ctx.storage.put({ index: all.filter((n) => n.id !== id), trash: [...(await this.trashIndex()), meta] });
    this.broadcast(id, { type: "deleted" });
    return true;
  }

  async restoreNotebook(id: string): Promise<NotebookMeta | null> {
    const trash = await this.trashIndex();
    const meta = trash.find((n) => n.id === id);
    if (!meta) return null;
    delete meta.deletedAt;
    const all = await this.index();
    if (all.some((n) => n.name.trim().toLowerCase() === meta.name.trim().toLowerCase())) {
      meta.name = `${meta.name} (restored)`;
      const nb = await this.getNotebook(id);
      if (nb) (nb.name = meta.name), await this.ctx.storage.put(`nb:${id}`, nb);
    }
    meta.updatedAt = Date.now();
    await this.ctx.storage.put({ index: [...all, meta], trash: trash.filter((n) => n.id !== id) });
    await this.markDirty(id);
    return meta;
  }

  /** Delete forever: the notebook, its handwriting, history, and its copies in Drive. */
  async purgeNotebook(id: string): Promise<boolean> {
    const trash = await this.trashIndex();
    const meta = trash.find((n) => n.id === id);
    if (!meta) return false;
    const inkFolder = await this.ctx.storage.get<string>(`inkFolder:${id}`);
    const hist = (await this.ctx.storage.get<Snapshot[]>(`histIndex:${id}`)) ?? [];
    await this.ctx.storage.delete([`nb:${id}`, `inkFolder:${id}`, `histIndex:${id}`, ...hist.map((h) => `hist:${id}:${h.ts}`)]);
    await this.ctx.storage.put("trash", trash.filter((n) => n.id !== id));
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM ink WHERE nb = ?", id);
    sql.exec("DELETE FROM ink_dirty WHERE nb = ?", id);
    sql.exec("DELETE FROM ink_files WHERE nb = ?", id);
    if (await this.hasRefreshToken()) {
      const d = this.drive();
      for (const f of [meta.driveJsonId, meta.driveMdId, inkFolder]) if (f) await d.trash(f).catch(() => {});
    }
    return true;
  }

  private async purgeOldTrash() {
    const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
    for (const n of await this.trashIndex()) if ((n.deletedAt ?? 0) < cutoff) await this.purgeNotebook(n.id);
  }

  // ----- Page history: a snapshot at most every 10 minutes while a notebook changes -----

  private async snapshot(nb: Notebook, force = false) {
    const key = `histIndex:${nb.id}`;
    const list = (await this.ctx.storage.get<Snapshot[]>(key)) ?? [];
    const last = list[list.length - 1];
    const json = JSON.stringify(nb.blocks);
    const hash = fnv(json);
    if (last && last.hash === hash) return;
    if (!force && last && Date.now() - last.ts < SNAPSHOT_EVERY_MS) return;
    const ts = Date.now();
    list.push({ ts, blockCount: nb.blocks.length, hash });
    const drop = list.splice(0, Math.max(0, list.length - MAX_SNAPSHOTS));
    await this.ctx.storage.put({ [`hist:${nb.id}:${ts}`]: nb.blocks, [key]: list });
    if (drop.length) await this.ctx.storage.delete(drop.map((d) => `hist:${nb.id}:${d.ts}`));
  }

  async listHistory(id: string): Promise<Snapshot[]> {
    return ((await this.ctx.storage.get<Snapshot[]>(`histIndex:${id}`)) ?? []).slice().reverse();
  }

  async getSnapshot(id: string, ts: number): Promise<Block[] | null> {
    return (await this.ctx.storage.get<Block[]>(`hist:${id}:${ts}`)) ?? null;
  }

  /** Puts an earlier version back (the current one is kept in history first, so this can be undone). */
  async restoreSnapshot(id: string, ts: number): Promise<{ version: number } | null> {
    if (!(await this.index()).some((n) => n.id === id)) return null;
    const nb = await this.getNotebook(id);
    const blocks = await this.getSnapshot(id, ts);
    if (!nb || !blocks) return null;
    await this.snapshot(nb, true);
    const deletes = nb.blocks.map((b) => b.id).filter((bid) => !blocks.some((x) => x.id === bid));
    nb.blocks = blocks;
    nb.version++;
    await this.store(nb, { type: "patch", upserts: blocks, deletes, order: blocks.map((b) => b.id), aiBlocks: nb.aiBlocks, clientId: "history" });
    return { version: nb.version };
  }

  /** Notebooks that link to this one (a "Link to notebook" block, or a link to /n/<id>). */
  async backlinks(id: string): Promise<{ id: string; name: string; icon?: string }[]> {
    const out: { id: string; name: string; icon?: string }[] = [];
    for (const meta of await this.index()) {
      if (meta.id === id) continue;
      const nb = await this.getNotebook(meta.id);
      const json = JSON.stringify(nb?.blocks ?? []);
      if (json.includes(`"target":"${id}"`) || json.includes(`/n/${id}`)) out.push({ id: meta.id, name: meta.name, icon: meta.icon });
    }
    return out;
  }

  /** Called by MCP tools: appends blocks at the end and shows them live in open tabs. */
  async appendBlocks(
    ref: string,
    blocks: Block[],
    by: string,
    createIfMissing = true,
  ): Promise<{ notebook: NotebookMeta; created: boolean; error?: undefined } | { error: string; notebook?: undefined; created?: undefined }> {
    const found = await this.resolveNotebook(ref);
    if (!found.meta && found.candidates.length)
      return { error: `"${ref}" could be ${found.candidates.map((c) => `"${c.name}"`).join(" or ")}. Ask the user which one, then use its exact name.` };
    let meta = found.meta;
    let created = false;
    if (!meta) {
      if (!createIfMissing) return { error: `No notebook called "${ref}".` };
      meta = await this.createNotebook(ref);
      created = true;
    }
    const nb = (await this.getNotebook(meta.id))!;
    // New content goes right after the last line: before any empty lines or blank pages at the end.
    const inked = new Set(this.inkAnchors(nb.id));
    let end = nb.blocks.length;
    while (end > 0 && (isEmptyParagraph(nb.blocks[end - 1]) || (nb.blocks[end - 1].type === "page" && !inked.has(nb.blocks[end - 1].id)))) end--;
    const after = end > 0 ? nb.blocks[end - 1].id : null;
    nb.version++;
    const at = Date.now();
    for (const b of blocks) {
      nb.addedAt[b.id] = nb.version;
      nb.aiBlocks[b.id] = { by, at };
    }
    nb.blocks.splice(end, 0, ...blocks);
    const updated = await this.store(nb, { type: "append", blocks, after, aiBlocks: Object.fromEntries(blocks.map((b) => [b.id, { by, at }])) });
    return { notebook: updated, created };
  }

  /**
   * Called by the web editor with only what changed since its last save:
   * blocks it added or edited, blocks it deleted, and its current order.
   * Changes are merged block by block, so an assistant, your iPad and your laptop
   * can all edit the same notebook at once; only edits to the very same block collide
   * (the latest save of that block wins).
   */
  async applyPatch(id: string, patch: EditorPatch, clientId: string): Promise<{ version: number } | null> {
    if (!(await this.index()).some((n) => n.id === id)) return null; // missing or in the Trash
    const nb = await this.getNotebook(id);
    if (!nb) return null;
    const old = nb.blocks;
    const byId = new Map(old.map((b) => [b.id, b]));
    for (const d of patch.deletes) byId.delete(d);
    for (const b of patch.upserts) byId.set(b.id, b);

    // Start from the editor's order, then slot in blocks it hasn't seen yet
    // (added by an assistant or another device) after the block they followed.
    const result = patch.order.filter((bid, i, arr) => byId.has(bid) && arr.indexOf(bid) === i);
    const placed = new Set(result);
    const unseenAtEnd: string[] = [];
    old.forEach((b, i) => {
      if (placed.has(b.id) || !byId.has(b.id)) return;
      if ((nb.addedAt[b.id] ?? 0) > patch.baseVersion) return void unseenAtEnd.push(b.id);
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const k = result.indexOf(old[j].id);
        if (k >= 0) {
          at = k + 1;
          break;
        }
      }
      result.splice(at, 0, b.id);
      placed.add(b.id);
    });
    for (const bid of unseenAtEnd) if (!placed.has(bid)) result.push(bid), placed.add(bid);
    for (const b of patch.upserts) if (!placed.has(b.id)) result.push(b.id), placed.add(b.id);
    nb.blocks = result.map((bid) => byId.get(bid)!);

    nb.version++;
    const ids = new Set<string>();
    const walk = (bs: Block[]) => bs.forEach((b) => (ids.add(b.id), walk(b.children ?? [])));
    walk(nb.blocks);
    nb.aiBlocks = Object.fromEntries(Object.entries(nb.aiBlocks).filter(([k]) => ids.has(k)));
    nb.addedAt = Object.fromEntries(Object.entries(nb.addedAt).filter(([k, v]) => ids.has(k) && v > nb.version - 500));
    await this.store(nb, {
      type: "patch",
      upserts: patch.upserts,
      deletes: patch.deletes,
      order: nb.blocks.map((b) => b.id),
      aiBlocks: nb.aiBlocks,
      clientId,
    });
    return { version: nb.version };
  }

  private async store(nb: Notebook, event: Record<string, unknown>): Promise<NotebookMeta> {
    if (JSON.stringify(nb).length > MAX_NOTEBOOK_BYTES)
      throw new Error("This notebook is full (about 2 MB of text). Start a new notebook for more notes.");
    const all = await this.index();
    const meta = all.find((n) => n.id === nb.id);
    if (!meta) throw new Error("This notebook is in the Trash. Restore it to make changes.");
    await this.snapshot(nb);
    meta.name = nb.name;
    meta.updatedAt = Date.now();
    meta.blockCount = nb.blocks.length;
    await this.ctx.storage.put({ [`nb:${nb.id}`]: nb, index: all });
    this.broadcast(nb.id, { ...event, version: nb.version });
    await this.markDirty(nb.id);
    return meta;
  }

  /**
   * Search notebook and PDF names, notebook text, and (for the web app only) PDF page text and
   * text boxes. Every word typed must match. Assistants call this with includePdfs = false.
   */
  async search(query: string, opts: { includePdfs?: boolean; limit?: number } = {}): Promise<SearchResult> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out: SearchResult = { notebooks: [], pdfs: [], hits: [] };
    if (!words.length) return out;
    const limit = opts.limit ?? 40;
    const all = (t: string) => {
      const l = t.toLowerCase();
      return words.every((w) => l.includes(w));
    };
    const snippet = (t: string) => {
      const flat = t.replace(/\s+/g, " ").trim();
      const l = flat.toLowerCase();
      const at = Math.max(0, Math.min(...words.map((w) => l.indexOf(w)).filter((i) => i >= 0)));
      const from = Math.max(0, at - 60);
      return (from > 0 ? "…" : "") + flat.slice(from, from + 200) + (flat.length > from + 200 ? "…" : "");
    };
    const index = (await this.index()).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const meta of index) {
      if (all(meta.name)) out.notebooks.push({ id: meta.id, name: meta.name, updatedAt: meta.updatedAt });
      const nb = await this.getNotebook(meta.id);
      for (const b of nb?.blocks ?? []) {
        if (out.hits.length >= limit) break;
        const t = blockText(b);
        if (t && all(t)) out.hits.push({ kind: "notebook", id: meta.id, name: meta.name, snippet: snippet(t), blockId: b.id });
      }
    }
    if (opts.includePdfs) {
      for (const meta of (await this.pdfIndex()).sort((a, b) => b.updatedAt - a.updatedAt)) {
        if (all(meta.name)) out.pdfs.push({ id: meta.id, name: meta.name, updatedAt: meta.updatedAt });
        const pages = (await this.ctx.storage.get<string[]>(`pdfText:${meta.id}`)) ?? [];
        const boxes = (await this.ctx.storage.get<PdfBox[]>(`pdfBoxes:${meta.id}`)) ?? [];
        for (const b of boxes) {
          if (out.hits.length >= limit) break;
          if (b.text && all(b.text)) out.hits.push({ kind: "pdf", id: meta.id, name: meta.name, snippet: snippet(b.text), page: b.page + 1, note: true });
        }
        for (let i = 0; i < pages.length && out.hits.length < limit; i++) {
          if (pages[i] && all(pages[i])) out.hits.push({ kind: "pdf", id: meta.id, name: meta.name, snippet: snippet(pages[i]), page: i + 1 });
        }
      }
    }
    return out;
  }

  /** The words on each PDF page (read in the browser with PDF.js), so PDFs can be searched. */
  async setPdfText(id: string, pages: string[]): Promise<boolean> {
    const all = await this.pdfIndex();
    const meta = all.find((p) => p.id === id);
    if (!meta) return false;
    let budget = 1_700_000; // stored values are capped at 2 MB
    const clean = pages.slice(0, 2000).map((t) => {
      const v = String(t ?? "").replace(/\s+/g, " ").trim().slice(0, Math.max(0, Math.min(6000, budget)));
      budget -= v.length;
      return v;
    });
    meta.textIndexed = true;
    await this.ctx.storage.put({ [`pdfText:${id}`]: clean, pdfIndex: all });
    return true;
  }

  // ---------- handwriting (ink) ----------

  /** Ids of blocks that have handwriting on them. */
  inkAnchors(nb: string): string[] {
    return this.ctx.storage.sql.exec<{ anchor: string }>("SELECT DISTINCT anchor FROM ink WHERE nb = ?", nb).toArray().map((r) => r.anchor);
  }

  async getNotebookWithInk(id: string): Promise<(Notebook & { inkAnchors: string[]; meta?: NotebookMeta; trashed?: boolean }) | null> {
    const nb = await this.getNotebook(id);
    if (!nb) return null;
    const meta = (await this.index()).find((n) => n.id === id);
    const trashed = !meta && (await this.trashIndex()).some((n) => n.id === id);
    if (!meta && !trashed) return null;
    return { ...nb, inkAnchors: this.inkAnchors(id), meta: meta ?? (await this.trashIndex()).find((n) => n.id === id), trashed: trashed || undefined };
  }

  /** Strokes for the given blocks, in drawing order. Only what's on screen is requested. */
  getInk(nb: string, anchors: string[]): Record<string, InkStroke[]> {
    const out: Record<string, InkStroke[]> = {};
    const list = anchors.slice(0, 200);
    if (!list.length) return out;
    const rows = this.ctx.storage.sql
      .exec<{ anchor: string; data: string }>(`SELECT anchor, data FROM ink WHERE nb = ? AND anchor IN (${list.map(() => "?").join(",")}) ORDER BY rowid`, nb, ...list)
      .toArray();
    for (const a of list) out[a] = [];
    for (const r of rows) out[r.anchor].push(JSON.parse(r.data));
    return out;
  }

  async applyInk(nb: string, add: { anchor: string; stroke: InkStroke }[], remove: { anchor: string; id: string }[], clientId: string): Promise<boolean> {
    if (!(await this.docExists(nb))) return false;
    const sql = this.ctx.storage.sql;
    const touched = new Set<string>();
    // Removals first, then additions: changing a stroke is "remove old + add new" with the same id.
    for (const { anchor, id } of remove) {
      sql.exec("DELETE FROM ink WHERE nb = ? AND id = ?", nb, id);
      touched.add(anchor);
    }
    for (const { anchor, stroke } of add) {
      sql.exec("INSERT OR REPLACE INTO ink (nb, id, anchor, data) VALUES (?, ?, ?, ?)", nb, stroke.id, anchor, JSON.stringify(stroke));
      touched.add(anchor);
    }
    for (const a of touched) sql.exec("INSERT OR IGNORE INTO ink_dirty (nb, anchor) VALUES (?, ?)", nb, a);
    this.broadcast(nb, { type: "ink", add, remove, clientId });
    await this.scheduleSync();
    return true;
  }

  // ---------- handwriting for assistants ----------

  /** Everything handwritten in a notebook, in reading order: whole pages, and notes written over other blocks. */
  async handwrittenItems(nbId: string): Promise<{ n: number; anchor: string; label: string; isPage: boolean; height: number }[]> {
    const nb = await this.getNotebook(nbId);
    if (!nb) return [];
    const inked = new Set(this.inkAnchors(nbId));
    const out: { n: number; anchor: string; label: string; isPage: boolean; height: number }[] = [];
    let page = 0;
    for (const b of nb.blocks) {
      if (b.type === "page") page++;
      if (!inked.has(b.id)) continue;
      const isPage = b.type === "page";
      const text = blockText(b).replace(/\s+/g, " ").trim();
      out.push({
        n: out.length + 1,
        anchor: b.id,
        isPage,
        height: isPage ? Number(b.props.height) || 1414 : 0,
        label: isPage ? `Handwritten page ${page}` : `Handwriting on "${text.slice(0, 60) || b.type}${text.length > 60 ? "…" : ""}"`,
      });
    }
    return out;
  }

  /** PNG pictures of handwriting, for an assistant to read. */
  async renderHandwriting(nbId: string, which: number[]): Promise<{ n: number; label: string; png: string }[]> {
    const items = await this.handwrittenItems(nbId);
    const out: { n: number; label: string; png: string }[] = [];
    for (const n of which) {
      const it = items.find((i) => i.n === n);
      if (!it) continue;
      const strokes = this.getInk(nbId, [it.anchor])[it.anchor];
      const b = inkBounds(strokes);
      if (!b) continue;
      const pad = 30;
      // Pages: the whole page (width 1000 units). Notes on other blocks: just the written area.
      const area = it.isPage
        ? { x0: Math.min(0, b.x0 - pad), y0: Math.min(0, b.y0 - pad), x1: Math.max(1000, b.x1 + pad), y1: Math.max(it.height, b.y1 + pad) }
        : { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad };
      out.push({ n, label: it.label, png: toBase64(await renderInkPng(strokes, area, 900)) });
    }
    return out;
  }

  /**
   * Puts typed text right after a handwritten page (or block), written by an assistant from
   * reading the handwriting. Optionally removes the handwriting (and the then-empty page).
   */
  async convertHandwriting(nbId: string, n: number, text: string, removeHandwriting: boolean, by: string): Promise<{ label: string } | null> {
    const it = (await this.handwrittenItems(nbId)).find((i) => i.n === n);
    if (!it) return null;
    const nb = (await this.getNotebook(nbId))!;
    const blocks = markdownToBlocks(text);
    if (!blocks.length) throw new Error("No text to add.");
    const at = Date.now();
    nb.version++;
    for (const b of blocks) {
      nb.addedAt[b.id] = nb.version;
      nb.aiBlocks[b.id] = { by, at };
    }
    const idx = nb.blocks.findIndex((b) => b.id === it.anchor);
    nb.blocks.splice(idx + 1, 0, ...blocks);
    await this.store(nb, { type: "append", blocks, after: it.anchor, aiBlocks: Object.fromEntries(blocks.map((b) => [b.id, { by, at }])) });

    if (removeHandwriting) {
      const ids = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM ink WHERE nb = ? AND anchor = ?", nbId, it.anchor).toArray();
      await this.applyInk(nbId, [], ids.map((r) => ({ anchor: it.anchor, id: r.id })), "assistant");
      if (it.isPage) {
        const fresh = (await this.getNotebook(nbId))!;
        fresh.blocks = fresh.blocks.filter((b) => b.id !== it.anchor);
        fresh.version++;
        await this.store(fresh, { type: "patch", upserts: [], deletes: [it.anchor], order: fresh.blocks.map((b) => b.id), aiBlocks: fresh.aiBlocks, clientId: "assistant" });
      }
    }
    return { label: it.label };
  }

  // ---------- PDFs (separate from notebooks; assistants can't see or change them) ----------

  async docExists(id: string): Promise<boolean> {
    return (await this.index()).some((n) => n.id === id) || (await this.pdfIndex()).some((p) => p.id === id);
  }

  private async pdfIndex(): Promise<PdfMeta[]> {
    return (await this.ctx.storage.get<PdfMeta[]>("pdfIndex")) ?? [];
  }

  async listPdfs(): Promise<PdfMeta[]> {
    return (await this.pdfIndex()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async uploadPdf(name: string, bytes: ArrayBuffer): Promise<PdfMeta | { error: string }> {
    const head = new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength)));
    if (!head.includes("%PDF-")) return { error: "That file isn't a PDF." };
    if (bytes.byteLength > MAX_PDF_BYTES) return { error: "PDFs must be 25 MB or smaller." };
    const id = "pdf" + shortId();
    const sql = this.ctx.storage.sql;
    for (let i = 0, idx = 0; i < bytes.byteLength; i += PDF_CHUNK, idx++)
      sql.exec("INSERT INTO pdf_chunks (id, idx, data) VALUES (?, ?, ?)", id, idx, bytes.slice(i, i + PDF_CHUNK));
    const now = Date.now();
    const clean = name.replace(/\.pdf$/i, "").trim().slice(0, 120) || "Untitled";
    const meta: PdfMeta = { id, name: clean, size: bytes.byteLength, createdAt: now, updatedAt: now };
    await this.ctx.storage.put("pdfIndex", [...(await this.pdfIndex()), meta]);
    await this.markPdfDirty(id, "file");
    return meta;
  }

  async getPdf(id: string): Promise<{ meta: PdfMeta; boxes: PdfBox[]; inkAnchors: string[] } | null> {
    const meta = (await this.pdfIndex()).find((p) => p.id === id);
    if (!meta) return null;
    return { meta, boxes: (await this.ctx.storage.get<PdfBox[]>(`pdfBoxes:${id}`)) ?? [], inkAnchors: this.inkAnchors(id) };
  }

  /** Cover picture for the library: a small JPEG of page 1, made in the browser. */
  async setPdfThumb(id: string, jpeg: ArrayBuffer, pages?: number): Promise<boolean> {
    const all = await this.pdfIndex();
    const meta = all.find((p) => p.id === id);
    if (!meta || jpeg.byteLength > 200_000) return false;
    const head = new Uint8Array(jpeg, 0, 3);
    if (!(head[0] === 0xff && head[1] === 0xd8)) return false; // JPEG only
    meta.thumb = true;
    if (pages && pages > 0) meta.pages = Math.floor(pages);
    await this.ctx.storage.put({ [`pdfThumb:${id}`]: jpeg, pdfIndex: all });
    return true;
  }

  async getPdfThumb(id: string): Promise<ArrayBuffer | null> {
    return (await this.ctx.storage.get<ArrayBuffer>(`pdfThumb:${id}`)) ?? null;
  }

  async saveBoxes(id: string, boxes: PdfBox[], clientId: string): Promise<boolean> {
    const all = await this.pdfIndex();
    const meta = all.find((p) => p.id === id);
    if (!meta) return false;
    const clean = boxes.slice(0, 5000).map((b) => ({
      id: String(b.id).slice(0, 40),
      page: Math.max(0, Math.floor(Number(b.page) || 0)),
      x: Math.min(1, Math.max(0, Number(b.x) || 0)),
      y: Math.min(1, Math.max(0, Number(b.y) || 0)),
      w: Math.min(1, Math.max(0.05, Number(b.w) || 0.3)),
      text: String(b.text ?? "").slice(0, 20_000),
      size: Math.min(72, Math.max(8, Number(b.size) || 14)),
      color: String(b.color ?? "ink").slice(0, 16),
    }));
    if (JSON.stringify(clean).length > MAX_NOTEBOOK_BYTES) throw new Error("Too much text on this PDF.");
    meta.updatedAt = Date.now();
    await this.ctx.storage.put({ [`pdfBoxes:${id}`]: clean, pdfIndex: all });
    this.broadcast(id, { type: "boxes", boxes: clean, clientId });
    await this.markPdfDirty(id, "notes");
    return true;
  }

  async renamePdf(id: string, name: string): Promise<PdfMeta | null> {
    return this.updatePdf(id, { name });
  }

  async updatePdf(id: string, ch: { name?: string; topic?: string }): Promise<PdfMeta | null> {
    const all = await this.pdfIndex();
    const meta = all.find((p) => p.id === id);
    if (!meta) return null;
    const renamed = ch.name !== undefined && ch.name.trim() && ch.name.trim() !== meta.name;
    if (renamed) meta.name = ch.name!.trim().slice(0, 120);
    if (ch.topic !== undefined) meta.topic = cleanTopic(ch.topic);
    meta.updatedAt = Date.now();
    await this.ctx.storage.put("pdfIndex", all);
    if (renamed) await this.markPdfDirty(id, "file");
    return meta;
  }

  /** Every topic in use, A to Z. */
  async topics(): Promise<string[]> {
    const t = new Set<string>();
    for (const n of await this.index()) if (n.topic) t.add(n.topic);
    for (const p of await this.pdfIndex()) if (p.topic) t.add(p.topic);
    return [...t].sort((a, b) => a.localeCompare(b));
  }

  async deletePdf(id: string): Promise<boolean> {
    const all = await this.pdfIndex();
    const meta = all.find((p) => p.id === id);
    if (!meta) return false;
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM pdf_chunks WHERE id = ?", id);
    sql.exec("DELETE FROM ink WHERE nb = ?", id);
    sql.exec("DELETE FROM ink_dirty WHERE nb = ?", id);
    sql.exec("DELETE FROM ink_files WHERE nb = ?", id);
    const inkFolder = await this.ctx.storage.get<string>(`inkFolder:${id}`);
    await this.ctx.storage.delete([`pdfBoxes:${id}`, `inkFolder:${id}`, `pdfThumb:${id}`, `pdfText:${id}`]);
    await this.ctx.storage.put("pdfIndex", all.filter((p) => p.id !== id));
    const dirty = ((await this.ctx.storage.get<string[]>("pdfDirty")) ?? []).filter((k) => !k.startsWith(id + ":"));
    await this.ctx.storage.put("pdfDirty", dirty);
    if (await this.hasRefreshToken()) {
      const d = this.drive();
      for (const f of [meta.driveFileId, meta.driveNotesId, inkFolder]) if (f) await d.trash(f).catch(() => {});
    }
    this.broadcast(id, { type: "deleted" });
    return true;
  }

  private pdfBytes(id: string): Uint8Array[] {
    return this.ctx.storage.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM pdf_chunks WHERE id = ? ORDER BY idx", id)
      .toArray()
      .map((r) => new Uint8Array(r.data));
  }

  private async markPdfDirty(id: string, what: "file" | "notes") {
    const dirty = new Set((await this.ctx.storage.get<string[]>("pdfDirty")) ?? []);
    dirty.add(`${id}:${what}`);
    await this.ctx.storage.put("pdfDirty", [...dirty]);
    await this.scheduleSync();
  }

  /** Copies PDFs to Drive / Noty / PDF, with their text boxes in "<name>.notes.json". Returns true if more is waiting. */
  private async syncPdfsToDrive(): Promise<boolean> {
    const dirty = (await this.ctx.storage.get<string[]>("pdfDirty")) ?? [];
    if (!dirty.length) return false;
    const d = this.drive();
    const { root } = await this.folders();
    let folder = await this.ctx.storage.get<string>("pdfFolder");
    if (!folder) {
      folder = await d.folder("PDF", root);
      await this.ctx.storage.put("pdfFolder", folder);
    }
    const done: string[] = [];
    for (const key of dirty.slice(0, 5)) {
      const [id, what] = key.split(":");
      const all = await this.pdfIndex();
      const meta = all.find((p) => p.id === id);
      if (!meta) {
        done.push(key);
        continue;
      }
      const base = safeFileName(meta.name);
      if (what === "file") {
        const blob = new Blob(this.pdfBytes(id), { type: "application/pdf" });
        meta.driveFileId = await d.uploadLarge({ name: `${base}.pdf`, parent: folder, mimeType: "application/pdf", body: blob, fileId: meta.driveFileId });
      } else {
        const boxes = (await this.ctx.storage.get<PdfBox[]>(`pdfBoxes:${id}`)) ?? [];
        meta.driveNotesId = await d.upload({
          name: `${base}.notes.json`,
          parent: folder,
          mimeType: "application/json",
          body: JSON.stringify({ format: "noty-pdf-notes/1", pdf: `${base}.pdf`, id, boxes }),
          fileId: meta.driveNotesId,
        });
      }
      const fresh = await this.pdfIndex();
      const m = fresh.find((p) => p.id === id);
      if (m) {
        m.driveFileId = meta.driveFileId;
        m.driveNotesId = meta.driveNotesId;
        await this.ctx.storage.put("pdfIndex", fresh);
      }
      done.push(key);
    }
    const left = ((await this.ctx.storage.get<string[]>("pdfDirty")) ?? []).filter((k) => !done.includes(k));
    await this.ctx.storage.put("pdfDirty", left);
    return left.length > 0;
  }

  // ---------- images ----------

  /**
   * Images are always kept in Noty first (works without Google, and a Drive hiccup can't fail the
   * upload), then copied to Drive / Noty / images in the background when Drive is connected.
   */
  async uploadImage(bytes: ArrayBuffer, mimeType: string, name: string): Promise<string> {
    const url = await this.saveLocalImage(bytes, mimeType);
    const id = url.split("/").pop()!;
    await this.ctx.storage.put(`imgName:${id}`, safeFileName(name));
    await this.queueImageForDrive([id]);
    return url;
  }

  private async queueImageForDrive(ids: string[]) {
    if (!ids.length) return;
    const q = new Set((await this.ctx.storage.get<string[]>("imgDirty")) ?? []);
    ids.forEach((i) => q.add(i));
    await this.ctx.storage.put("imgDirty", [...q]);
    await this.scheduleSync();
  }

  /** Copies images kept in Noty to Drive. Returns true if more are waiting. */
  private async syncImagesToDrive(batch = 8): Promise<boolean> {
    const q = (await this.ctx.storage.get<string[]>("imgDirty")) ?? [];
    if (!q.length) return false;
    const { images } = await this.folders();
    const d = this.drive();
    const done: string[] = [];
    for (const id of q.slice(0, batch)) {
      const img = await this.loadLocalImage(id);
      if (img && !(await this.ctx.storage.get(`imgDrive:${id}`))) {
        const ext = (img.mimeType.split("/")[1] ?? "png").replace("svg+xml", "svg").replace("jpeg", "jpg");
        const base = ((await this.ctx.storage.get<string>(`imgName:${id}`)) ?? id).replace(/\.[a-z0-9]+$/i, "");
        const driveId = await d.upload({ name: `${base}.${ext}`, parent: images, mimeType: img.mimeType, body: img.body });
        await this.ctx.storage.put(`imgDrive:${id}`, driveId);
      }
      done.push(id);
    }
    const left = ((await this.ctx.storage.get<string[]>("imgDirty")) ?? []).filter((i) => !done.includes(i));
    await this.ctx.storage.put("imgDirty", left);
    return left.length > 0;
  }

  // Durable Object values are capped at 2 MB, so images are stored in chunks.
  private async saveLocalImage(bytes: ArrayBuffer, mimeType: string): Promise<string> {
    const id = `local-${shortId()}`;
    const CHUNK = 1_000_000;
    const entries: Record<string, unknown> = {};
    let n = 0;
    for (let off = 0; off < bytes.byteLength; off += CHUNK, n++) entries[`img:${id}:${n}`] = bytes.slice(off, off + CHUNK);
    entries[`img:${id}`] = { mimeType, chunks: n };
    entries.imgIndex = [...((await this.ctx.storage.get<string[]>("imgIndex")) ?? []), id];
    await this.ctx.storage.put(entries);
    return `/api/files/${id}`;
  }

  private async loadLocalImage(id: string): Promise<{ mimeType: string; body: Uint8Array } | null> {
    const meta = await this.ctx.storage.get<{ mimeType: string; chunks: number }>(`img:${id}`);
    if (!meta) return null;
    const keys = Array.from({ length: meta.chunks }, (_, i) => `img:${id}:${i}`);
    const parts = await this.ctx.storage.get<ArrayBuffer>(keys);
    const bufs = keys.map((k) => new Uint8Array(parts.get(k) ?? new ArrayBuffer(0)));
    const body = new Uint8Array(bufs.reduce((s, b) => s + b.byteLength, 0));
    let off = 0;
    for (const b of bufs) body.set(b, (off += b.byteLength) - b.byteLength);
    return { mimeType: meta.mimeType, body };
  }

  // ---------- Drive mirror ----------

  private async markDirty(id: string) {
    const dirty = new Set((await this.ctx.storage.get<string[]>("dirty")) ?? []);
    dirty.add(id);
    await this.ctx.storage.put("dirty", [...dirty]);
    await this.scheduleSync();
  }

  private async scheduleSync() {
    const current = await this.ctx.storage.getAlarm();
    if (!current && (await this.hasRefreshToken())) await this.ctx.storage.setAlarm(Date.now() + DRIVE_DEBOUNCE_MS);
  }

  async alarm() {
    await this.purgeOldTrash().catch((e) => console.error("trash purge failed", e));
    const dirty = (await this.ctx.storage.get<string[]>("dirty")) ?? [];
    const failed: string[] = [];
    let signedOut = false;
    for (const id of dirty) {
      try {
        await this.writeToDrive(id);
      } catch (e) {
        failed.push(id);
        if (e instanceof NeedsSignInError) {
          // No point retrying until the person signs in again; setGoogleAuth() restarts the sync.
          signedOut = true;
          console.warn("Drive sync paused until next Google sign-in");
          break;
        }
        console.error("Drive sync failed for", id, e);
      }
    }
    // Anything marked dirty while we were writing is still in storage; keep it plus the failures.
    const now = new Set((await this.ctx.storage.get<string[]>("dirty")) ?? []);
    for (const id of dirty) if (!failed.includes(id)) now.delete(id);
    if (signedOut) for (const id of dirty) now.add(id);
    for (const id of failed) now.add(id);
    await this.ctx.storage.put("dirty", [...now]);

    let inkLeft = false;
    let inkFailed = false;
    if (!signedOut) {
      try {
        inkLeft = await this.syncInkToDrive();
        inkLeft = (await this.syncPdfsToDrive()) || inkLeft;
        inkLeft = (await this.syncImagesToDrive()) || inkLeft;
      } catch (e) {
        if (e instanceof NeedsSignInError) signedOut = true;
        else (inkFailed = true), console.error("Ink sync failed", e);
      }
    }
    const more = now.size > 0 || inkLeft || inkFailed;
    if (more && !signedOut) await this.ctx.storage.setAlarm(Date.now() + (failed.length || inkFailed ? DRIVE_RETRY_MS : DRIVE_DEBOUNCE_MS));
  }

  private async writeToDrive(id: string) {
    const nb = await this.getNotebook(id);
    if (!nb) return;
    const { root } = await this.folders();
    const d = this.drive();
    const all = await this.index();
    const meta = all.find((n) => n.id === id);
    if (!meta) return;
    const base = safeFileName(nb.name);
    meta.driveJsonId = await d.upload({
      name: `${base}.noty.json`,
      parent: root,
      mimeType: "application/json",
      body: JSON.stringify({ format: "noty/1", ...nb }),
      fileId: meta.driveJsonId,
    });
    const md = `# ${nb.name}\n\n${blocksToMarkdown(nb.blocks).replace(/\]\(\/api\/files\//g, `](${this.env.PUBLIC_URL}/api/files/`)}\n`;
    meta.driveMdId = await d.upload({ name: `${base}.md`, parent: root, mimeType: "text/markdown", body: md, fileId: meta.driveMdId });
    // Re-read the index: it may have changed while we were uploading.
    const fresh = await this.index();
    const m = fresh.find((n) => n.id === id);
    if (m) {
      m.driveJsonId = meta.driveJsonId;
      m.driveMdId = meta.driveMdId;
      await this.ctx.storage.put("index", fresh);
    }
  }

  /** Copies changed handwriting to Drive / Noty / ink / <notebook id> / <block id>.json. Returns true if more is waiting. */
  private async syncInkToDrive(batch = 150): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const dirty = sql.exec<{ nb: string; anchor: string }>("SELECT nb, anchor FROM ink_dirty LIMIT ?", batch).toArray();
    if (!dirty.length) return false;
    const d = this.drive();
    const { root } = await this.folders();
    for (const { nb, anchor } of dirty) {
      let folder = await this.ctx.storage.get<string>(`inkFolder:${nb}`);
      if (!folder) {
        const inkRoot = await d.folder("ink", root);
        folder = await d.folder(nb, inkRoot);
        await this.ctx.storage.put(`inkFolder:${nb}`, folder);
      }
      const rows = sql.exec<{ data: string }>("SELECT data FROM ink WHERE nb = ? AND anchor = ? ORDER BY rowid", nb, anchor).toArray();
      const file = sql.exec<{ file_id: string }>("SELECT file_id FROM ink_files WHERE nb = ? AND anchor = ?", nb, anchor).toArray()[0]?.file_id;
      if (!rows.length) {
        if (file) await d.trash(file);
        sql.exec("DELETE FROM ink_files WHERE nb = ? AND anchor = ?", nb, anchor);
      } else {
        const body = `{"format":"noty-ink/1","anchor":${JSON.stringify(anchor)},"strokes":[${rows.map((r) => r.data).join(",")}]}`;
        const id = await d.upload({ name: `${anchor}.json`, parent: folder, mimeType: "application/json", body, fileId: file });
        sql.exec("INSERT OR REPLACE INTO ink_files (nb, anchor, file_id) VALUES (?, ?, ?)", nb, anchor, id);
      }
      sql.exec("DELETE FROM ink_dirty WHERE nb = ? AND anchor = ?", nb, anchor);
    }
    return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ink_dirty").one().n > 0;
  }

  private async restoreInk(nb: string, root: string) {
    const d = this.drive();
    const inkRoot = await d.find("ink", root, "application/vnd.google-apps.folder");
    if (!inkRoot) return;
    const folder = await d.find(nb, inkRoot.id, "application/vnd.google-apps.folder");
    if (!folder) return;
    await this.ctx.storage.put(`inkFolder:${nb}`, folder.id);
    const sql = this.ctx.storage.sql;
    for (const f of await d.list(folder.id)) {
      if (!f.name.endsWith(".json")) continue;
      try {
        const data = (await (await d.download(f.id)).json()) as { anchor: string; strokes: InkStroke[] };
        for (const st of data.strokes ?? []) sql.exec("INSERT OR REPLACE INTO ink (nb, id, anchor, data) VALUES (?, ?, ?, ?)", nb, st.id, data.anchor, JSON.stringify(st));
        sql.exec("INSERT OR REPLACE INTO ink_files (nb, anchor, file_id) VALUES (?, ?, ?)", nb, data.anchor, f.id);
      } catch (e) {
        console.error("Skipping unreadable ink file", f.name, e);
      }
    }
  }

  /** After signing in on a fresh deployment, bring back notebooks already saved in Drive / Noty. */
  private async restoreFromDrive() {
    if ((await this.index()).length) return void (await this.ctx.storage.put("restored", true));
    const { root } = await this.folders();
    const d = this.drive();
    const files = (await d.list(root)).filter((f) => f.name.endsWith(".noty.json"));
    const index: NotebookMeta[] = [];
    for (const f of files) {
      try {
        const nb = (await (await d.download(f.id)).json()) as Notebook & { format?: string };
        if (!nb.id || !Array.isArray(nb.blocks)) continue;
        const clean: Notebook = { id: nb.id, name: nb.name, blocks: nb.blocks, version: nb.version ?? 1, addedAt: {}, aiBlocks: nb.aiBlocks ?? {} };
        await this.ctx.storage.put(`nb:${nb.id}`, clean);
        const t = Date.parse(f.modifiedTime ?? "") || Date.now();
        index.push({ id: nb.id, name: nb.name, createdAt: t, updatedAt: t, blockCount: nb.blocks.length, driveJsonId: f.id });
        await this.restoreInk(nb.id, root).catch((e) => console.error("ink restore failed", e));
      } catch (e) {
        console.error("Skipping unreadable Drive file", f.name, e);
      }
    }
    await this.ctx.storage.put({ index, restored: true });
  }

  // ---------- HTTP: live updates and image proxy ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const nb = url.searchParams.get("nb") ?? "";
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, [nb]);
      return new Response(null, { status: 101, webSocket: client });
    }
    const pdf = url.pathname.match(/^\/pdf\/([\w-]+)$/);
    if (pdf) {
      const parts = this.pdfBytes(pdf[1]);
      if (!parts.length) return new Response("PDF not found", { status: 404 });
      return new Response(new Blob(parts), {
        headers: { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
      });
    }
    const file = url.pathname.match(/^\/file\/([\w-]+)$/);
    if (file) {
      try {
        const local = file[1].startsWith("local-") ? await this.loadLocalImage(file[1]) : null;
        if (file[1].startsWith("local-") && !local) return new Response("Image not found", { status: 404 });
        const res = local ? new Response(local.body, { headers: { "Content-Type": local.mimeType } }) : await this.drive().download(file[1]);
        return new Response(res.body, {
          headers: {
            "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream",
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          },
        });
      } catch {
        return new Response("Image not found in Drive", { status: 404 });
      }
    }
    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (msg === "ping") ws.send("pong");
  }

  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "bye");
    } catch {}
  }

  private broadcast(notebookId: string, event: Record<string, unknown>) {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets(notebookId)) {
      try {
        ws.send(data);
      } catch {}
    }
  }
}
