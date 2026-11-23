/**
 * Share tokens: a design (minus inline uploads) as gzipped JSON in base64url, the `#d=…` hash of a
 * Card Studio share link (the wave3d scheme). Works in browsers and Node 18+ (CompressionStream).
 */
import type { CardDesign } from "../types.ts";
import { ensureDesign, stripEmbeddedMedia } from "./design.ts";

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const gzip = (bytes: BlobPart) => new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")));
const gunzip = (bytes: BlobPart) => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")));

/** The share token of a design. Inline uploads (data:/blob: artwork and stickers) are left out; `stripped` counts them. */
export async function encodeDesignToken(design: CardDesign): Promise<{ token: string; stripped: number }> {
  const { design: lean, stripped } = stripEmbeddedMedia(design);
  const gz = await gzip(JSON.stringify(lean)).arrayBuffer();
  return { token: bytesToB64url(new Uint8Array(gz)), stripped };
}

/**
 * The token in a share link, a location hash (`#d=…`, `d=…`) or a bare token; null when there is
 * none. Whitespace is ignored, so a token can be wrapped in an HTML attribute.
 */
export function shareToken(input: string): string | null {
  const s = input.replace(/\s+/g, "");
  if (!s) return null;
  const m = s.match(/(?:^|[#&?])d=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
}

/** Decode a share token (or link / hash, see `shareToken`) into a validated design. Throws when it can't be read. */
export async function decodeDesignToken(input: string): Promise<CardDesign> {
  const token = shareToken(input);
  if (!token) throw new Error("No share token found");
  const text = await gunzip(b64urlToBytes(token) as BlobPart).text();
  return ensureDesign(JSON.parse(text));
}
