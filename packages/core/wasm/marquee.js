// The marquee's engine (many cards in one canvas: a `CardStage` made for the marquee,
// crates/card3d-web/src/lib.rs), started like a card (loader.js picks the build and falls over the same
// way). A module of its own so pages without a marquee don't carry it: packages/core/src/marquee/mount.ts
// imports it.

import {
  BUILD,
  GOOD_MS,
  OP,
  engineParts,
  freshCanvas,
  holdWebgpuStart,
  isLoadError,
  loadDesignImages,
  loadEngine,
  preloadEngine,
  preloadParts,
  webgpuAvailable,
} from "./loader.js";

/** The page's view of a wasm `CardStage` made for the marquee (`WasmMarqueeStage`). */
function marqueeStage(raw) {
  return {
    call: (op, args) => raw.mcall(op, args),
    buildSlot: (slot, token, design, images, fontFamily) => raw.build(BUILD.SLOT, design, images, fontFamily, slot, token),
    resize: (w, h) => void raw.call(OP.RESIZE, w, h),
    render: () => void raw.call(OP.RENDER),
    setLighting: (id) => raw.setLighting(id),
    failure: () => raw.text(0),
    simulateDeviceLoss: () => void raw.call(OP.SIMULATE_DEVICE_LOSS),
    free: () => raw.free(),
  };
}

/**
 * The marquee (many cards in one canvas) on `canvas`, with the build `createCard`
 * would pick and its fall-overs: a WebGPU failure while starting or later (a lost device, a GPU
 * error, an engine panic) moves it to the WebGL build on a fresh canvas (`onCanvas`), and a lost WebGL
 * context rebuilds it on the same canvas. A new stage starts empty: `onRestart(stage)` replays the
 * page's state (designs, strip, layout, lighting) into it before its cards are built again.
 *
 *   const m = await createMarquee(canvas, { force, stage: { active, quality, lighting, intro, reducedMotion },
 *     onCanvas, onRestart, onFallback, onContextLost, resolveUrl, assets });
 *   (`assets`: the asset provider's { nameFontFamily }, as `createCard` takes them.)
 *   m.stage (the current stage: null while switching; read it each time); m.backend; m.canvas;
 *   m.render(); m.buildSlot(slot, token, json, { fontFamily }) → true once shown; m.dispose()
 */
export async function createMarquee(
  canvas,
  { force, stage: options = {}, onCanvas, onRestart, onFallback, onContextLost, resolveUrl = (s) => s, assets = null } = {},
) {
  const likely = preloadEngine(force);
  preloadParts(likely, ["marquee"]);
  let backend = force ?? (likely === "webgpu" && (await webgpuAvailable()) ? "webgpu" : "webgl");
  let stage = null;
  let switching = null;
  let lost = false;
  let drawn = false;
  /** Releases the marquee's "starting" mark (`holdWebgpuStart`). */
  let release = () => {};
  let watch = 0;
  let disposed = false;
  const cleanup = [];

  const make = async (b, opts) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const engine = await loadEngine(b);
        const o = [opts.active, ["performance", "full"].indexOf(opts.quality ?? "full"), opts.intro, opts.reducedMotion].map((v) =>
          v === undefined ? NaN : Number(v),
        );
        return marqueeStage(await engine.CardStage.create(canvas, true, o, opts.lighting ?? ""));
      } catch (e) {
        if (!isLoadError(e) || attempt > 0) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };
  const free = (s) => {
    try {
      s?.free();
    } catch {
      /* a panicked instance: its memory goes with the page */
    }
  };

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
      if (c !== canvas || !lost || disposed) return;
      const old = stage;
      stage = null;
      free(old);
      try {
        stage = await make("webgl", { ...options, intro: false });
        lost = false;
        onRestart?.(stage);
      } catch (e) {
        console.warn("[card3d] the marquee couldn't be rebuilt after a lost WebGL context", e);
      }
    };
    c.addEventListener("webglcontextlost", onLost);
    c.addEventListener("webglcontextrestored", onRestored);
    cleanup.push(
      () => c.removeEventListener("webglcontextlost", onLost),
      () => c.removeEventListener("webglcontextrestored", onRestored),
    );
  }

  const startWebgl = async (why) => {
    clearInterval(watch);
    if (backend === "webgpu") {
      canvas = freshCanvas(canvas);
      onCanvas?.(canvas);
    }
    backend = "webgl";
    const old = stage;
    stage = null;
    free(old);
    stage = await make("webgl", why ? { ...options, intro: false } : options);
    watchContext(canvas);
    if (why) {
      onRestart?.(stage);
      onFallback?.(why);
    }
  };
  const failOver = (why) => {
    release(true);
    switching ??= startWebgl(why).finally(() => (switching = null));
  };

  if (backend === "webgpu") {
    release = holdWebgpuStart();
    try {
      stage = await make("webgpu", options);
    } catch (e) {
      // A part that didn't download is the network's failure, not WebGPU's.
      release(!isLoadError(e));
      if (isLoadError(e)) throw e;
      await startWebgl(`WebGPU failed to start: ${e?.message ?? e}`);
    }
  } else {
    await startWebgl(null);
  }
  if (backend === "webgpu") {
    watch = setInterval(() => {
      const failure = stage?.failure();
      if (failure) failOver(failure);
    }, 1000);
  }

  return {
    get backend() {
      return backend;
    },
    get canvas() {
      return canvas;
    },
    /** The current stage (null while switching builds or after a lost context). */
    get stage() {
      return switching || lost ? null : stage;
    },
    /** Builds a slot's card on the current stage (false: replaced, or the stage changed meanwhile). */
    async buildSlot(slot, token, json, { fontFamily } = {}) {
      const design = JSON.parse(json);
      // The marquee's cards have no scenes.
      preloadParts(
        backend,
        engineParts(design).filter((p) => p !== "scene"),
      );
      const images = await loadDesignImages(design, resolveUrl, null, assets);
      const s = stage;
      if (!s || switching || lost || disposed) return false;
      try {
        return await s.buildSlot(slot, token, json, images, fontFamily);
      } catch (e) {
        if (isLoadError(e) || backend !== "webgpu" || s !== stage) throw e;
        failOver(`WebGPU failed to build a marquee card: ${e?.message ?? e}`);
        return false;
      }
    },
    /** Runs `f` on the stage; a panic in the WebGPU engine moves the marquee to WebGL. */
    guard(f, fallback) {
      const s = stage;
      if (!s || switching || lost) return fallback;
      try {
        return f(s);
      } catch (e) {
        if (backend === "webgpu") failOver(`WebGPU engine error: ${e?.message ?? e}`);
        else throw e;
        return fallback;
      }
    },
    render() {
      if (!this.guard((s) => (s.render(), true), false)) return;
      const failure = stage.failure();
      if (failure) {
        if (backend === "webgpu") failOver(failure);
        else throw new Error(failure);
        return;
      }
      if (backend === "webgpu" && !drawn) {
        drawn = true;
        setTimeout(() => {
          if (backend === "webgpu" && !stage?.failure()) release();
        }, GOOD_MS);
      }
    },
    /** Testing only: as if the GPU reset (WebGPU): the marquee should move to WebGL. */
    simulateDeviceLoss() {
      stage?.simulateDeviceLoss();
    },
    dispose() {
      disposed = true;
      clearInterval(watch);
      for (const f of cleanup.splice(0)) f();
      release(backend === "webgpu" && !!stage?.failure());
      const s = stage;
      stage = null;
      free(s);
    },
  };
}
