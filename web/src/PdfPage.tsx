// PDF viewer: scroll through the pages, add text boxes, and write on pages with the Pencil.
// PDFs are yours only: assistants can't see or change them (they're not notebooks).

import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type PdfBox, type PdfMeta, pdfLiveUrl } from "./api";
import { InkStore, type InkTool } from "./ink";
import { InkLayer } from "./InkLayer";
import { Icon } from "./icons";
import { InkToolbar } from "./Notebook";

type Mode = "select" | "text" | "pen" | "highlighter" | "eraser" | "lasso";
const MODES: { id: Mode; label: string }[] = [
  { id: "select", label: "Select" },
  { id: "text", label: "Text" },
  { id: "pen", label: "Pen" },
  { id: "highlighter", label: "Highlighter" },
  { id: "eraser", label: "Eraser" },
  { id: "lasso", label: "Lasso" },
];
const clientId = crypto.randomUUID();
const RENDER_MARGIN = 1.5; // render pages this many screens above/below

let pdfjs: Promise<typeof import("pdfjs-dist")> | null = null;

/** A small JPEG of page 1, used as the book cover in the library. */
export async function makePdfThumb(doc: PDFDocumentProxy): Promise<Blob | null> {
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 360 / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport: vp }).promise;
  return new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", 0.78));
}

/** The words on each page, so PDFs can be searched. */
export async function extractPdfText(doc: PDFDocumentProxy, maxPages = 2000): Promise<string[]> {
  const out: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  return out;
}

export function loadPdfJs() {
  pdfjs ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjs;
}

