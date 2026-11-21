// One notebook page: the editor, live updates from assistants, and autosave.

import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { BlockNoteView, type Theme } from "@blocknote/mantine";
import { type DefaultReactSuggestionItem, getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote } from "@blocknote/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, liveUrl, type Notebook as NB } from "./api";
import { type NotyEditor, schema } from "./blocks";
import { decodePoints, InkStore, type InkTool } from "./ink";
import { Icon } from "./icons";
import { EmojiPicker, HistoryDialog } from "./notion";
import { ThemeSwitch } from "./ThemeSwitch";
import { InkLayer, type Selected } from "./InkLayer";
import { useColorScheme } from "./useColorScheme";

type SyncState = "saved" | "saving" | "unsaved" | "offline" | "error";
type AiMap = NB["aiBlocks"];

const clientId = crypto.randomUUID();

const font = '"Literata", Georgia, serif';
const themes: Record<"light" | "dark", Theme> = {
  light: {
    fontFamily: font,
    borderRadius: 6,
    colors: { editor: { text: "#1D2433", background: "#FFFFFF" }, menu: { text: "#1D2433", background: "#FFFFFF" }, hovered: { text: "#1D2433", background: "#ECEFF3" }, selected: { text: "#FFFFFF", background: "#2050C0" }, border: "#D9DEE6", sideMenu: "#9AA2B2", shadow: "rgba(29,36,51,.12)", highlights: {
        gray: { text: "#495057", background: "#EEF0F3" }, brown: { text: "#7A4E2D", background: "#F4EAE1" }, red: { text: "#C92A2A", background: "#FFE3E3" },
        orange: { text: "#D9480F", background: "#FFE8D6" }, yellow: { text: "#1D2433", background: "#FFF1A8" }, green: { text: "#2B8A3E", background: "#DCF5E3" },
        blue: { text: "#2050C0", background: "#DDE7FB" }, purple: { text: "#6741D9", background: "#ECE5FF" }, pink: { text: "#C2255C", background: "#FFE0EC" },
      } },
  },
  dark: {
    fontFamily: font,
    borderRadius: 6,
    colors: { editor: { text: "#E5E8EE", background: "#1A1E26" }, menu: { text: "#E5E8EE", background: "#232833" }, hovered: { text: "#E5E8EE", background: "#2C323D" }, selected: { text: "#0E1424", background: "#86A6FF" }, border: "#2C323D", sideMenu: "#6E7687", shadow: "rgba(0,0,0,.4)", highlights: {
        gray: { text: "#CED4DA", background: "#2C323D" }, brown: { text: "#E3C4A8", background: "#3D2F24" }, red: { text: "#FFA8A8", background: "#4A2226" },
        orange: { text: "#FFC078", background: "#4A2E17" }, yellow: { text: "#FFF3C2", background: "#4D4213" }, green: { text: "#8CE99A", background: "#1D3B2A" },
        blue: { text: "#A5C0FF", background: "#1F2B4D" }, purple: { text: "#C7B5FF", background: "#2E2552" }, pink: { text: "#FAA2C1", background: "#4A2235" },
      } },
  },
};

export function NotebookPage({ id, onBack, onRenamed, onDeleted, onAuthLost }: { id: string; onBack: () => void; onRenamed: () => void; onDeleted: () => void; onAuthLost: (code: string) => void }) {
  const [nb, setNb] = useState<NB | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setNb(null);
    setError("");
    api
      .get(id)
      .then(setNb)
      .catch((e: ApiError) => (e.status === 401 ? onAuthLost(e.code) : setError(e.status === 404 ? "This notebook was deleted or never existed." : e.message)));
  }, [id]);

  if (error) return <div className="page-msg">{error}</div>;
  if (!nb) return <div className="page-msg" aria-busy="true">Opening notebook…</div>;
  return <Editor key={nb.id} initial={nb} onBack={onBack} onRenamed={onRenamed} onDeleted={onDeleted} onAuthLost={onAuthLost} />;
}

