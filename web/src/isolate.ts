import { type RefObject, useEffect } from "react";

// Inside custom blocks, the editor (TipTap/ProseMirror) already ignores events from
// inputs, textareas and buttons. For other areas we own (a map, a drawing surface),
// a mouse-down would make the editor select the whole block or start a text selection.
// Marking it defaultPrevented makes ProseMirror skip it, while React handlers still run.
// (Don't use stopPropagation here: React listens at the root, so it would break onClick/onChange.)
export function useIsolate<T extends HTMLElement>(ref: RefObject<T | null>, active = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, button, a, label, [contenteditable='true']")) return;
      e.preventDefault();
    };
    el.addEventListener("mousedown", onDown);
    return () => el.removeEventListener("mousedown", onDown);
  }, [ref, active]);
}
