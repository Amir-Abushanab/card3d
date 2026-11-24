/**
 * The sticker library (built-in SVG stickers shipped in /public/stickers plus the user's uploads)
 * and the image processing for uploads: stickers are downscaled to ≤ 768 px, artwork is fitted to
 * the card face (1280×804, the face's 0..1 UV space).
 */
import type { LibrarySticker } from "../state/storage.ts";
import { canEncodeWebp, loadImage, readAsDataUrl } from "../ui/dom.ts";
import { FACE_H, FACE_W } from "../draw/face.ts";

const base = import.meta.env.BASE_URL;

/** Original artwork, drawn for this studio. `aspect` matches each SVG's width/height. */
export const BUILTIN_STICKERS: LibrarySticker[] = [
  ["star", "Star", 1],
  ["heart", "Heart", 512 / 460],
  ["smiley", "Smiley", 1],
  ["bolt", "Bolt", 360 / 512],
  ["sparkle", "Sparkle", 1],
  ["rainbow", "Rainbow", 512 / 300],
  ["planet", "Planet", 512 / 400],
  ["check", "Check badge", 1],
  ["flame", "Flame", 400 / 512],
  ["badge-new", "New badge", 1],
].map(([id, name, aspect]) => ({ id: `builtin-${id}`, name: name as string, src: `${base}stickers/${id}.svg`, aspect: aspect as number, builtin: true }));

const MAX_STICKER = 768;
const MAX_GIF_BYTES = 2_500_000;

function encode(canvas: HTMLCanvasElement): string {
  return canEncodeWebp() ? canvas.toDataURL("image/webp", 0.9) : canvas.toDataURL("image/png");
}

/** Turn an uploaded file into a library sticker (animated GIFs are kept as-is when small enough). */
export async function stickerFromFile(file: File): Promise<LibrarySticker> {
  const src = await readAsDataUrl(file);
  const img = await loadImage(src);
  const w = img.naturalWidth || 512;
  const h = img.naturalHeight || 512;
  const name = file.name.replace(/\.[^.]+$/, "") || "Sticker";
  const id = `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (file.type === "image/gif" && file.size <= MAX_GIF_BYTES) return { id, name, src, aspect: w / h };
  const k = Math.min(1, MAX_STICKER / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { id, name, src: encode(c), aspect: c.width / c.height };
}

export type ArtworkFit = "cover" | "contain" | "stretch";

/** Fit an uploaded image to the card face and encode it (WebP when available, alpha kept). */
export async function artworkFromFile(file: File, fit: ArtworkFit): Promise<string> {
  const img = await loadImage(await readAsDataUrl(file));
  const c = document.createElement("canvas");
  c.width = FACE_W;
  c.height = FACE_H;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  const w = img.naturalWidth || FACE_W;
  const h = img.naturalHeight || FACE_H;
  if (fit === "stretch") {
    ctx.drawImage(img, 0, 0, FACE_W, FACE_H);
  } else {
    const k = fit === "cover" ? Math.max(FACE_W / w, FACE_H / h) : Math.min(FACE_W / w, FACE_H / h);
    const dw = w * k;
    const dh = h * k;
    ctx.drawImage(img, (FACE_W - dw) / 2, (FACE_H - dh) / 2, dw, dh);
  }
  return encode(c);
}
