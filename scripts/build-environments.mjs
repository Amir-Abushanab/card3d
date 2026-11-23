#!/usr/bin/env node
/**
 * Builds the scene environments shipped in packages/core/assets/environments/ from Poly Haven's CC0
 * HDRIs (https://polyhaven.com, licence: CC0 1.0). Run it only to add or refresh one; the outputs
 * are committed.
 *
 *   node scripts/build-environments.mjs [--cache <dir>] [--quality 90]
 *
 * For each entry of ENVIRONMENTS it asks Poly Haven's API (api.polyhaven.com/files/<id>) for the 1k
 * Radiance `.hdr` (1024 × 512 equirect), downloads it from Poly Haven's CDN into a temporary
 * directory (never into the repository), and re-encodes it as a gain-mapped WebP, about a tenth of the
 * `.hdr`'s size:
 *
 *   one W × 2H lossy WebP; the top half is the base, the bottom half the gain (grey):
 *     linear radiance = sRGB→linear(base) · 2^(gain/255 · 16)
 *
 * The gain is log2 of each pixel's brightest channel above 1 (0 elsewhere), dilated and blurred so it
 * varies smoothly (lossy coding then barely touches it), quantised upwards; the base is the radiance
 * divided by the quantised gain, so it stays in 0…1 and carries all the detail and colour. Decoded by
 * the engine (crates/card3d-engine/src/scene.rs; the three.js engine's `decodeGainMapEnvironment` is in the
 * local archive, .archive/three-engine/packages/core/src/scene/marketing/environment.ts).
 *
 * Needs `cwebp` (libwebp) on the PATH. three's HDRLoader parses the .hdr.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
// three.js is a dev dependency of the comparison tools only (crates/card3d-tools/package.json).
const three = (p) => pathToFileURL(join(root, "crates/card3d-tools/node_modules/three", p)).href;
const THREE = await import(three("build/three.module.js"));
const { HDRLoader } = await import(three("examples/jsm/loaders/HDRLoader.js"));

/** Our id → Poly Haven asset id. Keep in sync with SCENE_ENVIRONMENTS (core) and THIRD_PARTY_NOTICES.md. */
export const ENVIRONMENTS = {
  softbox: "studio_small_09",
  cyclorama: "cyclorama_hard_light",
  loft: "brown_photostudio_02",
  "warm-hall": "photo_studio_loft_hall",
  sunset: "venice_sunset",
};
/** Stops of headroom the gain plane encodes (8 bits over 0…16 stops: 1/16 stop per step). */
export const GAIN_STOPS = 16;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = resolve(root, "packages/core/assets/environments");
const QUALITY = opt("quality", "90");
const cache = opt("cache", null);
const work = mkdtempSync(join(tmpdir(), "card3d-env-"));
const UA = { "User-Agent": "card3d-build-environments" };

async function fetchHdr(phId) {
  const cached = cache && join(resolve(cache), `${phId}_1k.hdr`);
  if (cached && existsSync(cached)) return readFileSync(cached);
  const files = await (await fetch(`https://api.polyhaven.com/files/${phId}`, { headers: UA })).json();
  const url = files?.hdri?.["1k"]?.hdr?.url;
  if (!url || !url.startsWith("https://dl.polyhaven.org/")) throw new Error(`${phId}: no 1k .hdr from Poly Haven's CDN`);
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${phId}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (cached) {
    mkdirSync(resolve(cache), { recursive: true });
    writeFileSync(cached, buf);
  }
  return buf;
}

const srgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** Max filter of radius r (separable; wraps horizontally like the equirect, clamps vertically). */
function dilate(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) m = Math.max(m, src[y * w + ((x + k + w) % w)]);
      tmp[y * w + x] = m;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) m = Math.max(m, tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]);
      out[y * w + x] = m;
    }
  return out;
}

/** Gaussian blur, radius r = ceil(2σ) (separable, same edges as `dilate`). */
function blur(src, w, h, sigma) {
  const r = Math.ceil(2 * sigma);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sum = k.reduce((a, b) => a + b, 0);
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * src[y * w + ((x + i + w) % w)];
      tmp[y * w + x] = s / sum;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = s / sum;
    }
  return out;
}

function encode(id, phId, hdr) {
  const loader = new HDRLoader().setDataType(THREE.FloatType);
  const tex = loader.parse(hdr.buffer.slice(hdr.byteOffset, hdr.byteOffset + hdr.byteLength));
  const { width: w, height: h, data } = tex; // RGBA float, top row first
  const n = w * h;
  const stops = new Float32Array(n);
  let lum = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4],
      g = data[i * 4 + 1],
      b = data[i * 4 + 2];
    const m = Math.max(r, g, b);
    stops[i] = m > 1 ? Math.min(GAIN_STOPS, Math.log2(m)) : 0;
    lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    peak = Math.max(peak, m);
  }
  // Dilate further than the blur reaches, so the smoothed gain never falls below a pixel's own need.
  const smooth = blur(dilate(stops, w, h, 4), w, h, 1.5);
  const ppm = Buffer.alloc(15 + String(w).length + String(2 * h).length + w * 2 * h * 3);
  const header = `P6\n${w} ${2 * h}\n255\n`;
  ppm.write(header, 0, "latin1");
  let o = header.length;
  const gain8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const q = Math.min(255, Math.ceil((smooth[i] / GAIN_STOPS) * 255 - 1e-6));
    gain8[i] = Math.max(0, q);
    const k = Math.pow(2, (gain8[i] / 255) * GAIN_STOPS);
    for (let c = 0; c < 3; c++) ppm[o++] = Math.round(255 * srgb(Math.min(1, Math.max(0, data[i * 4 + c] / k))));
  }
  for (let i = 0; i < n; i++) {
    ppm[o++] = gain8[i];
    ppm[o++] = gain8[i];
    ppm[o++] = gain8[i];
  }
  const src = join(work, `${id}.ppm`);
  writeFileSync(src, ppm.subarray(0, o));
  const dst = join(OUT, `${id}.webp`);
  execFileSync("cwebp", ["-quiet", "-q", QUALITY, "-m", "6", "-sharp_yuv", "-metadata", "none", src, "-o", dst]);
  const mean = lum / n;
  console.log(
    `${id.padEnd(10)} ← ${phId.padEnd(24)} ${w}×${h}  mean ${mean.toFixed(3)}  peak ${peak.toFixed(1)}  ${(hdr.length / 1024).toFixed(0)} KB .hdr → ${(statSync(dst).size / 1024).toFixed(0)} KB .webp`,
  );
}

try {
  mkdirSync(OUT, { recursive: true });
  for (const [id, phId] of Object.entries(ENVIRONMENTS)) encode(id, phId, await fetchHdr(phId));
} finally {
  rmSync(work, { recursive: true, force: true });
}