function Editor({ initial, onBack, onRenamed, onDeleted, onAuthLost }: { initial: NB; onBack: () => void; onRenamed: () => void; onDeleted: () => void; onAuthLost: (code: string) => void }) {
  const scheme = useColorScheme();
  const [name, setName] = useState(initial.name);
  const [sync, setSync] = useState<SyncState>("saved");
  const [ai, setAi] = useState<AiMap>(initial.aiBlocks ?? {});
  const [flash, setFlash] = useState<string | null>(null);
  const ink = useMemo(() => new InkStore(initial.id, initial.inkAnchors ?? [], clientId), [initial.id]);
  const touchFirst = useMemo(() => matchMedia("(pointer: coarse)").matches, []);
  const [tool, setTool] = useState<InkTool>(touchFirst ? "pen" : "type");
  // Pen and highlighter each remember their own colour, so the swatch always matches what you draw.
  const [penColor, setPenColor] = useState(() => localStorage.getItem("noty:penColor") ?? "ink");
  const [hiColor, setHiColor] = useState(() => localStorage.getItem("noty:hiColor") ?? "yellow");
  const color = tool === "highlighter" ? hiColor : penColor;
  const setColor = (c: string) => {
    if (tool === "highlighter") setHiColor(c), localStorage.setItem("noty:hiColor", c);
    else setPenColor(c), localStorage.setItem("noty:penColor", c);
  };
  const [size, setSize] = useState(5);
  const [fingerDraws, setFingerDraws] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const [shapes, setShapes] = useState(() => localStorage.getItem("noty:shapes") === "1");
  const [pageStyle, setPageStyle] = useState<PageStyle>(() => {
    try {
      return { style: "dotted", size: "a4", ...JSON.parse(localStorage.getItem("noty:pageStyle") ?? "{}") };
    } catch {
      return { style: "dotted", size: "a4" };
    }
  });
  useEffect(() => void localStorage.setItem("noty:shapes", shapes ? "1" : "0"), [shapes]);
  useEffect(() => void localStorage.setItem("noty:pageStyle", JSON.stringify(pageStyle)), [pageStyle]);
  const newPage = () => ({ type: "page" as const, props: { style: pageStyle.style, size: pageStyle.size, height: PAGE_HEIGHTS[pageStyle.size] } });
  const [convert, setConvert] = useState<ConvertState | null>(null);
  const [isEmpty, setIsEmpty] = useState(false);
  useEffect(() => {
    const check = () => {
      const d = editor.document;
      setIsEmpty(d.length === 1 && d[0].type === "paragraph" && Array.isArray(d[0].content) && d[0].content.length === 0);
    };
    check();
    return editor.onChange(check);
  }, []);

  const version = useRef(initial.version);
  /** What the server has for each top-level block (as this editor normalises it), and their order. */
  const saved = useRef<{ blocks: Map<string, string>; order: string[] }>({ blocks: new Map(), order: [] });
  const applyingRemote = useRef(false);
  const timer = useRef<number>(0);
  const saving = useRef<Promise<void> | null>(null);

  // Unsaved work from last time (e.g. written offline, then the page was closed) wins over the server copy;
  // it's merged block by block when it syncs.
  const draftKey = `noty:draft:${initial.id}`;
  const draft = useMemo(() => {
    try {
      const d = JSON.parse(localStorage.getItem(draftKey) ?? "null") as { doc: NB["blocks"]; saved: [string, string][]; order: string[]; version: number } | null;
      return d && Array.isArray(d.doc) && d.doc.length ? d : null;
    } catch {
      return null;
    }
  }, [initial.id]);
  const editor = useCreateBlockNote({
    schema,
    initialContent: draft ? (draft.doc as never) : initial.blocks.length ? (initial.blocks as never) : undefined,
    uploadFile: (file: File) => api.upload(file),
  }) as NotyEditor;

  const snapshot = () => {
    const doc = editor.document;
    return { blocks: new Map(doc.map((b) => [b.id, JSON.stringify(b)])), order: doc.map((b) => b.id), doc };
  };
  const markSaved = (id: string) => {
    const b = editor.getBlock(id);
    if (b) saved.current.blocks.set(id, JSON.stringify(b));
    else saved.current.blocks.delete(id);
  };
  const isDirty = () => {
    const now = snapshot();
    if (now.order.join() !== saved.current.order.join()) return true;
    for (const [id, json] of now.blocks) if (saved.current.blocks.get(id) !== json) return true;
    return now.blocks.size !== saved.current.blocks.size;
  };

  // ----- autosave: send only the blocks that changed -----
  const save = async () => {
    const now = snapshot();
    const upserts = now.doc.filter((b) => saved.current.blocks.get(b.id) !== now.blocks.get(b.id));
    const deletes = [...saved.current.blocks.keys()].filter((id) => !now.blocks.has(id));
    if (!upserts.length && !deletes.length && now.order.join() === saved.current.order.join()) return setSync("saved");
    setSync("saving");
    try {
      const r = await api.save(initial.id, { upserts, deletes, order: now.order, baseVersion: version.current }, clientId);
      version.current = Math.max(version.current, r.version);
      for (const b of upserts) saved.current.blocks.set(b.id, now.blocks.get(b.id)!);
      for (const id of deletes) saved.current.blocks.delete(id);
      saved.current.order = now.order;
      setSync(isDirty() ? "unsaved" : "saved");
      writeDraft();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthLost(e.code);
      setSync(navigator.onLine ? "error" : "offline");
      writeDraft(); // keep it on this device until it can be sent
    }
  };
  const scheduleSave = (delay = 600) => {
    clearTimeout(timer.current);
    setSync((s) => (s === "saving" ? s : "unsaved"));
    timer.current = window.setTimeout(() => {
      saving.current = (saving.current ?? Promise.resolve()).then(save);
    }, delay);
  };

  useEffect(() => {
    const s = snapshot();
    saved.current = draft ? { blocks: new Map(draft.saved), order: draft.order } : { blocks: s.blocks, order: s.order };
    if (draft) {
      version.current = Math.min(version.current, draft.version);
      setSync("unsaved");
      setTimeout(() => scheduleSave(0), 300);
    }
    // Leaving the page: unsaved work is already kept on this device (and syncs next time), so just try to send it now.
    const beforeUnload = () => {
      if (isDirty()) {
        writeDraft();
        void save();
      }
    };
    addEventListener("beforeunload", beforeUnload);
    return () => {
      removeEventListener("beforeunload", beforeUnload);
      clearTimeout(timer.current);
      if (isDirty()) save();
    };
  }, []);

  const writeDraft = () => {
    try {
      if (isDirty()) {
        localStorage.setItem(draftKey, JSON.stringify({ doc: editor.document, saved: [...saved.current.blocks], order: saved.current.order, version: version.current }));
      } else localStorage.removeItem(draftKey);
    } catch {}
  };
  const draftTimer = useRef(0);
  useEffect(() => {
    const off = editor.onChange(() => {
      clearTimeout(draftTimer.current);
      draftTimer.current = window.setTimeout(writeDraft, 400);
    });
    const online = () => {
      setSync((s) => (s === "offline" || s === "error" ? "unsaved" : s));
      scheduleSave(0);
      void ink.flush();
    };
    const retry = setInterval(() => navigator.onLine && isDirty() && scheduleSave(0), 15_000);
    const offInk = ink.watchOnline();
    addEventListener("online", online);
    return () => {
      off?.();
      clearInterval(retry);
      offInk();
      removeEventListener("online", online);
    };
  }, []);

  const remote = (fn: () => void) => {
    applyingRemote.current = true;
    try {
      fn();
    } finally {
      setTimeout(() => (applyingRemote.current = false), 0);
    }
  };

  const reveal = (id: string) => {
    setFlash(id);
    setTimeout(() => setFlash(null), 2400);
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-node-type="blockOuter"][data-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }),
    );
  };

  /** Puts blocks at the end of the notebook, before the editor's empty last line if there is one. */
  /** True for the "nothing here yet" blocks at the end: empty lines and blank pages with no ink. */
  const isBlankTail = (b: (typeof editor.document)[number]) =>
    (b.type === "paragraph" && Array.isArray(b.content) && b.content.length === 0 && !b.children.length) || (b.type === "page" && !ink.hasInk(b.id));

  /** Puts blocks after the last line of real content (before trailing empty lines and blank pages). */
  const appendAtEnd = (fresh: NB["blocks"], after?: string | null) => {
    const doc = editor.document;
    if (after && editor.getBlock(after)) return void editor.insertBlocks(fresh as never, after, "after");
    let end = doc.length;
    while (end > 0 && isBlankTail(doc[end - 1])) end--;
    if (end > 0) editor.insertBlocks(fresh as never, doc[end - 1], "after");
    else if (doc.length && !(doc[0].type === "page")) editor.replaceBlocks([doc[0]], fresh as never);
    else if (doc.length) editor.insertBlocks(fresh as never, doc[0], "before");
    else editor.replaceBlocks(editor.document, fresh as never);
  };

  /**
   * Applies changes saved elsewhere (another device, tab, or an assistant), block by block.
   * A block you're in the middle of changing here keeps your version; it wins on your next save.
   */
  const applyRemote = (upserts: NB["blocks"], deletes: string[], order: string[]) => {
    const unchangedHere = (id: string) => {
      const b = editor.getBlock(id);
      return !b || JSON.stringify(b) === saved.current.blocks.get(id);
    };
    let firstNew: string | null = null;
    remote(() => {
      for (const id of deletes) {
        if (editor.getBlock(id) && unchangedHere(id)) editor.removeBlocks([id]);
        if (unchangedHere(id)) saved.current.blocks.delete(id);
      }
      for (const b of upserts) {
        const existing = editor.getBlock(b.id);
        if (existing) {
          if (unchangedHere(b.id)) {
            editor.updateBlock(b.id, b as never);
            markSaved(b.id);
          }
          continue;
        }
        // New block: put it after the block it follows on the server.
        const i = order.indexOf(b.id);
        let after: string | undefined;
        for (let j = i - 1; j >= 0; j--) if (editor.getBlock(order[j])) (after = order[j]), (j = -1);
        const before = !after ? order.slice(i + 1).find((id) => editor.getBlock(id)) : undefined;
        if (after) editor.insertBlocks([b as never], after, "after");
        else if (before) editor.insertBlocks([b as never], before, "before");
        else appendAtEnd([b]);
        markSaved(b.id);
        firstNew ??= b.id;
      }
    });
    saved.current.order = order.filter((id) => saved.current.blocks.has(id));
    return firstNew;
  };

  // Opened from a search result: scroll to that block and flash it.
  useEffect(() => {
    const b = new URLSearchParams(location.search).get("b");
    if (!b) return;
    const t = setTimeout(() => editor.getBlock(b) && reveal(b), 300);
    return () => clearTimeout(t);
  }, []);

  // ----- live updates -----
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let ping = 0;
    let firstConnect = true;

    const connect = () => {
      ws = new WebSocket(liveUrl(initial.id));
      ws.onopen = async () => {
        retry = 1000;
        ping = window.setInterval(() => ws?.readyState === 1 && ws.send("ping"), 30_000);
        setSync((s) => (s === "offline" ? "unsaved" : s));
        // After a reconnect (or when opening with unsaved work from last time), catch up on what changed meanwhile.
        if (!firstConnect || draft) {
          const latest = await api.get(initial.id).catch(() => null);
          if (latest && latest.version > version.current) {
            const ids = new Set(latest.blocks.map((b) => b.id));
            const changed = latest.blocks.filter((b) => !editor.getBlock(b.id) || saved.current.blocks.get(b.id) !== undefined);
            const gone = [...saved.current.blocks.keys()].filter((id) => !ids.has(id));
            applyRemote(changed, gone, latest.blocks.map((b) => b.id));
            setAi(latest.aiBlocks);
            version.current = latest.version;
          }
        }
        firstConnect = false;
      };
      ws.onmessage = (ev) => {
        if (ev.data === "pong") return;
        const msg = JSON.parse(ev.data);
        if (msg.type === "append") {
          const fresh = (msg.blocks as NB["blocks"]).filter((b) => !editor.getBlock(b.id));
          if (fresh.length) {
            remote(() => appendAtEnd(fresh, msg.after));
            fresh.forEach((b) => markSaved(b.id));
            saved.current.order = [...saved.current.order, ...fresh.map((b) => b.id)];
            reveal(fresh[0].id);
          }
          setAi((a) => ({ ...a, ...msg.aiBlocks }));
          version.current = Math.max(version.current, msg.version);
        } else if (msg.type === "patch") {
          if (msg.clientId !== clientId) {
            const first = applyRemote(msg.upserts, msg.deletes, msg.order);
            if (first) setFlash(first), setTimeout(() => setFlash(null), 2400);
          }
          setAi(msg.aiBlocks ?? {});
          version.current = Math.max(version.current, msg.version);
        } else if (msg.type === "ink") {
          ink.applyRemote(msg);
        } else if (msg.type === "meta") {
          setIcon(msg.icon ?? "");
          setFavorite(!!msg.favorite);
          setFont(msg.font || "neat");
        } else if (msg.type === "renamed") {
          setName(msg.name);
          onRenamed();
        } else if (msg.type === "deleted") {
          onDeleted();
        }
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (closed) return;
        setSync((s) => (s === "saved" ? s : "offline"));
        setTimeout(connect, (retry = Math.min(retry * 2, 30_000)));
      };
    };
    connect();
    return () => {
      closed = true;
      clearInterval(ping);
      ws?.close();
    };
  }, []);

  // ----- lasso "To text" -----
  const labelFor = (anchor: string) => {
    const doc = editor.document;
    const b = doc.find((x) => x.id === anchor);
    if (b?.type === "page") return `page ${doc.filter((x) => x.type === "page").findIndex((x) => x.id === anchor) + 1}`;
    const text = Array.isArray(b?.content) ? (b!.content as { text?: string }[]).map((c) => c.text ?? "").join("").slice(0, 40) : "";
    return text ? `the notes on “${text}”` : "this handwriting";
  };
  const onConvertText = async (picked: Selected[]) => {
    if (!picked.length) return;
    const anchor = picked[0].anchor;
    const where = labelFor(anchor);
    const ask = `Convert my handwriting on ${where} of my “${name}” notes to text.`;
    // Some browsers (Chrome on certain devices) can read handwriting themselves.
    const nav = navigator as Navigator & { createHandwritingRecognizer?: (o: unknown) => Promise<any> };
    const HS = (window as any).HandwritingStroke;
    if (nav.createHandwritingRecognizer && HS) {
      setConvert({ picked, anchor, ask, status: "reading" });
      try {
        const rec = await nav.createHandwritingRecognizer({ languages: ["en"] });
        const drawing = rec.startDrawing({ recognitionType: "text" });
        let t = 0;
        for (const { stroke } of picked) {
          const hs = new HS();
          const p = decodePoints(stroke);
          for (let i = 0; i + 2 < p.length; i += 3) hs.addPoint({ x: p[i], y: p[i + 1], t: (t += 8) });
          drawing.addStroke(hs);
        }
        const preds = await drawing.getPrediction();
        rec.finish?.();
        const text = preds?.[0]?.text?.trim();
        if (text) return setConvert({ picked, anchor, ask, status: "ready", text });
      } catch {}
    }
    setConvert({ picked, anchor, ask, status: "ask" });
  };
  const insertConverted = (text: string, removeInk: boolean) => {
    if (!convert) return;
    const blocks = text.split(/\n{2,}/).map((t) => ({ type: "paragraph" as const, content: t.trim() }));
    editor.insertBlocks(blocks, convert.anchor, "after");
    if (removeInk) ink.commit({ add: [], remove: convert.picked.map(({ anchor, stroke }) => ({ anchor, id: stroke.id, stroke })) });
    setConvert(null);
  };

  // ----- endless pages -----
  /** Adds a blank page at the very end, unless the last block already is one. */
  const ensureBlankPage = () => {
    const doc = editor.document;
    const last = doc[doc.length - 1];
    if (last && last.type === "page" && !ink.hasInk(last.id)) return false;
    if (last && last.type === "paragraph" && Array.isArray(last.content) && last.content.length === 0 && doc.length > 1 && doc[doc.length - 2].type === "page" && !ink.hasInk(doc[doc.length - 2].id)) return false;
    editor.insertBlocks([newPage()], last, "after");
    return true;
  };
  const addPage = () => {
    const doc = editor.document;
    const [p] = editor.insertBlocks([newPage()], doc[doc.length - 1], "after");
    requestAnimationFrame(() => document.querySelector(`[data-id="${CSS.escape(p.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  // Writing on the last page? Put a fresh one after it, so there's always room to keep going.
  const onStrokeEnd = (anchor: string) => {
    const doc = editor.document;
    const i = doc.findIndex((b) => b.id === anchor);
    if (i >= doc.length - 2) ensureBlankPage();
  };
  // Scrolling near the bottom with a pen tool: keep a blank page waiting.
  useEffect(() => {
    let t = 0;
    const check = () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        if (tool === "type" || !host.current) return;
        const r = host.current.getBoundingClientRect();
        if (r.bottom - innerHeight < innerHeight * 0.8) ensureBlankPage();
      }, 150);
    };
    check();
    addEventListener("scroll", check, { passive: true });
    return () => (clearTimeout(t), removeEventListener("scroll", check));
  }, [tool]);
  // Ink that hasn't reached the server yet is sent when leaving.
  useEffect(() => {
    ink.onSaveState = (st) => st === "error" && setSync(navigator.onLine ? "error" : "offline");
    const leave = () => ink.flush();
    addEventListener("pagehide", leave);
    return () => {
      removeEventListener("pagehide", leave);
      void ink.flush();
    };
  }, [ink]);
  // Keyboard: Cmd/Ctrl+Z undoes the last stroke when a pen tool is active.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tool === "type" || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      e.shiftKey ? ink.redo() : ink.undo();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [tool, ink]);

  // Mark blocks added by an assistant with a margin line and a "via …" label.
  const aiCss = useMemo(() => {
    const seen = new Set<string>();
    const rules = Object.entries(ai).map(([bid, { by, at }]) => {
      const sel = `[data-node-type="blockOuter"][data-id="${CSS.escape(bid)}"]>.bn-block`;
      // Label only the first block of each addition; the rest just get the margin line.
      const group = `${by}|${at}`;
      const first = !seen.has(group);
      seen.add(group);
      const label = `via ${by}`.replace(/["\\\n]/g, " ").slice(0, 40);
      return `${sel}::before{content:""}` + (first ? `${sel}::after{content:"${label}"}` : "");
    });
    if (flash) rules.push(`[data-node-type="blockOuter"][data-id="${CSS.escape(flash)}"]>.bn-block{animation:arrive 2.4s ease-out}`);
    return rules.join("\n");
  }, [ai, flash]);

  const slashItems = (q: string) => filterSuggestionItems([...customSlashItems(editor), ...getDefaultReactSlashMenuItems(editor)], q);

  const rename = async () => {
    const clean = name.trim();
    if (!clean || clean === initial.name) return setName(clean || initial.name);
    await api.rename(initial.id, clean).catch(() => {});
    onRenamed();
  };

  // Notion-style: Trash (restorable), favourite, icon, page history, backlinks.
  const remove = async () => {
    await api.remove(initial.id); // moves it to the Trash; it can be restored for 30 days
    onDeleted();
  };
  const [icon, setIcon] = useState(initial.meta?.icon ?? "");
  const [favorite, setFavorite] = useState(!!initial.meta?.favorite);
  // Text style: neat handwriting by default; "hand" = casual handwriting, "print" = printed font.
  const [font, setFont] = useState<string>(initial.meta?.font || "neat");
  const pickFont = async (f: string) => {
    const before = font;
    setFont(f);
    await api.update(initial.id, { font: f }).catch(() => setFont(before));
  };
  const [iconOpen, setIconOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [trashed, setTrashed] = useState(!!initial.trashed);
  const [links, setLinks] = useState<{ id: string; name: string; icon?: string }[]>([]);
  useEffect(() => {
    api.backlinks(initial.id).then(setLinks).catch(() => {});
  }, [initial.id]);
  useEffect(() => {
    editor.isEditable = !trashed; // a notebook in the Trash is read-only until restored
  }, [trashed]);
  const pickIcon = async (e: string) => {
    setIcon(e);
    setIconOpen(false);
    await api.update(initial.id, { icon: e }).catch(() => {});
    onRenamed();
  };
  const toggleFavorite = async () => {
    const v = !favorite;
    setFavorite(v);
    await api.update(initial.id, { favorite: v }).catch(() => setFavorite(!v));
    onRenamed();
  };
  const restoreFromTrash = async () => {
    await api.restore(initial.id).catch(() => {});
    setTrashed(false);
    onRenamed();
  };

  return (
    <article className={`sheet doc${font !== "print" ? ` font-${font}` : ""}`}>
      <style>{aiCss}</style>
      <div className="doc-top">
      <header className="doc-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back to library" title="Library">
          <Icon.back />
        </button>
        <div className="page-icon-wrap">
          <button type="button" className={`page-icon ${icon ? "" : "empty"}`} onClick={() => setIconOpen(!iconOpen)} aria-label={icon ? `Icon ${icon}. Change` : "Add an icon"} title={icon ? "Change icon" : "Add an icon"} aria-expanded={iconOpen}>
            {icon || <Icon.plus size={16} />}
          </button>
          {iconOpen && (
            <div className="page-icon-pop">
              <EmojiPicker value={icon} onPick={pickIcon} />
            </div>
          )}
        </div>
        <input
          className="sheet-title"
          aria-label="Notebook name"
          readOnly={trashed}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), editor.focus())}
        />
        <SyncBadge state={sync} onRetry={() => scheduleSave(0)} />
      </header>
      <InkToolbar
        tool={tool}
        setTool={setTool}
        color={color}
        setColor={setColor}
        size={size}
        setSize={setSize}
        fingerDraws={fingerDraws}
        setFingerDraws={setFingerDraws}
        onUndo={() => ink.undo()}
        onRedo={() => ink.redo()}
        onAddPage={addPage}
        shapes={shapes}
        setShapes={setShapes}
        pageStyle={pageStyle}
        setPageStyle={setPageStyle}
        docItems={
          <>
            <button type="button" className="ink-more-item" onClick={toggleFavorite} aria-pressed={favorite}>
              <span aria-hidden>{favorite ? "★" : "☆"}</span>
              <span className="ink-more-text">{favorite ? "Remove from Favorites" : "Add to Favorites"}</span>
            </button>
            <label className="ink-more-item ink-select">
              <span aria-hidden className="font-sample">Aa</span>
              <span className="ink-more-text">Text style</span>
              <select value={font} disabled={trashed} onChange={(e) => pickFont(e.target.value)} aria-label="Text style">
                <option value="neat">Neat handwriting</option>
                <option value="hand">Casual handwriting</option>
                <option value="print">Print</option>
              </select>
            </label>
            <button type="button" className="ink-more-item" onClick={() => setHistoryOpen(true)}>
              <Icon.undo />
              <span className="ink-more-text">Page history</span>
            </button>
            {!trashed && (
              <button type="button" className="ink-more-item danger" onClick={remove}>
                <Icon.trash />
                <span className="ink-more-text">
                  Move to Trash
                  <small>You can restore it for 30 days</small>
                </span>
              </button>
            )}
          </>
        }
      />
      </div>
      {trashed && (
        <div className="trash-banner" role="status">
          This notebook is in the Trash, so it can't be edited.
          <button type="button" className="btn" onClick={restoreFromTrash}>
            Restore notebook
          </button>
        </div>
      )}
      {historyOpen && (
        <HistoryDialog
          notebookId={initial.id}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => {
            setHistoryOpen(false);
            // reload so the editor shows the restored version cleanly
            try {
              localStorage.removeItem(`noty:draft:${initial.id}`);
            } catch {}
            location.reload();
          }}
        />
      )}
      {isEmpty && (
        <p className="empty-hint">
          <strong>This notebook is empty.</strong> Type here, write with your Pencil (pick <strong>Pen</strong> above), or ask your assistant to “add … to my {name} notes”.
        </p>
      )}
      {convert && <ConvertDialog state={convert} onClose={() => setConvert(null)} onInsert={insertConverted} />}
      <div className={`ink-host tool-${tool}`} ref={host}>
      <BlockNoteView
        editor={editor}
        theme={themes[scheme]}
        slashMenu={false}
        onChange={() => {
          if (!applyingRemote.current) scheduleSave();
        }}
      >
        <SuggestionMenuController triggerCharacter="/" getItems={async (q) => slashItems(q)} />
      </BlockNoteView>
      {links.length > 0 && (
        <aside className="backlinks" aria-label="Linked from">
          <h4>Linked from</h4>
          <ul>
            {links.map((l) => (
              <li key={l.id}>
                <a
                  href={`/n/${l.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    history.pushState(null, "", `/n/${l.id}`);
                    dispatchEvent(new PopStateEvent("popstate"));
                  }}
                >
                  <span aria-hidden>{l.icon || "📓"}</span> {l.name}
                </a>
              </li>
            ))}
          </ul>
        </aside>
      )}
      <InkLayer
        getRoot={() => editor.domElement?.querySelector(".bn-block-group")}
        subscribeLayout={(cb) => editor.onChange(cb)}
        store={ink}
        host={host}
        settings={{ tool, color, size, fingerDraws, shapes }}
        onStrokeEnd={onStrokeEnd}
        onConvertText={onConvertText}
      />
      </div>
    </article>
  );
}

