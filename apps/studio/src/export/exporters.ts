/**
 * Exports: stills (PNG/WebP/JPEG), turntable clips (WebM/MP4 via WebCodecs or MediaRecorder, GIF via
 * gifenc), the design JSON and the recipe spec, drawn on an offscreen stage (`offscreen.ts`:
 * the card engine). glTF (.glb) is `gltf.ts`.
 */
import { paintLightingBackdrop, type CardDesign, type LightingPresetId } from "@card3d/core/model";
import { cameraPathPose, cameraPathTime, getCameraPath, type CameraEasing, type CameraPathId } from "@card3d/core/engine";
import { canvasToBlob, downloadBlob, downloadText } from "../ui/dom.ts";
import { toRecipeSpec } from "../state/design.ts";
import { rotationQuaternion, type CaptureStage, type FrameOptions, type Quat } from "./offscreen.ts";

export type ImageFormat = "png" | "webp" | "jpeg";
export type ClipFormat = "webm" | "mp4" | "gif";

const IMAGE_MIME: Record<ImageFormat, string> = { png: "image/png", webp: "image/webp", jpeg: "image/jpeg" };

export interface OutputSettings {
  width: number;
  height: number;
  /** Transparent background (PNG/WebP only); otherwise filled with `background`. */
  transparent: boolean;
  background: string;
  /** Fill with this lighting preset's backdrop gradient instead of the flat `background`. */
  backdrop?: LightingPresetId | null;
}

export const SIZE_PRESETS: Record<string, [number, number]> = {
  "Card 3:2 · 1800×1200": [1800, 1200],
  "Square · 1080×1080": [1080, 1080],
  "Landscape · 1920×1080": [1920, 1080],
  "Social card · 1200×630": [1200, 630],
  "Portrait · 1080×1350": [1080, 1350],
  "Large · 3000×2000": [3000, 2000],
};

/** Paint the output background: the lighting backdrop gradient, or the flat colour. */
function paintBackground(ctx: CanvasRenderingContext2D, w: number, h: number, out: Pick<OutputSettings, "background" | "backdrop">): void {
  if (out.backdrop) paintLightingBackdrop(ctx, w, h, out.backdrop);
  else {
    ctx.fillStyle = out.background;
    ctx.fillRect(0, 0, w, h);
  }
}

/** Copy the stage canvas onto a 2D canvas, optionally over the background. */
function composite(src: HTMLCanvasElement, w: number, h: number, fill: Pick<OutputSettings, "background" | "backdrop"> | null): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  if (fill) paintBackground(ctx, w, h, fill);
  ctx.drawImage(src, 0, 0, w, h);
  return out;
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
export const fileBase = (d: CardDesign) =>
  (d.cardholderName || "card")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "card";

export async function exportImage(
  off: CaptureStage,
  design: CardDesign,
  quaternion: Quat,
  out: OutputSettings,
  format: ImageFormat,
  quality = 0.92,
): Promise<void> {
  await off.setDesign(design);
  const src = off.frame({ width: out.width, height: out.height, quaternion });
  const keepAlpha = out.transparent && format !== "jpeg";
  const canvas = composite(src, out.width, out.height, keepAlpha ? null : out);
  const blob = await canvasToBlob(canvas, IMAGE_MIME[format], format === "png" ? undefined : quality);
  downloadBlob(blob, `${fileBase(design)}-${out.width}x${out.height}.${format === "jpeg" ? "jpg" : format}`);
}

/**
 * Render a small JPEG/WebP data URL of the design (drafts, thumbnails). `settle`, when given, runs
 * between the draw and the readback (e.g. wait a frame or two) so the readback finds the GPU work done
 * instead of blocking on it; the drawing buffer is preserved and nothing redraws it meanwhile.
 */
export async function renderThumb(off: CaptureStage, design: CardDesign, w = 240, h = 150, key?: unknown, settle?: () => Promise<void>): Promise<string> {
  await off.setDesign(design, key);
  const src = off.frame({ width: w, height: h, quaternion: rotationQuaternion(-6, -16), margin: 1.04 });
  if (settle) await settle();
  const c = composite(src, w, h, null);
  const webp = c.toDataURL("image/webp", 0.82);
  return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/png");
}

