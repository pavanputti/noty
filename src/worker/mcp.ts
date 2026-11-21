// The MCP server. Each tool turns what an assistant sends into notebook blocks,
// so a question becomes a Q&A card, key points become a highlighted box,
// and Mermaid code becomes a drawn diagram.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  type Block,
  blocksToMarkdown,
  CALLOUT_KINDS,
  calloutBlock,
  mapBlock,
  type MindMapNode,
  mindMapCode,
  TABLE_COLORS,
  tableBlock,
  boardBlock,
  diagramBlock,
  flashcardsBlock,
  heading,
  imageBlock,
  keyPointsBlock,
  markdownToBlocks,
  questionBlock,
} from "../shared/blocks";

export interface AuthProps {
  userId: string;
  email: string;
  clientName: string;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const INSTRUCTIONS = `Noty is the user's notebook app; notebooks are saved in their Google Drive and open live in their browser or iPad.
When the user says "add/push/save this to my <name> notes", call a tool with notebook="<name>". New content always goes after the last line. A missing notebook is created automatically.
Pick the most visual tool that fits, and combine several calls when it helps (e.g. a callout, then a table):
- A question, or "add this question": add_question, with a clear answer, 2–5 key points, and a Mermaid diagram when a process, structure or comparison is involved.
- "Important points", "takeaways": add_key_points.
- A definition, tip, example, warning or summary: add_callout with the matching kind.
- Comparisons, lists of items with attributes, schedules: add_table.
- Tasks, plans, project steps ("make a to-do board"): add_board.
- A topic broken into sub-topics, brainstorming, revision overviews: add_mind_map.
- A process, flow, sequence, hierarchy, timeline or relationship: add_diagram (Mermaid).
- Places, routes, geography, travel plans: add_map with coordinates.
- Anything else: add_note (markdown; tables and "> [!tip]" callouts are converted automatically).
- An image you have as a URL or base64 data: add_image.
- "Summarise my notes": summarize_notebook (read first, then save with save_summary if they want it kept).
- "Make flashcards", "quiz me": read_notebook, then make_flashcards with 5–20 cards.
- Handwriting: read_handwriting shows you pictures of handwritten pages. To turn handwriting into typed text, read it, then call convert_handwriting.
- Notebooks show in neat handwriting by default. "Make it printed/typed": set_handwriting with font print; "messier/casual handwriting": font hand. It changes the look of the whole notebook.
Keep notes concise and written for the user to reread later. After adding, tell the user which notebook it went into.`;

const notebookArg = z
  .string()
  .min(1)
  .describe('Notebook name as the user said it, e.g. "DSA" or "Work". Created if it does not exist.');

function props(): AuthProps {
  const p = getMcpAuthContext()?.props as AuthProps | undefined;
  if (!p?.userId) throw new Error("Not signed in.");
  return p;
}

const vault = () => env.VAULT.get(env.VAULT.idFromName(props().userId));

async function add(notebook: string, blocks: Block[], what: string) {
  const r = await vault().appendBlocks(notebook, blocks, props().clientName || "assistant");
  if (r.error !== undefined) throw new Error(r.error);
  const { notebook: nb, created } = r;
  const link = `${env.PUBLIC_URL}/n/${nb.id}`;
  return {
    content: [
      {
        type: "text" as const,
        text: `${what} added to "${nb.name}"${created ? " (new notebook)" : ""}. Open it: ${link}`,
      },
    ],
  };
}

const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

const safe =
  <A,>(fn: (a: A) => Promise<{ content: { type: "text"; text: string }[] }>) =>
  async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      return fail(e);
    }
  };

