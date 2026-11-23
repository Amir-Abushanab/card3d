/**
 * A small PNG writer for production files: 1-bit and 8-bit greyscale, RGB and RGBA, with the
 * resolution recorded (pHYs, pixels per metre) so layout apps place them at the right size, and the
 * sRGB chunk on colour images. Deflate is fflate's. A reader for tests and derivatives.
 */
import { unzlibSync, zlibSync } from "fflate";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return c;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

export interface PngImage {
  width: number;
  height: number;
  /** 1 grey, 3 RGB, 4 RGBA (8 bits each), row-major, top row first. */
  channels: 1 | 3 | 4;
  data: Uint8Array;
}

export interface PngOptions {
  /** Dots per inch, written as pHYs. */
  dpi?: number;
  /** Greyscale only: 1-bit (threshold at 128). */
  bits?: 1 | 8;
  /** Greyscale only: invert (the vendor convention for masks: black = the effect). */
  invert?: boolean;
  /** Deflate level, default 6. */
  level?: number;
}

export function encodePng(img: PngImage, o: PngOptions = {}): Uint8Array<ArrayBuffer> {
  const { width: w, height: h, channels } = img;
  const bits = channels === 1 ? (o.bits ?? 8) : 8;
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const stride = bits === 1 ? Math.ceil(w / 8) : w * channels;
  const raw = new Uint8Array((stride + 1) * h);
  const inv = !!o.invert;
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1);
    const src = y * w * channels;
    if (bits === 1) {
      raw[row] = 0;
      for (let x = 0; x < w; x++) {
        const on = img.data[src + x]! >= 128 !== inv;
        if (on) raw[row + 1 + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    } else if (channels === 1 && inv) {
      raw[row] = 1; // Sub filter
      for (let x = 0; x < w; x++) {
        const v = 255 - img.data[src + x]!;
        const left = x ? 255 - img.data[src + x - 1]! : 0;
        raw[row + 1 + x] = (v - left) & 255;
      }
    } else {
      // Sub filter: cheap and good on smooth artwork and flat masks.
      raw[row] = 1;
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? img.data[src + i - channels]! : 0;
        raw[row + 1 + i] = (img.data[src + i]! - left) & 255;
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = bits;
  ihdr[9] = colorType;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  if (channels !== 1) parts.push(chunk("sRGB", new Uint8Array([0])));
  if (o.dpi) {
    const ppm = Math.round(o.dpi / 0.0254);
    const p = new Uint8Array(9);
    const pv = new DataView(p.buffer);
    pv.setUint32(0, ppm);
    pv.setUint32(4, ppm);
    p[8] = 1;
    parts.push(chunk("pHYs", p));
  }
  parts.push(chunk("IDAT", zlibSync(raw, { level: (o.level ?? 6) as 6 })), chunk("IEND", new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface DecodedPng extends PngImage {
  bits: number;
  /** pHYs in dpi, when present. */
  dpi: number | null;
}

/** Decode a non-interlaced PNG (greyscale 1/8-bit, RGB, RGBA). Expands 1-bit to 0 / 255. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let w = 0;
  let h = 0;
  let bits = 8;
  let type = 0;
  let dpi: number | null = null;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const len = v.getUint32(at);
    const t = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const d = bytes.subarray(at + 8, at + 8 + len);
    if (t === "IHDR") {
      w = v.getUint32(at + 8);
      h = v.getUint32(at + 12);
      bits = d[8]!;
      type = d[9]!;
    } else if (t === "pHYs" && d[8] === 1) dpi = Math.round(new DataView(d.buffer, d.byteOffset).getUint32(0) * 0.0254);
    else if (t === "IDAT") idat.push(d);
    else if (t === "IEND") break;
    at += 12 + len;
  }
  const z = new Uint8Array(idat.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of idat) {
    z.set(p, o);
    o += p.length;
  }
  const raw = unzlibSync(z);
  const channels = (type === 0 ? 1 : type === 2 ? 3 : type === 6 ? 4 : type === 4 ? 2 : 1) as 1 | 3 | 4;
  const bpp = Math.max(1, (channels * bits) >> 3);
  const stride = Math.ceil((w * channels * bits) / 8);
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let x = row[i]!;
      if (f === 1) x += a;
      else if (f === 2) x += b;
      else if (f === 3) x += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = x & 255;
    }
    if (bits === 1) for (let x = 0; x < w; x++) out[y * w + x] = cur[x >> 3]! & (0x80 >> (x & 7)) ? 255 : 0;
    else out.set(cur.subarray(0, w * channels), y * w * channels);
    prev.set(cur);
  }
  return { width: w, height: h, channels, data: out, bits, dpi };
}