// ── turntable clips ──────────────────────────────────────────────────────────

export interface ClipOptions {
  format: ClipFormat;
  seconds: number;
  /** Camera path (default "spin", the turntable) and its easing (default: the path's own). */
  path?: CameraPathId;
  easing?: CameraEasing;
  /** Frames per second (video); GIF uses min(fps, 25). */
  fps: number;
  /** Starting pose (degrees) — the spin adds 360° of yaw. */
  pitch: number;
  yaw: number;
  onProgress?(p: number): void;
  signal?: AbortSignal;
  /** Advance the card's clocks this many seconds before the first frame (match the live preview). */
  prime?: number;
}

/** Whether the browser can make this video: WebCodecs (exact frame times) or, failing that, MediaRecorder. */
export function canRecord(format: "webm" | "mp4"): boolean {
  if (typeof VideoEncoder !== "undefined") return true;
  if (typeof MediaRecorder === "undefined") return false;
  return pickVideoMime(format) !== null;
}

function pickVideoMime(format: "webm" | "mp4"): string | null {
  const candidates =
    format === "mp4"
      ? ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1", "video/mp4"]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

/**
 * Frame `i` of `frames` on the clip's camera path: the card's pose and the camera orbit. A function of
 * the frame index only, so a clip is the same every time (animated cards step 1/fps per frame).
 */
function clipFrame(o: Pick<ClipOptions, "path" | "easing" | "pitch" | "yaw">, i: number, frames: number): Pick<FrameOptions, "quaternion" | "orbit" | "lift"> {
  const path = o.path ?? "spin";
  const pose = cameraPathPose(path, cameraPathTime(path, i, frames), { easing: o.easing, pitch: o.pitch, yaw: o.yaw });
  return {
    quaternion: rotationQuaternion(pose.card.pitch, pose.card.yaw, pose.card.roll),
    orbit: pose.camera,
    lift: pose.card.lift,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The longest cross-fade at a looping clip's seam, seconds (at most a third of the clip). */
const LOOP_SEAM_SECONDS = 0.5;

/**
 * Frames of cross-fade at the seam of a clip on a looping path: the card's clocks (shader time, a
 * spinning record, growing vines) run on regardless of the path, so a looping clip of an animated card
 * would jump back at the seam. 0 for paths that don't loop and for still cards (their frames are a
 * function of the pose alone, which already loops).
 */
export function loopSeamFrames(path: CameraPathId, animated: boolean, frames: number, fps: number): number {
  if (!animated || !getCameraPath(path).loop || frames < 6) return 0;
  return Math.max(1, Math.min(Math.round(LOOP_SEAM_SECONDS * fps), Math.floor(frames / 3)));
}

/**
 * Weight of the seam frame `j` (0…m − 1) blended over the clip's last m frames. Rises from 1/(m+1) to
 * m/(m+1), so the frame after the last (the first, looping) is the seam's continuation at weight 1.
 */
export function loopSeamWeight(j: number, m: number): number {
  return (j + 1) / (m + 1);
}

/**
 * Render a clip's frames in order, each the card alone (transparent) at `w` × `h`, and hand them to
 * `emit`. Animations step exactly 1/fps per frame. On a looping path an animated card's last frames
 * are cross-faded (premultiplied, so alpha stays exact) into the frames that precede its first: the
 * clock runs m frames ahead first (those frames kept), and frame i of the clip is at clock (m + i)/fps,
 * so the seam frames, at clock j/fps, are exactly one clip length behind the frames they blend into,
 * and the clip ends where it begins.
 */
async function renderClip(
  off: CaptureStage,
  o: ClipOptions,
  w: number,
  h: number,
  fps: number,
  emit: (frame: HTMLCanvasElement, i: number, frames: number) => Promise<void> | void,
): Promise<void> {
  const frames = Math.max(1, Math.round(o.seconds * fps));
  const path = o.path ?? "spin";
  const m = loopSeamFrames(path, off.animated, frames, fps);
  const step = (i: number, first: boolean) => off.frame({ width: w, height: h, ...clipFrame(o, i, frames), fit: "turntable", dt: first ? 0 : 1 / fps });
  const aborted = () => {
    if (o.signal?.aborted) throw new DOMException("Recording cancelled", "AbortError");
  };
  // The seam frames: the clock's first m steps, posed as the clip's last m frames.
  const seam: ImageBitmap[] = [];
  const mix = document.createElement("canvas");
  mix.width = w;
  mix.height = h;
  const mctx = mix.getContext("2d")!;
  try {
    for (let j = 0; j < m; j++) {
      aborted();
      seam.push(await createImageBitmap(step(frames - m + j, j === 0)));
    }
    for (let i = 0; i < frames; i++) {
      aborted();
      const src = step(i, i === 0 && m === 0);
      const j = i - (frames - m);
      if (j < 0) {
        await emit(src, i, frames);
        continue;
      }
      // (1 − k)·this frame + k·seam frame, premultiplied: two draws, the second added.
      const k = loopSeamWeight(j, m);
      mctx.globalCompositeOperation = "source-over";
      mctx.clearRect(0, 0, w, h);
      mctx.globalAlpha = 1 - k;
      mctx.drawImage(src, 0, 0, w, h);
      mctx.globalCompositeOperation = "lighter";
      mctx.globalAlpha = k;
      mctx.drawImage(seam[j]!, 0, 0, w, h);
      mctx.globalAlpha = 1;
      mctx.globalCompositeOperation = "source-over";
      await emit(mix, i, frames);
    }
  } finally {
    for (const b of seam) b.close();
  }
}

export async function exportClip(off: CaptureStage, design: CardDesign, out: OutputSettings, o: ClipOptions): Promise<void> {
  // Always a fresh build: the card's clocks (shader time, vines) start from zero for every clip.
  await off.setDesign(design, null);
  if (o.prime) {
    off.frame({ width: 64, height: 64, ...clipFrame(o, 0, 2), fit: "turntable" });
    off.prime(o.prime);
  }
  if (o.format === "gif") return exportGif(off, design, out, o);

  // Video has no alpha: render over the background colour into a 2D canvas we encode from.
  const w = out.width - (out.width % 2);
  const h = out.height - (out.height % 2);
  const sink = document.createElement("canvas");
  sink.width = w;
  sink.height = h;
  sink.className = "c3-offscreen";
  document.body.append(sink);
  const ctx = sink.getContext("2d")!;
  const paint = (src: HTMLCanvasElement) => {
    paintBackground(ctx, w, h, out);
    ctx.drawImage(src, 0, 0, w, h);
  };
  const bitrate = Math.min(24_000_000, w * h * o.fps * 0.15);
  try {
    const encoded = (await encodeWithWebCodecs(off, o, sink, paint, bitrate)) ?? (await encodeWithRecorder(off, o, sink, paint, bitrate));
    if (o.signal?.aborted || !encoded) return;
    downloadBlob(encoded, `${fileBase(design)}-${o.path && o.path !== "spin" ? o.path : "turntable"}.${o.format}`);
  } finally {
    sink.remove();
  }
}

/**
 * Encode with WebCodecs (`video-encode.ts`, loaded on demand): every frame gets an exact timestamp,
 * i / fps, however long it took to render, so a loop's frames are evenly spaced. Null when the browser
 * has no encoder for the container (the caller falls back to MediaRecorder).
 */
async function encodeWithWebCodecs(
  off: CaptureStage,
  o: ClipOptions,
  sink: HTMLCanvasElement,
  paint: (src: HTMLCanvasElement) => void,
  bitrate: number,
): Promise<Blob | null> {
  if (o.format === "gif" || typeof VideoEncoder === "undefined") return null;
  const { canvasVideo } = await import("./video-encode.ts");
  const video = await canvasVideo(sink, o.format, o.fps, bitrate);
  if (!video) return null;
  try {
    await renderClip(off, o, sink.width, sink.height, o.fps, async (src, i, frames) => {
      paint(src);
      await video.add(i / o.fps, 1 / o.fps);
      o.onProgress?.((i + 1) / frames);
      if (i % 4 === 3) await sleep(0); // keep the page responsive
    });
    return await video.finish();
  } catch (e) {
    await video.cancel();
    throw e;
  }
}

/** The fallback: MediaRecorder on the canvas stream, frames paced in real time (it stamps by the clock). */
async function encodeWithRecorder(
  off: CaptureStage,
  o: ClipOptions,
  sink: HTMLCanvasElement,
  paint: (src: HTMLCanvasElement) => void,
  bitrate: number,
): Promise<Blob | null> {
  if (o.format === "gif") return null;
  const mime = pickVideoMime(o.format);
  if (!mime) throw new Error(`This browser cannot record ${o.format.toUpperCase()}`);
  const stream = sink.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  const dt = 1000 / o.fps;
  rec.start();
  const t0 = performance.now();
  try {
    await renderClip(off, o, sink.width, sink.height, o.fps, async (src, i, frames) => {
      paint(src);
      track.requestFrame();
      o.onProgress?.((i + 1) / frames);
      // MediaRecorder timestamps by wall clock: pace frames in real time, and always yield so the
      // capture track can grab the frame even when rendering is slower than real time.
      await sleep(Math.max(4, t0 + (i + 1) * dt - performance.now()));
    });
  } finally {
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
  }
  return new Blob(chunks, { type: mime.split(";")[0] });
}

const MAX_GIF_EDGE = 720;

async function exportGif(off: CaptureStage, design: CardDesign, out: OutputSettings, o: ClipOptions): Promise<void> {
  const k = Math.min(1, MAX_GIF_EDGE / Math.max(out.width, out.height));
  const w = Math.max(2, Math.round(out.width * k));
  const h = Math.max(2, Math.round(out.height * k));
  const fps = Math.min(o.fps, 25);
  const delay = Math.round(1000 / fps);
  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true })!;
  // The encoder loads with the first GIF export.
  const { GIFEncoder, applyPalette, quantize } = await import("gifenc");
  const gif = GIFEncoder();
  // One shared palette (sampled from a few poses) keeps colours stable frame to frame: no shimmer.
  let palette: number[][] | null = null;
  const transparent = out.transparent;
  await renderClip(off, o, w, h, fps, async (src, i, frames) => {
    ctx.clearRect(0, 0, w, h);
    if (!transparent) {
      paintBackground(ctx, w, h, out);
    }
    ctx.drawImage(src, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    if (!palette || i % 12 === 0) {
      palette = quantize(data, 256, transparent ? { format: "rgba4444", oneBitAlpha: true } : undefined);
    }
    const index = applyPalette(data, palette, transparent ? "rgba4444" : undefined);
    const tIndex = transparent ? palette.findIndex((c) => c[3] === 0) : -1;
    gif.writeFrame(index, w, h, {
      palette,
      delay,
      repeat: 0,
      transparent: tIndex >= 0,
      ...(tIndex >= 0 ? { transparentIndex: tIndex } : {}),
      dispose: transparent ? 2 : -1,
    });
    o.onProgress?.((i + 1) / frames);
    if (i % 3 === 2) await sleep(0); // keep the page responsive
  });
  gif.finish();
  downloadBlob(new Blob([gif.bytes()], { type: "image/gif" }), `${fileBase(design)}-${o.path && o.path !== "spin" ? o.path : "turntable"}.gif`);
}

// ── JSON ─────────────────────────────────────────────────────────────────────

export function exportDesignJson(design: CardDesign): void {
  downloadText(JSON.stringify(design, null, 2), `${fileBase(design)}-${stamp()}.card.json`, "application/json");
}

export function exportSpecJson(design: CardDesign): void {
  downloadText(JSON.stringify(toRecipeSpec(design), null, 2), `${fileBase(design)}-recipe.json`, "application/json");
}
