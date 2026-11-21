# Noty

A notebook in your browser that you and your AI assistants write in together.

- **You** open it and type, paste images, add diagrams (type `/` for the menu).
- **Assistants** (Claude, Gemini CLI, ChatGPT, Cursor… anything that supports remote MCP) add to it when you say *"add this question to my DSA notes"*. Questions become Q&A cards, important points become highlighted boxes, flows become drawn diagrams. They appear live in any open tab, marked in the margin with which assistant wrote them.
- **Everything is saved in your Google Drive**, in a folder called `Noty`: a `.md` file you can read anywhere, and a `.noty.json` file the app reads from. Images go in `Noty/images`.

It runs free on Cloudflare Workers. Google Drive's free 15 GB covers storage.

## How it fits together

```
browser editor ─┐                       ┌─ Google Drive / Noty
                ├─► Cloudflare Worker ──┤
assistants ─────┘   (web app + /mcp)    └─ Vault (one per Google account):
     (MCP + OAuth)                          notebooks, live updates, Drive sync
```

| Path | What it is |
|---|---|
| `src/worker/index.ts` | Routes, Google sign-in, the "Allow this assistant?" page, web API |
| `src/worker/mcp.ts` | The MCP tools assistants call |
| `src/worker/vault.ts` | Per-user Durable Object: stores notebooks, merges edits, pushes live updates, copies to Drive |
| `src/worker/google.ts` | Google OAuth and Drive API |
| `src/shared/blocks.ts` | Notebook block format, markdown ⇄ blocks |
| `web/src/` | The React editor (BlockNote + Mermaid) |

### MCP tools

| Tool | Say something like |
|---|---|
| `add_note` | "Add this to my Work notes" (markdown; tables and `> [!tip]` callouts become real tables/boxes) |
| `add_question` | "Add this question to my Physics notes" → Q&A card with key points and a diagram |
| `add_key_points` | "Save the important points" → yellow highlighted box |
| `add_callout` | "Add the definition of osmosis" → coloured box: tip (green), definition (purple), example (teal), warning (orange), summary (blue), note (grey) |
| `add_table` | "Compare arrays and linked lists in a table" → editable table with a coloured header |
| `add_mind_map` | "Make a mind map of this chapter" → colourful mind map |
| `add_diagram` | "Draw a flowchart / timeline / sequence of this" (Mermaid) |
| `add_map` | "Put these places on a map in my Trips notes" → map with numbered pins |
| `add_board` | "Make a to-do board for my project" → kanban columns with cards |
| `add_image` | "Add that image" (needs an https URL or base64 data) |
| `summarize_notebook` | "Summarise my Biology notes" (reads everything, then saves a Summary box if you want) |
| `make_flashcards` | "Make flashcards from chapter 3" → a tap-to-flip revision deck |
| `read_handwriting` | "What did I write on page 4?" → the assistant sees a picture of your handwriting |
| `convert_handwriting` | "Convert my handwriting on page 2 to text" → typed text placed right after it |
| `set_handwriting` | "Show my Biology notes in print" → switches a notebook between neat handwriting (default), casual handwriting and print |
| `list_notebooks`, `create_notebook`, `read_notebook`, `search_notes` | "What did I note about recursion?" |

Everything an assistant adds goes **after the last line** of the notebook you name.

### Writing and drawing yourself (iPad + Apple Pencil)

