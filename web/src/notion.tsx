// Notion-style extras: icons, cover colours, templates, page history.

import { useEffect, useState } from "react";
import { blocksToMarkdown, type Block } from "../../src/shared/blocks";
import { api, type NotebookMeta, type Snapshot } from "./api";

export const EMOJIS = [
  "📓", "📒", "📕", "📗", "📘", "📙", "📔", "📝", "✏️", "📚", "🎓", "🧪",
  "🔬", "🧬", "⚗️", "🧮", "📐", "📊", "📈", "💡", "🧠", "🌍", "🗺️", "💼",
  "🗂️", "✅", "📌", "⭐", "❤️", "🎵", "🎨", "🏃", "🍳", "✈️", "🏠", "💻",
  "🐍", "⚛️", "🔒", "💰", "📅", "🤖", "🌱", "🔥", "🎯", "🧩", "📖", "🗒️",
];
export const COVER_COLORS = ["#2F4B8F", "#2E6B4F", "#6B3FA0", "#B4532A", "#1F6F78", "#8A2D4D", "#4F5A2E", "#3B4252", "#A3782A", "#4A6FA5"];
export const autoCover = (id: string) => COVER_COLORS.slice(0, 8)[[...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 8];
export const coverOf = (b: Pick<NotebookMeta, "id" | "cover">) => b.cover || autoCover(b.id);

export function EmojiPicker({ value, onPick }: { value?: string; onPick: (e: string) => void }) {
  return (
    <div className="emoji-picker" role="listbox" aria-label="Icon">
      {EMOJIS.map((e) => (
        <button key={e} type="button" role="option" aria-selected={value === e} className={value === e ? "on" : ""} onClick={() => onPick(e)}>
          {e}
        </button>
      ))}
      <button type="button" className="emoji-none" onClick={() => onPick("")}>
        No icon
      </button>
    </div>
  );
}

export function CoverPicker({ value, id, onPick }: { value?: string; id: string; onPick: (c: string) => void }) {
  return (
    <div className="cover-picker" role="radiogroup" aria-label="Cover colour">
      <button type="button" role="radio" aria-checked={!value} className={`cover-swatch auto ${!value ? "on" : ""}`} style={{ background: autoCover(id) }} onClick={() => onPick("")} title="Automatic">
        A
      </button>
      {COVER_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} className={`cover-swatch ${value === c ? "on" : ""}`} style={{ background: c }} onClick={() => onPick(c)} />
      ))}
    </div>
  );
}

// ---------- templates ----------

const id = () => crypto.randomUUID();
const t = (text: string, bold = false) => ({ type: "text", text, styles: bold ? { bold: true } : {} });
const P = (text = "") => ({ id: id(), type: "paragraph", props: {}, content: text ? [t(text)] : [], children: [] });
const H = (text: string, level = 2) => ({ id: id(), type: "heading", props: { level }, content: [t(text)], children: [] });
const LI = (type: string, text: string, props: Record<string, unknown> = {}) => ({ id: id(), type, props, content: text ? [t(text)] : [], children: [] });
const CALLOUT = (kind: string, text: string, title = "") => ({ id: id(), type: "callout", props: { kind, title }, content: [t(text)], children: [] });
const PAGE = (style = "dotted") => ({ id: id(), type: "page", props: { height: 1414, style, size: "a4" }, children: [] });
const BOARD = (cols: [string, string[]][]) => ({
  id: id(),
  type: "board",
  props: { title: "", columns: JSON.stringify(cols.map(([name, cards]) => ({ id: id().slice(0, 8), name, cards: cards.map((c) => ({ id: id().slice(0, 8), text: c })) }))) },
  children: [],
});
const TABLE = (head: string[], rows: string[][]) => ({
  id: id(),
  type: "table",
  props: { textColor: "default" },
  content: {
    type: "tableContent",
    columnWidths: head.map(() => undefined),
    headerRows: 1,
    rows: [head, ...rows].map((r, i) => ({ cells: r.map((c) => ({ type: "tableCell", props: { backgroundColor: i === 0 ? "blue" : "default", textColor: "default", textAlignment: "left" }, content: c ? [t(c)] : [] })) })),
  },
  children: [],
});

