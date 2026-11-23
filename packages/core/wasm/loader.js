// Starts the card engine on a canvas with the best build that works, falling back to WebGL 2 when WebGPU
// can't be trusted:
//
// - no WebGPU, or no adapter: the WebGL build (wasm/pkg-webgl, ~750 KB gzipped, so only those
//   browsers download it);
// - WebGPU starts but fails (the device, a pipeline, or a panic while building the card), or later
//   loses its device or reports an error: the card moves to the WebGL build on a fresh canvas (a
//   canvas that has had a WebGPU context can't get a WebGL one);
// - the tab crashes while WebGPU starts (reported for some iOS 26 devices): JavaScript can't catch
//   that, so a "starting" mark is kept in localStorage while WebGPU starts. It is cleared 2 s after
//   the first frame, and also whenever the page is hidden or left normally (`pagehide`,
//   `visibilitychange`), which a crashed tab never gets to do; it is set again if the page comes back
//   before the start was confirmed. A load that finds the mark goes straight to WebGL, and so does
//   every load for a week after a WebGPU failure.
//
//   const card = await createCard(canvas, designJson, { onCanvas, onFallback, resolveUrl, fontFamily, stage });
//   (`stage`: the engine's stage options { quality, fit, interactive, intro, reducedMotion,
//   fitToViewport, defaultRotation }; `fontFamily`: the family a custom design font loaded under, from
//   core's `loadDesignFont`; `onCanvas`: the canvas was swapped, move listeners and sizing to it;
//   `onFallback`: the WebGL card is ready, draw a frame; `environmentUrl(env)`: the URL a scene's
//   environment id loads from, or a promise of it, null for none: core's catalog, which only the page
//   side knows; without it only `.hdr` / `.webp` URLs load; `assets`: the asset provider's
//   { nameFontFamily }.) A lost device is noticed within a second even when nothing draws.
//   card.advance(now) → flags (1 animating, 2 rotation changed, 4 flipped changed); card.render();
//   card.resize(w, h); card.setDesign(json, { fontFamily }); card.setRotation(x, y, z); card.setLift(y);
//   card.setCameraOrbit(azimuth, elevation, distance) (degrees; camera paths); card.setCameraDistance(z)
//   (the page frames the card itself: exports);
//   card.stage (the current CardStage: input, flip, reset, fit, quality; read it each time, a fall-over
//   replaces it); card.backend; card.canvas
//
// `force: "webgpu" | "webgl"` picks a build and skips the stored choice.
//
// The engine downloads in parts: a main module, then each lazily loaded feature the design uses
// (shaped bodies, holo foils, stickers, …). A part that can't be downloaded is a network problem, not
// a WebGPU one: `createCard` retries once and then rejects with an Error named "Card3dLoadError",
// without falling back or recording anything against WebGPU.

import { isGifSource, playGif } from "./gif-stickers.js";

const KEY = "card3d:webgpu";
const FAILED_FOR_MS = 7 * 24 * 3600 * 1000;
/** How long after its first frame a WebGPU start counts as good. */
export const GOOD_MS = 2000;

function store() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function mark(state) {
  try {
    const s = store();
    if (state) s?.setItem(KEY, `${state}:${Date.now()}`);
    else s?.removeItem(KEY);
  } catch {
    /* storage blocked: no memory between loads */
  }
}

/** Whether an earlier load showed WebGPU to be unsafe here. */
export function webgpuDistrusted() {
  let v = null;
  try {
    v = store()?.getItem(KEY) ?? null;
  } catch {
    return false;
  }
  if (!v) return false;
  const [state, at] = v.split(":");
  if (state === "starting") {
    // The last start never finished: the tab most likely crashed.
    mark("failed");
    return true;
  }
  return state === "failed" && Date.now() - Number(at) < FAILED_FOR_MS;
}

/** How long to wait for a WebGPU adapter before starting on WebGL instead (ms). */
const ADAPTER_TIMEOUT_MS = 5000;

export async function webgpuAvailable() {
  if (!navigator.gpu) return false;
  try {
    // A request that never settles (seen with software GPUs under load) must not keep the card from
    // starting: after a while it counts as no adapter.
    let timer = 0;
    const timeout = new Promise((r) => (timer = setTimeout(() => r(null), ADAPTER_TIMEOUT_MS)));
    const adapter = await Promise.race([navigator.gpu.requestAdapter(), timeout]);
    clearTimeout(timer);
    return !!adapter;
  } catch {
    return false;
  }
}

