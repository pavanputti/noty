// Notebook content model. Blocks use the same JSON shape as the BlockNote editor,
// so anything the AI adds through MCP opens directly in the web editor.

export type Styles = { bold?: true; italic?: true; code?: true; strike?: true };
export type InlineText = { type: "text"; text: string; styles: Styles };
export type InlineLink = { type: "link"; href: string; content: InlineText[] };
export type Inline = InlineText | InlineLink;

export interface Block {
  id: string;
  type: string;
  props: Record<string, string | number | boolean>;
  // Inline[] for text blocks, a table object for tables.
  content?: any;
  children: Block[];
}

const uid = () => crypto.randomUUID();

// ---------- inline text ----------

/** Parses a small, safe subset of inline markdown: **bold**, *italic*, `code`, [link](url). */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*]+)\*|_([^_]+)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index), styles: {} });
    if (m[2]) out.push({ type: "text", text: m[2], styles: { bold: true } });
    else if (m[3]) out.push({ type: "text", text: m[3], styles: { code: true } });
    else if (m[4]) out.push({ type: "link", href: m[5], content: [{ type: "text", text: m[4], styles: {} }] });
    else out.push({ type: "text", text: m[6] ?? m[7], styles: { italic: true } });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last), styles: {} });
  return out;
}

// ---------- block builders ----------

const text = (type: string, t: string, props: Block["props"] = {}): Block => ({
  id: uid(),
  type,
  props,
  content: inline(t),
  children: [],
});

export const paragraph = (t: string) => text("paragraph", t);
export const heading = (t: string, level: 1 | 2 | 3 = 2) => text("heading", t, { level });

export function keyPointsBlock(title: string, points: string[]): Block {
  return { id: uid(), type: "keyPoints", props: { title, points: points.join("\n") }, children: [] };
}

export function questionBlock(q: { question: string; answer: string; keyPoints?: string[]; diagram?: string }): Block {
  return {
    id: uid(),
    type: "question",
    props: {
      question: q.question,
      answer: q.answer,
      points: (q.keyPoints ?? []).join("\n"),
      diagram: q.diagram ?? "",
    },
    children: [],
  };
}

export function diagramBlock(code: string, caption = ""): Block {
  return { id: uid(), type: "diagram", props: { code, caption }, children: [] };
}

export function imageBlock(url: string, caption = "", name = ""): Block {
  return { id: uid(), type: "image", props: { url, caption, name, showPreview: true }, children: [] };
}

export const CALLOUT_KINDS = ["tip", "definition", "example", "warning", "summary", "note"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** A coloured box with editable text: tip, definition, example, warning, summary or note. */
export function calloutBlock(kind: CalloutKind, text: string, title = ""): Block {
  return { id: uid(), type: "callout", props: { kind, title }, content: inline(text), children: [] };
}

export const TABLE_COLORS = ["blue", "green", "purple", "orange", "pink", "yellow", "red", "gray"] as const;
export type TableColor = (typeof TABLE_COLORS)[number];

/** A real editor table; the header row is tinted with `color`. */
export function tableBlock(columns: string[], rows: string[][], color: TableColor = "blue"): Block {
  const width = Math.max(columns.length, ...rows.map((r) => r.length), 1);
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? "");
  const cell = (t: string, header: boolean) => ({
    type: "tableCell",
    props: { backgroundColor: header ? color : "default", textColor: "default", textAlignment: "left" },
    content: inline(t),
  });
  const all = columns.length ? [pad(columns), ...rows.map(pad)] : rows.map(pad);
  return {
    id: uid(),
    type: "table",
    props: { textColor: "default" },
    content: {
      type: "tableContent",
      columnWidths: Array(width).fill(undefined),
      headerRows: columns.length ? 1 : 0,
      rows: all.map((r, i) => ({ cells: r.map((t) => cell(t, columns.length > 0 && i === 0)) })),
    },
    children: [],
  };
}

export interface MindMapNode {
  label: string;
  children?: MindMapNode[];
}

