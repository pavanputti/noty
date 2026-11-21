import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Me, type NotebookMeta, type PdfMeta, type SearchResult } from "./api";
import { ASSISTANT_TOOLS } from "../../src/shared/tools";
import { Icon } from "./icons";
import { CoverPicker, coverOf, EmojiPicker, NewNotebookDialog } from "./notion";
import { NotebookPage } from "./Notebook";
import { extractPdfText, loadPdfJs, makePdfThumb, PdfPage } from "./PdfPage";
import { ThemeCycleButton, ThemeSwitch } from "./ThemeSwitch";

// ---------- tiny router: "/", "/n/:id", "/p/:id", "/connect" ----------

function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const go = useCallback((p: string) => {
    if (p !== location.pathname) history.pushState(null, "", p);
    setPath(p);
    scrollTo(0, 0);
  }, []);
  return [path, go];
}

export function App() {
  const [me, setMe] = useState<Me | null | "signed-out">(null);
  const [needsGoogle, setNeedsGoogle] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe("signed-out"));
  }, []);

  const onAuthLost = (code: string) => (code === "needs_google" ? setNeedsGoogle(true) : setMe("signed-out"));

  if (me === null) return <div className="page-msg">Loading…</div>;
  if (me === "signed-out") return <SignIn />;
  return <Shell me={me} needsGoogle={needsGoogle} onAuthLost={onAuthLost} />;
}

function SignIn() {
  // The sign-in page is served by the Worker (password and/or Google), so assistants' connect flow can use it too.
  useEffect(() => {
    location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }, []);
  return <div className="page-msg">Opening sign-in…</div>;
}

function Shell({ me, needsGoogle, onAuthLost }: { me: Me; needsGoogle: boolean; onAuthLost: (c: string) => void }) {
  const [path, go] = usePath();
  const [books, setBooks] = useState<NotebookMeta[] | null>(null);
  const [pdfs, setPdfs] = useState<PdfMeta[]>([]);
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => (removeEventListener("online", on), removeEventListener("offline", off));
  }, []);
  const nbId = path.match(/^\/n\/([\w-]+)/)?.[1];
  const pdfId = path.match(/^\/p\/([\w-]+)/)?.[1];

  const refresh = useCallback(() => {
    api
      .notebooks()
      .then(setBooks)
      .catch((e: ApiError) => e.status === 401 && onAuthLost(e.code));
    api.listPdfs().then(setPdfs).catch(() => {});
  }, []);
  useEffect(refresh, [refresh, path]);
  // Assistants can create notebooks at any time; keep the library fresh.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && !nbId && !pdfId && refresh(), 15_000);
    addEventListener("focus", refresh);
    return () => (clearInterval(t), removeEventListener("focus", refresh));
  }, [refresh, nbId, pdfId]);

  const back = () => go("/");
  return (
    <div className={`app ${nbId || pdfId ? "in-doc" : ""}`}>
      {offline && (
        <div className="offline-banner" role="status">
          You're offline. Keep writing: changes are saved on this device and sync when you're back online.
        </div>
      )}
      {needsGoogle && (
        <div className="banner" role="alert">
          Noty can't reach your Google Drive, so the Drive copy is paused. Your notes are still saved in Noty.{" "}
          <a href={`/login/google?link=1&next=${encodeURIComponent(location.pathname)}`}>Reconnect Google Drive</a>
        </div>
      )}
      {nbId ? (
        <NotebookPage id={nbId} onBack={back} onRenamed={refresh} onDeleted={() => (refresh(), back())} onAuthLost={onAuthLost} />
      ) : pdfId ? (
        <PdfPage id={pdfId} onBack={back} onChanged={refresh} onDeleted={() => (refresh(), back())} />
      ) : path === "/trash" ? (
        <TrashPage go={go} refresh={refresh} />
      ) : path === "/connect" ? (
        <div className="connect-wrap">
          <header className="lib-bar">
            <button type="button" className="icon-btn" onClick={back} aria-label="Back to library" title="Library">
              <Icon.back />
            </button>
            <span className="lib-title">Connect an assistant</span>
          </header>
          <Connect me={me} />
        </div>
      ) : (
        <Library me={me} books={books} pdfs={pdfs} go={go} refresh={refresh} />
      )}
    </div>
  );
}

// ---------- the library: notebooks and PDFs as books ----------