export function PdfPage({ id, onBack, onChanged, onDeleted }: { id: string; onBack: () => void; onChanged: () => void; onDeleted: () => void }) {
  const [meta, setMeta] = useState<PdfMeta | null>(null);
  const [error, setError] = useState("");
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [initial, setInitial] = useState<{ boxes: PdfBox[]; inkAnchors: string[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setDoc(null);
    setError("");
    (async () => {
      try {
        const info = await api.getPdf(id);
        if (cancelled) return;
        setMeta(info.meta);
        setInitial({ boxes: info.boxes, inkAnchors: info.inkAnchors });
        const lib = await loadPdfJs();
        const pdf = await lib.getDocument({ url: api.pdfFileUrl(id), withCredentials: true }).promise;
        if (!cancelled) setDoc(pdf);
      } catch (e) {
        if (!cancelled) setError((e as Error).message?.includes("404") || (e as { status?: number }).status === 404 ? "This PDF was deleted." : "Couldn't open this PDF.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <div className="page-msg">{error}</div>;
  if (!meta || !initial) return <div className="page-msg">Opening PDF…</div>;
  return <Viewer key={id} meta={meta} doc={doc} initial={initial} onBack={onBack} onChanged={onChanged} onDeleted={onDeleted} />;
}

function Viewer({
  meta,
  doc,
  initial,
  onBack,
  onChanged,
  onDeleted,
}: {
  meta: PdfMeta;
  doc: PDFDocumentProxy | null;
  initial: { boxes: PdfBox[]; inkAnchors: string[] };
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(meta.name);
  const [boxes, setBoxes] = useState<PdfBox[]>(initial.boxes);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [visible, setVisible] = useState<Set<number>>(new Set([0, 1]));
  const [saving, setSaving] = useState<"saved" | "saving" | "error">("saved");
  const touchFirst = useMemo(() => matchMedia("(pointer: coarse)").matches, []);
  const [mode, setMode] = useState<Mode>(touchFirst ? "pen" : "select");
  // Pen and highlighter each remember their own colour, so the swatch always matches what you draw.
  const [penColor, setPenColor] = useState(() => localStorage.getItem("noty:penColor") ?? "ink");
  const [hiColor, setHiColor] = useState(() => localStorage.getItem("noty:hiColor") ?? "yellow");
  const color = mode === "highlighter" ? hiColor : penColor;
  const setColor = (c: string) => {
    if (mode === "highlighter") setHiColor(c), localStorage.setItem("noty:hiColor", c);
    else setPenColor(c), localStorage.setItem("noty:penColor", c);
  };
  const [size, setSize] = useState(5);
  const [fingerDraws, setFingerDraws] = useState(false);
  const [focusBox, setFocusBox] = useState<string | null>(null);
  const [shapes, setShapes] = useState(() => localStorage.getItem("noty:shapes") === "1");
  useEffect(() => void localStorage.setItem("noty:shapes", shapes ? "1" : "0"), [shapes]);
  const ink = useMemo(() => new InkStore(meta.id, initial.inkAnchors, clientId), [meta.id]);
  const host = useRef<HTMLDivElement>(null);
  const pagesEl = useRef<HTMLDivElement>(null);
  const layoutListeners = useRef(new Set<() => void>());
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const saveTimer = useRef(0);

  // Older PDFs have no book cover or search text yet: make them now, in the background.
  useEffect(() => {
    if (!doc) return;
    if (!meta.thumb)
      makePdfThumb(doc)
        .then((jpg) => jpg && api.savePdfThumb(meta.id, jpg, doc.numPages))
        .then(() => onChanged())
        .catch(() => {});
    if (!meta.textIndexed)
      extractPdfText(doc)
        .then((pages) => api.savePdfText(meta.id, pages))
        .catch(() => {});
  }, [doc]);

  // Opened from a search result: jump to that page.
  useEffect(() => {
    const page = Number(new URLSearchParams(location.search).get("page"));
    if (!page || !sizes.length) return;
    const t = setTimeout(() => document.querySelector(`[data-page="${page - 1}"]`)?.scrollIntoView({ block: "start" }), 50);
    return () => clearTimeout(t);
  }, [sizes.length]);

  // Page sizes: the first page is measured right away; others are filled in as they're read.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const first = (await doc.getPage(1)).getViewport({ scale: 1 });
      if (cancelled) return;
      const est = Array.from({ length: doc.numPages }, () => ({ w: first.width, h: first.height }));
      setSizes(est);
      // Read the real size of every page in the background (cheap: no drawing), in small batches.
      for (let i = 2; i <= doc.numPages && !cancelled; i++) {
        const v = (await doc.getPage(i)).getViewport({ scale: 1 });
        if (Math.abs(v.width - first.width) > 1 || Math.abs(v.height - first.height) > 1) {
          est[i - 1] = { w: v.width, h: v.height };
          if (i % 20 === 0 || i === doc.numPages) setSizes([...est]);
        }
      }
      if (!cancelled) setSizes([...est]);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);
  useEffect(() => layoutListeners.current.forEach((f) => f()), [sizes]);

  // Which pages are near the screen (only those get drawn).
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      const el = pagesEl.current;
      if (!el) return;
      const margin = innerHeight * RENDER_MARGIN;
      const next = new Set<number>();
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const r = child.getBoundingClientRect();
        if (r.bottom > -margin && r.top < innerHeight + margin) next.add(Number(child.dataset.page));
      }
      setVisible((prev) => (prev.size === next.size && [...next].every((n) => prev.has(n)) ? prev : next));
    };
    const onScroll = () => (frame ||= requestAnimationFrame(check));
    check();
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    return () => {
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [sizes.length]);

  // ----- text boxes: save shortly after changes; live from other devices -----
  const persist = (next: PdfBox[]) => {
    setBoxes(next);
    clearTimeout(saveTimer.current);
    setSaving("saving");
    saveTimer.current = window.setTimeout(async () => {
      try {
        await api.saveBoxes(meta.id, boxesRef.current, clientId);
        setSaving("saved");
      } catch {
        setSaving("error");
      }
    }, 600);
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    const connect = () => {
      ws = new WebSocket(pdfLiveUrl(meta.id));
      ws.onmessage = (ev) => {
        if (ev.data === "pong") return;
        const msg = JSON.parse(ev.data);
        if (msg.type === "boxes" && msg.clientId !== clientId) {
          // Keep the box you're typing in as you have it; take everything else.
          setBoxes((mine) => {
            const editing = mine.find((b) => b.id === document.activeElement?.closest<HTMLElement>("[data-box]")?.dataset.box);
            return editing ? [...msg.boxes.filter((b: PdfBox) => b.id !== editing.id), editing] : msg.boxes;
          });
        } else if (msg.type === "ink") ink.applyRemote(msg);
        else if (msg.type === "deleted") onDeleted();
      };
      ws.onopen = () => (retry = 1000);
      ws.onclose = () => !closed && setTimeout(connect, (retry = Math.min(retry * 2, 30_000)));
    };
    connect();
    const ping = setInterval(() => ws?.readyState === 1 && ws.send("ping"), 30_000);
    const leave = () => void ink.flush();
    addEventListener("pagehide", leave);
    const offOnline = ink.watchOnline();
    return () => {
      closed = true;
      clearInterval(ping);
      ws?.close();
      removeEventListener("pagehide", leave);
      offOnline();
      void ink.flush();
    };
  }, [meta.id]);

  // Cmd/Ctrl+Z undoes ink in pen modes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(mode === "pen" || mode === "highlighter" || mode === "eraser" || mode === "lasso") || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      e.shiftKey ? ink.redo() : ink.undo();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [mode, ink]);

  const addBoxAt = (page: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (mode !== "text" || (e.target as HTMLElement).closest("[data-box]")) return;
    const r = e.currentTarget.getBoundingClientRect();
    const b: PdfBox = {
      id: crypto.randomUUID().slice(0, 12),
      page,
      x: Math.min(0.9, (e.clientX - r.left) / r.width),
      y: Math.min(0.95, (e.clientY - r.top) / r.height),
      w: 0.35,
      text: "",
      size: 14,
      color,
    };
    persist([...boxes, b]);
    setFocusBox(b.id);
    setMode("select");
  };

  const rename = async () => {
    const clean = name.trim();
    if (!clean || clean === meta.name) return setName(clean || meta.name);
    await api.renamePdf(meta.id, clean).catch(() => {});
    onChanged();
  };
  const remove = async () => {
    if (!confirm(`Delete “${name}”? Its copy in Google Drive / Noty / PDF goes to the bin too.`)) return;
    await api.removePdf(meta.id);
    onDeleted();
  };

  const inkTool: InkTool = mode === "select" || mode === "text" ? "type" : mode;

  return (
    <article className="sheet pdf-sheet doc">
      <div className="doc-top">
      <header className="doc-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back to library" title="Library">
          <Icon.back />
        </button>
        <input className="sheet-title" aria-label="PDF name" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        <span className="pdf-badge" title="PDFs are yours only. Assistants can't see or change them.">
          {doc ? `${doc.numPages} pages` : "PDF"}
        </span>
        <span className={`sync sync-${saving === "saved" ? "saved" : saving === "saving" ? "saving" : "error"}`} role="status" aria-live="polite">
          <span className="sync-text">{saving === "saved" ? "Saved" : saving === "saving" ? "Saving…" : "Couldn't save"}</span>
        </span>
      </header>
      <InkToolbar
        tool={inkTool}
        setTool={() => {}}
        modes={MODES}
        mode={mode}
        setMode={(m) => setMode(m as Mode)}
        color={color}
        setColor={setColor}
        size={size}
        setSize={setSize}
        fingerDraws={fingerDraws}
        setFingerDraws={setFingerDraws}
        onUndo={() => ink.undo()}
        onRedo={() => ink.redo()}
        shapes={shapes}
        setShapes={setShapes}
        docItems={
          <>
            <a className="ink-more-item" href={api.pdfFileUrl(meta.id)} download={`${meta.name}.pdf`}>
              <Icon.download />
              <span className="ink-more-text">Download PDF</span>
            </a>
            <button type="button" className="ink-more-item danger" onClick={remove}>
              <Icon.trash />
              <span className="ink-more-text">Delete PDF</span>
            </button>
          </>
        }
      />
      </div>
      {mode === "text" && <p className="pdf-hint">Tap anywhere on a page to add a text box.</p>}
      <div className={`ink-host pdf-host tool-${inkTool} mode-${mode}`} ref={host}>
        <div className="pdf-pages" ref={pagesEl}>
          {!doc && <div className="page-msg">Loading pages…</div>}
          {sizes.map((s, i) => (
            <div key={i} data-id={`pg${i}`} data-page={i} className="pdf-page" style={{ aspectRatio: `${s.w} / ${s.h}` }} onClick={(e) => addBoxAt(i, e)}>
              {doc && visible.has(i) && <PageCanvas doc={doc} index={i} onRendered={() => layoutListeners.current.forEach((f) => f())} />}
              <span className="pdf-num" aria-hidden>
                {i + 1}
              </span>
              {boxes
                .filter((b) => b.page === i)
                .map((b) => (
                  <TextBox
                    key={b.id}
                    box={b}
                    autoFocus={focusBox === b.id}
                    interactive={mode === "select" || mode === "text"}
                    onChange={(nb) => persist(boxesRef.current.map((x) => (x.id === nb.id ? nb : x)))}
                    onDelete={() => persist(boxesRef.current.filter((x) => x.id !== b.id))}
                  />
                ))}
            </div>
          ))}
        </div>
        <InkLayer
          getRoot={() => pagesEl.current}
          subscribeLayout={(cb) => {
            layoutListeners.current.add(cb);
            return () => void layoutListeners.current.delete(cb);
          }}
          store={ink}
          host={host}
          settings={{ tool: inkTool, color, size, fingerDraws, shapes }}
          bounded
        />
      </div>
    </article>
  );
}

/** Draws one PDF page into a canvas at screen resolution, only while it's near the screen. */
function PageCanvas({ doc, index, onRendered }: { doc: PDFDocumentProxy; index: number; onRendered: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(index + 1);
      const el = canvas.current;
      if (cancelled || !el) return;
      const cssWidth = el.parentElement!.clientWidth;
      const base = page.getViewport({ scale: 1 });
      const scale = (cssWidth / base.width) * Math.min(devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale });
      el.width = Math.floor(vp.width);
      el.height = Math.floor(vp.height);
      task = page.render({ canvas: el, viewport: vp });
      await task.promise.catch(() => {});
      if (!cancelled) onRendered();
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index]);
  return <canvas ref={canvas} className="pdf-canvas" aria-label={`Page ${index + 1}`} />;
}

function TextBox({
  box,
  autoFocus,
  interactive,
  onChange,
  onDelete,
}: {
  box: PdfBox;
  autoFocus: boolean;
  interactive: boolean;
  onChange: (b: PdfBox) => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(box.text);
  const typing = useRef(0);
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(box.text);
  }, [box.text]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  // Grow with the text.
  useEffect(() => {
    const el = ref.current;
    if (el) (el.style.height = "auto"), (el.style.height = el.scrollHeight + "px");
  }, [text, box.size]);

  // Drag the handle to move the box.
  const startDrag = (e: React.PointerEvent) => {
    const page = (e.currentTarget as HTMLElement).closest(".pdf-page") as HTMLElement;
    const r = page.getBoundingClientRect();
    const dx = e.clientX - (r.left + box.x * r.width);
    const dy = e.clientY - (r.top + box.y * r.height);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      onChange({ ...box, text, x: Math.min(0.98, Math.max(0, (ev.clientX - dx - r.left) / r.width)), y: Math.min(0.98, Math.max(0, (ev.clientY - dy - r.top) / r.height)) });
    const up = () => (removeEventListener("pointermove", move), removeEventListener("pointerup", up));
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    e.preventDefault();
  };

  return (
    <div
      className={`pdf-box ${interactive ? "" : "passive"}`}
      data-box={box.id}
      style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, ["--box-color" as string]: `var(--draw-${box.color})` }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="pdf-box-bar">
        <button type="button" className="pdf-box-move" onPointerDown={startDrag} aria-label="Move text box" title="Drag to move">
          ⠿
        </button>
        <button type="button" onClick={() => onChange({ ...box, text, size: Math.max(8, box.size - 2) })} aria-label="Smaller text">
          A−
        </button>
        <button type="button" onClick={() => onChange({ ...box, text, size: Math.min(72, box.size + 2) })} aria-label="Bigger text">
          A+
        </button>
        <button type="button" onClick={onDelete} aria-label="Delete text box">
          ✕
        </button>
      </div>
      <textarea
        ref={ref}
        value={text}
        rows={1}
        placeholder="Type here"
        style={{ fontSize: box.size }}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          clearTimeout(typing.current);
          typing.current = window.setTimeout(() => onChange({ ...box, text: t }), 700); // saves while you type
        }}
        onBlur={() => (clearTimeout(typing.current), text !== box.text && onChange({ ...box, text }))}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.currentTarget as HTMLTextAreaElement).blur();
          if ((e.key === "Backspace" || e.key === "Delete") && !text) onDelete();
        }}
      />
    </div>
  );
}