/** Builds Mermaid mind-map code from a simple tree, so assistants don't have to get the syntax right. */
export function mindMapCode(center: string, branches: MindMapNode[]): string {
  const clean = (s: string) => s.replace(/[()[\]{}"\n]/g, " ").replace(/\s+/g, " ").trim() || "…";
  const out = ["mindmap", `  root((${clean(center)}))`];
  const walk = (nodes: MindMapNode[], depth: number) => {
    for (const n of nodes) {
      out.push(`${"  ".repeat(depth)}${clean(n.label)}`);
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(branches, 2);
  return out.join("\n");
}

export interface Place {
  name: string;
  lat: number;
  lng: number;
  note?: string;
}

/** A map with pins (OpenStreetMap). Places are stored as JSON in a prop. */
export interface Flashcard {
  front: string;
  back: string;
}

/** A deck of tap-to-flip flashcards. Cards are stored as JSON in a prop. */
export function flashcardsBlock(cards: Flashcard[], title = ""): Block {
  return { id: uid(), type: "flashcards", props: { title, cards: JSON.stringify(cards) }, children: [] };
}

export interface BoardColumn {
  id: string;
  name: string;
  cards: { id: string; text: string }[];
}

/** A kanban board: columns of cards you can move between (To do / Doing / Done). */
export function boardBlock(columns: { name: string; cards: string[] }[], title = ""): Block {
  const cols: BoardColumn[] = columns.map((c) => ({ id: uid().slice(0, 8), name: c.name, cards: c.cards.map((t) => ({ id: uid().slice(0, 8), text: t })) }));
  return { id: uid(), type: "board", props: { title, columns: JSON.stringify(cols) }, children: [] };
}

/** A blank page to write or draw on with the pen. Height is in units where the page width is 1000. */
export function pageBlock(height = 1414): Block {
  return { id: uid(), type: "page", props: { height }, children: [] };
}

export function mapBlock(places: Place[], title = ""): Block {
  return { id: uid(), type: "map", props: { title, places: JSON.stringify(places) }, children: [] };
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Converts markdown (as an LLM usually writes it) into editor blocks. */
export function markdownToBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    const fence = trimmed.match(/^```(\w*)/);
    if (fence) {
      const body: string[] = [];
      while (++i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i]);
      const lang = fence[1].toLowerCase();
      if (lang === "mermaid") blocks.push(diagramBlock(body.join("\n")));
      else
        blocks.push({
          id: uid(),
          type: "codeBlock",
          props: { language: lang || "text" },
          content: [{ type: "text", text: body.join("\n"), styles: {} }],
          children: [],
        });
      continue;
    }

    // Markdown table: a | row | followed by a | --- | separator.
    if (trimmed.startsWith("|") && /^\|?\s*:?-{3,}/.test(lines[i + 1]?.trim() ?? "")) {
      const header = splitRow(trimmed);
      const rows: string[][] = [];
      i++;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) rows.push(splitRow(lines[++i]));
      blocks.push(tableBlock(header, rows));
      continue;
    }

    // Callout written as "> [!tip] text" (GitHub / Obsidian style).
    const callout = trimmed.match(/^>\s*\[!(\w+)\]\s*(.*)/);
    if (callout && (CALLOUT_KINDS as readonly string[]).includes(callout[1].toLowerCase())) {
      blocks.push(calloutBlock(callout[1].toLowerCase() as CalloutKind, callout[2]));
      continue;
    }

    let m: RegExpMatchArray | null;
    if ((m = trimmed.match(/^(#{1,3})\s+(.*)/))) blocks.push(heading(m[2], m[1].length as 1 | 2 | 3));
    else if ((m = trimmed.match(/^[-*]\s+\[( |x|X)\]\s+(.*)/)))
      blocks.push(text("checkListItem", m[2], { checked: m[1].toLowerCase() === "x" }));
    else if ((m = trimmed.match(/^[-*•]\s+(.*)/))) blocks.push(text("bulletListItem", m[1]));
    else if ((m = trimmed.match(/^\d+[.)]\s+(.*)/))) blocks.push(text("numberedListItem", m[1]));
    else if ((m = trimmed.match(/^>\s?(.*)/))) blocks.push(text("quote", m[1]));
    else if (/^(-{3,}|\*{3,})$/.test(trimmed)) blocks.push({ id: uid(), type: "divider", props: {}, children: [] });
    else blocks.push(paragraph(trimmed));
  }
  return blocks;
}

// ---------- reading back ----------

function inlineToText(content: unknown, md: boolean): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => {
      if (c.type === "link") {
        const t = inlineToText(c.content, false);
        return md ? `[${t}](${c.href})` : t;
      }
      const t = String(c.text ?? "");
      if (!md) return t;
      if (c.styles?.code) return "`" + t + "`";
      if (c.styles?.bold) return `**${t}**`;
      if (c.styles?.italic) return `*${t}*`;
      return t;
    })
    .join("");
}

const lines = (s: unknown) =>
  String(s ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Renders blocks as readable markdown: used for the .md copy in Drive and for read_notebook. */
/** `inked`: ids of blocks with handwriting on them, so readers know it's there. */
export function blocksToMarkdown(blocks: Block[], depth = 0, inked?: Set<string>): string {
  const tocSource = depth === 0 ? blocks.filter((b) => b.type === "heading") : [];
  const pad = "  ".repeat(depth);
  let n = 0;
  const out: string[] = [];
  for (const b of blocks) {
    const t = inlineToText(b.content, true);
    const p = b.props ?? {};
    if (b.type !== "numberedListItem") n = 0;
    switch (b.type) {
      case "heading":
        out.push(`${"#".repeat(Number(p.level) || 2)} ${t}`);
        break;
      case "bulletListItem":
        out.push(`${pad}- ${t}`);
        break;
      case "numberedListItem":
        out.push(`${pad}${++n}. ${t}`);
        break;
      case "checkListItem":
        out.push(`${pad}- [${p.checked ? "x" : " "}] ${t}`);
        break;
      case "quote":
        out.push(`> ${t}`);
        break;
      case "divider":
        out.push("---");
        break;
      case "codeBlock":
        out.push("```" + (p.language ?? "") + "\n" + inlineToText(b.content, false) + "\n```");
        break;
      case "image":
        out.push(`![${p.caption || p.name || "image"}](${p.url})`);
        break;
      case "diagram":
        out.push("```mermaid\n" + p.code + "\n```" + (p.caption ? `\n*${p.caption}*` : ""));
        break;
      case "keyPoints":
        out.push(`**⭐ ${p.title || "Key points"}**\n` + lines(p.points).map((l) => `- ${l}`).join("\n"));
        break;
      case "question": {
        const parts = [`**❓ ${p.question}**`, String(p.answer ?? "")];
        const pts = lines(p.points);
        if (pts.length) parts.push("Key points:\n" + pts.map((l) => `- ${l}`).join("\n"));
        if (p.diagram) parts.push("```mermaid\n" + p.diagram + "\n```");
        out.push(parts.join("\n\n"));
        break;
      }
      case "callout": {
        const label = String(p.kind ?? "note");
        out.push(`> **${label[0].toUpperCase() + label.slice(1)}${p.title ? `: ${p.title}` : ""}** ${t}`);
        break;
      }
      case "map": {
        let places: Place[] = [];
        try {
          places = JSON.parse(String(p.places || "[]"));
        } catch {}
        out.push(`**🗺 ${p.title || "Map"}**\n` + places.map((pl) => `- ${pl.name} (${pl.lat}, ${pl.lng})${pl.note ? `: ${pl.note}` : ""}`).join("\n"));
        break;
      }
      case "flashcards": {
        let cards: Flashcard[] = [];
        try {
          cards = JSON.parse(String(p.cards || "[]"));
        } catch {}
        out.push(`**🃏 ${p.title || "Flashcards"}** (${cards.length} cards)\n` + cards.map((c, i) => `${i + 1}. **Q:** ${c.front}\n   **A:** ${c.back}`).join("\n"));
        break;
      }
      case "board": {
        let cols: BoardColumn[] = [];
        try {
          cols = JSON.parse(String(p.columns || "[]"));
        } catch {}
        out.push(`**📋 ${p.title || "Board"}**\n` + cols.map((c) => `- **${c.name}**${c.cards.length ? "\n" + c.cards.map((k) => `  - ${k.text}`).join("\n") : " (empty)"}`).join("\n"));
        break;
      }
      case "toc":
        out.push("**Contents**\n" + (tocSource.length ? tocSource.map((h) => `${"  ".repeat(Math.max(0, (Number(h.props.level) || 1) - 1))}- ${inlineToText(h.content, false)}`).join("\n") : "- (no headings yet)"));
        break;
      case "nblink":
        out.push(`→ ${p.title || "Linked notebook"}`);
        break;
      case "page":
        if (inked?.has(b.id)) out.push("*[Handwritten page. Open the notebook to see it.]*");
        break;
      case "table": {
        const rows: any[] = (b.content as any)?.rows ?? [];
        rows.forEach((r, i) => {
          const cells = (r.cells ?? []).map((c: any) => inlineToText(Array.isArray(c) ? c : c?.content, true));
          out.push(`| ${cells.join(" | ")} |`);
          if (i === 0) out.push(`|${cells.map(() => " --- ").join("|")}|`);
        });
        break;
      }
      default:
        if (t) out.push(pad + t);
    }
    if (inked?.has(b.id) && b.type !== "page" && out.length) out[out.length - 1] += " *(has handwritten notes on it)*";
    if (b.children?.length) out.push(blocksToMarkdown(b.children, depth + 1, inked));
  }
  // Consecutive list items sit on adjacent lines; everything else gets a blank line between.
  const list = /^(\s*)([-*]|\d+\.) /;
  return out.reduce((acc, cur, i) => (i === 0 ? cur : acc + ((depth || (list.test(out[i - 1]) && list.test(cur))) ? "\n" : "\n\n") + cur), "");
}

/** Plain text of a block and its children, for search. */
export function blockText(b: Block): string {
  const p = b.props ?? {};
  const table = b.type === "table" ? ((b.content as any)?.rows ?? []).flatMap((r: any) => (r.cells ?? []).map((c: any) => inlineToText(Array.isArray(c) ? c : c?.content, false))).join(" ") : "";
  const board = b.type === "board" ? String(p.columns ?? "").replace(/[{}"[\]]|\bid\b|name|cards|text/g, " ") : "";
  const cards = b.type === "flashcards" ? String(p.cards ?? "").replace(/[{}"[\]]|front|back/g, " ") : "";
  const places = b.type === "map" ? String(p.places ?? "").replace(/[{}"[\]]|lat|lng|name|note/g, " ") : "";
  const own = [inlineToText(b.content, false), table, places, cards, board, p.title, p.points, p.question, p.answer, p.caption, p.code]
    .filter(Boolean)
    .join(" ");
  return [own, ...(b.children ?? []).map(blockText)].join(" ");
}
