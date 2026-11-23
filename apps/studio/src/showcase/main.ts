/**
 * card3d showcase page: the marquee engine (`mountMarquee`) plus the page chrome —
 * wordmark intro phases, headline fade, the desktop scroll morph into the lead grid tile, and compact
 * "flow" mode. Query params: `?seed=<int>` reproducible shuffle, `?card=<name|id|index>` pin a
 * design (or one of its aliases; an unknown value freezes the strip at offset 0),
 * `?quality=full|performance`, `?lighting=<preset>` (the lighting / backdrop preset; the switcher in
 * the hero sets it too). On a dev server, `?assets=reference` uses a local asset pack and the local
 * plugin's designs when they exist (src/local-plugin.ts).
 */
import "./showcase.css";
import {
  LIGHTING_PRESETS,
  getLightingPreset,
  lightingBackdropCss,
  registerCardFonts,
  type AssetProvider,
  type LightingPresetId,
  type Quality,
} from "@card3d/core/model";
import { createPublicAssets } from "@card3d/core/editor";
import { marqueeSmootherstep as smootherstep, marqueeSmoothstep as smoothstep, mountMarquee, type IntroPhase, type MarqueeHandle } from "@card3d/core/marquee";
import { publicMarqueeDesigns, type ShowcaseDesign } from "./designs.ts";
import { loadLocalPlugin } from "../local-plugin.ts";

type UiPhase = "waiting" | "chrome" | "wordmark" | "done";

const WORDMARK = "card3d";
const SCRUB_VH = 56;

const root = document.querySelector<HTMLElement>(".sc-root")!;
const hero = document.querySelector<HTMLElement>(".sc-hero")!;
const frame = hero.querySelector<HTMLElement>(".card-marquee")!;
const stageEl = document.getElementById("marquee")!;
const headline = hero.querySelector<HTMLElement>(".card-marquee__headline")!;
const title = hero.querySelector<HTMLElement>(".card-marquee__title")!;
const wordmark = document.getElementById("wordmark")!;
const nav = document.querySelector<HTMLElement>(".sc-nav")!;
const scrubEl = document.querySelector<HTMLElement>(".sc-scrub")!;
const stage = document.querySelector<HTMLElement>(".sc-stage")!;
const target = document.querySelector<HTMLElement>("[data-sc-target]")!;

const params = new URLSearchParams(location.search);
// The page and the cards' names use the self-hosted open fonts (Inter by default).
registerCardFonts();

// ── lighting / backdrop preset (?lighting=…, and the switcher) ────────────
/** The showcase opens on the studio rig: every finish (dark matte and black metal included) reads in it. */
const SHOWCASE_LIGHTING: LightingPresetId = "studio";
const lightingParam = params.get("lighting");
let lighting: LightingPresetId = LIGHTING_PRESETS.some((p) => p.id === lightingParam) ? (lightingParam as LightingPresetId) : SHOWCASE_LIGHTING;
const switcher = document.getElementById("lighting")!;
const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
const lightingButtons = LIGHTING_PRESETS.map((p) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sc-lighting__btn";
  b.setAttribute("role", "radio");
  b.dataset.value = p.id;
  b.title = p.description;
  const sw = document.createElement("span");
  sw.className = "sc-lighting__sw";
  sw.style.background = lightingBackdropCss(p.id);
  b.append(sw, p.label);
  b.addEventListener("click", () => setLighting(p.id));
  switcher.append(b);
  return b;
});
function applyLighting(): void {
  const preset = getLightingPreset(lighting);
  root.dataset.tone = preset.backdrop.dark ? "dark" : "light";
  document.documentElement.style.setProperty("--sc-backdrop", lightingBackdropCss(lighting));
  document.documentElement.style.setProperty("--sc-page", preset.backdrop.outer);
  themeMeta?.setAttribute("content", preset.backdrop.outer);
  for (const b of lightingButtons) {
    const on = b.dataset.value === lighting;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-checked", String(on));
  }
}
function setLighting(id: LightingPresetId): void {
  if (id === lighting) return;
  lighting = id;
  applyLighting();
  marquee?.setLighting(id);
  const url = new URL(location.href);
  if (id === SHOWCASE_LIGHTING) url.searchParams.delete("lighting");
  else url.searchParams.set("lighting", id);
  history.replaceState(history.state, "", url.href);
}
applyLighting();
const reducedMq = matchMedia("(prefers-reduced-motion: reduce)");
const compactMq = matchMedia("(max-width: 820px), (max-height: 500px) and (orientation: landscape)");
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ── wordmark (one span per character with --wordmark-i) ──────────────
for (const [i, ch] of [...WORDMARK].entries()) {
  const span = document.createElement("span");
  span.className = "card-marquee__wordmark-character";
  span.style.setProperty("--wordmark-i", String(i));
  span.textContent = ch;
  wordmark.appendChild(span);
}

