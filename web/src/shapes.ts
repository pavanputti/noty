// Turns a rough pen stroke into a clean shape when it's clearly one:
// line, arrow, circle, ellipse, rectangle or triangle. Points are flat [x, y, pressure, ...]
// in ink units. Returns new flat points, or null to keep the stroke as drawn.

type P = [number, number];

const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function toPts(flat: number[]): P[] {
  const out: P[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i], flat[i + 1]]);
  return out;
}
function length(pts: P[]) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}
function segDist(p: P, a: P, b: P) {
  const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  if (!l2) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2));
  return dist(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
}
/** Ramer–Douglas–Peucker simplification: keeps the corners. */
function rdp(pts: P[], eps: number): P[] {
  if (pts.length < 3) return pts;
  let max = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > max) (max = d), (idx = i);
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}
/** Samples a polyline evenly so the pen renderer draws clean edges. */
function sample(path: P[], step = 6): number[] {
  const out: number[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const n = Math.max(1, Math.ceil(dist(path[i], path[i + 1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push(Math.round(path[i][0] + t * (path[i + 1][0] - path[i][0])), Math.round(path[i][1] + t * (path[i + 1][1] - path[i][1])), 50);
    }
  }
  const last = path[path.length - 1];
  out.push(Math.round(last[0]), Math.round(last[1]), 50);
  return out;
}
const angle = (a: P, b: P, c: P) => {
  // angle at b between ba and bc, in degrees
  const v1 = [a[0] - b[0], a[1] - b[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
};
function arrowPath(a: P, b: P, head: number): P[] {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const h1: P = [b[0] - head * Math.cos(ang - Math.PI / 7), b[1] - head * Math.sin(ang - Math.PI / 7)];
  const h2: P = [b[0] - head * Math.cos(ang + Math.PI / 7), b[1] - head * Math.sin(ang + Math.PI / 7)];
  return [a, b, h1, b, h2];
}

export type ShapeKind = "line" | "arrow" | "circle" | "ellipse" | "rectangle" | "triangle";

export function recognize(flat: number[]): { kind: ShapeKind; flat: number[] } | null {
  const pts = toPts(flat);
  if (pts.length < 6) return null;
  const L = length(pts);
  if (L < 40) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const gap = dist(first, last);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
  const diag = Math.hypot(x1 - x0, y1 - y0);

  // Open strokes: line, or arrow (a line with a hook back at the end).
  if (gap > 0.25 * L) {
    let dev = 0;
    for (const p of pts) dev = Math.max(dev, segDist(p, first, last));
    if (dev < Math.max(5, 0.05 * gap)) return { kind: "line", flat: sample([first, last]) };
    const s = rdp(pts, Math.max(5, 0.06 * diag));
    if (s.length === 3) {
      const [a, b, c] = s;
      if (dist(b, c) < 0.45 * dist(a, b) && angle(a, b, c) < 65) return { kind: "arrow", flat: sample(arrowPath(a, b, Math.min(40, dist(a, b) * 0.25))) };
    }
    return null;
  }

  // Closed strokes: compare how well an ellipse fits against a triangle/rectangle, and take the closer fit.
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  if (rx < 8 || ry < 8) return null;
  // Average distance from the drawn points to each candidate, as a fraction of the shape's size.
  let ellErr = 0;
  for (const [x, y] of pts) ellErr += Math.abs(Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2) - 1) * ((rx + ry) / 2);
  ellErr /= pts.length * diag;

  const closed = [...pts, first];
  const corners = rdp(closed, Math.max(6, 0.09 * diag)).slice(0, -1);
  let poly: P[] | null = null;
  let polyErr = Infinity;
  if (corners.length === 3 || corners.length === 4) {
    const straight =
      corners.length === 4 &&
      corners.every((p, i) => {
        const q = corners[(i + 1) % 4];
        const a = Math.abs((Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI) % 90;
        return a < 14 || a > 76;
      });
    poly = straight ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : corners;
    polyErr = 0;
    for (const p of pts) {
      let d = Infinity;
      for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]));
      polyErr += d;
    }
    polyErr /= pts.length * diag;
  }

  if (poly && polyErr < ellErr && polyErr < 0.04) return { kind: poly.length === 3 ? "triangle" : "rectangle", flat: sample([...poly, poly[0]]) };
  if (ellErr < 0.045) {
    const circle = Math.abs(rx - ry) / Math.max(rx, ry) < 0.18;
    const r = (rx + ry) / 2;
    const ell: P[] = [];
    for (let i = 0; i <= 72; i++) {
      const t = (i / 72) * Math.PI * 2;
      ell.push([cx + (circle ? r : rx) * Math.cos(t), cy + (circle ? r : ry) * Math.sin(t)]);
    }
    return { kind: circle ? "circle" : "ellipse", flat: sample(ell, 8) };
  }
  return null;
}

/** A small "V" drawn at the end of a line: turn it into an arrowhead on that line. */
export function arrowheadFor(flat: number[], line: { a: P; b: P }): number[] | null {
  const pts = toPts(flat);
  if (pts.length < 4) return null;
  const L = length(pts);
  const lineLen = dist(line.a, line.b);
  if (L > lineLen * 0.9) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
  const s = rdp(pts, Math.max(4, 0.08 * Math.hypot(x1 - x0, y1 - y0)));
  if (s.length !== 3) return null;
  const apex = s[1];
  if (dist(apex, line.b) > Math.max(30, lineLen * 0.2)) return null;
  const path = arrowPath(line.a, line.b, Math.min(40, lineLen * 0.25)).slice(1); // just the head, anchored at b
  return sample(path);
}
