import { recognize } from "../web/src/shapes.ts";
const flat = (pts: number[][]) => pts.flatMap(([x, y]) => [Math.round(x), Math.round(y), 50]);
const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5); })();
const jit = (a: number) => rnd() * a;
const cases: [string, number[][], string | null][] = [];
cases.push(["wobbly circle", Array.from({ length: 70 }, (_, i) => { const a = (i / 69) * Math.PI * 2.05; const r = 140 + jit(16); return [500 + r * Math.cos(a), 500 + r * Math.sin(a)]; }), "circle"]);
cases.push(["oval", Array.from({ length: 70 }, (_, i) => { const a = (i / 69) * Math.PI * 2.03; return [500 + 220 * Math.cos(a) + jit(10), 500 + 110 * Math.sin(a) + jit(10)]; }), "ellipse"]);
const edge = (a: number[], b: number[], n: number) => Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n + jit(8), a[1] + ((b[1] - a[1]) * i) / n + jit(8)]);
cases.push(["rough square", [...edge([300, 300], [600, 300], 15), ...edge([600, 300], [600, 600], 15), ...edge([600, 600], [300, 600], 15), ...edge([300, 600], [300, 305], 15)], "rectangle"]);
cases.push(["rough triangle", [...edge([500, 200], [700, 550], 18), ...edge([700, 550], [300, 550], 18), ...edge([300, 550], [497, 205], 18)], "triangle"]);
cases.push(["rough line", Array.from({ length: 30 }, (_, i) => [200 + i * 15, 400 + jit(6)]), "line"]);
cases.push(["arrow with hook", [...Array.from({ length: 25 }, (_, i) => [200 + i * 16, 400 + jit(4)]), ...Array.from({ length: 6 }, (_, i) => [584 - i * 10, 400 - i * 9])], "arrow"]);
cases.push(["scribble (handwriting)", Array.from({ length: 60 }, (_, i) => [200 + i * 6 + jit(30), 400 + Math.sin(i) * 40 + jit(30)]), null]);
cases.push(["letter S", Array.from({ length: 40 }, (_, i) => { const t = (i / 39) * Math.PI * 2; return [400 + 60 * Math.sin(t) * (t < Math.PI ? 1 : -1), 300 + i * 6]; }), null]);
let fails = 0;
for (const [name, pts, want] of cases) {
  const got = recognize(flat(pts))?.kind ?? null;
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${got ?? "kept as drawn"}${ok ? "" : ` (wanted ${want ?? "kept as drawn"})`}`);
}
process.exit(fails ? 1 : 0);