- **Ink goes anywhere:** on blank pages, or on top of text, images, tables and anything an assistant wrote. Each stroke is pinned to the block it's on, so it moves with that block when content is added above it.
- **Endless pages, scrolling down only.** There's always a blank page at the bottom; writing on the last page adds another. Use **Add page** or `/page` for more. A notebook with 1,500 pages opens in well under a second, because ink only loads for the part you're looking at.
- **Apple Pencil always writes**, even in Type mode, so you can type with a keyboard and write with the Pencil without switching. Your finger scrolls and taps into text, and your palm is ignored while the Pencil is down. Turn on **Finger draws** if you have no stylus. On a laptop, pick **Pen** to draw with the mouse, **Type** to type.
- Toolbar (it stays at the top while you scroll): Type, Pen, Highlighter, Eraser, **Lasso**, 6 colours, 3 sizes, Undo/Redo (also Cmd/Ctrl+Z in pen modes), **Shapes**, Add page, and the style for new pages.
- **Page styles:** dotted, lined, grid or blank, in A4 or Letter size. Pick the style for new pages in the toolbar, or change any page with the menu in its top-right corner.
- **Lasso:** draw a loop around handwriting to select it. Drag inside to move it, drag the corner dot to resize, tap a colour to recolour, or Delete.
- **Shapes:** with Shapes on, a rough line, circle, oval, rectangle or triangle snaps to a clean one. Draw a line with a little hook at the end (or a small "V" at its tip) for an arrow. Handwriting is left alone.
- **Handwriting to text:** select with the lasso and tap **To text**. Browsers that can read handwriting (Chrome on some devices) do it right there; otherwise (including Safari on iPad) Noty gives you the exact sentence to ask your assistant, which reads a picture of the page and types it in below.
- **Works offline:** keep writing and drawing with no connection. Changes are kept on the device and sync when you're back online, even if you close the page in between. Notebooks you've opened before open offline too.
- **Install as an app:** on iPad Safari, tap Share, then **Add to Home Screen**; in Chrome, use the install icon in the address bar. Noty then opens full screen, with its own icon.
- **Assistants add content after your last line**, skipping blank pages and empty lines at the end.
- **Everything syncs live, block by block**, between your iPad, your laptop and assistants. Handwriting is saved to Drive in `Noty/ink/<notebook>/`, one file per block.
- On a much narrower screen, handwriting over *text* can shift slightly because the text wraps differently. Handwriting on blank pages always lines up.

### Notion-style organising

