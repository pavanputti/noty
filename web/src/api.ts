import type { Block } from "../../src/shared/blocks";

export interface Me {
  email: string;
  name?: string;
  picture?: string;
  mcpUrl: string;
  drive: { connected: boolean; email?: string };
  googleAvailable: boolean;
}
export interface NotebookMeta {
  id: string;
  name: string;
  updatedAt: number;
  blockCount: number;
  icon?: string;
  cover?: string;
  favorite?: boolean;
  topic?: string;
  deletedAt?: number;
  /** Text style; empty = the default, neat handwriting. */
  font?: NotebookFont;
}
export type NotebookFont = "print" | "hand" | "neat";
export interface Snapshot {
  ts: number;
  blockCount: number;
}
export interface Notebook {
  id: string;
  name: string;
  blocks: Block[];
  version: number;
  addedAt: Record<string, number>;
  aiBlocks: Record<string, { by: string; at: number }>;
  inkAnchors: string[];
  meta?: NotebookMeta;
  trashed?: boolean;
}
export interface PdfMeta {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  thumb?: boolean;
  pages?: number;
  textIndexed?: boolean;
  topic?: string;
}
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

export interface SearchResult {
  notebooks: { id: string; name: string; updatedAt: number }[];
  pdfs: { id: string; name: string; updatedAt: number }[];
  hits: { kind: "notebook" | "pdf"; id: string; name: string; snippet: string; blockId?: string; page?: number; note?: boolean }[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.error ?? "error", body.message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  me: () => call<Me>("/me"),
  notebooks: () => call<NotebookMeta[]>("/notebooks"),
  create: (name: string, topic?: string) => call<NotebookMeta>("/notebooks", { method: "POST", body: JSON.stringify({ name, topic }) }),
  topics: () => call<string[]>("/topics"),
  updatePdf: (id: string, ch: { name?: string; topic?: string }) => call<PdfMeta>(`/pdfs/${id}`, { method: "PATCH", body: JSON.stringify(ch) }),
  get: (id: string) => call<Notebook>(`/notebooks/${id}`),
  save: (id: string, patch: { upserts: unknown[]; deletes: string[]; order: string[]; baseVersion: number }, clientId: string) =>
    call<{ version: number }>(`/notebooks/${id}`, { method: "PUT", body: JSON.stringify({ ...patch, clientId }) }),
  rename: (id: string, name: string) => call<NotebookMeta>(`/notebooks/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  update: (id: string, ch: { name?: string; icon?: string; cover?: string; favorite?: boolean; topic?: string; font?: string }) => call<NotebookMeta>(`/notebooks/${id}`, { method: "PATCH", body: JSON.stringify(ch) }),
  trash: () => call<NotebookMeta[]>("/trash"),
  restore: (id: string) => call<NotebookMeta>(`/trash/${id}/restore`, { method: "POST" }),
  purge: (id: string) => call<{ ok: boolean }>(`/trash/${id}`, { method: "DELETE" }),
  history: (id: string) => call<Snapshot[]>(`/notebooks/${id}/history`),
  snapshot: (id: string, ts: number) => call<{ blocks: import("../../src/shared/blocks").Block[] }>(`/notebooks/${id}/history/${ts}`),
  restoreSnapshot: (id: string, ts: number) => call<{ version: number }>(`/notebooks/${id}/history/${ts}/restore`, { method: "POST" }),
  backlinks: (id: string) => call<{ id: string; name: string; icon?: string }[]>(`/notebooks/${id}/backlinks`),
  remove: (id: string) => call<{ ok: boolean }>(`/notebooks/${id}`, { method: "DELETE" }),
  getInk: (id: string, anchors: string[]) =>
    call<Record<string, import("./ink").InkStroke[]>>(`/notebooks/${id}/ink?anchors=${encodeURIComponent(anchors.join(","))}`),
  saveInk: (id: string, change: { add: unknown[]; remove: { anchor: string; id: string }[] }, clientId: string) =>
    call<{ ok: boolean }>(`/notebooks/${id}/ink`, { method: "POST", body: JSON.stringify({ ...change, clientId }) }),
  listPdfs: () => call<PdfMeta[]>("/pdfs"),
  uploadPdf: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<PdfMeta>("/pdfs", { method: "POST", body: form });
  },
  getPdf: (id: string) => call<{ meta: PdfMeta; boxes: PdfBox[]; inkAnchors: string[] }>(`/pdfs/${id}`),
  pdfFileUrl: (id: string) => `/api/pdfs/${id}/file`,
  pdfThumbUrl: (id: string) => `/api/pdfs/${id}/thumb`,
  savePdfThumb: (id: string, jpeg: Blob, pages: number) => call<{ ok: boolean }>(`/pdfs/${id}/thumb?pages=${pages}`, { method: "PUT", body: jpeg, headers: { "Content-Type": "image/jpeg" } }),
  saveBoxes: (id: string, boxes: PdfBox[], clientId: string) => call<{ ok: boolean }>(`/pdfs/${id}/boxes`, { method: "PUT", body: JSON.stringify({ boxes, clientId }) }),
  renamePdf: (id: string, name: string) => call<PdfMeta>(`/pdfs/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  removePdf: (id: string) => call<{ ok: boolean }>(`/pdfs/${id}`, { method: "DELETE" }),
  search: (q: string) => call<SearchResult>(`/search?q=${encodeURIComponent(q)}`),
  savePdfText: (id: string, pages: string[]) => call<{ ok: boolean }>(`/pdfs/${id}/text`, { method: "PUT", body: JSON.stringify({ pages }) }),
  upload: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return (await call<{ url: string }>("/upload", { method: "POST", body: form })).url;
  },
};

export const liveUrl = (id: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/notebooks/${id}/live`;
export const pdfLiveUrl = (id: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/pdfs/${id}/live`;