// ── UI intro phases: waiting → chrome (640 ms) → wordmark (1000 ms) → done ──
let uiPhase: UiPhase = "waiting";
let uiTimer = 0;
const setUi = (p: UiPhase) => {
  if (uiPhase === "done" || p === uiPhase) return;
  uiPhase = p;
  root.dataset.introUi = p;
  clearTimeout(uiTimer);
  if (p === "chrome") uiTimer = window.setTimeout(() => setUi("wordmark"), 640);
  else if (p === "wordmark") uiTimer = window.setTimeout(() => setUi("done"), 1000);
};
wordmark.addEventListener("animationend", (e) => {
  if ((e.target as HTMLElement) === wordmark.lastElementChild) setUi("done");
});
if (reducedMq.matches) setUi("done");
else
  window.setTimeout(() => {
    if (uiPhase === "waiting") setUi(root.scrollTop > 4 ? "done" : "chrome");
  }, 2200);

// ── scroll shell ─────────────────────────────────────────────────────
type Mode = "morph" | "flow";
const modeNow = (): Mode => (reducedMq.matches || compactMq.matches ? "flow" : "morph");
let mode: Mode = modeNow();
let marquee: MarqueeHandle | null = null;
let scrubbing = false;
let handedOff = false;

function applyMode(): void {
  mode = modeNow();
  root.classList.toggle("sc-root--flow", mode === "flow");
  if (mode === "flow") {
    hero.style.transform = "";
    hero.style.borderRadius = "";
    stage.style.opacity = "";
  }
  root.style.setProperty("--sc-viewport-aspect", `${innerWidth} / ${innerHeight}`);
  onScroll();
}

let scrollFrame = 0;
let restoreTitle = 0;
function onScroll(): void {
  scrollFrame = 0;
  const top = root.scrollTop;
  if (top > 4 && uiPhase !== "done") setUi("done");
  const D = Math.max(1, scrubEl.offsetHeight || (innerHeight * SCRUB_VH) / 100);

  // headline fade
  const h = clamp(top / D, 0, 1);
  const f = mode === "flow" ? 0 : smoothstep(h / 0.18);
  title.style.opacity = String(1 - f);
  title.style.transform = `translateY(${-30 * f}px)`;
  title.style.transitionDuration = "0s";
  cancelAnimationFrame(restoreTitle);
  if (top === 0) restoreTitle = requestAnimationFrame(() => requestAnimationFrame(() => (title.style.transitionDuration = "")));

  if (mode === "morph") {
    const o = clamp(top / D, 0, 1);
    const l = smootherstep(o);
    const vw = innerWidth;
    const vh = innerHeight;
    const r = target.getBoundingClientRect();
    // landed rect while scrubbing; after the scrub zone, keep tracking the cell (prewarm handoff)
    const destTop = r.top + (top - D) - Math.max(0, top - D);
    const sx = lerp(1, r.width / vw, l);
    const sy = lerp(1, r.height / vh, l);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    hero.style.transform = `translate3d(${snap(lerp(0, r.left, l))}px, ${snap(lerp(0, destTop, l))}px, 0) scale(${sx}, ${sy})`;
    const radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 20;
    hero.style.borderRadius = `${(radius * l) / sx}px / ${(radius * l) / sy}px`;
    stage.style.opacity = String(l);

    const nextScrub = scrubbing ? o > 0.003 : o > 0.006;
    if (nextScrub !== scrubbing) {
      scrubbing = nextScrub;
      root.toggleAttribute("data-scrubbing", scrubbing);
    }
    handedOff = handedOff ? o >= 0.42 : o > 0.55;
    root.toggleAttribute("data-handedoff", handedOff);
    root.toggleAttribute("data-landed", o >= 0.9999);
    // the 1.25× supersample is dropped mid-morph
    marquee?.setMorphing(scrubbing && o < 0.9999);
  } else {
    root.toggleAttribute("data-handedoff", top > 4);
    root.toggleAttribute("data-landed", true);
    marquee?.setMorphing(false);
  }
}
root.addEventListener(
  "scroll",
  () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(onScroll);
  },
  { passive: true },
);
addEventListener("resize", applyMode);
compactMq.addEventListener("change", applyMode);
reducedMq.addEventListener("change", applyMode);

