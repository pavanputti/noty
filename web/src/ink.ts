// Handwriting data: strokes pinned to blocks, loaded only for blocks near the screen,
// saved in small batches, and kept in sync with other devices over the live connection.

import { getStroke } from "perfect-freehand";
import { api } from "./api";

export interface InkStroke {
  id: string;
  /** colour key */ c: string;
  /** pen size, in units where the block width is 1000 */ s: number;
  /** "h" = highlighter */ t?: "h";
  /** points: x, y, pressure(0–100) as deltas, comma-separated */ d: string;
}
export type InkTool = "type" | "pen" | "highlighter" | "eraser" | "lasso";

// ---------- point encoding (deltas keep long notebooks small) ----------

export function encodePoints(flat: number[]): string {
  const out: number[] = [];
  for (let i = 0; i < flat.length; i += 3) {
    if (i === 0) out.push(flat[0], flat[1], flat[2]);
    else out.push(flat[i] - flat[i - 3], flat[i + 1] - flat[i - 2], flat[i + 2] - flat[i - 1]);
  }
  return out.join(",");
}

const decoded = new WeakMap<InkStroke, number[]>();
export function decodePoints(st: InkStroke): number[] {
  let v = decoded.get(st);
  if (v) return v;
  const n = st.d.split(",").map(Number);
  for (let i = 3; i < n.length; i++) n[i] += n[i - 3];
  decoded.set(st, n);
  return n;
}

// ---------- rendering ----------

const avg = (a: number, b: number) => (a + b) / 2;
function outlineToPath(pts: number[][]): string {
  if (pts.length < 4) return "";
  let [a, b] = pts;
  const c = pts[2];
  let d = `M${a[0].toFixed(1)},${a[1].toFixed(1)} Q${b[0].toFixed(1)},${b[1].toFixed(1)} ${avg(b[0], c[0]).toFixed(1)},${avg(b[1], c[1]).toFixed(1)} T`;
  for (let i = 2; i < pts.length - 1; i++) {
    a = pts[i];
    b = pts[i + 1];
    d += `${avg(a[0], b[0]).toFixed(1)},${avg(a[1], b[1]).toFixed(1)} `;
  }
  return d + "Z";
}

const paths = new WeakMap<InkStroke, string>();
export function strokePath(st: InkStroke, flat?: number[], live = false): string {
  if (!live) {
    const c = paths.get(st);
    if (c) return c;
  }
  const p = flat ?? decodePoints(st);
  const pts: [number, number, number][] = [];
  for (let i = 0; i + 2 < p.length; i += 3) pts.push([p[i], p[i + 1], p[i + 2] / 100]);
  const hi = st.t === "h";
  const d = outlineToPath(
    getStroke(pts, {
      size: hi ? st.s * 3 : st.s,
      thinning: hi ? 0 : 0.6,
      smoothing: 0.55,
      streamline: 0.45,
      simulatePressure: pts.every((q) => q[2] === 50 / 100),
      last: !live,
    }),
  );
  if (!live) paths.set(st, d);
  return d;
}

export function strokeHit(st: InkStroke, x: number, y: number, r: number): boolean {
  const p = decodePoints(st);
  const rr = (r + st.s) ** 2;
  for (let i = 0; i + 2 < p.length; i += 3) if ((p[i] - x) ** 2 + (p[i + 1] - y) ** 2 < rr) return true;
  return false;
}

// ---------- store ----------

type Change = { add: { anchor: string; stroke: InkStroke }[]; remove: { anchor: string; id: string; /** kept so undo can bring it back */ stroke?: InkStroke }[] };

export class InkStore {
  /** anchor block id → strokes in drawing order */
  private strokes = new Map<string, InkStroke[]>();
  /** blocks that have handwriting on the server (whether or not loaded here yet) */
  readonly inked: Set<string>;
  private loaded = new Set<string>();
  private loading = new Set<string>();
  private listeners = new Set<() => void>();
  /** Changes not yet on the server: stroke id → its latest state. Kept on this device until sent (works offline). */
  private pending = new Map<string, { anchor: string; stroke?: InkStroke }>();
  private get queueKey() {
    return `noty:inkq:${this.notebookId}`;
  }
  private timer = 0;
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  onSaveState?: (state: "saving" | "saved" | "error") => void;

  constructor(
    private notebookId: string,
    inkAnchors: string[],
    private clientId: string,
  ) {
    this.inked = new Set(inkAnchors);
    try {
      const saved = JSON.parse(localStorage.getItem(this.queueKey) ?? "[]") as [string, { anchor: string; stroke?: InkStroke }][];
      if (saved.length) {
        this.pending = new Map(saved);
        // Show strokes drawn earlier (e.g. offline) right away, then send them.
        this.apply({
          add: saved.flatMap(([, v]) => (v.stroke ? [{ anchor: v.anchor, stroke: v.stroke }] : [])),
          remove: saved.flatMap(([id, v]) => (v.stroke ? [] : [{ anchor: v.anchor, id }])),
        });
        setTimeout(() => this.flush(), 500);
      }
    } catch {}
  }

