/**
 * The marquee for the comparison harness (`compare.mjs --marquee`): the same designs, layout and
 * frozen strip states drawn by the three.js marquee (`?engine=three`, from the local archive through
 * `@three-engine/`, ../three-archive.mjs) or the Rust engine's (`?engine=webgpu` / `webgl`, which work
 * without the archive). `?w=&h=` the container (CSS px, pixel ratio 1); `?designs=<url>` a
 * JSON array of CardDesigns (as `ensureDesign` returns them, clocks frozen: designs/generate.ts).
 * Nothing animates (no drift, no intro); each state is a strip offset and a marquee time.
 *
 *   window.__ready              true once mounted (else an error string)
 *   window.__render(offset, t)  → a promise of the frame's PNG data URL
 */
import { createPublicAssets } from "../../../packages/core/src/scene/assets.ts";
import { createMarqueeStrip } from "../../../packages/core/src/marquee/strip.ts";
import { computeMarqueeLayout } from "../../../packages/core/src/marquee/pose.ts";
import type { CardDesign } from "../../../packages/core/src/types.ts";

declare global {
  interface Window {
    __ready?: true | string;
    __render?(offset: number, time: number): Promise<string>;
    __backend?: string;
  }
}

async function main() {
  const q = new URLSearchParams(location.search);
  const engine = q.get("engine") ?? "three";
  const [w, h] = [Number(q.get("w") ?? 1200), Number(q.get("h") ?? 750)];
  const el = document.getElementById("marquee") as HTMLElement;
  Object.assign(el.style, { width: `${w}px`, height: `${h}px` });
  const designs = (await (await fetch(q.get("designs")!)).json()) as CardDesign[];
  const strip = createMarqueeStrip();
  const opts = {
    designs,
    assets: createPublicAssets(),
    shuffle: false,
    quality: (q.get("quality") === "performance" ? "performance" : "full") as "full" | "performance",
    active: true,
    intro: false,
    interactive: false,
    animate: false,
    pauseOffscreen: false,
    pixelRatio: 1,
    layout: computeMarqueeLayout({ width: w, height: h }),
    strip,
    preserveDrawingBuffer: true,
  };
  const m =
    engine === "three"
      ? (await import("@three-engine/marquee/marquee.ts")).mountMarquee(el, opts)
      : (await import("../../../packages/core/src/marquee/mount.ts")).mountMarquee(el, { ...opts, backend: engine as "webgpu" | "webgl" });
  await m.ready();
  window.__backend = "backend" in m ? (m.backend ?? "?") : "three";
  window.__render = async (offset, time) => {
    strip.offset = offset;
    strip.time = time;
    await m.ready();
    m.render();
    // The cards' first frame may still be compiling pipelines (three) or settling: draw again.
    m.render();
    return m.canvas.toDataURL("image/png");
  };
  window.__ready = true;
}
main().catch((e) => (window.__ready = String(e?.stack ?? e)));