function customSlashItems(editor: NotyEditor): DefaultReactSuggestionItem[] {
  const ins = (block: Parameters<typeof insertOrUpdateBlockForSlashMenu<any, any, any>>[1]) => () => insertOrUpdateBlockForSlashMenu(editor, block);
  const ico = (t: string, cls = "") => <span className={`slash-ico ${cls}`}>{t}</span>;
  return [
    { title: "Blank page", subtext: "Space to write or draw with the pen", aliases: ["page", "draw", "sketch", "pencil", "handwriting", "ink", "blank"], group: "Noty", icon: ico("▭"), onItemClick: ins({ type: "page" }) },
    { title: "Question card", subtext: "Question, answer, key points and a diagram", aliases: ["question", "qa", "q&a", "faq"], group: "Noty", icon: ico("Q"), onItemClick: ins({ type: "question" }) },
    { title: "Key points", subtext: "Highlighted list of important points", aliases: ["key", "points", "takeaways", "important"], group: "Noty", icon: ico("★", "hi"), onItemClick: ins({ type: "keyPoints" }) },
    { title: "Tip", subtext: "Green box", aliases: ["callout", "tip", "hint"], group: "Noty", icon: ico("💡"), onItemClick: ins({ type: "callout", props: { kind: "tip" } }) },
    { title: "Definition", subtext: "Purple box for a term and its meaning", aliases: ["callout", "definition", "term", "meaning"], group: "Noty", icon: ico("📖"), onItemClick: ins({ type: "callout", props: { kind: "definition" } }) },
    { title: "Example", subtext: "Teal box", aliases: ["callout", "example", "eg"], group: "Noty", icon: ico("🧪"), onItemClick: ins({ type: "callout", props: { kind: "example" } }) },
    { title: "Warning", subtext: "Orange box for common mistakes", aliases: ["callout", "warning", "caution", "mistake"], group: "Noty", icon: ico("⚠️"), onItemClick: ins({ type: "callout", props: { kind: "warning" } }) },
    { title: "Summary", subtext: "Blue box", aliases: ["callout", "summary", "tldr", "recap"], group: "Noty", icon: ico("📌"), onItemClick: ins({ type: "callout", props: { kind: "summary" } }) },
    { title: "Diagram", subtext: "Flowchart, sequence, timeline… from Mermaid code", aliases: ["diagram", "mermaid", "flowchart", "chart", "timeline"], group: "Noty", icon: ico("◇"), onItemClick: ins({ type: "diagram" }) },
    {
      title: "Mind map",
      subtext: "Central topic with branches",
      aliases: ["mindmap", "mind", "brainstorm"],
      group: "Noty",
      icon: ico("✺"),
      onItemClick: ins({ type: "diagram", props: { code: "mindmap\n  root((Topic))\n    Idea one\n      Detail\n    Idea two\n    Idea three" } }),
    },
    { title: "Flashcards", subtext: "Tap-to-flip cards for revision", aliases: ["flashcards", "cards", "quiz", "revise", "study"], group: "Noty", icon: ico("🃏"), onItemClick: ins({ type: "flashcards" }) },
    { title: "Board", subtext: "Task board: To do, Doing, Done", aliases: ["board", "kanban", "tasks", "todo", "project"], group: "Noty", icon: ico("▦"), onItemClick: ins({ type: "board" }) },
    { title: "Table of contents", subtext: "Lists this notebook's headings", aliases: ["toc", "contents", "outline", "headings"], group: "Noty", icon: ico("☰"), onItemClick: ins({ type: "toc" }) },
    { title: "Link to notebook", subtext: "A link to another notebook", aliases: ["link", "page", "notebook", "mention"], group: "Noty", icon: ico("↗"), onItemClick: ins({ type: "nblink" }) },
    { title: "Map", subtext: "Places with pins", aliases: ["map", "places", "location", "geography", "trip"], group: "Noty", icon: ico("⌖"), onItemClick: ins({ type: "map" }) },
  ];
}