function Library({ me, books, pdfs, go, refresh }: { me: Me; books: NotebookMeta[] | null; pdfs: PdfMeta[]; go: (p: string) => void; refresh: () => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [uploading, setUploading] = useState("");
  const [menu, setMenu] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) return setFound(null), setSearching(false);
    setSearching(true);
    const t = setTimeout(
      () =>
        api
          .search(q)
          .then(setFound)
          .catch(() => setFound({ notebooks: [], pdfs: [], hits: [] }))
          .finally(() => setSearching(false)),
      250,
    );
    return () => clearTimeout(t);
  }, [q]);
  // Names filter instantly as you type (every word must match).
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const nameMatch = (n: string) => words.every((w) => n.toLowerCase().includes(w));
  const searchingNow = words.length > 0;
  const shownBooks = searchingNow ? (books ?? []).filter((b) => nameMatch(b.name)) : (books ?? []);
  const shownPdfs = searchingNow ? pdfs.filter((p) => nameMatch(p.name)) : pdfs;
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    addEventListener("pointerdown", close);
    return () => removeEventListener("pointerdown", close);
  }, [menu]);

  const [newOpen, setNewOpen] = useState(false);
  const [newTopic, setNewTopic] = useState("");
  const create = () => (setNewTopic(topicFilter), setNewOpen(true));
  // Group by topic (subjects/folders) or by recent; filter to one topic with the chips.
  const [groupBy, setGroupByState] = useState<"topic" | "recent">(() => (localStorage.getItem("noty:groupBy") === "recent" ? "recent" : "topic"));
  const setGroupBy = (g: "topic" | "recent") => (setGroupByState(g), localStorage.setItem("noty:groupBy", g));
  const [topicFilter, setTopicFilter] = useState("");
  const allTopics = [...new Set([...(books ?? []).map((b) => b.topic), ...pdfs.map((x) => x.topic)].filter((t): t is string => !!t))].sort((a, b) => a.localeCompare(b));
  useEffect(() => {
    if (topicFilter && !allTopics.includes(topicFilter)) setTopicFilter("");
  }, [allTopics.join("|")]);
  const inTopic = (t?: string) => !topicFilter || t === topicFilter;
  const visibleBooks = (books ?? []).filter((b) => inTopic(b.topic));
  const visiblePdfs = pdfs.filter((x) => inTopic(x.topic));
  const favs = visibleBooks.filter((b) => b.favorite);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return alert("PDFs must be 25 MB or smaller.");
    setUploading(file.name);
    try {
      const meta = await api.uploadPdf(file);
      // Make the book cover from page 1 while we still have the file.
      try {
        const lib = await loadPdfJs();
        const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        const jpg = await makePdfThumb(doc);
        if (jpg) await api.savePdfThumb(meta.id, jpg, doc.numPages);
        api.savePdfText(meta.id, await extractPdfText(doc)).catch(() => {}); // makes the PDF searchable
      } catch {}
      refresh();
      go(`/p/${meta.id}`);
    } catch (e) {
      alert((e as Error).message || "Couldn't upload that PDF.");
    } finally {
      setUploading("");
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const signOut = (e: React.FormEvent) => {
    const unsynced = Object.keys(localStorage).some((k) => k.startsWith("noty:draft:") || k.startsWith("noty:inkq:"));
    if (unsynced && !confirm("Some changes haven't synced yet (you may be offline). Signing out deletes them from this device. Sign out anyway?")) {
      e.preventDefault();
      return;
    }
    // Shared device: don't leave this account's notebooks cached for offline use.
    caches?.keys().then((ks) => ks.filter((k) => k.endsWith("-data")).forEach((k) => caches.delete(k)));
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith("noty:draft:") || k.startsWith("noty:inkq:"))
        .forEach((k) => localStorage.removeItem(k));
    } catch {}
  };
  const who = me.name === "Owner" ? "Owner" : me.email;

  return (
    <div className="library">
      <header className="lib-bar">
        <span className="wordmark small">Noty</span>
        <label className="lib-search">
          <Icon.search size={18} />
          <span className="visually-hidden">Search notes</span>
          <input type="search" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="lib-actions">
          <button type="button" className="icon-btn labelled" onClick={create} title="New notebook">
            <Icon.plus />
            <span>New notebook</span>
          </button>
          <button type="button" className="icon-btn labelled" onClick={() => fileInput.current?.click()} disabled={!!uploading} title="Upload a PDF">
            <Icon.upload />
            <span>{uploading ? "Uploading…" : "Upload PDF"}</span>
          </button>
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => upload(e.target.files?.[0])} />
          <ThemeCycleButton />
          <button type="button" className="icon-btn" onClick={() => go("/connect")} title="Connect an assistant" aria-label="Connect an assistant">
            <Icon.plug />
          </button>
          <div className="acct" ref={menuRef}>
            <button type="button" className="avatar" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label={`Account: ${who}`} title={who}>
              {(who[0] ?? "N").toUpperCase()}
            </button>
            {menu && (
              <div className="acct-menu">
                <p className="acct-who">{who}</p>
                <div className="acct-row">
                  <span>Appearance</span>
                  <ThemeSwitch />
                </div>
                <button type="button" className="ink-more-item" onClick={() => go("/connect")}>
                  <Icon.plug />
                  <span className="ink-more-text">Connect an assistant</span>
                </button>
                <button type="button" className="ink-more-item" onClick={() => go("/trash")}>
                  <Icon.trash />
                  <span className="ink-more-text">Trash</span>
                </button>
                <form method="post" action="/logout" onSubmit={signOut}>
                  <button type="submit" className="ink-more-item">
                    <Icon.back />
                    <span className="ink-more-text">Sign out</span>
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      </header>

      {searchingNow && (
        <section className="shelf found" aria-live="polite">
          <h2 className="shelf-title">
            Found inside {found ? <span className="count">{found.hits.length}</span> : null}
          </h2>
          {found && found.hits.length > 0 ? (
            <ul className="found-list">
              {found.hits.map((h, i) => (
                <li key={`${h.id}-${h.blockId ?? h.page}-${i}`}>
                  <button type="button" onClick={() => go(h.kind === "notebook" ? `/n/${h.id}${h.blockId ? `?b=${h.blockId}` : ""}` : `/p/${h.id}${h.page ? `?page=${h.page}` : ""}`)}>
                    <span className="found-where">
                      {h.kind === "pdf" ? <span className="pdf-tag">PDF</span> : <Icon.book size={15} />}
                      {h.name}
                      {h.page ? <span className="found-page">{h.note ? `text box, page ${h.page}` : `page ${h.page}`}</span> : null}
                    </span>
                    <span className="found-snip">
                      <Highlight text={h.snippet} words={words} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="shelf-empty">{searching || !found ? "Searching…" : `No notes contain “${q}”.`}</p>
          )}
        </section>
      )}

      {!searchingNow && allTopics.length > 0 && (
        <div className="lib-controls">
          <div className="seg" role="radiogroup" aria-label="Group by">
            <span className="seg-label">Group by</span>
            {(["topic", "recent"] as const).map((g) => (
              <button key={g} type="button" role="radio" aria-checked={groupBy === g} className={groupBy === g ? "on" : ""} onClick={() => setGroupBy(g)}>
                {g === "topic" ? "Topic" : "Recent"}
              </button>
            ))}
          </div>
          <div className="chips" role="radiogroup" aria-label="Show topic">
            {["", ...allTopics].map((t) => (
              <button key={t || "all"} type="button" role="radio" aria-checked={topicFilter === t} className={`chip ${topicFilter === t ? "on" : ""}`} onClick={() => setTopicFilter(t)}>
                {t || "All"}
              </button>
            ))}
          </div>
        </div>
      )}

      {!searchingNow && favs.length > 0 && (
        <section className="shelf" aria-labelledby="fav-shelf">
          <h2 className="shelf-title" id="fav-shelf">
            Favorites
          </h2>
          <div className="books-grid">
            {favs.map((b) => (
              <NotebookBook key={b.id} b={b} go={go} refresh={refresh} topics={allTopics} />
            ))}
          </div>
        </section>
      )}

      {!searchingNow && groupBy === "topic" && allTopics.length > 0 ? (
        <>
          {[...(topicFilter ? [topicFilter] : allTopics), ...(topicFilter ? [] : [""])].map((t) => {
            const nbs = visibleBooks.filter((b) => (b.topic ?? "") === t);
            const pds = visiblePdfs.filter((x) => (x.topic ?? "") === t);
            if (t === "" && !nbs.length && !pds.length) return null;
            return (
              <section key={t || "none"} className="shelf" aria-label={t || "No topic"}>
                <h2 className="shelf-title">
                  {t || "No topic"} <span className="count">{nbs.length + pds.length}</span>
                </h2>
                <div className="books-grid">
                  {nbs.map((b) => (
                    <NotebookBook key={b.id} b={b} go={go} refresh={refresh} topics={allTopics} />
                  ))}
                  {pds.map((x) => (
                    <PdfBook key={x.id} p={x} go={go} refresh={refresh} topics={allTopics} />
                  ))}
                  <button type="button" className="book new" onClick={() => (setNewTopic(t), setNewOpen(true))}>
                    <span className="book-cover">
                      <Icon.plus size={26} />
                      <span>{t ? `New notebook in ${t}` : "New notebook"}</span>
                    </span>
                  </button>
                </div>
              </section>
            );
          })}
        </>
      ) : (
        <>
          <section className="shelf" aria-labelledby="nb-shelf">
            <h2 className="shelf-title" id="nb-shelf">
              Notebooks {searchingNow && <span className="count">{shownBooks.length}</span>}
            </h2>
            <div className="books-grid">
              {!searchingNow && (
                <button type="button" className="book new" onClick={() => (setNewTopic(topicFilter), setNewOpen(true))}>
                  <span className="book-cover">
                    <Icon.plus size={28} />
                    <span>New notebook</span>
                  </span>
                </button>
              )}
              {(searchingNow ? shownBooks : visibleBooks).map((b) => (
                <NotebookBook key={b.id} b={b} go={go} refresh={refresh} topics={allTopics} />
              ))}
            </div>
            {searchingNow && shownBooks.length === 0 && <p className="shelf-empty">No notebook names match “{q}”.</p>}
            {!searchingNow && books && books.length === 0 && <p className="shelf-empty">No notebooks yet. Make one, or ask an assistant to “add a note to my Physics notes”.</p>}
          </section>

          <section className="shelf" aria-labelledby="pdf-shelf">
            <h2 className="shelf-title" id="pdf-shelf">
              PDFs {searchingNow && <span className="count">{shownPdfs.length}</span>}
            </h2>
            <div className="books-grid">
              {!searchingNow && (
                <button type="button" className="book new" onClick={() => fileInput.current?.click()} disabled={!!uploading}>
                  <span className="book-cover">
                    <Icon.upload size={28} />
                    <span>{uploading ? "Uploading…" : "Upload PDF"}</span>
                  </span>
                </button>
              )}
              {(searchingNow ? shownPdfs : visiblePdfs).map((x) => (
                <PdfBook key={x.id} p={x} go={go} refresh={refresh} topics={allTopics} />
              ))}
            </div>
            {searchingNow && shownPdfs.length === 0 && <p className="shelf-empty">No PDF names match “{q}”.</p>}
            {!searchingNow && pdfs.length === 0 && <p className="shelf-empty">Upload a PDF to read it, add text boxes and write on it with your Pencil. Only you can see your PDFs.</p>}
          </section>
        </>
      )}
      {!searchingNow && (
        <p className="shelf trash-link">
          <button type="button" className="icon-btn labelled" onClick={() => go("/trash")}>
            <Icon.trash />
            <span>Trash</span>
          </button>
        </p>
      )}
      {newOpen && <NewNotebookDialog topics={allTopics} defaultTopic={newTopic} onClose={() => setNewOpen(false)} onCreated={(id) => (setNewOpen(false), go(`/n/${id}`))} />}
    </div>
  );
}

/** Choose a topic: an existing one, a new one, or none. */
function TopicPicker({ current, topics, onPick }: { current?: string; topics: string[]; onPick: (t: string) => void }) {
  return (
    <div className="topic-picker" role="listbox" aria-label="Topic">
      {topics.map((t) => (
        <button key={t} type="button" role="option" aria-selected={current === t} className={`ink-more-item ${current === t ? "on" : ""}`} onClick={() => onPick(t)}>
          <span aria-hidden>{current === t ? "✓" : ""}</span>
          <span className="ink-more-text">{t}</span>
        </button>
      ))}
      <button
        type="button"
        className="ink-more-item"
        onClick={() => {
          const t = prompt("New topic name (e.g. Biology, Work, DSA)");
          if (t?.trim()) onPick(t.trim());
        }}
      >
        <Icon.plus size={16} />
        <span className="ink-more-text">New topic…</span>
      </button>
      {current && (
        <button type="button" className="ink-more-item" onClick={() => onPick("")}>
          <span aria-hidden>✕</span>
          <span className="ink-more-text">No topic</span>
        </button>
      )}
    </div>
  );
}

/** A notebook as a book, with a ⋯ menu: favourite, icon, cover colour, rename, Trash. */
function NotebookBook({ b, go, refresh, topics = [] }: { b: NotebookMeta; go: (p: string) => void; refresh: () => void; topics?: string[] }) {
  const [menu, setMenu] = useState<null | "main" | "icon" | "cover" | "topic">(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setMenu(null);
    addEventListener("pointerdown", close);
    return () => removeEventListener("pointerdown", close);
  }, [menu]);
  const update = async (ch: { icon?: string; cover?: string; favorite?: boolean; name?: string; topic?: string }) => {
    await api.update(b.id, ch).catch(() => {});
    refresh();
  };
  return (
    <div className="book-wrap" ref={ref}>
      <button type="button" className="book" onClick={() => go(`/n/${b.id}`)} style={{ ["--cover" as string]: coverOf(b) }}>
        <span className="book-cover">
          <span className="book-label">
            {b.icon && (
              <span className="book-icon" aria-hidden>
                {b.icon}
              </span>
            )}
            {b.name}
          </span>
          {b.favorite && (
            <span className="book-star" aria-label="Favorite">
              ★
            </span>
          )}
        </span>
        <span className="book-meta">
          <span className="book-name">{b.name}</span>
          <span className="book-when">{ago(b.updatedAt)}</span>
        </span>
      </button>
      <button type="button" className="book-more" aria-label={`Options for ${b.name}`} aria-expanded={!!menu} onClick={() => setMenu(menu ? null : "main")}>
        <Icon.more size={18} />
      </button>
      {menu && (
        <div className="book-menu" role="menu">
          {menu === "main" && (
            <>
              <button type="button" className="ink-more-item" onClick={() => (update({ favorite: !b.favorite }), setMenu(null))}>
                <span aria-hidden>{b.favorite ? "★" : "☆"}</span>
                <span className="ink-more-text">{b.favorite ? "Remove from Favorites" : "Add to Favorites"}</span>
              </button>
              <button type="button" className="ink-more-item" onClick={() => setMenu("topic")}>
                <Icon.book size={18} />
                <span className="ink-more-text">
                  Topic
                  <small>{b.topic || "None"}</small>
                </span>
              </button>
              <button type="button" className="ink-more-item" onClick={() => setMenu("icon")}>
                <span aria-hidden>{b.icon || "🙂"}</span>
                <span className="ink-more-text">Icon</span>
              </button>
              <button type="button" className="ink-more-item" onClick={() => setMenu("cover")}>
                <span className="mini-swatch" style={{ background: coverOf(b) }} aria-hidden />
                <span className="ink-more-text">Cover colour</span>
              </button>
              <button
                type="button"
                className="ink-more-item"
                onClick={() => {
                  const n = prompt("Rename notebook", b.name);
                  if (n?.trim()) update({ name: n.trim() });
                  setMenu(null);
                }}
              >
                <Icon.text />
                <span className="ink-more-text">Rename</span>
              </button>
              <button type="button" className="ink-more-item danger" onClick={async () => (await api.remove(b.id).catch(() => {}), setMenu(null), refresh())}>
                <Icon.trash />
                <span className="ink-more-text">Move to Trash</span>
              </button>
            </>
          )}
          {menu === "icon" && <EmojiPicker value={b.icon} onPick={(e) => (update({ icon: e }), setMenu(null))} />}
          {menu === "topic" && <TopicPicker current={b.topic} topics={topics} onPick={(t) => (update({ topic: t }), setMenu(null))} />}
          {menu === "cover" && <CoverPicker value={b.cover} id={b.id} onPick={(c) => (update({ cover: c }), setMenu(null))} />}
        </div>
      )}
    </div>
  );
}

/** A PDF as a book (its first page is the cover), with a ⋯ menu: topic, rename, delete. */
function PdfBook({ p, go, refresh, topics = [] }: { p: PdfMeta; go: (path: string) => void; refresh: () => void; topics?: string[] }) {
  const [menu, setMenu] = useState<null | "main" | "topic">(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setMenu(null);
    addEventListener("pointerdown", close);
    return () => removeEventListener("pointerdown", close);
  }, [menu]);
  const update = async (ch: { name?: string; topic?: string }) => {
    await api.updatePdf(p.id, ch).catch(() => {});
    refresh();
  };
  return (
    <div className="book-wrap" ref={ref}>
      <button type="button" className="book pdf" onClick={() => go(`/p/${p.id}`)}>
        <span className="book-cover">
          {p.thumb ? <img src={api.pdfThumbUrl(p.id)} alt="" loading="lazy" /> : <span className="book-label">{p.name}</span>}
          <span className="pdf-corner">PDF</span>
        </span>
        <span className="book-meta">
          <span className="book-name">{p.name}</span>
          <span className="book-when">
            {p.pages ? `${p.pages} pages, ` : ""}
            {ago(p.updatedAt)}
          </span>
        </span>
      </button>
      <button type="button" className="book-more" aria-label={`Options for ${p.name}`} aria-expanded={!!menu} onClick={() => setMenu(menu ? null : "main")}>
        <Icon.more size={18} />
      </button>
      {menu && (
        <div className="book-menu" role="menu">
          {menu === "main" && (
            <>
              <button type="button" className="ink-more-item" onClick={() => setMenu("topic")}>
                <Icon.book size={18} />
                <span className="ink-more-text">
                  Topic
                  <small>{p.topic || "None"}</small>
                </span>
              </button>
              <button
                type="button"
                className="ink-more-item"
                onClick={() => {
                  const n = prompt("Rename PDF", p.name);
                  if (n?.trim()) update({ name: n.trim() });
                  setMenu(null);
                }}
              >
                <Icon.text />
                <span className="ink-more-text">Rename</span>
              </button>
              <a className="ink-more-item" href={api.pdfFileUrl(p.id)} download={`${p.name}.pdf`}>
                <Icon.download />
                <span className="ink-more-text">Download</span>
              </a>
              <button
                type="button"
                className="ink-more-item danger"
                onClick={async () => {
                  if (!confirm(`Delete “${p.name}”? Its copy in Google Drive goes to the bin too.`)) return;
                  await api.removePdf(p.id).catch(() => {});
                  setMenu(null);
                  refresh();
                }}
              >
                <Icon.trash />
                <span className="ink-more-text">Delete PDF</span>
              </button>
            </>
          )}
          {menu === "topic" && <TopicPicker current={p.topic} topics={topics} onPick={(t) => (update({ topic: t }), setMenu(null))} />}
        </div>
      )}
    </div>
  );
}

/** Deleted notebooks: restore, or delete forever. Removed automatically after 30 days. */
function TrashPage({ go, refresh }: { go: (p: string) => void; refresh: () => void }) {
  const [list, setList] = useState<NotebookMeta[] | null>(null);
  const load = () => api.trash().then(setList).catch(() => setList([]));
  useEffect(() => void load(), []);
  const daysLeft = (t?: number) => Math.max(0, 30 - Math.floor((Date.now() - (t ?? Date.now())) / 86_400_000));
  return (
    <div className="library">
      <header className="lib-bar">
        <button type="button" className="icon-btn" onClick={() => go("/")} aria-label="Back to library" title="Library">
          <Icon.back />
        </button>
        <span className="lib-title">Trash</span>
      </header>
      <section className="shelf">
        <p className="shelf-empty">Notebooks you delete stay here for 30 days, then they're removed for good (with their handwriting and Drive copies).</p>
        {list === null ? (
          <p className="shelf-empty">Loading…</p>
        ) : list.length === 0 ? (
          <p className="shelf-empty">The Trash is empty.</p>
        ) : (
          <ul className="trash-list">
            {list.map((n) => (
              <li key={n.id}>
                <span className="trash-name">
                  <span aria-hidden>{n.icon || "📓"}</span> {n.name}
                </span>
                <span className="book-when">{daysLeft(n.deletedAt)} days left</span>
                <button type="button" className="btn" onClick={async () => (await api.restore(n.id).catch(() => {}), refresh(), load())}>
                  Restore
                </button>
                <button
                  type="button"
                  className="btn quiet danger-text"
                  onClick={async () => {
                    if (!confirm(`Delete “${n.name}” forever? This can't be undone.`)) return;
                    await api.purge(n.id).catch(() => {});
                    load();
                  }}
                >
                  Delete forever
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Marks the searched words inside a result. */
function Highlight({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}
    </>
  );
}

function Connect({ me }: { me: Me }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(me.mcpUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <article className="sheet connect">
      <h1>Let your assistant write here</h1>
      <p className="connect-lede">
        Add this address to any assistant that supports MCP. Then say things like “add this question to my DSA notes” and it appears in that notebook,
        styled, while you watch.
      </p>
      <div className="mcp-url">
        <code>{me.mcpUrl}</code>
        <button type="button" className="btn" onClick={copy}>
          {copied ? "Copied" : "Copy address"}
        </button>
      </div>

      <h2>Where to paste it</h2>
      <dl className="where">
        <dt>Claude (web or desktop)</dt>
        <dd>Settings, then Connectors, then Add custom connector. Paste the address, sign in to Noty when asked, and choose Allow.</dd>
        <dt>Claude Code</dt>
        <dd>
          <code>claude mcp add --transport http noty {me.mcpUrl}</code>
        </dd>
        <dt>Gemini CLI</dt>
        <dd>
          In <code>~/.gemini/settings.json</code>: <code>{`"mcpServers": { "noty": { "httpUrl": "${me.mcpUrl}" } }`}</code>, then run <code>/mcp auth noty</code>.
        </dd>
        <dt>Others (ChatGPT, Cursor…)</dt>
        <dd>Look for “custom connector” or “MCP server” and paste the same address.</dd>
      </dl>

      <h2>What your assistant can do ({ASSISTANT_TOOLS.length} tools)</h2>
      <p className="fine">Assistants can only reach your notebooks. Your PDFs stay private.</p>
      {(["Add", "Study", "Handwriting", "Find"] as const).map((g) => (
        <div key={g} className="tools-group">
          <h3>{g === "Add" ? "Add to a notebook" : g === "Study" ? "Study" : g === "Handwriting" ? "Your handwriting" : "Find and organise"}</h3>
          <ul className="tools-list">
            {ASSISTANT_TOOLS.filter((t) => t.group === g).map((t) => (
              <li key={t.name}>
                <code>{t.name}</code>
                <span className="tool-what">{t.what}</span>
                <span className="tool-say">“{t.say}”</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <h2>Google Drive copy</h2>
      {me.drive.connected ? (
        <p>
          Connected to <strong>{me.drive.email}</strong>. Every notebook, image and page of handwriting is copied to the <strong>Noty</strong> folder in that
          Drive a few seconds after each change.{" "}
          <a href="/login/google?link=1&next=/">Use a different Google account</a>
        </p>
      ) : me.googleAvailable ? (
        <div className="drive-off">
          <p>Your notebooks are saved in Noty. Connect Google Drive to keep your own copy there as well.</p>
          <a className="btn" href="/login/google?link=1&next=/">
            Connect Google Drive
          </a>
        </div>
      ) : (
        <p className="fine">Your notebooks, PDFs and images are saved in Noty. The Google Drive copy is switched off on this Noty for now; the owner can turn it on in its settings (see the README).</p>
      )}

      <h2>Things to try</h2>
      <ul className="try">
        {[
          "Add this question to my Physics notes: why is the sky blue?",
          "Save the important points of this chat to Work.",
          "Make flashcards from my Biology notes.",
          "Read my handwriting on page 1 of DSA and type it out.",
          "Draw a mind map of photosynthesis in my Biology notes.",
          "Summarise my DSA notes.",
        ].map((t) => (
          <li key={t}>
            <button
              type="button"
              title="Copy"
              onClick={async (e) => {
                const b = e.currentTarget;
                await navigator.clipboard.writeText(t).catch(() => {});
                b.dataset.copied = "1";
                setTimeout(() => delete b.dataset.copied, 1400);
              }}
            >
              “{t}”
            </button>
          </li>
        ))}
      </ul>
      <p className="fine">Tap one to copy it, then paste it into your assistant.</p>
      <p className="fine">
        Signed in as {me.name === "Owner" ? `the owner${me.email && me.email !== "owner" ? ` (${me.email})` : ""}` : me.email}. These notebooks are private to this account, and
        assistants you connect while signed in here can only reach these notebooks.
      </p>
    </article>
  );
}

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
