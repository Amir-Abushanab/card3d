/**
 * Raster → vector outlines for the plate SVGs: marching squares on a greyscale mask at its 50 % level
 * (interpolated between pixel centres, so the outline is sub-pixel accurate on antialiased edges),
 * closed loops, simplified (Ramer–Douglas–Peucker) within a fraction of a pixel. Even-odd filling
 * reproduces holes (the counters of O, A, …). At 600–1200 dpi the outlines are well inside a printer's
 * tolerances; they are traced, not the font's own curves (noted in the files).
 */

export interface TraceRaster {
  width: number;
  height: number;
  data: Uint8Array;
}

export type Loop = Array<[number, number]>;

/** Closed outlines (pixel coordinates; pixel centres at +0.5) of where `data ≥ threshold`. */
export function traceLoops(img: TraceRaster, threshold = 128, tolerance = 0.25): Loop[] {
  const { width: w, height: h, data } = img;
  // Bounds of the set pixels (cells outside them are empty).
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[y * w + x]! >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return [];
  const val = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[y * w + x]!);
  const inside = (x: number, y: number) => val(x, y) >= threshold;
  // Edge ids: horizontal edge from corner (x, y) to (x + 1, y) → 2·idx; vertical (x, y)–(x, y + 1) → 2·idx + 1.
  const W = w + 2;
  const id = (x: number, y: number, vertical: boolean) => ((y + 1) * W + (x + 1)) * 2 + (vertical ? 1 : 0);
  const point = (e: number): [number, number] => {
    const vertical = e & 1;
    const idx = e >> 1;
    const x = (idx % W) - 1;
    const y = Math.floor(idx / W) - 1;
    const a = val(x, y);
    const b = vertical ? val(x, y + 1) : val(x + 1, y);
    const t = a === b ? 0.5 : Math.min(1, Math.max(0, (threshold - 0.5 - a) / (b - a)));
    return vertical ? [x + 0.5, y + 0.5 + t] : [x + 0.5 + t, y + 0.5];
  };
  const next = new Map<number, number>();
  for (let cy = y0 - 1; cy <= y1; cy++) {
    for (let cx = x0 - 1; cx <= x1; cx++) {
      // Corners: tl (cx, cy), tr (cx+1, cy), br (cx+1, cy+1), bl (cx, cy+1).
      const tl = inside(cx, cy);
      const tr = inside(cx + 1, cy);
      const br = inside(cx + 1, cy + 1);
      const bl = inside(cx, cy + 1);
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const T = id(cx, cy, false);
      const B = id(cx, cy + 1, false);
      const L = id(cx, cy, true);
      const R = id(cx + 1, cy, true);
      // Segments as [from, to] with the inside on the right of travel (y down: clockwise outer loops).
      const segs: Array<[number, number]> = [];
      const centre = (val(cx, cy) + val(cx + 1, cy) + val(cx + 1, cy + 1) + val(cx, cy + 1)) / 4 >= threshold;
      switch (code) {
        case 1:
          segs.push([L, B]);
          break;
        case 2:
          segs.push([B, R]);
          break;
        case 3:
          segs.push([L, R]);
          break;
        case 4:
          segs.push([R, T]);
          break;
        case 5:
          if (centre) segs.push([L, T], [R, B]);
          else segs.push([L, B], [R, T]);
          break;
        case 6:
          segs.push([B, T]);
          break;
        case 7:
          segs.push([L, T]);
          break;
        case 8:
          segs.push([T, L]);
          break;
        case 9:
          segs.push([T, B]);
          break;
        case 10:
          if (centre) segs.push([T, R], [B, L]);
          else segs.push([T, L], [B, R]);
          break;
        case 11:
          segs.push([T, R]);
          break;
        case 12:
          segs.push([R, L]);
          break;
        case 13:
          segs.push([R, B]);
          break;
        case 14:
          segs.push([B, L]);
          break;
      }
      for (const [a, b] of segs) next.set(a, b);
    }
  }
  const loops: Loop[] = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const loop: Loop = [];
    let e = start;
    for (let guard = 0; guard < 1e7; guard++) {
      const n = next.get(e);
      if (n === undefined) break;
      next.delete(e);
      loop.push(point(e));
      e = n;
      if (e === start) break;
    }
    if (loop.length >= 3) loops.push(simplifyClosed(loop, tolerance));
  }
  return loops.filter((l) => l.length >= 3);
}

function rdp(pts: Loop, eps: number): Loop {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let best = -1;
    let dmax = eps;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > dmax) {
        dmax = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplify a closed loop: split at its farthest pair so both halves keep their ends. */
function simplifyClosed(loop: Loop, eps: number): Loop {
  if (loop.length < 8) return loop;
  let far = 0;
  let dmax = -1;
  const [x0, y0] = loop[0]!;
  loop.forEach(([x, y], i) => {
    const d = (x - x0) ** 2 + (y - y0) ** 2;
    if (d > dmax) {
      dmax = d;
      far = i;
    }
  });
  const a = rdp(loop.slice(0, far + 1), eps);
  const b = rdp([...loop.slice(far), loop[0]!], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Loops → SVG path data, through `map` (px → output units), 3 decimals. */
export function loopsToPath(loops: Loop[], map: (x: number, y: number) => [number, number]): string {
  const f = (v: number) => {
    const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
    return s === "-0" ? "0" : s;
  };
  let d = "";
  for (const l of loops) {
    l.forEach(([x, y], i) => {
      const [X, Y] = map(x, y);
      d += `${i ? "L" : "M"}${f(X)} ${f(Y)}`;
    });
    d += "Z";
  }
  return d;
}

/** Area enclosed by the loops (even-odd), px². */
export function loopsArea(loops: Loop[]): number {
  let total = 0;
  for (const l of loops) {
    let a = 0;
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) a += (l[j]![0] - l[i]![0]) * (l[j]![1] + l[i]![1]);
    total += a / 2;
  }
  return Math.abs(total);
}