function createServer() {
  const server = new McpServer({ name: "Noty", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "add_note",
    {
      title: "Add a note",
      description:
        "Add text to a notebook, after its last line. Supports markdown: headings, bullet and numbered lists, checklists (- [ ]), quotes, code blocks, tables (| a | b |), callouts (> [!tip] text; kinds: tip, definition, example, warning, summary, note), and ```mermaid blocks (drawn as diagrams).",
      inputSchema: {
        notebook: notebookArg,
        content: z.string().min(1).describe("The note, in markdown."),
        title: z.string().optional().describe("Optional heading shown above the note."),
      },
    },
    safe(async ({ notebook, content, title }) => {
      const blocks = markdownToBlocks(content);
      if (title) blocks.unshift(heading(title, 2));
      return add(notebook, blocks, "Note");
    }),
  );

  server.registerTool(
    "add_question",
    {
      title: "Add a question card",
      description:
        "Add a question as a visual Q&A card: the question, its answer, highlighted key points and an optional Mermaid diagram. Use this whenever the user asks to save a question.",
      inputSchema: {
        notebook: notebookArg,
        question: z.string().min(1),
        answer: z.string().min(1).describe("A clear answer. Markdown bold, italic and code are supported."),
        key_points: z.array(z.string()).max(12).optional().describe("2–5 short takeaways."),
        diagram: z.string().optional().describe("Optional Mermaid code (e.g. 'flowchart LR; A-->B') that explains the answer visually."),
      },
    },
    safe(async ({ notebook, question, answer, key_points, diagram }) =>
      add(notebook, [questionBlock({ question, answer, keyPoints: key_points, diagram })], "Question card"),
    ),
  );

  server.registerTool(
    "add_key_points",
    {
      title: "Add key points",
      description: "Add a highlighted box of important points, a summary or takeaways.",
      inputSchema: {
        notebook: notebookArg,
        points: z.array(z.string().min(1)).min(1).max(20),
        title: z.string().optional().describe('Box title, e.g. "Key points" or "Exam tips".'),
      },
    },
    safe(async ({ notebook, points, title }) => add(notebook, [keyPointsBlock(title ?? "Key points", points)], "Key points")),
  );

  server.registerTool(
    "add_diagram",
    {
      title: "Add a diagram",
      description:
        "Add a diagram drawn from Mermaid code: flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, mindmap, timeline, pie, gantt. Use valid Mermaid syntax; quote labels that contain special characters.",
      inputSchema: {
        notebook: notebookArg,
        mermaid: z.string().min(1).describe("Mermaid code, without ``` fences."),
        caption: z.string().optional(),
      },
    },
    safe(async ({ notebook, mermaid, caption }) => {
      const code = mermaid.replace(/^```(?:mermaid)?\s*|\s*```$/g, "").trim();
      return add(notebook, [diagramBlock(code, caption ?? "")], "Diagram");
    }),
  );

  server.registerTool(
    "add_image",
    {
      title: "Add an image",
      description:
        "Save an image (PNG, JPEG, GIF, WebP or SVG) into the notebook and the user's Drive. Give either a public https URL or base64 data.",
      inputSchema: {
        notebook: notebookArg,
        url: z.string().url().optional().describe("Public https URL of the image."),
        base64: z.string().optional().describe("Base64 image data (a data: URL is also accepted)."),
        mime_type: z.string().optional().describe('e.g. "image/png". Needed with base64 unless it is a data: URL.'),
        caption: z.string().optional(),
      },
    },
    safe(async ({ notebook, url, base64, mime_type, caption }) => {
      let bytes: ArrayBuffer;
      let type = mime_type ?? "";
      if (base64) {
        const m = base64.match(/^data:([^;]+);base64,(.*)$/s);
        if (m) type = m[1];
        const raw = atob((m ? m[2] : base64).replace(/\s/g, ""));
        bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer;
      } else if (url) {
        if (!url.startsWith("https://")) throw new Error("Image URL must start with https://");
        const res = await fetch(url, { headers: { Accept: "image/*", "User-Agent": "Noty/1.0 (notes app image fetch)" } });
        if (!res.ok) throw new Error(`Could not download the image (${res.status}).`);
        type = type || (res.headers.get("Content-Type") ?? "").split(";")[0];
        bytes = await res.arrayBuffer();
      } else throw new Error("Give either url or base64.");
      if (!type.startsWith("image/")) throw new Error(`That is not an image (type: ${type || "unknown"}).`);
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Images must be 10 MB or smaller.");
      const ext = type.split("/")[1]?.replace("svg+xml", "svg") ?? "png";
      const src = await vault().uploadImage(bytes, type, `${(caption || "image").slice(0, 60)}.${ext}`);
      return add(notebook, [imageBlock(src, caption ?? "")], "Image");
    }),
  );

  server.registerTool(
    "add_callout",
    {
      title: "Add a coloured callout",
      description:
        "Add a coloured box: tip (green), definition (purple), example (teal), warning (orange), summary (blue) or note (grey). The text stays editable in the notebook.",
      inputSchema: {
        notebook: notebookArg,
        kind: z.enum(CALLOUT_KINDS),
        text: z.string().min(1).describe("Body text. Markdown bold, italic, code and links are supported."),
        title: z.string().optional().describe('Optional title, e.g. the term being defined.'),
      },
    },
    safe(async ({ notebook, kind, text, title }) => add(notebook, [calloutBlock(kind, text, title ?? "")], `${kind[0].toUpperCase()}${kind.slice(1)} box`)),
  );

  server.registerTool(
    "add_table",
    {
      title: "Add a table",
      description: "Add an editable table with a coloured header row. Good for comparisons, pros and cons, schedules and lists of items with attributes.",
      inputSchema: {
        notebook: notebookArg,
        columns: z.array(z.string()).min(1).max(12).describe("Header cells."),
        rows: z.array(z.array(z.string()).max(12)).min(1).max(200).describe("Body rows, one array of cell texts per row."),
        color: z.enum(TABLE_COLORS).optional().describe("Header colour. Default blue."),
        title: z.string().optional().describe("Optional heading shown above the table."),
      },
    },
    safe(async ({ notebook, columns, rows, color, title }) => {
      const blocks: Block[] = [tableBlock(columns, rows, color ?? "blue")];
      if (title) blocks.unshift(heading(title, 3));
      return add(notebook, blocks, "Table");
    }),
  );

  const mindNode: z.ZodType<MindMapNode> = z.lazy(() =>
    z.object({ label: z.string().min(1), children: z.array(mindNode).max(12).optional() }),
  );

  server.registerTool(
    "add_mind_map",
    {
      title: "Add a mind map",
      description: "Add a colourful mind map: a central topic with branches and sub-branches (up to 3 levels deep works best).",
      inputSchema: {
        notebook: notebookArg,
        center: z.string().min(1).describe("The central topic."),
        branches: z.array(mindNode).min(1).max(12),
        caption: z.string().optional(),
      },
    },
    safe(async ({ notebook, center, branches, caption }) => add(notebook, [diagramBlock(mindMapCode(center, branches), caption ?? "")], "Mind map")),
  );

  server.registerTool(
    "add_map",
    {
      title: "Add a map",
      description: "Add an interactive map with numbered pins. Use real latitude/longitude in decimal degrees.",
      inputSchema: {
        notebook: notebookArg,
        places: z
          .array(
            z.object({
              name: z.string().min(1),
              lat: z.number().min(-90).max(90),
              lng: z.number().min(-180).max(180),
              note: z.string().optional(),
            }),
          )
          .min(1)
          .max(50),
        title: z.string().optional(),
      },
    },
    safe(async ({ notebook, places, title }) => add(notebook, [mapBlock(places, title ?? "")], "Map")),
  );

  server.registerTool(
    "add_board",
    {
      title: "Add a task board",
      description: "Add a kanban board: columns (e.g. To do, Doing, Done) with cards the user can move between them. Good for tasks, plans and project steps.",
      inputSchema: {
        notebook: notebookArg,
        columns: z
          .array(z.object({ name: z.string().min(1).max(60), cards: z.array(z.string().min(1).max(500)).max(50) }))
          .min(1)
          .max(8)
          .describe('Columns from left to right, e.g. [{"name":"To do","cards":["Read chapter 3"]},{"name":"Done","cards":[]}].'),
        title: z.string().optional(),
      },
    },
    safe(async ({ notebook, columns, title }) => add(notebook, [boardBlock(columns, title ?? "")], `Board (${columns.reduce((n, c) => n + c.cards.length, 0)} cards)`)),
  );

  server.registerTool(
    "summarize_notebook",
    {
      title: "Summarise a notebook",
      description:
        "Step 1: call with just the notebook to get all its content (typed text, and which pages have handwriting; use read_handwriting to see those). Write a clear summary for the user. Step 2 (only if they want it saved): call again with save_summary, and it's added to the end of the notebook as a blue Summary box.",
      inputSchema: {
        notebook: z.string().min(1),
        save_summary: z.string().optional().describe("The summary text to save into the notebook (markdown bold/italic allowed)."),
        title: z.string().optional().describe('Title for the saved summary, e.g. "Chapter 3".'),
      },
    },
    safe(async ({ notebook, save_summary, title }) => {
      const v = vault();
      const found = await v.requireNotebook(notebook);
      if (found.error !== undefined) throw new Error(found.error);
      const meta = found.meta;
      if (save_summary) return add(meta.id, [calloutBlock("summary", save_summary, title ?? "")], "Summary");
      const nb = await v.getNotebookWithInk(meta.id);
      const items = await v.handwrittenItems(meta.id);
      const md = blocksToMarkdown(nb?.blocks ?? [], 0, new Set(nb?.inkAnchors ?? []));
      const hand = items.length
        ? `\n\nHandwriting (${items.length}): ${items.map((i) => `${i.n}. ${i.label}`).join("; ")}. Call read_handwriting to see it before summarising.`
        : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `# ${meta.name}\n\n${md || "(no typed text)"}${hand}\n\nNow write the summary for the user. To keep it in the notebook, call summarize_notebook again with save_summary.`.slice(0, 120_000),
          },
        ],
      };
    }),
  );

  server.registerTool(
    "make_flashcards",
    {
      title: "Make flashcards",
      description:
        "Add a deck of tap-to-flip flashcards for revision. Read the notebook first (read_notebook / read_handwriting), then write 5–20 cards: a short question or term on the front, a concise answer on the back.",
      inputSchema: {
        notebook: notebookArg,
        cards: z
          .array(z.object({ front: z.string().min(1).max(500), back: z.string().min(1).max(2000) }))
          .min(1)
          .max(100),
        title: z.string().optional().describe('Deck title, e.g. "Photosynthesis revision".'),
      },
    },
    safe(async ({ notebook, cards, title }) => add(notebook, [flashcardsBlock(cards, title ?? "")], `Flashcard deck (${cards.length} cards)`)),
  );

  server.registerTool(
    "read_handwriting",
    {
      title: "Read handwriting",
      description:
        "See the user's handwriting as pictures. Without `items`, lists every handwritten page/note in the notebook and shows the first few. With `items` (numbers from that list), shows those. Up to 4 pictures per call.",
      inputSchema: {
        notebook: z.string().min(1),
        items: z.array(z.number().int().min(1)).max(4).optional().describe("Which handwritten items to show (numbers from the list)."),
      },
    },
    safe(async ({ notebook, items }) => {
      const v = vault();
      const found = await v.requireNotebook(notebook);
      if (found.error !== undefined) throw new Error(found.error);
      const meta = found.meta;
      const all = await v.handwrittenItems(meta.id);
      if (!all.length) return { content: [{ type: "text" as const, text: `"${meta.name}" has no handwriting yet.` }] };
      const which = items?.length ? items : all.slice(0, 3).map((i) => i.n);
      const pics = await v.renderHandwriting(meta.id, which);
      const list = all.map((i) => `${i.n}. ${i.label}`).join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `Handwriting in "${meta.name}" (${all.length}):\n${list}\n\nShowing: ${pics.map((p) => `${p.n}. ${p.label}`).join(", ") || "none"}. Pictures show only the handwriting (ink), not typed text.${all.length > which.length ? " Ask for others with items." : ""}`,
          },
          ...pics.map((p) => ({ type: "image" as const, data: p.png, mimeType: "image/png" })),
        ],
      } as never;
    }),
  );

  server.registerTool(
    "convert_handwriting",
    {
      title: "Convert handwriting to text",
      description:
        "After reading handwriting with read_handwriting, type out what it says. The text is placed right after that handwritten page or note. By default the handwriting is removed (and a now-empty page with it); set keep_handwriting to keep both.",
      inputSchema: {
        notebook: z.string().min(1),
        item: z.number().int().min(1).describe("The handwritten item number from read_handwriting."),
        text: z.string().min(1).describe("What the handwriting says, as markdown (keep the user's wording; fix only obvious misspellings)."),
        keep_handwriting: z.boolean().optional(),
      },
    },
    safe(async ({ notebook, item, text, keep_handwriting }) => {
      const v = vault();
      const found = await v.requireNotebook(notebook);
      if (found.error !== undefined) throw new Error(found.error);
      const meta = found.meta;
      const r = await v.convertHandwriting(meta.id, item, text, !keep_handwriting, props().clientName || "assistant");
      if (!r) throw new Error(`There's no handwritten item ${item}. Call read_handwriting to see the list.`);
      return {
        content: [
          { type: "text" as const, text: `Typed text added after "${r.label}"${keep_handwriting ? "" : " and the handwriting removed"}. Open it: ${env.PUBLIC_URL}/n/${meta.id}` },
        ],
      };
    }),
  );

  server.registerTool(
    "list_notebooks",
    { title: "List notebooks", description: "List the user's notebooks (with their topics), most recently changed first.", inputSchema: {} },
    safe(async () => {
      const list = await vault().listNotebooks();
      const text = list.length
        ? list.map((n) => `- ${n.name}${n.topic ? ` [topic: ${n.topic}]` : ""} (${n.blockCount} blocks, updated ${new Date(n.updatedAt).toISOString().slice(0, 10)})`).join("\n")
        : "No notebooks yet. Adding a note creates one.";
      return { content: [{ type: "text" as const, text }] };
    }),
  );

  server.registerTool(
    "create_notebook",
    {
      title: "Create a notebook",
      description: "Create an empty notebook, optionally inside a topic (the user's subjects/folders, e.g. \"Biology\"), and optionally shown in a handwriting font.",
      inputSchema: {
        name: z.string().min(1),
        topic: z.string().optional().describe("Topic to group it under. Use an existing topic from list_notebooks when one fits."),
        font: z.enum(["print", "hand", "neat"]).optional().describe("neat (tidy handwriting, the default), hand (casual handwriting) or print (a normal printed font)."),
      },
    },
    safe(async ({ name, topic, font }) => {
      const nb = await vault().createNotebook(name, topic, font);
      return { content: [{ type: "text" as const, text: `Notebook "${nb.name}" is ready: ${env.PUBLIC_URL}/n/${nb.id}` }] };
    }),
  );

  server.registerTool(
    "set_handwriting",
    {
      title: "Show a notebook in handwriting",
      description:
        "Switch a whole notebook between handwriting fonts and a printed font (everything in it, including what you add). Notebooks use neat handwriting by default. Use when the user asks for printed/typed-looking notes, or a different handwriting. The text stays normal, searchable text.",
      inputSchema: {
        notebook: z.string().min(1),
        font: z.enum(["print", "hand", "neat"]).describe("hand = casual handwriting, neat = tidy handwriting, print = back to the normal font."),
      },
    },
    safe(async ({ notebook, font }) => {
      const found = await vault().requireNotebook(notebook);
      if (found.error !== undefined) throw new Error(found.error);
      await vault().updateNotebook(found.meta.id, { font });
      const label = font === "print" ? "the printed font" : font === "neat" ? "neat handwriting" : "handwriting";
      return { content: [{ type: "text" as const, text: `"${found.meta.name}" now shows in ${label}.` }] };
    }),
  );

  server.registerTool(
    "read_notebook",
    {
      title: "Read a notebook",
      description: "Return a notebook's content as markdown, to answer questions about it or to avoid adding duplicates.",
      inputSchema: { notebook: z.string().min(1) },
    },
    safe(async ({ notebook }) => {
      const found = await vault().requireNotebook(notebook);
      if (found.error !== undefined) throw new Error(found.error);
      const meta = found.meta;
      const nb = await vault().getNotebookWithInk(meta.id);
      const md = blocksToMarkdown(nb?.blocks ?? [], 0, new Set(nb?.inkAnchors ?? []));
      return { content: [{ type: "text" as const, text: `# ${meta.name}\n\n${md || "(empty)"}`.slice(0, 100_000) }] };
    }),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description: "Search notebook names and everything typed in them. Every word must match.",
      inputSchema: { query: z.string().min(1) },
    },
    safe(async ({ query }) => {
      const r = await vault().search(query, { includePdfs: false, limit: 30 });
      const names = r.notebooks.map((n) => `- Notebook "${n.name}"`);
      const lines = r.hits.map((h) => `- [${h.name}] ${h.snippet}`);
      const text = names.length || lines.length ? [...names, ...lines].join("\n") : `Nothing found for "${query}".`;
      return { content: [{ type: "text" as const, text }] };
    }),
  );

  return server;
}

export const mcpHandler = createMcpHandler(createServer, { route: "/mcp" });
