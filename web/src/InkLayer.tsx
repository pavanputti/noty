// A transparent ink layer over the whole notebook. Write or draw anywhere: on blank pages,
// over text, images, tables or anything an assistant added. Each stroke is pinned to the block
// it starts on, so it moves with that block when content above it changes.
//
// Input rules: Apple Pencil (pen) always draws. Mouse draws when a pen tool is selected.
// A finger scrolls and taps into text, unless "Finger draws" is on. While the Pencil is down,
// other touches (your palm) are ignored.

import { useEffect, useReducer, useRef, useState } from "react";
import { decodePoints, encodePoints, type InkStore, type InkStroke, type InkTool, strokeHit, strokePath } from "./ink";
import { arrowheadFor, recognize } from "./shapes";

const UNITS = 1000; // a block's width in ink units; y uses the same scale
const MARGIN_SCREENS = 1.5; // load and draw ink this far above and below the screen

interface Box {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface InkSettings {
  tool: InkTool;
  color: string;
  size: number;
  fingerDraws: boolean;
  /** Snap rough lines, arrows, circles, rectangles and triangles to clean ones. */
  shapes?: boolean;
}

export interface Selected {
  anchor: string;
  stroke: InkStroke;
}

/** Move/resize applied to a lasso selection, in host pixels: scale around (ox, oy), then shift. */
interface Xform {
  dx: number;
  dy: number;
  s: number;
  ox: number;
  oy: number;
}
type Rect = { x: number; y: number; w: number; h: number };

function pointInPoly(x: number, y: number, poly: number[][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function InkLayer({
  getRoot,
  subscribeLayout,
  store,
  host,
  settings,
  onStrokeEnd,
  onConvertText,
  bounded = false,
}: {
  /** The element whose children (each with a data-id) are the things ink is pinned to: notebook blocks or PDF pages. */
  getRoot: () => Element | null | undefined;
  /** Calls back when content may have moved (edits, pages rendering). Returns an unsubscribe function. */
  subscribeLayout: (cb: () => void) => (() => void) | void;
  store: InkStore;
  host: React.RefObject<HTMLDivElement | null>;
  settings: InkSettings;
  onStrokeEnd?: (anchor: string) => void;
  /** Lasso "To text": the selected strokes. */
  onConvertText?: (selected: Selected[]) => void;
  /** PDFs: ink only on a page (not beside it or between pages), clipped at the page edge. */
  bounded?: boolean;
}) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [visible, setVisible] = useState<Box[]>([]);
  const [live, setLive] = useState<{ box: Box; stroke: InkStroke; flat: number[] } | null>(null);
  const boxesRef = useRef<Box[]>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const boundedRef = useRef(bounded);
  boundedRef.current = bounded;
  const onStrokeEndRef = useRef(onStrokeEnd);
  onStrokeEndRef.current = onStrokeEnd;
  // Lasso selection
  const [lassoPath, setLassoPath] = useState<number[][] | null>(null);
  const [sel, setSel] = useState<{ items: { anchor: string; id: string }[]; rect: Rect } | null>(null);
  const [xform, setXformState] = useState<Xform | null>(null);
  const xformRef = useRef<Xform | null>(null);
  const setXform = (t: Xform | null) => {
    xformRef.current = t;
    setXformState(t);
  };
  const selRef = useRef(sel);
  selRef.current = sel;
  useEffect(() => {
    if (settings.tool !== "lasso") setSel(null);
  }, [settings.tool]);

  useEffect(() => store.subscribe(rerender), [store]);

  // ----- where is every top-level block? (cached; refreshed when layout changes) -----
  const measure = () => {
    const h = host.current;
    const root = getRoot();
    if (!h || !root) return;
    const hr = h.getBoundingClientRect();
    const list: Box[] = [];
    for (const el of Array.from(root.children) as HTMLElement[]) {
      const id = el.getAttribute("data-id");
      if (!id) continue;
      const r = el.getBoundingClientRect();
      list.push({ id, top: r.top - hr.top, left: r.left - hr.left, width: r.width, height: r.height });
    }
    boxesRef.current = list;
    setBoxes(list);
    updateVisible(list);
  };

  const updateVisible = (list = boxesRef.current) => {
    const h = host.current;
    if (!h) return;
    const hr = h.getBoundingClientRect();
    const margin = innerHeight * MARGIN_SCREENS;
    const top = -hr.top - margin;
    const bottom = -hr.top + innerHeight + margin;
    // Blocks are in vertical order: binary search for the first one on screen.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].top + list[mid].height < top) lo = mid + 1;
      else hi = mid;
    }
    const vis: Box[] = [];
    for (let i = lo; i < list.length && list[i].top < bottom; i++) vis.push(list[i]);
    setVisible((prev) => (prev.length === vis.length && prev.every((b, i) => b === vis[i]) ? prev : vis));
    store.ensure(vis.map((b) => b.id));
  };

  useEffect(() => {
    let t = 0;
    const soon = (ms = 120) => {
      clearTimeout(t);
      t = window.setTimeout(measure, ms);
    };
    soon(0);
    const offChange = subscribeLayout(() => soon());
    const ro = new ResizeObserver(() => soon(60));
    if (host.current) ro.observe(host.current);
    const onLoad = () => soon(30);
    host.current?.addEventListener("load", onLoad, true); // images finishing loading change heights
    document.fonts?.ready.then(() => soon(0));
    let frame = 0;
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          updateVisible();
        });
    };
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    return () => {
      clearTimeout(t);
      offChange?.();
      ro.disconnect();
      host.current?.removeEventListener("load", onLoad, true);
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [store]);