export const TEMPLATES: { id: string; name: string; icon: string; about: string; blocks: () => unknown[] }[] = [
  { id: "blank", name: "Blank", icon: "📓", about: "An empty notebook.", blocks: () => [] },
  {
    id: "lecture",
    name: "Lecture notes",
    icon: "🎓",
    about: "Key ideas, a summary box and a page to write on.",
    blocks: () => [H("Key ideas"), LI("bulletListItem", ""), H("Details"), P(), CALLOUT("summary", "Write the one-paragraph summary here."), H("Handwritten notes"), PAGE("lined")],
  },
  {
    id: "meeting",
    name: "Meeting notes",
    icon: "💼",
    about: "Agenda, notes, decisions and action items.",
    blocks: () => [H("Agenda"), LI("numberedListItem", ""), H("Notes"), P(), H("Decisions"), LI("bulletListItem", ""), H("Action items"), LI("checkListItem", "", { checked: false })],
  },
  {
    id: "todo",
    name: "To-do list",
    icon: "✅",
    about: "A task board plus a quick checklist.",
    blocks: () => [BOARD([["To do", ["First task"]], ["Doing", []], ["Done", []]]), H("Quick list"), LI("checkListItem", "", { checked: false })],
  },
  {
    id: "study",
    name: "Study plan",
    icon: "📅",
    about: "A schedule table, exam tips and a revision board.",
    blocks: () => [
      H("Schedule"),
      TABLE(["Topic", "When", "Done?"], [["", "", ""], ["", "", ""], ["", "", ""]]),
      { id: id(), type: "keyPoints", props: { title: "Exam tips", points: "Start with past papers\nTeach it back in your own words" }, children: [] },
      H("Revision"),
      BOARD([["To revise", []], ["Revising", []], ["Confident", []]]),
    ],
  },
  {
    id: "reading",
    name: "Reading notes",
    icon: "📖",
    about: "Summary, key terms, quotes and questions.",
    blocks: () => [H("Summary"), P(), CALLOUT("definition", "A key term and what it means.", "Term"), H("Quotes"), LI("quote", ""), H("Questions"), LI("bulletListItem", "")],
  },
];

export function NewNotebookDialog({ onClose, onCreated, topics = [], defaultTopic = "" }: { onClose: () => void; onCreated: (id: string) => void; topics?: string[]; defaultTopic?: string }) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState(defaultTopic);
  const [tpl, setTpl] = useState("blank");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const create = async () => {
    const chosen = TEMPLATES.find((x) => x.id === tpl)!;
    const n = name.trim() || (tpl === "blank" ? "Untitled" : chosen.name);
    setBusy(true);
    setErr("");
    try {
      const nb = await api.create(n, topic.trim() || undefined);
      const blocks = chosen.blocks() as { id: string }[];
      if (blocks.length) await api.save(nb.id, { upserts: blocks, deletes: [], order: blocks.map((b) => b.id), baseVersion: 1 }, "template");
      if (chosen.icon && tpl !== "blank") await api.update(nb.id, { icon: chosen.icon });
      onCreated(nb.id);
    } catch (e) {
      setErr((e as Error).message || "Couldn't create the notebook.");
      setBusy(false);
    }
  };
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="nn-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="nn-title">New notebook</h2>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tpl === "blank" ? "Untitled" : TEMPLATES.find((x) => x.id === tpl)!.name} onKeyDown={(e) => e.key === "Enter" && !busy && create()} />
        </label>
        <label className="field">
          <span>Topic (optional)</span>
          <input list="topic-options" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Biology, Work, DSA" />
          <datalist id="topic-options">
            {topics.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <p className="field-label">Start from</p>
        <div className="templates" role="radiogroup" aria-label="Template">
          {TEMPLATES.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={tpl === x.id} className={`template ${tpl === x.id ? "on" : ""}`} onClick={() => setTpl(x.id)}>
              <span className="template-icon" aria-hidden>
                {x.icon}
              </span>
              <span className="template-name">{x.name}</span>
              <span className="template-about">{x.about}</span>
            </button>
          ))}
        </div>
        {err && <p className="warn">{err}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create notebook"}
          </button>
          <button type="button" className="btn quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- page history ----------

const when = (ts: number) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function HistoryDialog({ notebookId, onClose, onRestored }: { notebookId: string; onClose: () => void; onRestored: () => void }) {
  const [list, setList] = useState<Snapshot[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .history(notebookId)
      .then((l) => (setList(l), l[0] && setSel(l[0].ts)))
      .catch(() => setList([]));
  }, [notebookId]);
  useEffect(() => {
    if (!sel) return;
    setPreview("Loading…");
    api
      .snapshot(notebookId, sel)
      .then((r) => setPreview(blocksToMarkdown(r.blocks as Block[]).slice(0, 4000) || "(empty)"))
      .catch(() => setPreview("Couldn't load this version."));
  }, [sel]);
  const restore = async () => {
    if (!sel) return;
    setBusy(true);
    await api.restoreSnapshot(notebookId, sel).catch(() => {});
    onRestored();
  };
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog wide history" role="dialog" aria-modal="true" aria-labelledby="hist-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="hist-title">Page history</h2>
        <p className="fine">A version is kept every 10 minutes while the notebook changes (the last 40). Restoring keeps the current version in history too, so you can undo it. Handwriting isn't part of history.</p>
        {list === null ? (
          <p>Loading…</p>
        ) : list.length === 0 ? (
          <p>No earlier versions yet. They appear as you edit.</p>
        ) : (
          <div className="history-body">
            <ul className="history-list">
              {list.map((h, i) => (
                <li key={h.ts}>
                  <button type="button" className={sel === h.ts ? "on" : ""} onClick={() => setSel(h.ts)}>
                    <span>{i === 0 ? `${when(h.ts)} (latest)` : when(h.ts)}</span>
                    <small>{h.blockCount} blocks</small>
                  </button>
                </li>
              ))}
            </ul>
            <pre className="history-preview">{preview}</pre>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={restore} disabled={!sel || busy || !list?.length}>
            {busy ? "Restoring…" : "Restore this version"}
          </button>
          <button type="button" className="btn quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