- **Topics (group by subject):** put notebooks and PDFs into topics from their ⋯ menu (or when making a new notebook). The library groups them by topic (Group by: Topic / Recent), the chips show one topic at a time, and each topic shelf has its own "New notebook in …" tile. Assistants can create a notebook in a topic and see topics when listing notebooks.
- **Icons and covers:** give each notebook an emoji (next to its title, or from the book's ⋯ menu) and a cover colour.
- **Favorites:** star notebooks to keep them on a Favorites shelf at the top of the library.
- **Templates:** New notebook offers Blank, Lecture notes, Meeting notes, To-do list, Study plan and Reading notes.
- **Trash:** deleting moves a notebook to the Trash (account menu, or the bottom of the library). Restore it within 30 days; after that it's removed for good. A notebook in the Trash opens read-only with a Restore button, and assistants can't see it.
- **Handwriting font:** notebooks show in **neat handwriting** by default: your typing and everything assistants add. "…" → **Text style** switches a notebook to **Casual handwriting** or **Print**. It's still normal text, so search, copy and the Drive copy work as before. Assistants can switch it too ("show my notes in print").
- **Page history:** "…" → Page history keeps a version every 10 minutes while you edit (the last 40). Restore any of them; the version you replaced is kept too, so a restore can be undone. (Handwriting isn't versioned.)
- **Blocks:** type `/` for **Board** (kanban columns with cards you move between them), **Table of contents** (live list of headings), and **Link to notebook**. A linked notebook shows **Linked from** at the bottom.

### PDFs (yours only)

Upload a PDF from the sidebar (**PDFs → Upload**, up to 25 MB). Open it to scroll through the pages, add **text boxes** (Text, then tap a page; drag ⠿ to move, A−/A+ to resize), and write or highlight with the Pencil. PDFs are separate from notebooks: **assistants can't see or change them**. They're stored in Noty and copied to Google Drive in `Noty/PDF/`, with your text boxes in `<name>.notes.json` next to each PDF.

## 1. Put it online (free, about 5 minutes)

```sh
npm install
cp .dev.vars.example .dev.vars    # then set ADMIN_PASSWORD and COOKIE_SECRET in it
npx wrangler login                # free Cloudflare account, no card needed
npm run deploy
```

`npm run deploy` creates the storage it needs, deploys, puts your address (`https://noty.<you>.workers.dev`) into `wrangler.jsonc`, and uploads everything in `.dev.vars` as encrypted secrets, without printing them. Run it again after any change.

Open the address and sign in with your **admin password**. That's all you need to use Noty and connect assistants. Your notebooks are stored in Cloudflare.

### Sign-in options

| Setting in `.dev.vars` | What it does |
|---|---|
| `ADMIN_PASSWORD` | Sign in with a password (10+ characters). After 8 wrong tries from one address, sign-in from that address pauses for 15 minutes. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Adds **Continue with Google**, and lets you keep a copy of everything in Google Drive. |
| `OWNER_EMAIL` | Your Google address. Signing in with it opens the **same notebooks** as the admin password. |
| `ALLOWED_EMAILS` | Other Google accounts allowed in; each gets their own notebooks. |

Signed in with the password and want the Drive copy? Open the home page and choose **Connect Google Drive**.

## 2. Optional: Google sign-in and the Drive copy (about 15 minutes)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project (e.g. "Noty").
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **Google Auth Platform → Branding / Audience**: choose **External**, fill in the app name and your email.
4. **Data access → Add scopes**: add `.../auth/drive.file` (plus `openid`, `email`, `profile`).
5. **Audience → Publish app** to move it to *In production*. Skip this and Google signs you out of Drive every 7 days. Because Noty only asks for `drive.file`, publishing shouldn't need Google's review; you may see an "unverified app" screen when signing in, which you can continue past for your own app.
6. **Clients → Create client → Web application**. Under *Authorised redirect URIs* add `https://noty.<you>.workers.dev/auth/callback` (and `http://localhost:8787/auth/callback` for local testing).
7. Put the **Client ID**, **Client secret** and your Google address (`OWNER_EMAIL`) in `.dev.vars`, then `npm run deploy`.

## 3. Run it on your computer (optional)

```sh
npm run dev        # http://localhost:8787
```

With `DEV_LOGIN=1` in `.dev.vars`, the sign-in page also shows **Local test sign-in** (only on localhost). `npm test` runs the end-to-end test against it (start from fresh state: `rm -rf .wrangler/state`). For hot reload while changing the UI, also run `npm run dev:web` and use http://localhost:5173.

## 4. Connect your assistants

Your MCP address is `https://noty.<you>.workers.dev/mcp` (the app's home page shows it, with a copy button).

| Assistant | How |
|---|---|
| Claude (web / desktop) | Settings → Connectors → Add custom connector → paste the address → sign in |
| Claude Code | `claude mcp add --transport http noty https://noty.<you>.workers.dev/mcp` |
| Gemini CLI | `~/.gemini/settings.json`: `"mcpServers": { "noty": { "httpUrl": "https://noty.<you>.workers.dev/mcp" } }`, then `/mcp auth noty` |
| ChatGPT, Cursor, others | Their "custom connector" / "MCP server" setting, same address |

Each assistant opens Noty's sign-in page (password or Google), then asks you to **Allow** it. Approve once and it's remembered for 30 days.

Menu names and plan requirements change; check each assistant's docs if a step doesn't match.

## Good to know

- **Free-tier limits:** Workers free plan gives 100,000 requests a day, far more than one person's notes need.
- **Images** are stored in Noty (so they work without Google) and copied to `Drive/Noty/images` when Drive is connected. **From assistants:** diagrams always work (they're Mermaid text). A generated image only works if the assistant can pass it as a URL or base64 data, which varies by assistant. Images you paste into the editor always work.
- **A notebook holds about 2 MB of text.** Start a new one when it fills up; images don't count, they live in Drive.
- **Editing the Drive files by hand** doesn't flow back into the app; the app is the source and Drive is the copy. If you deploy fresh, signing in restores your notebooks from `Drive/Noty/*.noty.json`.
- **Revoking access:** remove a connected assistant in its own settings, or remove Noty entirely at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