// The hero sits over the scroller; vertical wheel over it scrolls the page.
hero.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey || e.defaultPrevented) return;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? root.clientHeight : 1;
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    root.scrollTop += e.deltaY * k;
    e.preventDefault();
  },
  { passive: false },
);

// ── marquee ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  applyMode();
  let assets: AssetProvider = createPublicAssets();
  let designs: ShowcaseDesign[] = [];
  // Dev server with a local asset pack only, and only on request (?assets=reference); a build drops
  // this import. The designs then come from the local plugin, if there is one (src/local-plugin.ts).
  const wantRef = params.get("assets") === "reference";
  const localPack = import.meta.env.DEV && __CARD3D_LOCAL_PACK__ && wantRef ? await import("@card3d/core/reference") : null;
  if (localPack && (await localPack.hasReferencePack())) {
    try {
      assets = await localPack.loadReferenceAssets();
      const plugin = await loadLocalPlugin();
      designs = (await plugin?.showcase?.({ params, nav: document.querySelector(".sc-nav__links") })) ?? [];
    } catch (err) {
      console.warn("[showcase] local pack unavailable, using public designs", err);
    }
  }
  if (!designs.length) designs = publicMarqueeDesigns();

  const seedParam = params.get("seed");
  const seed = seedParam !== null && seedParam !== "" && Number.isFinite(Number(seedParam)) ? Number(seedParam) | 0 : undefined;
  const cardParam = params.get("card");
  const qualityParam = params.get("quality");
  const quality: Quality | undefined = qualityParam === "full" || qualityParam === "performance" ? qualityParam : undefined;

  marquee = mountMarquee(stageEl, {
    designs,
    assets,
    seed,
    quality,
    lighting,
    pin: cardParam ? (/^\d+$/.test(cardParam) ? Number(cardParam) : cardParam) : null,
    scrollElement: () => root,
    manualTouchScroll: mode === "morph",
    layoutBand: () => {
      const H = hero.clientHeight;
      // Below the nav, and below the lighting switcher where it sits at the top (compact layout).
      const sw = switcher.getBoundingClientRect();
      const heroTop = hero.getBoundingClientRect().top;
      const top = clamp(Math.max(nav.getBoundingClientRect().bottom, sw.top - heroTop < H / 2 ? sw.bottom - heroTop + 8 : 0), 0, H);
      return { top, bottom: clamp(headline.offsetTop, top, H) };
    },
    onIntroPhase(p: IntroPhase) {
      frame.dataset.intro = p;
      if (p === "done") delete root.dataset.marqueeIntro;
      else root.dataset.marqueeIntro = p;
      if (p !== "arrive" && uiPhase === "waiting") setUi("chrome");
    },
  });
  frame.dataset.intro = marquee.introPhase;
  if (marquee.introPhase !== "done") root.dataset.marqueeIntro = marquee.introPhase;
  // Any `?card` value pauses the strip; an unknown one freezes the shuffle at offset 0.
  if (cardParam && !marquee.strip.previewPaused) marquee.pin(0);

  (window as unknown as { __marquee?: MarqueeHandle }).__marquee = marquee;
  onScroll();
}

main().catch((err) => {
  console.error(err);
  setUi("done");
});