const modules = {};
/** One build's module, initialised once. */
export async function loadEngine(backend) {
  if (!modules[backend]) {
    modules[backend] = (async () => {
      try {
        // Literal paths, so bundlers emit each build (and its wasm) as chunks and assets.
        const mod = await (backend === "webgpu" ? import("./pkg/card3d_web.js") : import("./pkg-webgl/card3d_web.js"));
        await mod.default();
        return mod;
      } catch (e) {
        delete modules[backend]; // let a later call try again
        throw loadError(`couldn't download the card engine: ${e?.message ?? e}`);
      }
    })();
  }
  return modules[backend];
}

/**
 * `CardStage.call` operations (crates/card3d-web/src/lib.rs, `op`): the binding takes numbers through
 * one export, and `cardStage` gives the page its methods back by name.
 */
export const OP = {
  RESIZE: 0,
  RENDER: 1,
  POLL: 2,
  SIMULATE_DEVICE_LOSS: 3,
  ADVANCE: 4,
  SET_ROTATION: 5,
  SET_POINTER: 6,
  WHEEL: 7,
  SET_LIFT: 8,
  SET_CAMERA_ORBIT: 9,
  SET_CAMERA_DISTANCE: 10,
  HAS_CARD: 11,
  POINTER_DOWN: 12,
  POINTER_MOVE: 13,
  POINTER_UP: 14,
  POINTER_CANCEL: 15,
  DOUBLE_CLICK: 16,
  KEY: 17,
  TOGGLE_FLIP: 18,
  SET_FLIPPED: 19,
  RESET: 20,
  RESTORE_POSE: 21,
  SET_ACTIVE: 22,
  SET_VISIBLE: 23,
  SET_REDUCED_MOTION: 24,
  FLIPPED: 25,
  ROTATION_X: 26,
  ROTATION_Y: 27,
  INTRO_STATE: 28,
  SET_QUALITY: 29,
  SET_FIT: 30,
  SET_INTERACTION_ROTATION: 31,
};
/** `CardStage.build` kinds. */
export const BUILD = { DESIGN: 0, SLOT: 1, PRINT: 2, AR: 3, CHECK: 4 };
/** `CardStage.mcall` operations on a card's stage (`vop`). */
const VOP = { VIEW: 0, STICKER: 1 };
const INTRO_STATES = ["running", "skipped", "complete", "interrupting", "interrupted", "reset"];
/** The keys the card handles (`CardInteraction::key`): reset, flip. */
const KEYS = { Home: 1, Escape: 1, Enter: 2, " ": 2 };

/** A stage's options as `CardStage.create` takes them (numbers; NaN for the engine's default). */
function stageArgs(o) {
  const n = (v) => (v === undefined ? NaN : Number(v));
  const of = (v, names) => (names.includes(v) ? names.indexOf(v) : NaN);
  return [
    of(o.quality, ["performance", "full"]),
    of(o.fit, ["studio", "contain"]),
    n(o.interactive),
    n(o.intro),
    n(o.reducedMotion),
    n(o.fitToViewport),
    n(o.defaultRotation?.x),
    n(o.defaultRotation?.y),
  ];
}