  // ----- lasso helpers (host pixels <-> a block's ink units) -----
  const toHost = (b: Box, u: number, v: number) => [b.left + (u * b.width) / UNITS, b.top + (v * b.width) / UNITS];
  const toLocal = (b: Box, x: number, y: number) => [((x - b.left) * UNITS) / b.width, ((y - b.top) * UNITS) / b.width];
  const boxById = (id: string) => boxesRef.current.find((b) => b.id === id);
  const transformFlat = (flat: number[], b: Box, t: Xform) => {
    const out = flat.slice();
    for (let i = 0; i + 2 < out.length; i += 3) {
      const [x, y] = toHost(b, out[i], out[i + 1]);
      const [u, v] = toLocal(b, t.ox + (x - t.ox) * t.s + t.dx, t.oy + (y - t.oy) * t.s + t.dy);
      out[i] = Math.round(u);
      out[i + 1] = Math.round(v);
    }
    return out;
  };
  const selectedStrokes = (): Selected[] => {
    const cur = selRef.current;
    if (!cur) return [];
    return cur.items.flatMap(({ anchor, id }) => {
      const st = store.get(anchor).find((x) => x.id === id);
      return st ? [{ anchor, stroke: st }] : [];
    });
  };
  const rectOf = (items: Selected[]): Rect | null => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { anchor, stroke } of items) {
      const b = boxById(anchor);
      if (!b) continue;
      const p = decodePoints(stroke);
      for (let i = 0; i + 2 < p.length; i += 3) {
        const [x, y] = toHost(b, p[i], p[i + 1]);
        (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
      }
    }
    return Number.isFinite(x0) ? { x: x0 - 8, y: y0 - 8, w: x1 - x0 + 16, h: y1 - y0 + 16 } : null;
  };
  /** Replace the selected strokes with changed copies (same ids), as one undoable step. */
  const changeSelected = (fn: (st: InkStroke, b: Box) => InkStroke) => {
    const items = selectedStrokes();
    const remove = items.map(({ anchor, stroke }) => ({ anchor, id: stroke.id, stroke }));
    const add = items.flatMap(({ anchor, stroke }) => {
      const b = boxById(anchor);
      return b ? [{ anchor, stroke: fn(stroke, b) }] : [];
    });
    store.commit({ add, remove });
    return add.map((a) => ({ anchor: a.anchor, stroke: a.stroke }));
  };
  const recolor = (c: string) => changeSelected((st) => ({ ...st, c }));
  const deleteSelected = () => {
    const items = selectedStrokes();
    store.commit({ add: [], remove: items.map(({ anchor, stroke }) => ({ anchor, id: stroke.id, stroke })) });
    setSel(null);
  };
  const selRefFns = useRef({ changeSelected, rectOf, selectedStrokes, transformFlat });
  selRefFns.current = { changeSelected, rectOf, selectedStrokes, transformFlat };

  // ----- pen input -----
  useEffect(() => {
    const h = host.current;
    if (!h) return;
    let active: { pointerId: number; type: string; box: Box; flat: number[]; stroke: InkStroke; erasing: boolean; erased: { anchor: string; id: string; stroke: InkStroke }[] } | null = null;
    let frame = 0;
    let lastPointer = "mouse";

    const toolFor = (e: PointerEvent): InkTool | null => {
      const s = settingsRef.current;
      if (e.button > 0) return null;
      if (e.pointerType === "pen") return s.tool === "type" ? "pen" : s.tool; // the Pencil always writes
      if (s.tool === "type") return null;
      if (e.pointerType === "mouse") return s.tool;
      if (e.pointerType === "touch" && s.fingerDraws) return s.tool;
      return null;
    };

    const boxAt = (y: number): Box | null => {
      const list = boxesRef.current;
      if (!list.length) return null;
      let best = list[0];
      for (const b of list) {
        if (b.top <= y) best = b;
        else break;
      }
      return best;
    };

    const local = (e: PointerEvent, box: Box) => {
      const hr = h.getBoundingClientRect();
      const k = UNITS / box.width;
      // Strokes can't run off the left/right edge; on PDFs not off the top/bottom of the page either.
      const x = Math.min(UNITS, Math.max(0, (e.clientX - hr.left - box.left) * k));
      const yRaw = (e.clientY - hr.top - box.top) * k;
      const y = boundedRef.current ? Math.min(box.height * k, Math.max(0, yRaw)) : yRaw;
      return [x, y] as const;
    };

    let lastErase: [number, number] | null = null;
    /** Erase along the path since the last position, so fast strokes don't skip lines. */
    const eraseAlong = (e: PointerEvent) => {
      const events = typeof e.getCoalescedEvents === "function" && e.getCoalescedEvents().length ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        const cur: [number, number] = [ev.clientX, ev.clientY];
        if (lastErase) {
          const steps = Math.min(40, Math.ceil(Math.hypot(cur[0] - lastErase[0], cur[1] - lastErase[1]) / 4));
          for (let i = 1; i < steps; i++) eraseAt({ clientX: lastErase[0] + ((cur[0] - lastErase[0]) * i) / steps, clientY: lastErase[1] + ((cur[1] - lastErase[1]) * i) / steps });
        }
        eraseAt(ev);
        lastErase = cur;
      }
    };
    const eraseAt = (e: { clientX: number; clientY: number }) => {
      const hr = h.getBoundingClientRect();
      const y = e.clientY - hr.top;
      const removed: { anchor: string; id: string; stroke: InkStroke }[] = [];
      for (const b of boxesRef.current) {
        if (b.top > y + 400 || b.top + b.height < y - 1200) continue; // strokes can spill past their block
        const strokes = store.get(b.id);
        if (!strokes.length) continue;
        const k = UNITS / b.width;
        const lx = (e.clientX - hr.left - b.left) * k;
        const ly = (y - b.top) * k;
        for (const st of strokes) if (strokeHit(st, lx, ly, 12)) removed.push({ anchor: b.id, id: st.id, stroke: st });
      }
      if (removed.length) {
        active?.erased.push(...removed);
        store.commit({ add: [], remove: removed });
      }
    };

    let lasso: { pointerId: number; mode: "draw" | "move" | "resize"; sx: number; sy: number; path: number[][]; rect?: Rect } | null = null;
    let lastLine: { anchor: string; a: [number, number]; b: [number, number]; t: number } | null = null;

    const down = (e: PointerEvent) => {
      lastPointer = e.pointerType;
      if ((e.target as HTMLElement).closest(".ink-ui")) return; // our own buttons (selection bar, page style)
      const tool = toolFor(e);
      if (!tool) return;
      if (tool === "lasso") {
        if (lasso) return;
        e.preventDefault();
        e.stopPropagation();
        h.setPointerCapture(e.pointerId);
        if (!boxesRef.current.length) measure();
        const hr = h.getBoundingClientRect();
        const x = e.clientX - hr.left;
        const y = e.clientY - hr.top;
        const r = selRef.current?.rect;
        if (r && Math.abs(x - (r.x + r.w)) < 22 && Math.abs(y - (r.y + r.h)) < 22) lasso = { pointerId: e.pointerId, mode: "resize", sx: x, sy: y, path: [], rect: r };
        else if (r && x > r.x - 6 && x < r.x + r.w + 6 && y > r.y - 6 && y < r.y + r.h + 6) lasso = { pointerId: e.pointerId, mode: "move", sx: x, sy: y, path: [], rect: r };
        else {
          setSel(null);
          lasso = { pointerId: e.pointerId, mode: "draw", sx: x, sy: y, path: [[x, y]] };
          setLassoPath([[x, y]]);
        }
        return;
      }
      // Palm rejection: ignore touches while the Pencil is writing.
      if (active && active.type === "pen" && e.pointerType !== "pen") return;
      if (active) return;
      if (!boxesRef.current.length) measure();
      const hr = h.getBoundingClientRect();
      const box = boxAt(e.clientY - hr.top);
      if (!box) return;
      // Only on the page: not beside it, and (for PDFs) not in the gap between pages.
      const px = e.clientX - hr.left;
      const py = e.clientY - hr.top;
      const list = boxesRef.current;
      const inX = px >= box.left && px <= box.left + box.width;
      const inY = boundedRef.current ? py >= box.top && py <= box.top + box.height : py >= list[0].top && py <= list[list.length - 1].top + list[list.length - 1].height;
      if (!inX || !inY) {
        // Outside the page with the Pencil (or a pen tool): do nothing at all, rather than letting the
        // touch fall through to the editor (which would grab a block's drag handle in the margin).
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const s = settingsRef.current;
      if (tool === "eraser") {
        active = { pointerId: e.pointerId, type: e.pointerType, box, flat: [], stroke: { id: "", c: "", s: 0, d: "" }, erasing: true, erased: [] };
        lastErase = null;
        eraseAlong(e);
        return;
      }
      const [x, y] = local(e, box);
      const pr = e.pointerType === "pen" ? Math.round((e.pressure || 0.5) * 100) : 50;
      const stroke: InkStroke = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 14), c: s.color, s: s.size, d: "" };
      if (tool === "highlighter") stroke.t = "h";
      active = { pointerId: e.pointerId, type: e.pointerType, box, flat: [Math.round(x), Math.round(y), pr], stroke, erasing: false, erased: [] };
      setLive({ box, stroke, flat: active.flat });
    };

    const move = (e: PointerEvent) => {
      if (lasso && lasso.pointerId === e.pointerId) {
        e.preventDefault();
        e.stopPropagation();
        const hr = h.getBoundingClientRect();
        const x = e.clientX - hr.left;
        const y = e.clientY - hr.top;
        if (lasso.mode === "draw") {
          lasso.path.push([x, y]);
          if (!frame) frame = requestAnimationFrame(() => ((frame = 0), lasso && setLassoPath([...lasso.path])));
        } else if (lasso.mode === "move") setXform({ dx: x - lasso.sx, dy: y - lasso.sy, s: 1, ox: 0, oy: 0 });
        else if (lasso.rect) {
          const r = lasso.rect;
          const sc = Math.max(0.15, Math.max((x - r.x) / r.w, (y - r.y) / r.h));
          setXform({ dx: 0, dy: 0, s: sc, ox: r.x, oy: r.y });
        }
        return;
      }
      if (!active || active.pointerId !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      if (active.erasing) return eraseAlong(e);
      const events = typeof e.getCoalescedEvents === "function" && e.getCoalescedEvents().length ? e.getCoalescedEvents() : [e];
      const f = active.flat;
      for (const ev of events) {
        const [x, y] = local(ev, active.box);
        if ((x - f[f.length - 3]) ** 2 + (y - f[f.length - 2]) ** 2 < 2.5) continue; // skip tiny moves: keeps notebooks small
        f.push(Math.round(x), Math.round(y), active.type === "pen" ? Math.round((ev.pressure || 0.5) * 100) : 50);
      }
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (active && !active.erasing) setLive({ box: active.box, stroke: active.stroke, flat: [...active.flat] });
        });
    };

    const up = (e: PointerEvent) => {
      if (lasso && lasso.pointerId === e.pointerId) {
        e.stopPropagation();
        const l = lasso;
        lasso = null;
        const f = selRefFns.current;
        if (l.mode === "draw") {
          setLassoPath(null);
          if (l.path.length < 3) return;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const [x, y] of l.path) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
          const picked: Selected[] = [];
          for (const b of boxesRef.current) {
            if (b.top > y1 + 600 || b.top + b.height < y0 - 1600) continue;
            for (const st of store.get(b.id)) {
              const p = decodePoints(st);
              let n = 0, inside = 0;
              for (let i = 0; i + 2 < p.length; i += 9) {
                const [x, y] = toHost(b, p[i], p[i + 1]);
                n++;
                if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && pointInPoly(x, y, l.path)) inside++;
              }
              if (n && inside / n >= 0.6) picked.push({ anchor: b.id, stroke: st });
            }
          }
          const rect = f.rectOf(picked);
          setSel(rect ? { items: picked.map((p) => ({ anchor: p.anchor, id: p.stroke.id })), rect } : null);
          return;
        }
        // Finish a move/resize: write the changed strokes (once, outside any state update).
        const t = xformRef.current;
        setXform(null);
        if (t && (t.dx || t.dy || t.s !== 1)) {
          const changed = f.changeSelected((st, b) => ({ ...st, d: encodePoints(f.transformFlat(decodePoints(st), b, t)), s: Math.max(1, Math.round(st.s * Math.sqrt(t.s) * 10) / 10) }));
          const rect = f.rectOf(changed);
          if (rect) setSel((cur) => (cur ? { ...cur, rect } : cur));
        }
        return;
      }
      if (!active || active.pointerId !== e.pointerId) return;
      e.stopPropagation();
      const a = active;
      active = null;
      setLive(null);
      if (a.erasing) return;
      // Shapes: snap a rough line/arrow/circle/box to a clean one; a small V at a line's end becomes an arrowhead.
      if (settingsRef.current.shapes && !a.stroke.t) {
        const head = lastLine && lastLine.anchor === a.box.id && Date.now() - lastLine.t < 6000 ? arrowheadFor(a.flat, lastLine) : null;
        if (head) {
          a.flat = head;
          lastLine = null;
        } else {
          const r = recognize(a.flat);
          if (r) {
            a.flat = r.flat;
            lastLine = r.kind === "line" ? { anchor: a.box.id, a: [r.flat[0], r.flat[1]], b: [r.flat[r.flat.length - 3], r.flat[r.flat.length - 2]], t: Date.now() } : null;
          } else lastLine = null;
        }
      }
      const stroke = { ...a.stroke, d: encodePoints(a.flat) };
      store.commit({ add: [{ anchor: a.box.id, stroke }], remove: [] });
      onStrokeEndRef.current?.(a.box.id);
    };

    // Stop the page scrolling (and text selection / callouts) when the Pencil touches it.
    const touch = (e: TouchEvent) => {
      const stylus = Array.from(e.touches).some((t) => (t as Touch & { touchType?: string }).touchType === "stylus");
      const s = settingsRef.current;
      if (stylus || (s.fingerDraws && s.tool !== "type") || active || lasso) e.preventDefault();
    };
    // Block the editor from seeing mouse events that belong to a stroke.
    const swallow = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".ink-ui")) return;
      const s = settingsRef.current;
      const fingerTap = lastPointer === "touch" && !s.fingerDraws; // a finger tap still places the cursor
      if (active || (s.tool !== "type" && e.button === 0 && !fingerTap)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    h.addEventListener("pointerdown", down, { capture: true });
    h.addEventListener("pointermove", move, { capture: true });
    h.addEventListener("pointerup", up, { capture: true });
    h.addEventListener("pointercancel", up, { capture: true });
    h.addEventListener("touchstart", touch, { capture: true, passive: false });
    h.addEventListener("touchmove", touch, { capture: true, passive: false });
    h.addEventListener("mousedown", swallow, { capture: true });
    return () => {
      h.removeEventListener("pointerdown", down, { capture: true });
      h.removeEventListener("pointermove", move, { capture: true });
      h.removeEventListener("pointerup", up, { capture: true });
      h.removeEventListener("pointercancel", up, { capture: true });
      h.removeEventListener("touchstart", touch, { capture: true });
      h.removeEventListener("touchmove", touch, { capture: true });
      h.removeEventListener("mousedown", swallow, { capture: true });
      cancelAnimationFrame(frame);
    };
  }, [store]);

  const svgFor = (b: Box, children: React.ReactNode, key: string) => (
    <svg
      key={key}
      className={`ink-svg ${bounded ? "clip" : ""}`}
      style={{ left: b.left, top: b.top, width: b.width, height: Math.max(b.height, 1) }}
      viewBox={`0 0 ${UNITS} ${(Math.max(b.height, 1) * UNITS) / b.width}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {children}
    </svg>
  );

  void boxes;
  void recolor;
  return (
    <div className={`ink-layer tool-${settings.tool}`} aria-hidden>
      {visible.map((b) => {
        const strokes = store.get(b.id);
        if (!strokes.length) return null;
        const selIds = sel ? new Set(sel.items.filter((i) => i.anchor === b.id).map((i) => i.id)) : null;
        return svgFor(
          b,
          strokes.map((st) => {
            const moving = xform && selIds?.has(st.id);
            const d = moving ? strokePath(st, transformFlat(decodePoints(st), b, xform), true) : strokePath(st);
            return <path key={st.id} d={d} fill={`var(--draw-${st.c})`} className={`${st.t === "h" ? "hi" : ""} ${selIds?.has(st.id) ? "picked" : ""}`} />;
          }),
          b.id,
        );
      })}
      {lassoPath && lassoPath.length > 1 && (
        <svg className="ink-lasso" style={{ left: 0, top: 0, width: 1, height: 1 }} aria-hidden>
          <polyline points={lassoPath.map((p) => p.join(",")).join(" ")} />
        </svg>
      )}
      {sel && settings.tool === "lasso" && (() => {
        const r = xform ? { x: xform.ox + (sel.rect.x - xform.ox) * xform.s + xform.dx, y: xform.oy + (sel.rect.y - xform.oy) * xform.s + xform.dy, w: sel.rect.w * xform.s, h: sel.rect.h * xform.s } : sel.rect;
        return (
          <>
            <div className="ink-sel" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
              <span className="ink-sel-handle" />
            </div>
            {!xform && (
              <div className="ink-ui ink-sel-bar" style={{ left: r.x, top: Math.max(0, r.y - 48) }} role="toolbar" aria-label="Selection">
                {["ink", "blue", "red", "green", "orange", "purple", "yellow"].map((c) => (
                  <button key={c} type="button" className="ink-swatch" style={{ background: `var(--draw-${c})` }} aria-label={`Make it ${c === "ink" ? "black" : c}`} onClick={() => { const changed = changeSelected((st) => ({ ...st, c })); const rect = rectOf(changed); if (rect) setSel((cur) => (cur ? { ...cur, rect } : cur)); }} />
                ))}
                {onConvertText && (
                  <button type="button" className="ink-tool" onClick={() => onConvertText(selectedStrokes())}>
                    To text
                  </button>
                )}
                <button type="button" className="ink-tool" onClick={deleteSelected}>
                  Delete
                </button>
                <span className="ink-sel-count">{sel.items.length} stroke{sel.items.length === 1 ? "" : "s"}</span>
              </div>
            )}
          </>
        );
      })()}
      {live &&
        live.flat.length >= 3 &&
        svgFor(live.box, <path d={strokePath(live.stroke, live.flat, true)} fill={`var(--draw-${live.stroke.c})`} className={live.stroke.t === "h" ? "hi" : undefined} />, "live")}
    </div>
  );
}
