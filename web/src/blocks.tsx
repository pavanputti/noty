// Custom notebook blocks: Q&A card, key points box, and Mermaid diagram.
// Each one shows a finished visual and has an Edit mode for changing it by hand.

import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { CALLOUT_KINDS, type CalloutKind, inline, type Place } from "../../src/shared/blocks";
import { useIsolate } from "./isolate";
import { isDark, useTheme } from "./theme";

// ---------- shared bits ----------

/** Renders **bold**, *italic*, `code` and links without using innerHTML. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {inline(text).map((part, i) => {
        if (part.type === "link")
          return (
            <a key={i} href={part.href} target="_blank" rel="noreferrer noopener">
              {part.content.map((c) => c.text).join("")}
            </a>
          );
        let node: ReactNode = part.text;
        if (part.styles.code) node = <code>{node}</code>;
        if (part.styles.bold) node = <strong>{node}</strong>;
        if (part.styles.italic) node = <em>{node}</em>;
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);

function Form({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useIsolate(ref);
  return (
    <div className="nb-form" ref={ref}>
      {children}
    </div>
  );
}

function EditButton({ onClick, label = "Edit" }: { onClick: () => void; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  useIsolate(ref);
  return (
    <button ref={ref} type="button" className="nb-edit" onClick={onClick} contentEditable={false}>
      {label}
    </button>
  );
}

// ---------- Mermaid ----------

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
let mermaidDark: boolean | null = null;

async function getMermaid() {
  const dark = isDark();
  if (!mermaidReady || mermaidDark !== dark) {
    mermaidDark = dark;
    mermaidReady = import("mermaid").then((m) => {
      const light = {
        background: "transparent",
        primaryColor: "#E8EEFB", primaryBorderColor: "#2050C0", primaryTextColor: "#1D2433",
        secondaryColor: "#E3F5EC", secondaryBorderColor: "#2F9E62", secondaryTextColor: "#1D2433",
        tertiaryColor: "#FFF4CC", tertiaryBorderColor: "#C99A00", tertiaryTextColor: "#1D2433",
        lineColor: "#626B7F", textColor: "#1D2433", edgeLabelBackground: "#FFFFFF",
        clusterBkg: "#F6F8FB", clusterBorder: "#D9DEE6", noteBkgColor: "#FFF4CC", noteBorderColor: "#C99A00",
        actorBkg: "#E8EEFB", actorBorder: "#2050C0", signalColor: "#1D2433", labelBoxBkgColor: "#F0EBFF",
        pie1: "#2050C0", pie2: "#2F9E62", pie3: "#E8590C", pie4: "#7048E8", pie5: "#0C8599", pie6: "#D6336C", pie7: "#C99A00",
        cScale0: "#2050C0", cScale1: "#2F9E62", cScale2: "#E8590C", cScale3: "#7048E8", cScale4: "#0C8599", cScale5: "#D6336C", cScale6: "#C99A00", cScale7: "#5C7CFA",
        cScaleLabel0: "#FFFFFF", cScaleLabel1: "#FFFFFF", cScaleLabel2: "#FFFFFF", cScaleLabel3: "#FFFFFF", cScaleLabel4: "#FFFFFF", cScaleLabel5: "#FFFFFF", cScaleLabel6: "#1D2433", cScaleLabel7: "#FFFFFF",
      };
      const darkVars = {
        ...light,
        primaryColor: "#1F2944", primaryBorderColor: "#86A6FF", primaryTextColor: "#E5E8EE",
        secondaryColor: "#173326", secondaryBorderColor: "#5FCB8F", secondaryTextColor: "#E5E8EE",
        tertiaryColor: "#3A3110", tertiaryBorderColor: "#E8C440", tertiaryTextColor: "#E5E8EE",
        lineColor: "#959DAE", textColor: "#E5E8EE", edgeLabelBackground: "#1A1E26",
        clusterBkg: "#20252F", clusterBorder: "#2C323D", noteBkgColor: "#3A3110", noteBorderColor: "#E8C440",
        actorBkg: "#1F2944", actorBorder: "#86A6FF", signalColor: "#E5E8EE", labelBoxBkgColor: "#2A2348",
        cScale0: "#86A6FF", cScale1: "#5FCB8F", cScale2: "#FF9B5E", cScale3: "#A98BFF", cScale4: "#3BC9DB", cScale5: "#F783AC", cScale6: "#E8C440", cScale7: "#748FFC",
        cScaleLabel0: "#0E1424", cScaleLabel1: "#0E1424", cScaleLabel2: "#0E1424", cScaleLabel3: "#0E1424", cScaleLabel4: "#0E1424", cScaleLabel5: "#0E1424", cScaleLabel6: "#0E1424", cScaleLabel7: "#0E1424",
      };
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: { ...(dark ? darkVars : light), fontFamily: "Schibsted Grotesk, system-ui, sans-serif", fontSize: "15px" },
        flowchart: { curve: "basis", padding: 14 },
      });
      return m.default;
    });
  }
  return mermaidReady;
}

export function Mermaid({ code }: { code: string }) {
  const { dark } = useTheme();
  const id = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    if (!code.trim()) return setSvg(""), setError("");
    getMermaid()
      .then((m) => m.render(`${id}-${n}`, code))
      .then(({ svg }) => n === seq.current && (setSvg(svg), setError("")))
      .catch((e: Error) => n === seq.current && (setSvg(""), setError(e.message?.split("\n")[0] ?? "Invalid diagram")));
  }, [code, id, dark]);

  if (error)
    return (
      <div className="nb-diagram-error" role="alert">
        <p>This diagram has a syntax error: {error}</p>
        <pre>{code}</pre>
      </div>
    );
  if (!svg) return <div className="nb-diagram-empty">Drawing…</div>;
  // Mermaid output in "strict" mode is sanitised (no scripts, no event handlers).
  return <div className="nb-diagram-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}

// ---------- Diagram block ----------

export const DiagramBlock = createReactBlockSpec(
  { type: "diagram", propSchema: { code: { default: "" }, caption: { default: "" } }, content: "none" },
  {
    render: ({ block, editor }) => {
      const [editing, setEditing] = useState(!block.props.code);
      const [code, setCode] = useState(block.props.code);
      const [caption, setCaption] = useState(block.props.caption);
      const save = () => {
        editor.updateBlock(block, { props: { code, caption } });
        setEditing(false);
      };
      return (
        <figure className="nb-diagram" contentEditable={false}>
          {editing ? (
            <Form>
              <label>
                Mermaid code
                <textarea rows={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder={"flowchart LR\n  Idea --> Draft --> Done"} spellCheck={false} />
              </label>
              <label>
                Caption
                <input value={caption} onChange={(e) => setCaption(e.target.value)} />
              </label>
              {code.trim() && <Mermaid code={code} />}
              <div className="nb-form-actions">
                <button type="button" className="nb-btn" onClick={save}>
                  Save diagram
                </button>
                {block.props.code && (
                  <button type="button" className="nb-btn quiet" onClick={() => (setCode(block.props.code), setCaption(block.props.caption), setEditing(false))}>
                    Cancel
                  </button>
                )}
              </div>
            </Form>
          ) : (
            <>
              <EditButton onClick={() => setEditing(true)} />
              <Mermaid code={block.props.code} />
              {block.props.caption && <figcaption>{block.props.caption}</figcaption>}
            </>
          )}
        </figure>
      );
    },
  },
);

// ---------- Key points block ----------

export const KeyPointsBlock = createReactBlockSpec(
  { type: "keyPoints", propSchema: { title: { default: "Key points" }, points: { default: "" } }, content: "none" },
  {
    render: ({ block, editor }) => {
      const [editing, setEditing] = useState(!block.props.points);
      const [title, setTitle] = useState(block.props.title);
      const [points, setPoints] = useState(block.props.points);
      const save = () => {
        editor.updateBlock(block, { props: { title: title || "Key points", points } });
        setEditing(false);
      };
      return (
        <section className="nb-keypoints" contentEditable={false}>
          {editing ? (
            <Form>
              <label>
                Title
                <input value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label>
                Points, one per line
                <textarea rows={5} value={points} onChange={(e) => setPoints(e.target.value)} />
              </label>
              <div className="nb-form-actions">
                <button type="button" className="nb-btn" onClick={save}>
                  Save points
                </button>
              </div>
            </Form>
          ) : (
            <>
              <EditButton onClick={() => setEditing(true)} />
              <h4>{block.props.title || "Key points"}</h4>
              <ul>
                {lines(block.props.points).map((p, i) => (
                  <li key={i}>
                    <mark>
                      <Rich text={p} />
                    </mark>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      );
    },
  },
);

// ---------- Question card ----------

export const QuestionBlock = createReactBlockSpec(
  {
    type: "question",
    propSchema: { question: { default: "" }, answer: { default: "" }, points: { default: "" }, diagram: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const p = block.props;
      const [editing, setEditing] = useState(!p.question);
      const [form, setForm] = useState(p);
      const set = (k: keyof typeof p) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
      const save = () => {
        editor.updateBlock(block, { props: form });
        setEditing(false);
      };
      const pts = lines(p.points);
      return (
        <article className="nb-question" contentEditable={false}>
          {editing ? (
            <Form>
              <label>
                Question
                <input value={form.question} onChange={set("question")} />
              </label>
              <label>
                Answer
                <textarea rows={4} value={form.answer} onChange={set("answer")} />
              </label>
              <label>
                Key points, one per line
                <textarea rows={3} value={form.points} onChange={set("points")} />
              </label>
              <label>
                Diagram (Mermaid, optional)
                <textarea rows={4} value={form.diagram} onChange={set("diagram")} spellCheck={false} />
              </label>
              <div className="nb-form-actions">
                <button type="button" className="nb-btn" onClick={save}>
                  Save card
                </button>
              </div>
            </Form>
          ) : (
            <>
              <EditButton onClick={() => (setForm(p), setEditing(true))} />
              <h3 className="nb-q">
                <span className="nb-q-mark" aria-hidden>
                  Q
                </span>
                <Rich text={p.question} />
              </h3>
              <div className="nb-a">
                {p.answer.split(/\n{2,}/).map((para, i) => (
                  <p key={i}>
                    <Rich text={para} />
                  </p>
                ))}
              </div>
              {pts.length > 0 && (
                <ul className="nb-q-points" aria-label="Key points">
                  {pts.map((pt, i) => (
                    <li key={i}>
                      <mark>
                        <Rich text={pt} />
                      </mark>
                    </li>
                  ))}
                </ul>
              )}
              {p.diagram && (
                <div className="nb-q-diagram">
                  <Mermaid code={p.diagram} />
                </div>
              )}
            </>
          )}
        </article>
      );
    },
  },
);

// ---------- Callout ----------

const CALLOUT_META: Record<CalloutKind, { icon: string; label: string }> = {
  tip: { icon: "💡", label: "Tip" },
  definition: { icon: "📖", label: "Definition" },
  example: { icon: "🧪", label: "Example" },
  warning: { icon: "⚠️", label: "Watch out" },
  summary: { icon: "📌", label: "Summary" },
  note: { icon: "📝", label: "Note" },
};

export const CalloutBlock = createReactBlockSpec(
  {
    type: "callout",
    propSchema: { kind: { default: "tip", values: [...CALLOUT_KINDS] }, title: { default: "" } },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => {
      const kind = block.props.kind as CalloutKind;
      const meta = CALLOUT_META[kind] ?? CALLOUT_META.note;
      const btn = useRef<HTMLButtonElement>(null);
      useIsolate(btn);
      const next = () => {
        const i = CALLOUT_KINDS.indexOf(kind);
        editor.updateBlock(block, { props: { kind: CALLOUT_KINDS[(i + 1) % CALLOUT_KINDS.length] } });
      };
      return (
        <div className="nb-callout" data-kind={kind}>
          <button ref={btn} type="button" className="nb-callout-icon" contentEditable={false} onClick={next} title={`${meta.label}. Click to change the type.`} aria-label={`${meta.label}. Change type`}>
            <span aria-hidden>{meta.icon}</span>
          </button>
          <div className="nb-callout-text">
            <div className="nb-callout-label" contentEditable={false}>
              {meta.label}
              {block.props.title ? `: ${block.props.title}` : ""}
            </div>
            <div className="nb-callout-body" ref={contentRef} />
          </div>
        </div>
      );
    },
  },
);

// ---------- Map ----------

function parsePlaces(s: string): Place[] {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)) : [];
  } catch {
    return [];
  }
}
const placesToText = (ps: Place[]) => ps.map((p) => `${p.name} | ${p.lat}, ${p.lng}${p.note ? ` | ${p.note}` : ""}`).join("\n");
const textToPlaces = (t: string): Place[] =>
  t
    .split("\n")
    .map((l) => l.split("|").map((x) => x.trim()))
    .map(([name, coords, note]) => {
      const [lat, lng] = (coords ?? "").split(",").map(Number);
      return { name: name || "Place", lat, lng, note: note || undefined };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);

function LeafletMap({ places }: { places: Place[] }) {
  const el = useRef<HTMLDivElement>(null);
  useIsolate(el);
  const key = JSON.stringify(places);
  useEffect(() => {
    if (!el.current || !places.length) return;
    let map: import("leaflet").Map | undefined;
    let cancelled = false;
    Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(([L]) => {
      if (cancelled || !el.current) return;
      map = L.map(el.current, { scrollWheelZoom: false, attributionControl: true });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      const pts = places.map((p, i) => {
        const icon = L.divIcon({ className: "nb-pin", html: `<span><b>${i + 1}</b></span>`, iconSize: [28, 28], iconAnchor: [14, 28] });
        const m = L.marker([p.lat, p.lng], { icon, title: p.name }).addTo(map!);
        const pop = document.createElement("div");
        const b = document.createElement("strong");
        b.textContent = p.name;
        pop.append(b);
        if (p.note) pop.append(document.createElement("br"), p.note);
        m.bindPopup(pop);
        return L.latLng(p.lat, p.lng);
      });
      if (pts.length > 1) L.polyline(pts, { color: "#2050C0", weight: 2, opacity: 0.35, dashArray: "4 6" }).addTo(map);
      if (pts.length === 1) map.setView(pts[0], 11);
      else map.fitBounds(L.latLngBounds(pts), { padding: [36, 36] });
    });
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [key]);
  return <div className="nb-map-canvas" ref={el} />;
}

export const MapBlock = createReactBlockSpec(
  { type: "map", propSchema: { title: { default: "" }, places: { default: "[]" } }, content: "none" },
  {
    render: ({ block, editor }) => {
      const places = parsePlaces(block.props.places);
      const [editing, setEditing] = useState(places.length === 0);
      const [title, setTitle] = useState(block.props.title);
      const [text, setText] = useState(placesToText(places));
      const parsed = textToPlaces(text);
      const save = () => {
        editor.updateBlock(block, { props: { title, places: JSON.stringify(parsed) } });
        setEditing(false);
      };
      return (
        <section className="nb-map" contentEditable={false}>
          {editing ? (
            <Form>
              <label>
                Title
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Trip to Kerala" />
              </label>
              <label>
                Places, one per line: name | latitude, longitude | note
                <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Kochi | 9.9312, 76.2673 | Fort Kochi walk\nMunnar | 10.0889, 77.0595"} spellCheck={false} />
              </label>
              <p className="nb-form-hint">{parsed.length} place{parsed.length === 1 ? "" : "s"} found.</p>
              <div className="nb-form-actions">
                <button type="button" className="nb-btn" onClick={save} disabled={!parsed.length}>
                  Save map
                </button>
              </div>
            </Form>
          ) : (
            <>
              <EditButton onClick={() => (setText(placesToText(places)), setTitle(block.props.title), setEditing(true))} />
              {block.props.title && <h4 className="nb-map-title">{block.props.title}</h4>}
              <LeafletMap places={places} />
              <ol className="nb-map-list">
                {places.map((p, i) => (
                  <li key={i}>
                    <span className="nb-map-num">{i + 1}</span>
                    <span>
                      <strong>{p.name}</strong>
                      {p.note && <span className="nb-map-note"> {p.note}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      );
    },
  },
);

// ---------- Blank page (for handwriting; the ink itself lives in the ink layer) ----------

const PAGE_STYLES = ["dotted", "lined", "grid", "blank"] as const;
const SIZE_HEIGHT: Record<string, number> = { a4: 1414, letter: 1294 };

export const PageBlock = createReactBlockSpec(
  {
    type: "page",
    propSchema: { height: { default: 1414 }, style: { default: "dotted" }, size: { default: "a4" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const ref = useRef<HTMLDivElement>(null);
      useIsolate(ref);
      const h = Math.max(200, Number(block.props.height) || 1414);
      const style = PAGE_STYLES.includes(block.props.style as never) ? block.props.style : "dotted";
      return (
        <div ref={ref} className={`nb-page style-${style}`} contentEditable={false} style={{ aspectRatio: `1000 / ${h}` }} aria-label={`Blank ${style} page for handwriting`} role="img">
          <div className="nb-page-bg" />
          <label className="nb-page-style ink-ui" title="Page style">
            <span className="visually-hidden">Page style</span>
            <select
              value={`${style}:${block.props.size}`}
              onChange={(e) => {
                const [st, sz] = e.target.value.split(":");
                editor.updateBlock(block, { props: { style: st, size: sz, height: SIZE_HEIGHT[sz] ?? 1414 } });
              }}
            >
              {PAGE_STYLES.flatMap((st) =>
                ["a4", "letter"].map((sz) => (
                  <option key={`${st}:${sz}`} value={`${st}:${sz}`}>
                    {st[0].toUpperCase() + st.slice(1)}, {sz === "a4" ? "A4" : "Letter"}
                  </option>
                )),
              )}
            </select>
          </label>
        </div>
      );
    },
  },
);

// ---------- Flashcards ----------

interface Card {
  front: string;
  back: string;
}
const parseCards = (s: string): Card[] => {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.filter((c) => c && typeof c.front === "string") : [];
  } catch {
    return [];
  }
};

export const FlashcardsBlock = createReactBlockSpec(
  { type: "flashcards", propSchema: { title: { default: "" }, cards: { default: "[]" } }, content: "none" },
  {
    render: ({ block, editor }) => {
      const cards = parseCards(block.props.cards);
      const [order, setOrder] = useState<number[]>(() => cards.map((_, i) => i));
      const [i, setI] = useState(0);
      const [flipped, setFlipped] = useState(false);
      const [editing, setEditing] = useState(cards.length === 0);
      const [text, setText] = useState(cards.map((c) => `${c.front} | ${c.back}`).join("\n"));
      const [title, setTitle] = useState(block.props.title);
      const ref = useRef<HTMLDivElement>(null);
      useIsolate(ref);
      useEffect(() => setOrder(cards.map((_, k) => k)), [block.props.cards]);
      const n = cards.length;
      const card = cards[order[i % Math.max(1, n)] ?? 0];
      const go = (d: number) => {
        setFlipped(false);
        setI((x) => (x + d + n) % n);
      };
      const shuffle = () => {
        const o = cards.map((_, k) => k);
        for (let k = o.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [o[k], o[j]] = [o[j], o[k]];
        }
        setOrder(o);
        setI(0);
        setFlipped(false);
      };
      const save = () => {
        const next = text
          .split("\n")
          .map((l) => l.split("|"))
          .filter((parts) => parts[0]?.trim())
          .map(([f, ...b]) => ({ front: f.trim(), back: b.join("|").trim() }));
        editor.updateBlock(block, { props: { title, cards: JSON.stringify(next) } });
        setEditing(false);
        setI(0);
      };
      return (
        <section className="nb-cards" contentEditable={false} ref={ref}>
          {editing ? (
            <Form>
              <label>
                Deck title
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Photosynthesis revision" />
              </label>
              <label>
                Cards, one per line: question | answer
                <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={"What absorbs light? | Chlorophyll\nWhere is the Calvin cycle? | Stroma"} />
              </label>
              <div className="nb-form-actions">
                <button type="button" className="nb-btn" onClick={save}>
                  Save cards
                </button>
              </div>
            </Form>
          ) : (
            <>
              <EditButton onClick={() => (setText(cards.map((c) => `${c.front} | ${c.back}`).join("\n")), setTitle(block.props.title), setEditing(true))} />
              <h4 className="nb-cards-title">{block.props.title || "Flashcards"}</h4>
              {card && (
                <button type="button" className={`nb-card ${flipped ? "flipped" : ""}`} onClick={() => setFlipped(!flipped)} aria-label={flipped ? "Show question" : "Show answer"}>
                  <span className="nb-card-inner">
                    <span className="nb-card-face front">
                      <span className="nb-card-side">Question</span>
                      <Rich text={card.front} />
                    </span>
                    <span className="nb-card-face back">
                      <span className="nb-card-side">Answer</span>
                      <Rich text={card.back} />
                    </span>
                  </span>
                </button>
              )}
              <div className="nb-cards-nav">
                <button type="button" className="nb-tool" onClick={() => go(-1)} disabled={n < 2}>
                  Previous
                </button>
                <span className="nb-cards-count" aria-live="polite">
                  {n ? `${(i % n) + 1} of ${n}` : "No cards"}
                </span>
                <button type="button" className="nb-tool" onClick={() => go(1)} disabled={n < 2}>
                  Next
                </button>
                <button type="button" className="nb-tool" onClick={shuffle} disabled={n < 2}>
                  Shuffle
                </button>
              </div>
            </>
          )}
        </section>
      );
    },
  },
);

// ---------- Table of contents (live list of the notebook's headings) ----------

export const TocBlock = createReactBlockSpec(
  { type: "toc", propSchema: {}, content: "none" },
  {
    render: ({ editor }) => {
      const [, tick] = useState(0);
      useEffect(() => editor.onChange(() => tick((n) => n + 1)), [editor]);
      const heads = (editor.document as unknown as { id: string; type: string; props: { level: number }; content: { text?: string }[] }[]).filter((b) => b.type === "heading");
      const ref = useRef<HTMLDivElement>(null);
      useIsolate(ref);
      return (
        <nav className="nb-toc" contentEditable={false} ref={ref} aria-label="Contents">
          <h4>Contents</h4>
          {heads.length === 0 ? (
            <p className="nb-toc-empty">Add headings (type “/heading”) and they’ll be listed here.</p>
          ) : (
            <ol>
              {heads.map((h) => (
                <li key={h.id} style={{ paddingLeft: `${(Math.max(1, Number(h.props.level) || 1) - 1) * 16}px` }}>
                  <button type="button" onClick={() => document.querySelector(`[data-node-type="blockOuter"][data-id="${CSS.escape(h.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                    {(h.content ?? []).map((c) => c.text ?? "").join("") || "Untitled heading"}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </nav>
      );
    },
  },
);

// ---------- Link to another notebook ----------

const openPath = (path: string) => {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
};

export const NbLinkBlock = createReactBlockSpec(
  { type: "nblink", propSchema: { target: { default: "" }, title: { default: "" }, icon: { default: "" } }, content: "none" },
  {
    render: ({ block, editor }) => {
      const [list, setList] = useState<{ id: string; name: string; icon?: string }[] | null>(null);
      const [q, setQ] = useState("");
      const picking = !block.props.target;
      useEffect(() => {
        if (picking) import("./api").then(({ api }) => api.notebooks().then(setList).catch(() => setList([])));
      }, [picking]);
      if (picking)
        return (
          <section className="nb-link-pick" contentEditable={false}>
            <Form>
              <label>
                Link to a notebook
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your notebooks" autoFocus />
              </label>
            </Form>
            <ul>
              {(list ?? [])
                .filter((n) => n.name.toLowerCase().includes(q.toLowerCase()))
                .slice(0, 8)
                .map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => editor.updateBlock(block, { props: { target: n.id, title: n.name, icon: n.icon ?? "" } })}>
                      <span aria-hidden>{n.icon || "📓"}</span> {n.name}
                    </button>
                  </li>
                ))}
              {list && list.length === 0 && <li className="nb-toc-empty">No other notebooks yet.</li>}
            </ul>
          </section>
        );
      return (
        <button type="button" className="nb-link" contentEditable={false} onClick={() => openPath(`/n/${block.props.target}`)} title="Open notebook">
          <span className="nb-link-icon" aria-hidden>
            {block.props.icon || "📓"}
          </span>
          <span className="nb-link-title">{block.props.title || "Notebook"}</span>
          <span className="nb-link-go" aria-hidden>
            Open
          </span>
        </button>
      );
    },
  },
);

// ---------- Board (kanban) ----------

interface Col {
  id: string;
  name: string;
  cards: { id: string; text: string }[];
}
const parseCols = (s: string): Col[] => {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.filter((c) => c && Array.isArray(c.cards)) : [];
  } catch {
    return [];
  }
};
const rid = () => crypto.randomUUID().slice(0, 8);

export const BoardBlock = createReactBlockSpec(
  {
    type: "board",
    propSchema: { title: { default: "" }, columns: { default: JSON.stringify([{ id: "todo", name: "To do", cards: [] }, { id: "doing", name: "Doing", cards: [] }, { id: "done", name: "Done", cards: [] }]) } },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const cols = parseCols(block.props.columns);
      const ref = useRef<HTMLDivElement>(null);
      useIsolate(ref);
      const save = (next: Col[]) => editor.updateBlock(block, { props: { columns: JSON.stringify(next) } });
      const moveCard = (ci: number, ki: number, dir: -1 | 1) => {
        const next = structuredClone(cols);
        const [card] = next[ci].cards.splice(ki, 1);
        next[ci + dir].cards.push(card);
        save(next);
      };
      return (
        <section className="nb-board" contentEditable={false} ref={ref}>
          {block.props.title && <h4 className="nb-board-title">{block.props.title}</h4>}
          <div className="nb-board-cols">
            {cols.map((c, ci) => (
              <div key={c.id} className="nb-col">
                <input
                  className="nb-col-name"
                  defaultValue={c.name}
                  aria-label="Column name"
                  onBlur={(e) => e.target.value.trim() !== c.name && save(cols.map((x, i) => (i === ci ? { ...x, name: e.target.value.trim() || x.name } : x)))}
                />
                <span className="nb-col-count">{c.cards.length}</span>
                <ul>
                  {c.cards.map((k, ki) => (
                    <li key={k.id} className="nb-card-item">
                      <textarea
                        defaultValue={k.text}
                        rows={Math.min(6, Math.max(1, Math.ceil(k.text.length / 28)))}
                        aria-label="Card"
                        onBlur={(e) => e.target.value !== k.text && save(cols.map((x, i) => (i === ci ? { ...x, cards: x.cards.map((y, j) => (j === ki ? { ...y, text: e.target.value } : y)) } : x)))}
                      />
                      <div className="nb-card-actions">
                        <button type="button" onClick={() => moveCard(ci, ki, -1)} disabled={ci === 0} aria-label={`Move to ${cols[ci - 1]?.name ?? ""}`} title={`Move to ${cols[ci - 1]?.name ?? ""}`}>
                          ←
                        </button>
                        <button type="button" onClick={() => moveCard(ci, ki, 1)} disabled={ci === cols.length - 1} aria-label={`Move to ${cols[ci + 1]?.name ?? ""}`} title={`Move to ${cols[ci + 1]?.name ?? ""}`}>
                          →
                        </button>
                        <button type="button" onClick={() => save(cols.map((x, i) => (i === ci ? { ...x, cards: x.cards.filter((_, j) => j !== ki) } : x)))} aria-label="Delete card" title="Delete card">
                          ✕
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                <form
                  className="nb-add-card"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = e.currentTarget.elements.namedItem("t") as HTMLInputElement;
                    const v = input.value.trim();
                    if (!v) return;
                    save(cols.map((x, i) => (i === ci ? { ...x, cards: [...x.cards, { id: rid(), text: v }] } : x)));
                    input.value = "";
                  }}
                >
                  <input name="t" placeholder="+ Add a card" aria-label={`Add a card to ${c.name}`} />
                </form>
              </div>
            ))}
            <button type="button" className="nb-add-col" onClick={() => save([...cols, { id: rid(), name: "New column", cards: [] }])}>
              + Column
            </button>
          </div>
        </section>
      );
    },
  },
);

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    diagram: DiagramBlock(),
    keyPoints: KeyPointsBlock(),
    question: QuestionBlock(),
    callout: CalloutBlock(),
    map: MapBlock(),
    page: PageBlock(),
    flashcards: FlashcardsBlock(),
    toc: TocBlock(),
    nblink: NbLinkBlock(),
    board: BoardBlock(),
  },
});

export type NotyEditor = typeof schema.BlockNoteEditor;
