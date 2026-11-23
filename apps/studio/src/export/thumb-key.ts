/**
 * Cache keys for rendered thumbnails: a hash of the exact design rendered (key order doesn't matter),
 * the output size and a version string (renderer revision, engine build, asset pack, thumbnail
 * format), so any change to what a thumbnail would look like gives it a new key. Pure.
 */

/** JSON with object keys sorted at every level (`undefined` members dropped, like JSON.stringify). */
export function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown): string => {
    if (v === null || typeof v !== "object") {
      const s = JSON.stringify(v);
      return s === undefined ? "null" : s; // functions/undefined in arrays → null, as JSON does
    }
    if (seen.has(v)) throw new TypeError("stableStringify: circular structure");
    seen.add(v);
    try {
      const withJson = v as { toJSON?: () => unknown };
      if (typeof withJson.toJSON === "function") return walk(withJson.toJSON());
      if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
      const rec = v as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(rec).sort()) {
        const x = rec[k];
        if (x === undefined || typeof x === "function" || typeof x === "symbol") continue;
        parts.push(`${JSON.stringify(k)}:${walk(x)}`);
      }
      return `{${parts.join(",")}}`;
    } finally {
      seen.delete(v);
    }
  };
  return walk(value);
}

/**
 * 64-bit-ish string hash (cyrb53 by bryc, public domain): two 32-bit lanes mixed with Math.imul,
 * returned as 14 hex digits. Not cryptographic; collisions are negligible at thumbnail-cache scale.
 */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

export interface ThumbKeyParts {
  design: unknown;
  width: number;
  height: number;
  /** Renderer/app version string (see `thumbVersion`). */
  version: string;
}

/** `t1-<hash>`: what the thumbnail cache is keyed by. */
export function thumbCacheKey({ design, width, height, version }: ThumbKeyParts): string {
  return `t1-${hashString(`${version}\n${width}x${height}\n${stableStringify(design)}`)}`;
}

/** The version part of the key: everything outside the design that changes a thumbnail's pixels. */
export function thumbVersion(parts: { renderer: string | number; build: string; assets: string; format?: number }): string {
  return `r${parts.renderer}|b${parts.build}|a${parts.assets}|f${parts.format ?? 1}`;
}