/** The page's view of a wasm `CardStage` (a card's stage): its operations by name (`WasmCardStage`). */
export function cardStage(raw) {
  const c = (op, ...a) => raw.call(op, ...a);
  const run =
    (op) =>
    (...a) =>
      void c(op, ...a);
  const yes =
    (op) =>
    (...a) =>
      c(op, ...a) === 1;
  const num = (op) => () => c(op) || 0;
  return {
    setDesign: (design, images, fontFamily) => raw.build(BUILD.DESIGN, design, images, fontFamily, 0, 0),
    build: (kind, design, images, fontFamily, a = 0, b = 0) => raw.build(kind, design, images, fontFamily, a, b),
    setQuality: (q) => void c(OP.SET_QUALITY, ["performance", "full"].indexOf(q)),
    setFit: (f) => void c(OP.SET_FIT, ["studio", "contain"].indexOf(f)),
    resize: run(OP.RESIZE),
    advance: (now) => c(OP.ADVANCE, now),
    render: run(OP.RENDER),
    poll: run(OP.POLL),
    setRotation: run(OP.SET_ROTATION),
    setLift: run(OP.SET_LIFT),
    setCameraOrbit: run(OP.SET_CAMERA_ORBIT),
    setCameraDistance: run(OP.SET_CAMERA_DISTANCE),
    setPointer: run(OP.SET_POINTER),
    wheel: run(OP.WHEEL),
    hasCard: yes(OP.HAS_CARD),
    shaderErrors: () => raw.text(1) ?? "[]",
    checkShader: (code) => raw.build(BUILD.CHECK, code, undefined, undefined, 0, 0),
    view: () => raw.mcall(VOP.VIEW, new Float64Array(0)),
    sticker: (decal, values) => raw.mcall(VOP.STICKER, Float64Array.from([decal, ...(values ?? [])])),
    setStickerFrame: (decal, frame) => raw.setStickerFrame(decal, frame),
    pointerDown: yes(OP.POINTER_DOWN),
    pointerMove: yes(OP.POINTER_MOVE),
    pointerUp: run(OP.POINTER_UP),
    pointerCancel: run(OP.POINTER_CANCEL),
    doubleClick: run(OP.DOUBLE_CLICK),
    key: (key, now) => (KEYS[key] ? c(OP.KEY, KEYS[key], now) === 1 : false),
    toggleFlip: run(OP.TOGGLE_FLIP),
    setFlipped: run(OP.SET_FLIPPED),
    reset: run(OP.RESET),
    restorePose: run(OP.RESTORE_POSE),
    setInteractionRotation: run(OP.SET_INTERACTION_ROTATION),
    setActive: run(OP.SET_ACTIVE),
    setVisible: run(OP.SET_VISIBLE),
    setReducedMotion: run(OP.SET_REDUCED_MOTION),
    flipped: yes(OP.FLIPPED),
    rotationX: num(OP.ROTATION_X),
    rotationY: num(OP.ROTATION_Y),
    introState: () => INTRO_STATES[c(OP.INTRO_STATE)],
    failure: () => raw.text(0),
    simulateDeviceLoss: run(OP.SIMULATE_DEVICE_LOSS),
    free: () => raw.free(),
  };
}

export function loadError(message) {
  const e = new Error(message);
  e.name = "Card3dLoadError";
  return e;
}
export const isLoadError = (e) => e?.name === "Card3dLoadError";

/**
 * A `CardStage` on `canvas` showing `design` (`current`: { design, images, fontFamily }), with the slot
 * pose replayed; retried once (after a second) when a part of the engine didn't download.
 */