const INK_COLORS = ["ink", "blue", "red", "green", "orange", "purple", "yellow"];
const INK_SIZES: [string, number][] = [["Fine", 3], ["Medium", 5], ["Bold", 9]];
const TOOL_LABEL: Record<InkTool, string> = { type: "Type", pen: "Pen", highlighter: "Highlighter", eraser: "Eraser", lasso: "Lasso" };

export type PageStyle = { style: "blank" | "lined" | "grid" | "dotted"; size: "a4" | "letter" };
/** Page height in ink units, for a page width of 1000 (A4 is 1:√2, Letter is 8.5×11). */
export const PAGE_HEIGHTS: Record<PageStyle["size"], number> = { a4: 1414, letter: 1294 };

type ConvertState = { picked: Selected[]; anchor: string; ask: string; status: "reading" | "ready" | "ask"; text?: string };

function ConvertDialog({ state, onClose, onInsert }: { state: ConvertState; onClose: () => void; onInsert: (text: string, removeInk: boolean) => void }) {
  const [text, setText] = useState(state.text ?? "");
  const [copied, setCopied] = useState(false);
  useEffect(() => setText(state.text ?? ""), [state.text]);
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="cv-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="cv-title">Handwriting to text</h2>
        {state.status === "reading" && <p>Reading your handwriting…</p>}
        {state.status === "ready" && (
          <>
            <p>Check the text, fix anything misread, then add it below your handwriting.</p>
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => onInsert(text, true)} disabled={!text.trim()}>
                Replace handwriting with text
              </button>
              <button type="button" className="btn quiet" onClick={() => onInsert(text, false)} disabled={!text.trim()}>
                Add text, keep handwriting
              </button>
            </div>
          </>
        )}
        {state.status === "ask" && (
          <>
            <p>This browser can't read handwriting by itself, but your AI assistant can: it looks at a picture of your page and types it out, right below it. Ask it:</p>
            <blockquote className="ask">{state.ask}</blockquote>
            <div className="dialog-actions">
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(state.ask).catch(() => {});
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy request"}
              </button>
              <button type="button" className="btn quiet" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function InkToolbar(p: {
  tool: InkTool;
  setTool: (t: InkTool) => void;
  color: string;
  setColor: (c: string) => void;
  size: number;
  setSize: (n: number) => void;
  fingerDraws: boolean;
  setFingerDraws: (b: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  onAddPage?: () => void;
  shapes?: boolean;
  setShapes?: (b: boolean) => void;
  pageStyle?: PageStyle;
  setPageStyle?: (p: PageStyle) => void;
  /** Document actions (delete, download…) shown at the end of the "…" menu. */
  docItems?: React.ReactNode;
  /** Override the mode buttons (PDFs use Select / Text / Pen / Highlighter / Eraser). */
  modes?: { id: string; label: string }[];
  mode?: string;
  setMode?: (m: string) => void;
}) {
  const modes = p.modes ?? (["type", "pen", "highlighter", "eraser", "lasso"] as InkTool[]).map((t) => ({ id: t, label: TOOL_LABEL[t] }));
  const current = p.mode ?? p.tool;
  const pick = (m: string) => (p.setMode ? p.setMode(m) : p.setTool(m as InkTool));
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: PointerEvent) => !moreRef.current?.contains(e.target as Node) && setMoreOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMoreOpen(false);
    addEventListener("pointerdown", close);
    addEventListener("keydown", esc);
    return () => (removeEventListener("pointerdown", close), removeEventListener("keydown", esc));
  }, [moreOpen]);
  const tip = `var(--draw-${p.color})`;
  const iconFor = (id: string) => {
    const I = (Icon as Record<string, (x: { tip?: string }) => React.ReactElement>)[id] ?? Icon.pen;
    return <I tip={id === "pen" ? tip : undefined} />;
  };
  return (
    <div className="ink-bar">
      <div className="ink-dock" role="toolbar" aria-label="Writing tools">
        <div className="ink-modes" role="radiogroup" aria-label="Tool">
          {modes.map((m) => {
            const on = current === m.id;
            return (
              <button key={m.id} type="button" role="radio" aria-checked={on} title={m.label} className={`ink-mode ${on ? "on" : ""}`} onClick={() => pick(m.id)}>
                {iconFor(m.id)}
                <span className={on ? "ink-mode-label" : "visually-hidden"}>{m.label}</span>
              </button>
            );
          })}
        </div>
        <span className="ink-sep" aria-hidden />
        <div className="ink-group" role="radiogroup" aria-label="Pen colour">
          {INK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={p.color === c}
              aria-label={c === "ink" ? "Ink" : c[0].toUpperCase() + c.slice(1)}
              title={c === "ink" ? "Ink" : c[0].toUpperCase() + c.slice(1)}
              className={`ink-swatch ${p.color === c ? "on" : ""}`}
              style={{ background: `var(--draw-${c})` }}
              onClick={() => {
                // Picking a colour keeps Pen or Highlighter; from any other tool it switches to the Pen.
                if (current !== "pen" && current !== "highlighter" && current !== "text") pick("pen");
                p.setColor(c);
              }}
            />
          ))}
        </div>
        <span className="ink-sep" aria-hidden />
        <div className="ink-group" role="radiogroup" aria-label="Pen size">
          {INK_SIZES.map(([label, n]) => (
            <button key={n} type="button" role="radio" aria-checked={p.size === n} aria-label={label} title={label} className={`ink-size ${p.size === n ? "on" : ""}`} onClick={() => p.setSize(n)}>
              <span style={{ width: n + 3, height: n + 3 }} />
            </button>
          ))}
        </div>
        <span className="ink-sep" aria-hidden />
        <div className="ink-group">
          <button type="button" className="ink-icon" onClick={p.onUndo} title="Undo last stroke (Cmd/Ctrl+Z)">
            <Icon.undo />
            <span className="visually-hidden">Undo</span>
          </button>
          <button type="button" className="ink-icon" onClick={p.onRedo} title="Redo (Shift+Cmd/Ctrl+Z)">
            <Icon.redo />
            <span className="visually-hidden">Redo</span>
          </button>
        </div>
        <div className="ink-more-wrap" ref={moreRef}>
          <button type="button" className={`ink-icon ${moreOpen ? "on" : ""}`} aria-expanded={moreOpen} aria-haspopup="true" title="More options" onClick={() => setMoreOpen(!moreOpen)}>
            <Icon.more />
            <span className="visually-hidden">More</span>
          </button>
          <div className="ink-more" hidden={!moreOpen} role="group" aria-label="More options">
            {p.setShapes && (
              <button type="button" className="ink-more-item" aria-pressed={!!p.shapes} onClick={() => p.setShapes!(!p.shapes)}>
                <Icon.shapes />
                <span className="ink-more-text">
                  Shapes
                  <small>Rough lines, arrows, circles and boxes snap clean</small>
                </span>
                <span className={`switch ${p.shapes ? "on" : ""}`} aria-hidden />
              </button>
            )}
            <button type="button" className="ink-more-item" aria-pressed={p.fingerDraws} onClick={() => p.setFingerDraws(!p.fingerDraws)}>
              <Icon.hand />
              <span className="ink-more-text">
                Finger draws
                <small>Off: your finger scrolls, only the Pencil writes</small>
              </span>
              <span className={`switch ${p.fingerDraws ? "on" : ""}`} aria-hidden />
            </button>
            {p.pageStyle && p.setPageStyle && (
              <label className="ink-more-item ink-select">
                <Icon.page />
                <span className="ink-more-text">New pages</span>
                <select
                  value={`${p.pageStyle.style}:${p.pageStyle.size}`}
                  onChange={(e) => {
                    const [style, size] = e.target.value.split(":") as [PageStyle["style"], PageStyle["size"]];
                    p.setPageStyle!({ style, size });
                  }}
                >
                  {(["dotted", "lined", "grid", "blank"] as const).flatMap((st) =>
                    (["a4", "letter"] as const).map((sz) => (
                      <option key={`${st}:${sz}`} value={`${st}:${sz}`}>
                        {st[0].toUpperCase() + st.slice(1)}, {sz === "a4" ? "A4" : "Letter"}
                      </option>
                    )),
                  )}
                </select>
              </label>
            )}
            {p.onAddPage && (
              <button type="button" className="ink-more-item" onClick={() => (p.onAddPage!(), setMoreOpen(false))}>
                <Icon.page />
                <span className="ink-more-text">Add page</span>
              </button>
            )}
            <div className="ink-more-item theme-row">
              <Icon.auto />
              <span className="ink-more-text">Appearance</span>
              <ThemeSwitch />
            </div>
            {p.docItems && <hr className="ink-more-sep" />}
            {p.docItems}
          </div>
        </div>
      </div>
    </div>
  );
}

function SyncBadge({ state, onRetry }: { state: SyncState; onRetry: () => void }) {
  const text: Record<SyncState, string> = {
    saved: "Saved",
    saving: "Saving…",
    unsaved: "Editing",
    offline: "Offline: changes save when you reconnect",
    error: "Couldn't save",
  };
  return (
    <span className={`sync sync-${state}`} role="status" aria-live="polite" title="A copy goes to Google Drive / Noty a few seconds after each save">
      <span className="sync-text">{text[state]}</span>
      {state === "error" && (
        <button type="button" className="link-btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </span>
  );
}
