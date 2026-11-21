// Draws handwriting strokes into a PNG on the server (no canvas in Workers), so an
// assistant can look at a handwritten page. Strokes are filled as polygons with 2x
// supersampling for smooth edges, then encoded as PNG using the built-in zlib stream.

import { getStroke } from "perfect-freehand";

export interface RenderStroke {
  c: string;
  s: number;
  t?: "h";
  d: string;
}

const COLORS: Record<string, [number, number, number]> = {
  ink: [29, 36, 51],
  blue: [32, 80, 192],
  red: [224, 49, 49],
  green: [47, 158, 68],
  orange: [247, 103, 7],
  purple: [112, 72, 232],
  yellow: [255, 212, 59],
};

function decode(d: string): number[] {
  const n = d.split(",").map(Number);
  for (let i = 3; i < n.length; i++) n[i] += n[i - 3];
  return n;
}

/** Outline polygon of a stroke, in the stroke's own units (block width = 1000). */
function outline(st: RenderStroke): number[][] {
  const p = decode(st.d);
  const pts: [number, number, number][] = [];
  for (let i = 0; i + 2 < p.length; i += 3) pts.push([p[i], p[i + 1], p[i + 2] / 100]);
  const hi = st.t === "h";
  return getStroke(pts, {
    size: hi ? st.s * 3 : st.s,
    thinning: hi ? 0 : 0.6,
    smoothing: 0.55,
    streamline: 0.45,
    simulatePressure: pts.every((q) => q[2] === 0.5),
    last: true,
  });
}

/** The area the strokes cover, in units. */
export function inkBounds(strokes: RenderStroke[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const st of strokes) {
    const p = decode(st.d);
    for (let i = 0; i + 2 < p.length; i += 3) {
      x0 = Math.min(x0, p[i]);
      x1 = Math.max(x1, p[i]);
      y0 = Math.min(y0, p[i + 1]);
      y1 = Math.max(y1, p[i + 1]);
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/**
 * Renders strokes into a PNG. `area` is the region to draw, in units; `widthPx` is the
 * output width (height follows the area's shape, capped so images stay a sensible size).
 */
export async function renderInkPng(strokes: RenderStroke[], area: { x0: number; y0: number; x1: number; y1: number }, widthPx = 900): Promise<Uint8Array> {
  const SS = 2; // supersampling
  const aw = Math.max(1, area.x1 - area.x0);
  const ah = Math.max(1, area.y1 - area.y0);
  let scale = widthPx / aw;
  if (ah * scale > 2400) scale = 2400 / ah; // very tall areas: shrink to fit
  const W = Math.max(1, Math.round(aw * scale));
  const H = Math.max(1, Math.round(ah * scale));
  const SW = W * SS;
  const SH = H * SS;
  const k = scale * SS;

  // RGB at supersampled size, white background.
  const img = new Uint8ClampedArray(SW * SH * 3).fill(255);
  const cover = new Uint8Array(SW); // per-row coverage scratch

  for (const st of strokes) {
    const poly = outline(st).map(([x, y]) => [(x - area.x0) * k, (y - area.y0) * k]);
    if (poly.length < 3) continue;
    const [r, g, b] = COLORS[st.c] ?? COLORS.ink;
    const alpha = st.t === "h" ? 0.38 : 1;
    let minY = Infinity,
      maxY = -Infinity;
    for (const [, y] of poly) (minY = Math.min(minY, y)), (maxY = Math.max(maxY, y));
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(SH - 1, Math.ceil(maxY));
    const xs: { x: number; w: number }[] = [];
    for (let y = yStart; y <= yEnd; y++) {
      const sy = y + 0.5;
      xs.length = 0;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if (yi <= sy !== yj <= sy) xs.push({ x: xi + ((sy - yi) / (yj - yi)) * (xj - xi), w: yi < yj ? 1 : -1 });
      }
      if (!xs.length) continue;
      xs.sort((a, c) => a.x - c.x);
      cover.fill(0);
      // Non-zero winding: fill between crossings while inside.
      let wind = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i].w;
        if (wind === 0) continue;
        const from = Math.max(0, Math.round(xs[i].x));
        const to = Math.min(SW, Math.round(xs[i + 1].x));
        for (let x = from; x < to; x++) cover[x] = 1;
      }
      const row = y * SW * 3;
      for (let x = 0; x < SW; x++) {
        if (!cover[x]) continue;
        const o = row + x * 3;
        img[o] = img[o] * (1 - alpha) + r * alpha;
        img[o + 1] = img[o + 1] * (1 - alpha) + g * alpha;
        img[o + 2] = img[o + 2] * (1 - alpha) + b * alpha;
      }
    }
  }

  // Downsample 2x2 -> 1 and add the PNG row filter byte.
  const raw = new Uint8Array(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) {
    const out = y * (W * 3 + 1);
    raw[out] = 0;
    for (let x = 0; x < W; x++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) sum += img[((y * SS + dy) * SW + (x * SS + dx)) * 3 + ch];
        raw[out + 1 + x * 3 + ch] = sum / (SS * SS);
      }
    }
  }
  return encodePng(W, H, raw);
}

// ---------- PNG encoding ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function encodePng(w: number, h: number, raw: Uint8Array): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const zipped = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zipped), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