async function createStage(backend, canvas, options, current, slot, pose = null) {
  for (let attempt = 0; ; attempt++) {
    try {
      const engine = await loadEngine(backend);
      const stage = cardStage(await engine.CardStage.create(canvas, false, stageArgs(options), null));
      stage.setRotation(...slot.rotation);
      stage.setLift(slot.lift);
      stage.setCameraOrbit(...slot.orbit);
      stage.setCameraDistance(slot.distance);
      await stage.setDesign(current.design, current.images, current.fontFamily);
      if (pose) stage.restorePose(...pose);
      return stage;
    } catch (e) {
      if (!isLoadError(e) || attempt > 0) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Longest side of a design image handed to the engine (`MAX_DESIGN_IMAGE_SIDE`). */
const MAX_IMAGE_SIDE = 1280;

/**
 * Every image a design uses (key → [src, max side, kind]): artwork (downscaled), stickers and a
 * raster logo (as loaded), and liquid-metal masks (kind "mask": an SVG is rasterised at 4096 px).
 */
function imageSources(design) {
  const out = new Map();
  for (const src of Object.values(design.surfaceSources ?? {})) if (typeof src === "string" && src) out.set(src, [src, MAX_IMAGE_SIDE]);
  // (Animated GIF stickers are decoded frame by frame instead: gif-stickers.js.)
  for (const d of design.decals ?? []) if (typeof d?.src === "string" && d.src && !isGifSource(d.src)) out.set(`full:${d.src}`, [d.src, Infinity]);
  if (typeof design.logo?.src === "string" && design.logo.src && !design.logo.path) out.set(`full:${design.logo.src}`, [design.logo.src, Infinity]);
  // Liquid metal reads its masks at their own size: a layer's artwork (its mask when `mask` is 0, the
  // default).
  const mask = (src) => typeof src === "string" && src && out.set(`mask:${src}`, [src, Infinity, "mask"]);
  for (const l of Array.isArray(design.shaders) ? design.shaders : []) {
    if (l?.id !== "liquid-metal" || l.enabled === false) continue;
    const sides = l.side === "both" ? ["front", "back"] : [l.side === "back" ? "back" : "front"];
    for (const side of sides) mask(design.surfaceSources?.[side]);
  }
  return out;
}

/** Whether a mask `src` is an SVG (`toProcessedLiquidMetal`: by its name or a data URL's type). */
const isSvg = (src) => /\.svg([?#].*)?$/i.test(src) || src.startsWith("data:image/svg+xml");

/** A WebGL 2 context for reading images back as uploaded (see `straightPixels`); one per page. */
let readback = null;

/**
 * An image's pixels exactly as the three.js engine uploads it (`texImage2D` without premultiplying):
 * straight alpha, with the colour of fully transparent pixels kept. A 2D canvas premultiplies, which
 * zeroes that colour; an opaque material that samples such an image would show black where three
 * shows the image's own colour. Null when WebGL 2 isn't available.
 */
function straightPixels(img, w, h) {
  if (typeof OffscreenCanvas === "undefined") return null;
  if (!readback || readback.isContextLost()) readback = new OffscreenCanvas(1, 1).getContext("webgl2");
  const gl = readback;
  if (!gl) return null;
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    const data = new Uint8ClampedArray(4 * w * h);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return gl.getError() === gl.NO_ERROR ? new ImageData(data, w, h) : null;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
  }
}

/** A scene environment's URL when it names a file itself (`environmentUrl` in scene/marketing/). */
const fileEnvironment = (env, resolveUrl) => (/\.(hdr|webp)([?#].*)?$/i.test(env) ? resolveUrl(env) : null);

/**
 * Decoded environments by URL: every card on the page shares one download and decode (a page-wide
 * registry, so separately bundled copies of this loader share it too).
 */
const environments = (globalThis[Symbol.for("card3d.environment-images")] ??= new Map());

/**
 * A scene environment file as the three.js engine read it (scene/marketing/environment.ts): a `.hdr`
 * file's bytes (the engine decodes them), or a gain-mapped image's pixels, decoded without colour
 * management or premultiplication.
 */
function loadEnvironment(url) {
  let p = environments.get(url);
  if (p) return p;
  p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`environment ${url}: HTTP ${res.status}`);
    if (/\.hdr([?#].*)?$/i.test(url)) return new Uint8Array(await res.arrayBuffer());
    const blob = await res.blob();
    let source;
    try {
      source = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    } catch {
      const objectUrl = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = objectUrl;
        await img.decode();
        source = img;
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }
    const { width, height } = source;
    const canvas =
      typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2D canvas to decode the environment");
    ctx.drawImage(source, 0, 0);
    if ("close" in source) source.close();
    return ctx.getImageData(0, 0, width, height);
  })();
  environments.set(url, p);
  p.catch(() => environments.delete(url));
  return p;
}

/**
 * Loads and decodes a design's images as the three.js engine did (`loadImage`; artwork through
 * `designTexture`: downscaled to ≤ 1280 px with high-quality smoothing). Keys: artwork by `src`,
 * full-size images by `full:` + `src`. A failed image is left out (the engine skips that layer).
 * `resolveUrl` maps a design `src` to a fetchable URL.
 */
export async function loadDesignImages(design, resolveUrl = (s) => s, environmentUrl = null, assets = null) {
  const images = new Map();
  // The provider's name font (`Host::name_font`).
  if (typeof assets?.nameFontFamily === "string" && assets.nameFontFamily) images.set("font:name", assets.nameFontFamily);
  // A scene's environment (key `env:` + its id or URL); a failed one leaves the studio environment.
  const env = design.scene?.environment;
  const environment =
    typeof env === "string" && env && env !== "studio"
      ? (async () => {
          try {
            const url = environmentUrl ? await environmentUrl(env) : fileEnvironment(env, resolveUrl);
            if (url) images.set(`env:${env}`, await loadEnvironment(url));
          } catch (e) {
            console.warn(`[card3d] scene environment ${String(env).slice(0, 80)} failed to load; using the studio environment`, e);
          }
        })()
      : null;
  await Promise.all([
    environment,
    ...[...imageSources(design)].map(async ([key, [src, maxSide, kind]]) => {
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = resolveUrl(src);
        await img.decode();
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (kind === "mask" && isSvg(src)) {
          // `toProcessedLiquidMetal` draws an SVG at 4096 px on its longer side.
          [w, h] = w > h ? [4096, 4096 / (w / h)] : [4096 * (w / h), 4096];
          const c = new OffscreenCanvas(Math.trunc(w), Math.trunc(h));
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          images.set(key, ctx.getImageData(0, 0, c.width, c.height));
          return;
        }
        const k = Math.min(1, maxSide / Math.max(w, h, 1));
        const cw = Math.max(1, Math.round(w * k));
        const ch = Math.max(1, Math.round(h * k));
        // As three: an image that fits is used as decoded; a larger one is downscaled on a canvas.
        const straight = k === 1 ? straightPixels(img, w, h) : null;
        if (straight) {
          images.set(key, straight);
          return;
        }
        const ctx = new OffscreenCanvas(cw, ch).getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, cw, ch);
        images.set(key, ctx.getImageData(0, 0, cw, ch));
      } catch (e) {
        console.warn(`[card3d] image failed to load: ${String(src).slice(0, 80)}`, e);
      }
    }),
  ]);
  return images;
}

/** The interaction's pose ([pitch, yaw, flipped]) of a stage about to be replaced, if it has one. */
function poseOf(stage, options) {
  if (!stage || options.interactive === false) return null;
  try {
    return stage.hasCard() ? [stage.rotationX(), stage.rotationY(), stage.flipped()] : null;
  } catch {
    return null; // a panicked instance
  }
}

/** Swaps `canvas` for a fresh copy (same id, classes, style, size) and returns it. */
export function freshCanvas(canvas) {
  const fresh = canvas.cloneNode(false);
  canvas.replaceWith(fresh);
  return fresh;
}

export async function createCard(
  canvas,
  design,
  {
    force,
    onCanvas,
    onFallback,
    onContextLost,
    onContextRestored,
    onStickerFrame,
    resolveUrl = (s) => s,
    environmentUrl = null,
    assets = null,
    fontFamily,
    stage: options = {},
  } = {},
) {
  /** The design on screen, replayed on a fall-over. */
  let current = { design, images: await loadDesignImages(JSON.parse(design), resolveUrl, environmentUrl, assets), fontFamily };
  const slot = { rotation: [0, 0, 0], lift: 0, orbit: [0, 0, 1], distance: NaN };
  let backend = force ?? (webgpuDistrusted() ? "webgl" : (await webgpuAvailable()) ? "webgpu" : "webgl");
  let stage = null;
  let drawn = false;
  /** The WebGPU start has run 2 s past its first frame without failing. */
  let confirmed = false;
  let switching = null;

  // Animated GIF stickers: the page decodes them and sends each frame to the engine. The last frame of
  // each is kept for a stage that replaces this one (a fall-over, a restored context).
  let players = [];
  let stickersReady = Promise.resolve();
  const lastFrames = new Map();
  const startStickers = () => {
    for (const p of players) p.stop();
    players = [];
    lastFrames.clear();
    let decals = [];
    try {
      decals = JSON.parse(current.design).decals ?? [];
    } catch {
      /* the engine already rejected it */
    }
    decals.forEach((d, i) => {
      if (!isGifSource(d?.src)) return;
      players.push(
        playGif(resolveUrl(d.src), (frame) => {
          lastFrames.set(i, frame);
          if (stage && !switching && !lost) {
            stage.setStickerFrame(i, frame);
            onStickerFrame?.();
          }
        }),
      );
    });
    stickersReady = Promise.all(players.map((p) => p.firstFrame)).then(() => undefined);
  };
  /** A new stage for the current design: show the stickers' last frames. */
  const replayStickers = () => {
    for (const [i, frame] of lastFrames) stage?.setStickerFrame(i, frame);
  };

  let watch = 0;
  const startWebgl = async (why) => {
    clearInterval(watch);
    if (backend === "webgpu") {
      canvas = freshCanvas(canvas);
      onCanvas?.(canvas);
    }
    backend = "webgl";
    const old = stage;
    const pose = poseOf(old, options);
    stage = null;
    try {
      old?.free();
    } catch {
      /* a panicked instance: its memory goes with the page */
    }
    // The card carries on where it was: same pose, no second intro.
    stage = await createStage("webgl", canvas, pose ? { ...options, intro: false } : options, current, slot, pose);
    replayStickers();
    watchContext(canvas);
    if (why) onFallback?.(why);
  };

  // WebGL: a lost context (GPU reset, driver watchdog, too many contexts) is restored by the browser
  // when we ask (preventDefault); the card is then rebuilt on the same canvas, in the same pose.
  let lost = false;
  const cleanup = [];
  const watched = new WeakSet();
  function watchContext(c) {
    if (watched.has(c)) return;
    watched.add(c);
    const onLost = (e) => {
      e.preventDefault();
      if (c !== canvas) return;
      lost = true;
      onContextLost?.();
    };
    const onRestored = async () => {
      if (c !== canvas || !lost) return;
      const old = stage;
      const pose = poseOf(old, options);
      stage = null;
      try {
        old?.free();
      } catch {
        /* the old instance went with its context */
      }
      try {
        stage = await createStage("webgl", canvas, { ...options, intro: false }, current, slot, pose);
        replayStickers();
        lost = false;
        onContextRestored?.();
      } catch (e) {
        console.warn("[card3d] the card couldn't be rebuilt after a lost WebGL context", e);
      }
    };
    c.addEventListener("webglcontextlost", onLost);
    c.addEventListener("webglcontextrestored", onRestored);
    cleanup.push(
      () => c.removeEventListener("webglcontextlost", onLost),
      () => c.removeEventListener("webglcontextrestored", onRestored),
    );
  }

  if (backend === "webgpu") {
    mark("starting");
    try {
      stage = await createStage("webgpu", canvas, options, current, slot);
    } catch (e) {
      if (isLoadError(e)) {
        mark(null); // WebGPU didn't fail: the network did
        throw e;
      }
      mark("failed");
      await startWebgl(`WebGPU failed to start: ${e?.message ?? e}`);
    }
  } else {
    await startWebgl(null);
  }
  if (backend === "webgl") watchContext(canvas);
  startStickers();

  const failOver = (why) => {
    mark("failed");
    switching ??= startWebgl(why).finally(() => (switching = null));
  };
  if (backend === "webgpu") {
    // A normal exit or hide proves the start didn't crash the tab (so far): don't leave the mark.
    const healthy = () => backend === "webgpu" && !stage?.failure();
    const onHide = () => healthy() && mark(null);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
      else if (healthy() && !confirmed) mark("starting");
    };
    addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    cleanup.push(
      () => removeEventListener("pagehide", onHide),
      () => document.removeEventListener("visibilitychange", onVisibility),
    );
    watch = setInterval(() => {
      const failure = stage?.failure();
      if (failure) failOver(failure);
    }, 1000);
  }

  /** Runs `f` on the stage; a panic in the engine (wasm `unreachable`) makes that instance unusable. */
  const guard = (f, fallback) => {
    if (!stage || switching || lost) return fallback;
    try {
      return f(stage);
    } catch (e) {
      if (backend === "webgpu") failOver(`WebGPU engine error: ${e?.message ?? e}`);
      else throw e;
      return fallback;
    }
  };

  /**
   * Builds `json` on this card's GPU as `kind` (`BUILD`: a print job, an AR model, ...; `a`, `b` its
   * numbers, crates/card3d-web/src/lib.rs `CardStage.build`), with the design's images.
   */
  const build = async (kind, json, { fontFamily: family } = {}, a = 0, b = 0) => {
    const images = await loadDesignImages(JSON.parse(json), resolveUrl, environmentUrl, assets);
    const s = stage;
    if (!s || switching || lost) throw new Error("the card engine is restarting; try again");
    return s.build(kind, json, images, family, a, b);
  };

  return {
    get backend() {
      return backend;
    },
    get canvas() {
      return canvas;
    },
    /** The current `CardStage` (null while switching builds). */
    get stage() {
      return switching || lost ? null : stage;
    },
    /** Settles once the design's animated stickers have shown their first frame (or given up). */
    get stickersReady() {
      return stickersReady;
    },
    /** True between a lost WebGL context and the card's rebuild. */
    get contextLost() {
      return lost;
    },
    /** Shows another design (resolves false when a newer one replaced it first). */
    async setDesign(json, { fontFamily: family } = {}) {
      const next = { design: json, images: await loadDesignImages(JSON.parse(json), resolveUrl, environmentUrl, assets), fontFamily: family };
      current = next;
      const s = stage;
      if (!s || switching || lost) return false;
      try {
        const shown = await s.setDesign(next.design, next.images, next.fontFamily);
        if (shown && next === current) startStickers();
        return shown;
      } catch (e) {
        if (isLoadError(e) || backend !== "webgpu") throw e;
        failOver(`WebGPU failed to build the card: ${e?.message ?? e}`);
        return false;
      }
    },
    resize(w, h) {
      guard((s) => s.resize(w, h));
    },
    setRotation(x, y, z) {
      slot.rotation = [x, y, z];
      guard((s) => s.setRotation(x, y, z));
    },
    setLift(y) {
      slot.lift = y;
      guard((s) => s.setLift(y));
    },
    /** Orbits the camera around its framing target (degrees; `distance` × the framing distance). */
    setCameraOrbit(azimuth, elevation, distance) {
      slot.orbit = [azimuth, elevation, distance];
      guard((s) => s.setCameraOrbit(azimuth, elevation, distance));
    },
    /** Places the camera `z` from its target (the page frames the card); NaN: the stage's own distance. */
    setCameraDistance(z) {
      slot.distance = z;
      guard((s) => s.setCameraDistance(z));
    },
    /** Builds a design on this card's GPU as a `BUILD` kind (see `build` above). */
    build,
    /**
     * Builds `json` for a print bake on this card's GPU (the engine's `print` part): a job whose
     * `items()` lists what a pass chooses for and whose `render(spec)` resolves to a pass's RGBA pixels
     * (`crates/card3d-engine/src/print.rs`). Free it with `free()`.
     */
    async printJob(json, opts = {}) {
      const job = await build(BUILD.PRINT, json, opts);
      return {
        backend,
        items: () => JSON.parse(job.items()),
        maxSize: () => job.maxSize(),
        setArtwork: (back, image) => job.setArtwork(back, image),
        // WebGPU calls back by itself; the WebGL build maps the pixels on a later poll.
        render: (spec) =>
          new Promise((resolve) => {
            let done = false;
            job.render(spec, (px) => {
              done = true;
              resolve(px);
            });
            const poll = () => {
              if (done) return;
              job.poll();
              if (!done) setTimeout(poll, 4);
            };
            poll();
          }),
        free: () => job.free(),
      };
    },
    /** Advances the interaction to `now` (ms): flags, see above. */
    advance(now) {
      return guard((s) => s.advance(now), 0);
    },
    render() {
      if (!guard((s) => (s.render(), true), false)) return;
      const failure = stage.failure();
      if (failure) {
        if (backend === "webgpu") failOver(failure);
        else throw new Error(failure);
        return;
      }
      if (backend === "webgpu" && !drawn) {
        drawn = true;
        setTimeout(() => {
          if (backend === "webgpu" && !stage?.failure()) {
            confirmed = true;
            mark(null);
          }
        }, GOOD_MS);
      }
    },
    /** Testing only: as if the GPU reset (WebGPU) — the card should move to WebGL. */
    simulateDeviceLoss() {
      stage?.simulateDeviceLoss();
    },
    /** Frees the engine's stage (its GPU device goes with it) and stops watching it. */
    dispose() {
      clearInterval(watch);
      for (const p of players) p.stop();
      players = [];
      for (const f of cleanup.splice(0)) f();
      if (backend === "webgpu" && drawn && !stage?.failure()) mark(null);
      const s = stage;
      stage = null;
      try {
        s?.free();
      } catch {
        /* already gone */
      }
    },
  };
}
