/**
 * Share links: the design (minus inline uploads) gzipped + base64url into the location hash
 * (`#d=…`), the wave3d scheme.
 */
import type { CardDesign } from "@card3d/core/model";
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

async function encodeDesign(design: CardDesign): Promise<{ token: string; stripped: number }> {
  const { design: lean, stripped } = stripEmbeddedMedia(design);
  const gz = await new Response(new Blob([JSON.stringify(lean)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  return { token: bytesToB64url(new Uint8Array(gz)), stripped };
}

export async function decodeDesignFromHash(hash: string): Promise<CardDesign | null> {
  const m = hash.match(/[#&]d=([^&]+)/);
  if (!m) return null;
  try {
    const bytes = b64urlToBytes(m[1]);
    const text = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return ensureDesign(JSON.parse(text));
  } catch (err) {
    console.warn("[studio] could not decode the shared design", err);
    return null;
  }
}

export const hasSharedDesign = () => /[#&]d=/.test(location.hash);

/** Put the design in the URL and copy it. Returns what happened so the UI can say so. */
export async function copyShareLink(design: CardDesign): Promise<{ copied: boolean; stripped: number; url: string }> {
  const { token, stripped } = await encodeDesign(design);
  history.replaceState(null, "", `${location.pathname}${location.search}#d=${token}`);
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    return { copied: true, stripped, url };
  } catch {
    return { copied: false, stripped, url };
  }
}
