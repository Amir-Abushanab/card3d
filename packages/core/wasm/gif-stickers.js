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

/** Steps 1–7 of `drawFrame`: scale to ≤ 720, pad, 32-tap cream dilation of the silhouette, frame on top. */
function borderedFrame(frame, w, h) {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const iw = Math.max(1, Math.round(w * k));
  const ih = Math.max(1, Math.round(h * k));
  const p = Math.max(7, Math.round(0.035 * Math.max(iw, ih)));
  const [sa, a] = canvas2d(iw, ih);
  a.imageSmoothingEnabled = true;
  a.imageSmoothingQuality = "high";
  a.drawImage(frame, 0, 0, iw, ih);
  const [sb, b] = canvas2d(iw, ih);
  b.drawImage(sa, 0, 0);
  b.globalCompositeOperation = "source-in";
  b.fillStyle = BORDER_COLOR;
  b.fillRect(0, 0, iw, ih);
  const [, o] = canvas2d(iw + 2 * p, ih + 2 * p);
  const rho = 0.72 * p;
  for (let j = 0; j < TAPS; j++) {
    const phi = (2 * Math.PI * j) / TAPS;
    o.drawImage(sb, p + rho * Math.cos(phi), p + rho * Math.sin(phi));
  }
  o.drawImage(sa, p, p);
  return o.getImageData(0, 0, iw + 2 * p, ih + 2 * p);
}

/**
 * Plays one GIF: calls `onFrame(imageData)` with each bordered frame until `stop()`. Never throws (a
 * GIF that can't be decoded warns once and draws nothing, as the three.js engine does). `firstFrame`
 * settles after the first frame was sent, or once decoding gave up (`GifDecalSource.firstFrame`).
 */
export function playGif(url, onFrame) {
  let first;
  const firstFrame = new Promise((r) => (first = r));
  const send = (frame) => {
    onFrame(frame);
    first();
  };
  let stopped = false;
  let timer = 0;
  let raf = 0;
  let decoder = null;
  let img = null;
  const Decoder = globalThis.ImageDecoder;

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
      send(borderedFrame(image, image.displayWidth, image.displayHeight));
      const ms = clampMs((image.duration ?? 100000) / 1000);
      image.close();
      if (count === 1) return;
      index = (index + 1) % count;
      timer = setTimeout(() => void step().catch(fail), ms);
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
    let last = -Infinity;
    const loop = (t) => {
      if (stopped || !img) return;
      if (t - last >= MIN_FRAME_MS) {
        last = t;
        send(borderedFrame(img, img.naturalWidth, img.naturalHeight));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  };

  const fail = (err) => {
    if (!stopped) console.warn("[card3d] animated sticker failed", err);
    first();
  };

  void (async () => {
    if (Decoder && (await Decoder.isTypeSupported("image/gif").catch(() => false))) return viaDecoder();
    if (typeof document !== "undefined") return viaImage();
    throw new Error("no GIF decoding available");
  })().catch(fail);

  return {
    firstFrame,
    stop() {
      stopped = true;
      first();
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      decoder?.close();
      img?.remove();
    },
  };
}