  /** Call once: sends waiting strokes as soon as the connection comes back. */
  watchOnline() {
    const on = () => void this.flush();
    addEventListener("online", on);
    return () => removeEventListener("online", on);
  }

  private persistQueue() {
    try {
      if (this.pending.size) localStorage.setItem(this.queueKey, JSON.stringify([...this.pending]));
      else localStorage.removeItem(this.queueKey);
    } catch {}
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((f) => f());
  }

  get(anchor: string): InkStroke[] {
    return this.strokes.get(anchor) ?? [];
  }
  hasInk(anchor: string) {
    return this.inked.has(anchor);
  }

  /** Loads strokes for blocks that are about to be on screen. */
  async ensure(anchors: string[]) {
    const need = anchors.filter((a) => this.inked.has(a) && !this.loaded.has(a) && !this.loading.has(a));
    if (!need.length) return;
    need.forEach((a) => this.loading.add(a));
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      try {
        const res = await api.getInk(this.notebookId, chunk);
        for (const a of chunk) {
          // Merge: strokes drawn here while loading must not be lost.
          const local = this.strokes.get(a) ?? [];
          const ids = new Set((res[a] ?? []).map((s) => s.id));
          this.strokes.set(a, [...(res[a] ?? []), ...local.filter((s) => !ids.has(s.id))]);
          this.loaded.add(a);
        }
      } catch {
        // Try again next time these blocks come into view.
      } finally {
        chunk.forEach((a) => this.loading.delete(a));
      }
    }
    this.emit();
  }

  private apply(ch: Change) {
    for (const { anchor, id } of ch.remove) {
      const list = this.strokes.get(anchor);
      if (list) this.strokes.set(anchor, list.filter((s) => s.id !== id));
      if (!this.strokes.get(anchor)?.length && this.loaded.has(anchor)) this.inked.delete(anchor);
    }
    for (const { anchor, stroke } of ch.add) {
      const list = (this.strokes.get(anchor) ?? []).filter((s) => s.id !== stroke.id);
      list.push(stroke);
      this.strokes.set(anchor, list);
      if (!this.inked.has(anchor)) this.loaded.add(anchor); // nothing else to fetch for a fresh block
      this.inked.add(anchor);
    }
    this.emit();
  }

  /** A change made here: apply now, remember for undo, and send to the server shortly. */
  commit(ch: Change, fromUndo = false) {
    if (!ch.add.length && !ch.remove.length) return;
    this.apply(ch);
    if (!fromUndo) {
      this.undoStack.push(ch);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    for (const r of ch.remove) this.pending.set(r.id, { anchor: r.anchor });
    for (const a of ch.add) this.pending.set(a.stroke.id, { anchor: a.anchor, stroke: a.stroke });
    this.persistQueue();
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), 250);
  }

  undo() {
    const ch = this.undoStack.pop();
    if (!ch) return;
    const inverse: Change = {
      add: ch.remove.flatMap((r) => (r.stroke ? [{ anchor: r.anchor, stroke: r.stroke }] : [])),
      remove: ch.add.map((a) => ({ anchor: a.anchor, id: a.stroke.id, stroke: a.stroke })),
    };
    this.redoStack.push(ch);
    this.commit(inverse, true);
  }
  redo() {
    const ch = this.redoStack.pop();
    if (!ch) return;
    this.undoStack.push(ch);
    this.commit(ch, true);
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }

  async flush() {
    if (!this.pending.size) return;
    const batch = new Map(this.pending);
    const add = [...batch].flatMap(([, v]) => (v.stroke ? [{ anchor: v.anchor, stroke: v.stroke }] : []));
    const remove = [...batch].flatMap(([id, v]) => (v.stroke ? [] : [{ anchor: v.anchor, id }]));
    this.onSaveState?.("saving");
    try {
      await api.saveInk(this.notebookId, { add, remove }, this.clientId);
      // Drop what was sent, unless it changed again meanwhile.
      for (const [id, v] of batch) if (this.pending.get(id) === v) this.pending.delete(id);
      this.persistQueue();
      this.onSaveState?.("saved");
    } catch {
      this.onSaveState?.("error");
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.flush(), navigator.onLine ? 3000 : 10000);
    }
  }

  get hasPending() {
    return this.pending.size > 0;
  }

  /** All strokes on a block (loaded ones). */
  strokesOf(anchor: string) {
    return this.get(anchor);
  }

  /** Strokes drawn or erased on another device. */
  applyRemote(msg: { add: Change["add"]; remove: Change["remove"]; clientId: string }) {
    if (msg.clientId === this.clientId) return;
    this.apply({ add: msg.add.filter((a) => this.loaded.has(a.anchor) || !this.inked.has(a.anchor)), remove: msg.remove });
    // Blocks we haven't loaded yet: just note they have ink; it loads when scrolled to.
    for (const a of msg.add) this.inked.add(a.anchor);
    this.emit();
  }
}
