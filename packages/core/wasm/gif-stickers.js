// Animated GIF stickers for the Rust engine (the page side of card/gif-decal.ts):
// frames decoded with WebCodecs' ImageDecoder where available, else sampled from a hidden,
// browser-animated <img>; each drawn with its die-cut border and sent to the engine as ImageData.

/** `^data:image/gif[;,]` or a `.gif` path before `?`, `#` or end (case-insensitive). */
export const isGifSource = (src) => typeof src === "string" && (/^data:image\/gif[;,]/i.test(src) || /\.gif(?:[?#]|$)/i.test(src));

const MAX_SIDE = 720;
const BORDER_COLOR = "#f4f1e7";
const TAPS = 32;
const MIN_FRAME_MS = 1000 / 30;
const clampMs = (ms) => Math.min(10000, Math.max(MIN_FRAME_MS, ms));

function canvas2d(w, h) {
  const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  return [c, c.getContext("2d", { willReadFrequently: true })];
}

/**
 * Steps 1–7 of `drawFrame`: scale to ≤ 720, pad, 32-tap cream dilation of the silhouette, frame on top.
 * One per GIF: its canvases are reused from frame to frame (a GIF's frames share a size).
 */
function framer() {
  let size = "";
  let sa, a, sb, b, o;
  return (frame, w, h) => {
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    const iw = Math.max(1, Math.round(w * k));
    const ih = Math.max(1, Math.round(h * k));
    const p = Math.max(7, Math.round(0.035 * Math.max(iw, ih)));
    if (size !== `${iw}x${ih}`) {
      size = `${iw}x${ih}`;
      [sa, a] = canvas2d(iw, ih);
      [sb, b] = canvas2d(iw, ih);
      [, o] = canvas2d(iw + 2 * p, ih + 2 * p);
      a.imageSmoothingEnabled = true;
      a.imageSmoothingQuality = "high";
      b.fillStyle = BORDER_COLOR;
    } else {
      a.clearRect(0, 0, iw, ih);
      b.clearRect(0, 0, iw, ih);
      o.clearRect(0, 0, iw + 2 * p, ih + 2 * p);
    }
    a.drawImage(frame, 0, 0, iw, ih);
    b.globalCompositeOperation = "source-over";
    b.drawImage(sa, 0, 0);
    b.globalCompositeOperation = "source-in";
    b.fillRect(0, 0, iw, ih);
    const rho = 0.72 * p;
    for (let j = 0; j < TAPS; j++) {
      const phi = (2 * Math.PI * j) / TAPS;
      o.drawImage(sb, p + rho * Math.cos(phi), p + rho * Math.sin(phi));
    }
    o.drawImage(sa, p, p);
    return o.getImageData(0, 0, iw + 2 * p, ih + 2 * p);
  };
}

/**
 * GIFs playing on the page by URL: cards showing the same GIF share one decoder (a page-wide
 * registry, so separately bundled copies of this loader share it too).
 */
const playing = (globalThis[Symbol.for("card3d.gif-stickers")] ??= new Map());

/**
 * Decodes `url` for its subscribers (`playGif`): each frame goes to all of them. It runs while any of
 * them is unpaused (the first frame is always sent), and stops when the last one leaves.
 */
function gifSource(url) {
  const subs = new Set();
  let stopped = false;
  let timer = 0;
  let raf = 0;
  let decoder = null;
  let img = null;
  /** The next frame's step, while paused. */
  let pending = null;
  let last = null;
  let failed = false;
  const Decoder = globalThis.ImageDecoder;
  const border = framer();
  const running = () => [...subs].some((s) => !s.paused);
  const send = (frame) => {
    last = frame;
    for (const s of subs) s.frame(frame);
  };
  /** Runs `next` now, or once a subscriber resumes. */
  const later = (next) => {
    if (running()) next();
    else pending = next;
  };

  const viaDecoder = async () => {
    const data = await (await fetch(url)).arrayBuffer();
    if (stopped) return;
    decoder = new Decoder({ data, type: "image/gif", preferAnimation: true });
    await decoder.tracks.ready;
    const count = decoder.tracks.selectedTrack?.frameCount ?? 1;
    let index = 0;
    const step = async () => {
      if (stopped || !decoder) return;
      const { image } = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
      if (stopped) return image.close();
      send(border(image, image.displayWidth, image.displayHeight));
      const ms = clampMs((image.duration ?? 100000) / 1000);
      image.close();
      if (count === 1) return;
      index = (index + 1) % count;
      timer = setTimeout(() => later(() => void step().catch(fail)), ms);
    };
    await step();
  };

  const viaImage = async () => {
    img = document.createElement("img");
    img.crossOrigin = "anonymous";
    Object.assign(img.style, { position: "fixed", left: "0", bottom: "0", width: "1px", height: "1px", opacity: "0.001", pointerEvents: "none", zIndex: "-1" });
    img.src = url;
    document.body.appendChild(img);
    await img.decode();
    let at = -Infinity;
    const loop = (t) => {
      if (stopped || !img) return;
      if (t - at >= MIN_FRAME_MS) {
        at = t;
        send(border(img, img.naturalWidth, img.naturalHeight));
      }
      if (running()) raf = requestAnimationFrame(loop);
      else pending = () => (raf = requestAnimationFrame(loop));
    };
    raf = requestAnimationFrame(loop);
  };

  const fail = (err) => {
    if (stopped) return;
    console.warn("[card3d] animated sticker failed", err);
    failed = true;
    for (const s of subs) s.gaveUp();
  };

  void (async () => {
    if (Decoder && (await Decoder.isTypeSupported("image/gif").catch(() => false))) return viaDecoder();
    if (typeof document !== "undefined") return viaImage();
    throw new Error("no GIF decoding available");
  })().catch(fail);

  return {
    subscribe(sub) {
      subs.add(sub);
      if (last) sub.frame(last);
      else if (failed) sub.gaveUp();
    },
    unsubscribe(sub) {
      subs.delete(sub);
      if (subs.size) return;
      stopped = true;
      playing.delete(url);
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      decoder?.close();
      img?.remove();
    },
    /** A subscriber resumed. */
    wake() {
      const next = pending;
      pending = null;
      next?.();
    },
  };
}

/**
 * Plays one GIF: calls `onFrame(imageData)` with each bordered frame until `stop()`; `pause()` holds
 * the current frame (after the first) and `resume()` goes on. Never throws (a GIF that can't be
 * decoded warns once and draws nothing, as the three.js engine does). `firstFrame` settles after the
 * first frame was sent, or once decoding gave up (`GifDecalSource.firstFrame`).
 */
export function playGif(url, onFrame) {
  let first;
  const firstFrame = new Promise((r) => (first = r));
  const source = playing.get(url) ?? playing.set(url, gifSource(url)).get(url);
  const sub = {
    paused: false,
    frame(f) {
      onFrame(f);
      first();
    },
    gaveUp: () => first(),
  };
  source.subscribe(sub);
  return {
    firstFrame,
    pause() {
      sub.paused = true;
    },
    resume() {
      if (!sub.paused) return;
      sub.paused = false;
      source.wake();
    },
    stop() {
      first();
      source.unsubscribe(sub);
    },
  };
}
