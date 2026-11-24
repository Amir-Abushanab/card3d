/**
 * Card Studio: one interactive card stage, the recipe control panel, direct sticker editing,
 * undo/redo, drafts and exports. Everything edits one live `CardDesign` (`design`, mutated in place
 * so the panel's bindings stay attached); the card is rebuilt from it after each change.
 */
import "./style.css";
import {
  CARD_PRESETS,
  embeddedFont,
  getLightingPreset,
  lightingBackdropCss,
  isMissingUpload,
  loadCustomFont,
  loadedCustomFontFamily,
  registerCardFonts,
  type AssetProvider,
  type CardCustomFont,
  type CardDesign,
  type Decal,
  type FaceShader,
  type Side,
} from "@card3d/core/model";
import { WGSL_SHADER_EXAMPLES, cardFrameSize, getShaderDefinition, createPublicAssets } from "@card3d/core/editor";
import { cameraPathPose, createEngineStage, getCameraPath, type EngineStage } from "@card3d/core/engine";
import { cloneDesign, countEmbeddedMedia, defaultDesign, DEFAULT_PRESET_ID, ensureDesign, withPreset } from "./state/design.ts";
import { History } from "./state/history.ts";
import {
  autosave,
  deleteDraft,
  listDrafts,
  loadAutosave,
  loadPrefs,
  loadStickerLibrary,
  saveDraft,
  savePrefs,
  saveStickerLibrary,
  type LibrarySticker,
} from "./state/storage.ts";
import { copyShareLink, decodeDesignFromHash, hasSharedDesign } from "./state/share.ts";
import {
  MAX_SHADER_LAYERS,
  layerName,
  newBuiltinLayer,
  newCustomLayer,
  glslLayerErrors,
  pauseCustomLayers,
  pruneLayerParams,
  stillDesign,
} from "./state/fx.ts";
import { isGlass } from "./panel/effects-section.ts";
import { ShaderPicker } from "./shaders/picker.ts";
import { ShaderEditor } from "./shaders/shader-editor.ts";
import { hideBanner, showBanner } from "./ui/banner.ts";
import { randomizeDesign } from "./state/randomize.ts";
import { Panel, type Backdrop, type StudioUi } from "./panel/panel.ts";
import { StickerEditor } from "./stickers/sticker-editor.ts";
import { BUILTIN_STICKERS, artworkFromFile, stickerFromFile } from "./stickers/library.ts";
import { logoFromFile } from "./stickers/logo.ts";
import { CAMERA_FOV, ExportStage, fitDistance } from "./export/offscreen.ts";
import { exportClip, exportDesignJson, exportImage, exportSpecJson, fileBase, renderThumb } from "./export/exporters.ts";
import { ThumbScheduler, type ThumbRequest } from "./export/thumbs.ts";
import { openThumbCache } from "./export/thumb-cache.ts";
import { thumbVersion } from "./export/thumb-key.ts";
import { ENGINE_BUILD } from "virtual:card3d-build";
import { HistoryControls } from "./ui/history-controls.ts";
import { dismissToast, showToast } from "./ui/toast.ts";
import { downloadBlob, h, isTyping, pickFiles } from "./ui/dom.ts";
import { describeFinishEnabled } from "./describe/flag.ts";
import type { DescribeDialog } from "./describe/dialog.ts";
import { loadLocalPlugin } from "./local-plugin.ts";
import { reloadOnStaleBuild } from "./ui/stale-build.ts";

/** Idle time after which the export stage is disposed (it is made again on the next export). */
const EXPORT_STAGE_IDLE_MS = 60_000;
/** Idle time after which the thumbnail stage is disposed (the queue drained; the next thumbnail makes it again). */
const THUMB_STAGE_IDLE_MS = 5_000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stageEl = $<HTMLDivElement>("stage");
const canvas = $<HTMLCanvasElement>("card-canvas");
const workspace = $<HTMLElement>("workspace");
const statusEl = $<HTMLElement>("status");
const sideBtn = $<HTMLButtonElement>("side-toggle");
const resBadge = $<HTMLElement>("res-badge");

// Visible errors (wave3d): anything uncaught surfaces as a toast instead of failing silently.
const isExtensionNoise = (s?: string) => !!s && /-extension:\/\//.test(s);
window.addEventListener("error", (e) => {
  if (isExtensionNoise(e.filename) || isExtensionNoise((e.error as Error)?.stack)) return;
  showToast({ message: `Error: ${e.message}`, tone: "error" });
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = (e.reason as Error)?.message ?? String(e.reason);
  if (isExtensionNoise((e.reason as Error)?.stack)) return;
  showToast({ message: `Error: ${msg}`, tone: "error" });
});
/** Saves the design before a reload for a new build (set once the design exists). */
let saveBeforeReload: (() => void) | undefined;
reloadOnStaleBuild(() => saveBeforeReload?.());

async function boot(): Promise<void> {
  // The self-hosted card fonts (name/bio, the font picker's samples, and the panel's UI face).
  registerCardFonts();
  const prefs = loadPrefs();
  const params = new URLSearchParams(location.search);

  // ── assets: the public defaults; a local asset pack only on request (dev: ?assets=reference, the
  // panel's dev toggle, or the local plugin asking for it), so even a machine with a pack shows the
  // public card by default. `localPack` (its loader) exists only on a dev server that found
  // `.reference/pack/` (__CARD3D_LOCAL_PACK__, set by the local-pack plugin): a build drops the import,
  // and a clone without a pack never requests /@ref/. The local plugin (src/local-plugin.ts) is likewise
  // dev-only and optional.
  const plugin = await loadLocalPlugin();
  const localPack = import.meta.env.DEV && __CARD3D_LOCAL_PACK__ ? await import("@card3d/core/reference") : null;
  let assets: AssetProvider = createPublicAssets();
  const hasRef = localPack ? await localPack.hasReferencePack() : false;
  const wantRef = hasRef && (params.get("assets") ?? (plugin?.wantsLocalAssets?.(params) ? "reference" : prefs.assets) ?? "public") === "reference";
  if (localPack && wantRef) {
    try {
      assets = await localPack.loadReferenceAssets();
    } catch (err) {
      console.warn("[studio] local pack unavailable, using public assets", err);
    }
  }

  // ── stage ──
  const ui: StudioUi = {
    quality: prefs.quality ?? "full",
    backdrop: prefs.backdrop === "checker" ? "checker" : "scene",
    spin: false,
    presetCategory: (prefs.presetCategory as StudioUi["presetCategory"]) ?? "classic",
    activePreset: null,
    artworkFit: "cover",
    sizePreset: "Card 3:2 · 1800×1200",
    width: 1800,
    height: 1200,
    transparent: true,
    exportBackground: "transparent",
    background: "#0b0b10",
    imageFormat: "png",
    imageQuality: 0.92,
    clipFormat: "webm",
    clipSeconds: 4,
    clipPath: "spin",
    clipEasing: "auto",
    selectedSticker: null,
    assets: wantRef ? "reference" : "public",
    randomizeFx: false,
  };

  let contextTimer = 0;
  // The card engine (WebGPU, else its WebGL 2 build): the live card, its camera and interaction.
  const stage: EngineStage = createEngineStage(canvas, {
    quality: ui.quality,
    interactive: true,
    intro: true,
    element: stageEl,
    label: "Interactive three-dimensional metal card",
    assets,
    resolveUrl: (src) => assets.resolveUrl(src),
    // A lost WebGL context (GPU reset) must never leave a blank stage without a word: say so, let the
    // stage rebuild itself when the browser restores the context, and offer a reload if it doesn't.
    onContextLost: () => {
      clearTimeout(contextTimer);
      showToast({ message: "The graphics context was lost. Restoring the card…", tone: "warn", duration: 60_000 });
      contextTimer = window.setTimeout(() => {
        if (!stage.contextLost) return;
        showToast({
          message: "The browser didn't restore the graphics context. Your design is saved; reload to continue.",
          tone: "error",
          actionLabel: "Reload",
          onAction: () => {
            autosave(design);
            location.reload();
          },
          duration: 600_000,
        });
      }, 6000);
    },
    onContextRestored: () => {
      clearTimeout(contextTimer);
      showToast("Graphics restored.");
    },
    // Weaker GPUs: lower the live preview's resolution while an animated card can't keep up (exports
    // render on their own stages at the requested size, and stills return to full resolution).
    // `?adaptive=off` disables it (frame intervals are the engine stage's only source).
    adaptiveResolution: params.get("adaptive") !== "off",
    onPixelRatioChange: (c) => showResolution(c.ratio, c.full, c.frameMs),
    onRotationChange: () => updateSide(),
    onFlippedChange: () => {
      updateSide();
      setTimeout(updateSide, 700);
    },
  });
  /** A subtle badge while the live preview runs below full resolution. */
  const showResolution = (ratio: number, full: number, frameMs?: number) => {
    const reduced = ratio < full - 1e-3;
    resBadge.hidden = !reduced;
    resBadge.textContent = `${Math.round((ratio / full) * 100)}% res`;
    resBadge.title = reduced
      ? `Preview resolution lowered to ${ratio.toFixed(2)}× (of ${full}×) to keep this animated card smooth${frameMs ? ` (frame time ${frameMs.toFixed(1)} ms)` : ""}. Exports always render at full size.`
      : "";
    document.body.dataset.pixelRatio = ratio.toFixed(2);
  };

  // Frame the whole card with a margin, whatever the stage's aspect (the engine's default camera is
  // the marquee's close-up).
  // Portrait shapes are framed by their own (taller) size.
  let frameSize: { width: number; height: number; portrait: boolean } | null = null;
  const frame = () => {
    const r = stageEl.getBoundingClientRect();
    if (!r.width || !r.height) return;
    stage.setCameraDistance(fitDistance(r.width / r.height, CAMERA_FOV, 1.34, frameSize ?? undefined));
  };
  new ResizeObserver(frame).observe(stageEl);
  frame();

  // ── document ──
  const design: CardDesign = defaultDesign();
  let restored: "shared" | "autosave" | null = null;
  /** Custom layers paused by the untrusted-code gate, until "Run it". */
  let gated: FaceShader[] = [];
  if (hasSharedDesign()) {
    const shared = await decodeDesignFromHash(location.hash);
    if (shared) {
      const paused = pauseCustomLayers(shared);
      assign(design, shared);
      gated = paused.map((i) => design.shaders![i]);
      restored = "shared";
    } else showToast({ message: "That share link couldn't be read — showing the default card.", tone: "warn" });
  } else {
    const saved = loadAutosave();
    if (saved) {
      assign(design, saved.design);
      restored = "autosave";
    }
  }

  /** The page behind the canvas follows the design's lighting preset (unless the checkerboard is on). */
  const syncBackdrop = () => applyBackdrop(ui.backdrop, design.lighting);
  syncBackdrop();

  if (!restored) ui.activePreset = DEFAULT_PRESET_ID;

  let library: LibrarySticker[] = [...BUILTIN_STICKERS, ...loadStickerLibrary()];
  const thumbs = new Map<string, string>();

  // ── rebuild: single flight, always converging on the latest design ──
  /** When the live card was last built (its animation clocks start there). */
  let builtAt = performance.now();
  const liveSeconds = () => (performance.now() - builtAt) / 1000;
  let building = false;
  let pending = false;
  let shownShaderErrors = false;
  /** Rebuilds of the live card so far (the sticker editor re-shows a live edit after one). */
  let builds = 0;
  let busyTimer = 0;
  const scheduleRebuild = () => {
    pending = true;
    if (!building) void pump();
  };
  async function pump() {
    building = true;
    document.body.dataset.building = "1";
    clearTimeout(busyTimer);
    busyTimer = window.setTimeout(() => statusEl.classList.add("is-on"), 180);
    while (pending) {
      pending = false;
      await new Promise((r) => requestAnimationFrame(r));
      try {
        const size = cardFrameSize(design);
        const reframe = size.portrait !== (frameSize?.portrait ?? false);
        frameSize = size;
        await stage.setDesign(cloneDesign(design));
        if (reframe) frame();
        builtAt = performance.now();
        builds++;
      } catch (err) {
        console.error(err);
        showToast({ message: `Couldn't build the card: ${(err as Error).message}`, tone: "error" });
      }
    }
    building = false;
    delete document.body.dataset.building;
    checkFont();
    startThumbs();
    clearTimeout(busyTimer);
    statusEl.classList.remove("is-on");
    updateSide();
    // Face shader layers the card skipped (custom WGSL that doesn't build, GLSL): the panel's errors.
    if (design.shaders?.length || shownShaderErrors) {
      shownShaderErrors = !!design.shaders?.length;
      requestAnimationFrame(() => panel.refreshShaderErrors());
    }
    noteGlslLayers();
  }

  // ── GLSL layers: the card engine runs WGSL, so they are skipped. Say so once per design (the panel
  // marks each one); the shader editor rewrites them in place. ──
  let glslNoted = "";
  function noteGlslLayers() {
    const glsl = [...new Set(glslLayerErrors(design).map((e) => e.index))];
    const key = glsl.join(",");
    if (key === glslNoted) return;
    glslNoted = key;
    if (!glsl.length) return;
    const n = glsl.length;
    showToast({
      message: `This design has ${n} custom shader layer${n > 1 ? "s" : ""} in GLSL. The card engine runs WGSL, so ${n > 1 ? "they are" : "it is"} skipped: rewrite ${n > 1 ? "them" : "it"} in WGSL in the shader editor.`,
      tone: "warn",
      actionLabel: "Open the editor",
      onAction: () => void shaderEditor.open(glsl[0]),
      duration: 12_000,
    });
  }

  // ── custom fonts: say when one can't be loaded (the card shows Inter), rebuild when a slow one arrives ──
  let fontNotice = "";
  const customFont = (): CardCustomFont | null => (design.font && typeof design.font === "object" ? design.font : null);
  function checkFont() {
    const f = customFont();
    const key = f ? `${f.source}|${f.family}|${f.weight ?? ""}|${f.src?.length ?? 0}|${f.src?.slice(-48) ?? ""}` : "";
    if (key === fontNotice) return;
    fontNotice = key;
    if (!f) return;
    if (isMissingUpload(f)) {
      showToast({
        message: `This design uses “${f.family}”, an uploaded font whose file isn't included (share links leave uploads out): the card shows Inter until you add it.`,
        tone: "warn",
        actionLabel: "Add font file…",
        onAction: () => void openFontDialog("upload"),
        duration: 12_000,
      });
      return;
    }
    // Built with the fallback because the font was still loading (slow network)? Rebuild once it is in.
    const builtWithFallback = !loadedCustomFontFamily(f);
    void loadCustomFont(f).then((r) => {
      if (customFont() !== f) return;
      if (r.ok) {
        if (builtWithFallback) scheduleRebuild();
        return;
      }
      panel.refresh();
      showToast({
        message: `Couldn't load the font “${f.family}” (${r.error}). The card uses Inter for now.`,
        tone: "warn",
        actionLabel: "Change font…",
        onAction: () => void openFontDialog(),
      });
    });
  }

  // ── history ──
  const history = new History({ getLive: () => design, onChange: () => historyControls?.update(history.getState()) });
  let saveTimer = 0;
  let warnedStorage = false;
  // An edit not saved yet is saved before a reload.
  saveBeforeReload = () => {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    autosave(design);
  };
  const scheduleAutosave = () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      const r = autosave(design);
      if (r !== "ok" && !warnedStorage) {
        warnedStorage = true;
        showToast({
          message:
            r === "without-media"
              ? "Browser storage is full: uploads aren't autosaved. Save the design (.json) to keep them."
              : "Autosave is unavailable in this browser.",
          tone: "warn",
        });
      }
    }, 700);
  };

  /** The design was edited in place (panel, stickers). */
  const edited = (label?: string) => {
    dismissToast();
    syncBackdrop();
    scheduleRebuild();
    if (label) {
      history.flush();
      history.commit(design, label);
    } else history.markDirty();
    scheduleAutosave();
    shaderEditor?.sync();
  };

  /** Replace the whole design (preset, undo, load…). */
  const applyDesign = (next: CardDesign, label?: string, record = true) => {
    if (record) history.flush();
    assign(design, next);
    syncBackdrop();
    panel.refresh();
    editor.sync();
    shaderEditor?.sync(true);
    panel.refreshPlaced();
    scheduleRebuild();
    if (record) history.commit(design, label);
    scheduleAutosave();
  };

  const visibleSide = (): Side => editor.visibleSide();
  const showSide = (side: Side) => {
    if (visibleSide() !== side) stage.flip();
  };

  // ── offscreen stages (lazy) ──
  // Exports, thumbnails and AR models draw on the card engine. Each stage holds a GPU device (or a
  // WebGL context, which counts against the page's limit), so it goes once it has been idle a while
  // and is made again on demand.
  let exportStage: ExportStage | null = null;
  let exportUsers = 0;
  let exportIdle: ReturnType<typeof setTimeout> | undefined;
  const getExportStage = () => (exportStage ??= new ExportStage(assets, "full"));
  /** Runs `fn` on the export stage; the stage is disposed a minute after the last use. */
  const withExportStage = async <T>(fn: (s: ExportStage) => Promise<T>): Promise<T> => {
    exportUsers++;
    clearTimeout(exportIdle);
    try {
      return await fn(getExportStage());
    } finally {
      if (--exportUsers === 0) {
        exportIdle = setTimeout(() => {
          exportStage?.dispose();
          exportStage = null;
        }, EXPORT_STAGE_IDLE_MS);
      }
    }
  };
  let thumbStage: ExportStage | null = null;
  let thumbUse = 0;
  let thumbIdle: ReturnType<typeof setTimeout> | undefined;
  /** The thumbnail stage (only used under `thumbScheduler.exclusive`): disposed once the queue has drained a while. */
  const getThumbStage = () => {
    thumbStage ??= new ExportStage(assets, "performance");
    const use = ++thumbUse;
    clearTimeout(thumbIdle);
    thumbIdle = setTimeout(
      () =>
        void thumbScheduler.exclusive(async () => {
          if (use !== thumbUse) return; // used again meanwhile
          thumbStage?.dispose();
          thumbStage = null;
        }),
      THUMB_STAGE_IDLE_MS,
    );
    return thumbStage;
  };
  /** The live card's pose (the interaction's, without the camera path's slot pose). */
  const liveQuaternion = () => stage.view()?.quaternion ?? { x: 0, y: 0, z: 0, w: 1 };
  /**
   * Preset / shader-picker thumbnails: cached persistently, rendered lazily one per idle slot, never
   * while the live card builds (export/thumbs.ts). Draft thumbnails share the stage via `exclusive`.
   */
  const thumbScheduler = new ThumbScheduler({
    stage: getThumbStage,
    cache: openThumbCache(),
    version: thumbVersion({ renderer: "engine", build: ENGINE_BUILD, assets: wantRef ? "reference" : "public" }),
    liveReady: () => !building && stage.backend !== null && !stage.contextLost,
    liveBuiltAt: () => builtAt,
    liveAnimated: () => stage.animated || isGlass(design),
  });
  // ── the local plugin's additions (dev only, optional: src/local-plugin.ts) ──
  const pluginParts = plugin?.studio
    ? await Promise.resolve()
        .then(() =>
          plugin.studio!({
            params,
            thumbs: thumbScheduler,
            toolbarAnchor: sideBtn,
            openDesign: (next, label) => {
              ui.activePreset = null;
              applyDesign(next, label);
            },
          }),
        )
        .catch((err: unknown) => {
          console.warn("[studio] the local plugin failed", err);
          return null;
        })
    : null;

  /** Live clocks frozen where the preview is, for single-frame captures. */
  const stillOfLive = () => {
    const t = liveSeconds();
    return stillDesign(cloneDesign(design), t, { vinesTime: t % 80 });
  };

  // ── shader layers: picker thumbnails, picker, code editor, untrusted-code gate ──
  const shaderThumbs = new Map<string, string>();
  const thumbBase = () => {
    const base = defaultDesign();
    base.cardholderName = "";
    return base;
  };
  const shaderThumbDesign = (key: string): CardDesign | null => {
    const base = thumbBase();
    const [kind, id] = key.split(":");
    if (kind === "builtin") {
      const def = getShaderDefinition(id);
      if (!def) return null;
      base.shaders = [newBuiltinLayer(def, "front", base)];
    } else {
      const ex = WGSL_SHADER_EXAMPLES.find((e) => e.id === id);
      if (!ex) return null;
      base.shaders = [newCustomLayer(ex.code, ex.target, "front")];
    }
    return stillDesign(base, 1.6);
  };
  /** Shader-picker thumbnails: requested only when the picker opens (it is then what's visible). */
  const renderShaderThumbs = (keys: string[], onThumb?: (key: string, url: string) => void) => {
    const items: ThumbRequest[] = [];
    for (const key of keys) {
      if (shaderThumbs.has(key)) continue;
      const design = shaderThumbDesign(key);
      if (design) items.push({ id: key, design, width: 240, height: 150 });
    }
    thumbScheduler.request(items, "visible", (key, url) => {
      shaderThumbs.set(key, url);
      onThumb?.(key, url);
    });
  };
  let shaderPicker: ShaderPicker | null = null;
  let thumbListener: ((key: string, url: string) => void) | null = null;
  const openPicker = async () => {
    shaderPicker ??= new ShaderPicker({
      thumb: (k) => shaderThumbs.get(k),
      renderThumbs: (keys, onThumb) => {
        thumbListener = onThumb;
        renderShaderThumbs(keys, (k, u) => thumbListener?.(k, u));
      },
      full: () =>
        (design.shaders?.length ?? 0) >= MAX_SHADER_LAYERS ? `This card already has ${MAX_SHADER_LAYERS} layers (the limit). Remove one to add another.` : null,
    });
    const pick = await shaderPicker.open();
    thumbListener = null;
    if (!pick || (design.shaders?.length ?? 0) >= MAX_SHADER_LAYERS) return;
    const side = visibleSide();
    const layer = pick.kind === "builtin" ? newBuiltinLayer(pick.def, side, design) : newCustomLayer(pick.code, pick.target, side);
    const targets = pick.kind === "builtin" ? pick.def.targets : (["skin", "overlay"] as const);
    // Skins don't render on glass: start such layers as overlays when the shader allows it.
    if (isGlass(design) && layer.target === "skin" && targets.includes("overlay")) layer.target = "overlay";
    (design.shaders ??= []).push(layer);
    const index = design.shaders.length - 1;
    panel.refreshShaders(index);
    edited(`add ${layerName(layer)}`);
    if (pick.kind === "custom") void shaderEditor.open(index);
  };

  const shaderEditor: ShaderEditor = new ShaderEditor({
    design,
    check: (code) => stage.checkShader(code),
    width: prefs.editorWidth ?? 520,
    onResize: (w) => {
      savePrefs({ editorWidth: w });
      frame();
    },
    onTarget: () => {
      panel.refreshShaders();
      requestAnimationFrame(frame);
    },
    apply: (index, code) => {
      const l = design.shaders?.[index];
      if (!l || l.id !== "custom") return;
      l.code = code;
      // Code that builds as WGSL is WGSL from now on (a GLSL layer rewritten in place).
      l.language = "wgsl";
      pruneLayerParams(l);
      dismissToast();
      scheduleRebuild();
      history.markDirty(1500); // one undo step per typing burst
      scheduleAutosave();
      panel.refreshShaders();
    },
  });

  /** "Run it": re-enable the custom layers the gate paused. */
  const runGated = () => {
    let n = 0;
    for (const l of gated) {
      // Layers still in the design (an undo/load since may have replaced them: then nothing to run).
      if (design.shaders?.includes(l) && l.enabled === false) {
        delete l.enabled;
        n++;
      }
    }
    gated = [];
    hideBanner();
    if (!n) return;
    panel.refreshShaders();
    edited(`run custom shader${n > 1 ? "s" : ""}`);
  };
  const showGate = (source: string) => {
    if (!gated.length) return hideBanner();
    const n = gated.length;
    showBanner(workspace, {
      message: `This design contains custom shader code`,
      detail: `${n} custom layer${n > 1 ? "s" : ""} from ${source} ${n > 1 ? "are" : "is"} paused. Shader code can't read your data, but a heavy one can freeze the GPU — review it if you don't trust the source.`,
      actions: [
        { label: "Run it", primary: true, onClick: runGated },
        { label: "Review code", keep: true, onClick: () => void shaderEditor.open(Math.max(0, design.shaders?.indexOf(gated[0]) ?? 0)) },
      ],
      onDismiss: () => (gated = []),
    });
  };
  /** Apply a design from an untrusted source with its custom layers paused. */
  const applyUntrusted = (next: CardDesign, label: string, source: string) => {
    const paused = pauseCustomLayers(next);
    applyDesign(next, label);
    gated = paused.map((i) => design.shaders![i]);
    showGate(source);
  };

  // ── dialogs (each loaded on first use) ──
  let codeDialog: import("./ui/code-dialog.ts").CodeDialog | null = null;
  let embedDialog: import("./ui/embed-dialog.ts").EmbedDialog | null = null;
  let arDialog: import("./ui/ar-dialog.ts").ArDialog | null = null;
  let importDialog: import("./ui/import-dialog.ts").ImportDialog | null = null;
  let drawDialog: import("./draw/draw-dialog.ts").DrawDialog | null = null;
  let fontDialog: import("./ui/font-dialog.ts").FontDialog | null = null;

  /** "Custom…" font: one undo step when a font is chosen. */
  const openFontDialog = async (tab?: CardCustomFont["source"]) => {
    const { FontDialog } = await import("./ui/font-dialog.ts");
    fontDialog ??= new FontDialog(() => design.cardholderName);
    const f = await fontDialog.open(customFont(), tab);
    if (!f) return;
    design.font = f;
    panel.refresh();
    edited(`font ${f.family}`);
    showSide("front");
  };

  const shareLabel = async () => {
    const r = await copyShareLink(design);
    const kb = Math.round(r.url.length / 1024);
    if (kb >= 8 && design.shaders?.some((l) => l.id === "custom")) {
      showToast({
        message: `This link is ${kb} KB long because it carries your shader code. Some apps cut long links: Save design (.json) to share reliably.`,
        tone: "warn",
      });
    } else if (r.stripped) {
      const font = customFont();
      const fontLeft = embeddedFont(design) && font ? 1 : 0;
      const images = r.stripped - fontLeft;
      const what = [
        images ? `${images} uploaded image${images > 1 ? "s" : ""}` : "",
        fontLeft && font ? `the uploaded font “${font.family}” (the link names it; others see Inter until they add the file)` : "",
      ].filter(Boolean);
      showToast({
        message: `${what.join(" and ")} ${r.stripped > 1 ? "aren't" : "isn't"} included in links (too large). Save the design (.json) to keep ${r.stripped > 1 ? "them" : "it"}.`,
        tone: "warn",
      });
    }
    return r.copied ? "Link copied!" : "URL updated";
  };

  const progress = createProgress(workspace);

  // "Describe a finish…": feature-flagged (off by default; src/describe/flag.ts, DEPLOY.md). The dialog,
  // the API client and the design-space description load only when it is first opened.
  let describeDialog: DescribeDialog | null = null;
  const openDescribe = async () => {
    if (!describeDialog) {
      const { DescribeDialog } = await import("./describe/dialog.ts");
      describeDialog = new DescribeDialog({
        getDesign: () => design,
        check: (code) => (stage.contextLost ? Promise.resolve(null) : stage.checkShader(code)),
        apply: (next, label) => {
          ui.activePreset = null;
          applyDesign(next, label);
        },
      });
    }
    await describeDialog.open();
  };

  const panel: Panel = new Panel($("panel"), design, ui, {
    presets: CARD_PRESETS,
    presetsExtra: pluginParts?.presetBlocks ?? [],
    hasReference: hasRef,
    describeFinish: describeFinishEnabled() ? () => void openDescribe() : undefined,
    library: () => library,
    drafts: listDrafts,
    thumbs,
    resolveUrl: (src) => assets.resolveUrl(src),
    folds: prefs.folds ?? {},
    onFold: (title, expanded) => {
      savePrefs({ folds: { ...loadPrefs().folds, [title]: expanded } });
      if (title === PRESETS_FOLDER && expanded) prioritizePresetThumbs();
    },
    sticker: {
      // The editor is created after the panel: read the selection from `ui` (the editor keeps it in step).
      selected: () => (ui.selectedSticker ? (design.decals.find((d) => d.id === ui.selectedSticker) ?? null) : null),
      live: () => editor.live(),
      cropping: () => editor.cropping,
      crop: () => (editor.cropping ? editor.commitCrop() : editor.enterCrop()),
      resetCrop: () => editor.resetCrop(),
      resetPicture: () => editor.resetPicture(),
      flip: (axis) => editor.flip(axis),
    },
    shaders: {
      onAdd: () => void openPicker(),
      onEdit: (i) => void shaderEditor.open(i),
      errors: () => [...stage.shaderErrors(), ...glslLayerErrors(design)],
      editing: () => shaderEditor?.editing ?? null,
    },
    hooks: {
      onChange: edited,
      onPresetCategory: (c) => {
        savePrefs({ presetCategory: c });
        prioritizePresetThumbs();
      },
      onPreset: (p) => {
        applyDesign(withPreset(design, p), p.name);
        ui.activePreset = p.id;
        panel.refresh();
      },
      onRandomize: () => applyDesign(randomizeDesign(design, { withEffects: ui.randomizeFx }), ui.randomizeFx ? "Randomize (with effects)" : "Randomize"),
      onResetDesign: () => {
        ui.activePreset = DEFAULT_PRESET_ID;
        applyDesign(defaultDesign(), "Reset");
      },
      onQuality: (q) => {
        savePrefs({ quality: q });
        void stage.setQuality(q);
      },
      onBackdrop: (b) => {
        savePrefs({ backdrop: b });
        syncBackdrop();
      },
      onLighting: () => syncBackdrop(),
      onLogoUpload: async () => {
        const [file] = await pickFiles("image/svg+xml,.svg,image/png,image/webp,image/jpeg,image/gif");
        if (!file) return;
        try {
          const logo = await logoFromFile(file);
          // Keep the placement of the logo being replaced.
          if (design.logo?.position) logo.position = design.logo.position;
          if (design.logo?.scale) logo.scale = design.logo.scale;
          design.logo = logo;
          panel.refresh();
          edited("logo");
          showSide("front");
        } catch (err) {
          showToast({ message: (err as Error).message, tone: "error" });
        }
      },
      onFontCustom: (tab) => void openFontDialog(tab),
      onLogoRemove: () => {
        if (!design.logo) return;
        delete design.logo;
        panel.refresh();
        edited("remove logo");
      },
      onSpin: (on) => setSpin(on),
      onFlip: () => stage.flip(),
      onResetView: () => stage.reset(),
      onAssets: (a) => {
        savePrefs({ assets: a });
        autosave(design);
        const url = new URL(location.href);
        url.searchParams.delete("assets");
        location.assign(url.href);
      },
      onArtworkUpload: async (side) => {
        const [file] = await pickFiles("image/*");
        if (!file) return;
        try {
          design.surfaceSources[side] = await artworkFromFile(file, ui.artworkFit);
          design.surfaceTreatments[side] ??= "inlay";
          panel.refresh();
          edited(`${side} artwork`);
          showSide(side);
        } catch (err) {
          showToast({ message: (err as Error).message, tone: "error" });
        }
      },
      onArtworkRemove: (side) => {
        delete design.surfaceSources[side];
        delete design.surfaceTreatments[side];
        panel.refresh();
        edited(`remove ${side} artwork`);
      },
      onDraw: async (side) => {
        const { DrawDialog } = await import("./draw/draw-dialog.ts");
        drawDialog ??= new DrawDialog();
        const src = design.surfaceSources[side];
        const result = await drawDialog.open(side, src ? assets.resolveUrl(src) : undefined);
        if (!result) return;
        design.surfaceSources[side] = result.dataUrl;
        design.surfaceTreatments[side] ??= "printed";
        panel.refresh();
        edited(`${side} drawing`);
        showSide(side);
      },
      onStickerAdd: (s) => addSticker(s),
      onStickerUpload: async () => {
        const files = await pickFiles("image/png,image/jpeg,image/webp,image/gif,image/svg+xml", true);
        if (!files.length) return;
        const added: LibrarySticker[] = [];
        for (const f of files) {
          try {
            added.push(await stickerFromFile(f));
          } catch (err) {
            showToast({ message: `${f.name}: ${(err as Error).message}`, tone: "error" });
          }
        }
        if (!added.length) return;
        library = [...library, ...added];
        if (!saveStickerLibrary(library)) showToast({ message: "Sticker library is full in this browser; new uploads last until you reload.", tone: "warn" });
        panel.refreshLibrary();
        addSticker(added[0]);
      },
      onLibraryRemove: (id) => {
        library = library.filter((s) => s.id !== id);
        saveStickerLibrary(library);
        panel.refreshLibrary();
      },
      onStickerSelect: (id) => {
        const d = design.decals.find((x) => x.id === id);
        if (d) showSide(d.side);
        editor.select(id);
      },
      onStickerRemove: (id) => removeSticker(id),
      onStickersClear: () => {
        if (!design.decals.length) return;
        editor.select(null);
        design.decals = [];
        panel.refreshPlaced();
        edited("remove all stickers");
      },
      onExportImage: async () => {
        try {
          const still = stillOfLive();
          const pose = liveQuaternion();
          await withExportStage((s) => exportImage(s, still, pose, outputSettings(), ui.imageFormat, ui.imageQuality));
        } catch (err) {
          showToast({ message: `Image export failed: ${(err as Error).message}`, tone: "error" });
          throw err;
        }
      },
      onExportClip: async () => {
        stopPreview();
        const ctrl = new AbortController();
        progress.start(`Recording ${ui.clipFormat.toUpperCase()}`, () => ctrl.abort());
        try {
          // The clip's clocks start fresh; vines start where the preview is.
          const t = liveSeconds();
          const clip = cloneDesign(design);
          const vines = clip.addons?.vines;
          await withExportStage((s) =>
            exportClip(s, clip, outputSettings(), {
              prime: vines && vines.cycle !== false && vines.time === undefined ? t % 80 : 0,
              format: ui.clipFormat,
              seconds: ui.clipSeconds,
              path: ui.clipPath,
              easing: ui.clipEasing === "auto" ? undefined : ui.clipEasing,
              fps: 30,
              pitch: -8,
              yaw: 0,
              signal: ctrl.signal,
              onProgress: (p) => progress.set(p),
            }),
          );
        } catch (err) {
          if ((err as Error).name !== "AbortError") showToast({ message: `Recording failed: ${(err as Error).message}`, tone: "error" });
          throw err;
        } finally {
          progress.stop();
        }
      },
      onPreviewPath: () => (previewFrame ? stopPreview() : startPreview()),
      onViewAr: async () => {
        const { ArDialog } = await import("./ui/ar-dialog.ts");
        arDialog ??= new ArDialog({
          usdz: () => arModel("usdz"),
          glb: () => arModel("glb"),
          fileBase: () => fileBase(design),
          title: () => design.cardholderName.trim() || "Card",
        });
        void arDialog.open();
      },
      onExportPrint: () => void openPrintDialog(),
      onExportCode: async () => {
        const { CodeDialog } = await import("./ui/code-dialog.ts");
        (codeDialog ??= new CodeDialog(() => design)).open();
      },
      onExportEmbed: async () => {
        const { EmbedDialog } = await import("./ui/embed-dialog.ts");
        (embedDialog ??= new EmbedDialog(() => design)).open();
      },
      onExportGltf: async () => {
        try {
          // The card engine's model (the AR export's GLB: real scale, baked faces).
          downloadBlob(await arModel("glb"), `${fileBase(design)}.glb`);
        } catch (err) {
          showToast({ message: `glTF export failed: ${(err as Error).message}`, tone: "error" });
          throw err;
        }
      },
      onExportSpec: () => {
        exportSpecJson(design);
        if (countEmbeddedMedia(design))
          showToast({ message: "The recipe spec leaves out uploaded images. Use Save design (.json) to keep them.", tone: "info" });
      },
      onSaveJson: () => exportDesignJson(design),
      onLoadJson: async () => {
        const [file] = await pickFiles("application/json,.json");
        if (!file) return;
        try {
          applyUntrusted(ensureDesign(JSON.parse(await file.text())), `Opened ${file.name}`, file.name);
        } catch (err) {
          showToast({ message: `Couldn't open ${file.name}: ${(err as Error).message}`, tone: "error" });
        }
      },
      onShare: shareLabel,
      onImportRecipe: async () => {
        const { ImportDialog } = await import("./ui/import-dialog.ts");
        (importDialog ??= new ImportDialog(
          () => design,
          (d) => applyUntrusted(d, "Imported recipe", "the imported JSON"),
        )).open();
      },
      onDraftSave: async () => {
        let thumb: string | undefined;
        try {
          thumb = await thumbScheduler.exclusive(() => renderThumb(getThumbStage(), stillOfLive(), 200, 125, null));
        } catch {
          thumb = undefined;
        }
        const name = design.cardholderName.trim() || "Untitled card";
        const r = saveDraft({ id: `draft-${Date.now().toString(36)}`, name, savedAt: Date.now(), thumb, design: cloneDesign(design) });
        if (r === "failed") throw new Error("Browser storage is full or unavailable");
        if (r === "without-media") showToast({ message: "Draft saved without its uploaded images (browser storage is full).", tone: "warn" });
        panel.refreshDrafts();
      },
      onDraftLoad: (id) => {
        const d = listDrafts().find((x) => x.id === id);
        if (d) applyDesign(ensureDesign(d.design), `Draft · ${d.name}`);
      },
      onDraftDelete: (id) => {
        const d = listDrafts().find((x) => x.id === id);
        deleteDraft(id);
        panel.refreshDrafts();
        if (d) showToast({ message: `Deleted “${d.name}”`, actionLabel: "Undo", onAction: () => (saveDraft(d), panel.refreshDrafts()) });
      },
    },
  });

  const outputSettings = () => ({
    width: Math.round(ui.width),
    height: Math.round(ui.height),
    transparent: ui.exportBackground === "transparent",
    background: ui.background,
    backdrop: ui.exportBackground === "scene" ? getLightingPreset(design.lighting).id : null,
  });

  /**
   * The AR model (real scale, baked faces) of the card as it is on screen, made by the card engine (its
   * `ar` part, loaded on first use) on the export stage at full quality.
   */
  const arModel = async (kind: "usdz" | "glb"): Promise<Blob> => {
    const still = stillOfLive();
    const type = kind === "usdz" ? "model/vnd.usdz+zip" : "model/gltf-binary";
    return new Blob([new Uint8Array(await withExportStage((s) => s.stage.exportAr(still, { format: kind })))], { type });
  };

  /**
   * Export → Print files…: the production package (export/print/, loaded on first use with pdf-lib).
   * Each bake renders the design as a still (as image exports do) flat with `bakePrint`, on the card
   * engine of the export stage.
   */
  let printDialog: import("./ui/print-dialog.ts").PrintDialog | null = null;
  const printBake = async (d: CardDesign, o: import("@card3d/core/print").PrintBakeOptions) => {
    const t = liveSeconds();
    const still = stillDesign(cloneDesign(d), t, { vinesTime: t % 80 });
    const { bakePrint } = await import("@card3d/core/print");
    return withExportStage((s) => bakePrint(s.stage, still, o));
  };
  const openPrintDialog = async () => {
    if (!printDialog) {
      const { PrintDialog } = await import("./ui/print-dialog.ts");
      printDialog = new PrintDialog({ design: () => design, printDeps: () => ({ bake: printBake, assets, fileBase: fileBase(design) }) });
    }
    printDialog.open();
  };

  // ── camera path preview: the live card plays the export's path ──
  let previewFrame = 0;
  const stopPreview = () => {
    if (!previewFrame) return;
    cancelAnimationFrame(previewFrame);
    previewFrame = 0;
    stage.setRotation([0, 0, 0]);
    stage.setLift(0);
    stage.setCameraOrbit(null);
    panel.setPreviewing(false);
    delete document.body.dataset.previewing;
  };
  function startPreview() {
    setSpin(false);
    stage.reset();
    const t0 = performance.now();
    panel.setPreviewing(true);
    document.body.dataset.previewing = ui.clipPath;
    const r = (deg: number) => (deg * Math.PI) / 180;
    const tick = (now: number) => {
      const path = getCameraPath(ui.clipPath);
      const seconds = Math.max(0.5, ui.clipSeconds);
      // Loops play on; one-shot paths hold their last pose for a moment, then play again.
      const elapsed = (now - t0) / 1000;
      const t = path.loop ? (elapsed / seconds) % 1 : Math.min(1, (elapsed % (seconds + 0.8)) / seconds);
      const pose = cameraPathPose(path.id, t, { easing: ui.clipEasing === "auto" ? undefined : ui.clipEasing, pitch: -8, yaw: 0 });
      stage.setRotation([r(pose.card.pitch), r(pose.card.yaw), r(pose.card.roll)]);
      stage.setLift(pose.card.lift);
      stage.setCameraOrbit(pose.camera);
      updateSide();
      previewFrame = requestAnimationFrame(tick);
    };
    previewFrame = requestAnimationFrame(tick);
  }
  // Grabbing the card ends the preview.
  stageEl.addEventListener("pointerdown", () => stopPreview(), { capture: true });

  // ── stickers ──
  const editor = new StickerEditor(stage, stageEl, {
    getDesign: () => design,
    onSelect: (id) => {
      ui.selectedSticker = id;
      panel.refreshPlaced();
    },
    onCommit: (label) => {
      panel.refreshPlaced();
      edited(label);
    },
    onRemove: (id) => removeSticker(id),
    onLive: () => panel.refreshSticker(),
    onCropMode: () => panel.refreshSticker(),
    generation: () => builds,
  });

  function addSticker(s: LibrarySticker) {
    const side = visibleSide();
    const jitter = () => (Math.random() - 0.5) * 16;
    const d: Decal = {
      id: `sticker-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      side,
      src: s.src,
      aspect: s.aspect,
      x: 50 + jitter(),
      y: 46 + jitter() * 0.6,
      width: s.aspect >= 1.4 ? 30 : 22,
      rotation: Math.round((Math.random() - 0.5) * 16),
      scale: 1,
    };
    design.decals.push(d);
    panel.refreshPlaced();
    edited("add sticker");
    editor.select(d.id);
  }

  function removeSticker(id: string) {
    const i = design.decals.findIndex((d) => d.id === id);
    if (i < 0) return;
    if (editor.selected === id) editor.select(null);
    design.decals.splice(i, 1);
    panel.refreshPlaced();
    edited("remove sticker");
  }

  // ── undo / redo ──
  const undo = () => {
    history.flush();
    const d = history.undo();
    if (d) applyDesign(d, undefined, false);
  };
  const redo = () => {
    history.flush();
    const d = history.redo();
    if (d) applyDesign(d, undefined, false);
  };
  const historyControls = new HistoryControls(workspace, {
    onUndo: undo,
    onRedo: redo,
    onJump: (id) => {
      history.flush();
      const d = history.jump(id);
      if (d) applyDesign(d, undefined, false);
    },
    onClear: () => {
      history.clear(design);
      showToast({ message: "History cleared", actionLabel: "Undo", onAction: () => history.undoClear() });
    },
  });
  history.reset(design, restored === "shared" ? "Shared link" : restored === "autosave" ? "Restored" : "Default");

  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || isTyping(e.target) || document.querySelector("dialog[open]")) return;
      if ((e.target as Element | null)?.closest?.(".c3-drawer")) return; // the code editor's own keys
      const k = e.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      e.preventDefault();
      if (k === "y" || e.shiftKey) redo();
      else undo();
    },
    true,
  );
  window.addEventListener("pointerdown", () => history.hold(), true);
  const flushOnRelease = () => queueMicrotask(() => history.release());
  window.addEventListener("pointerup", flushOnRelease, true);
  window.addEventListener("pointercancel", flushOnRelease, true);
  window.addEventListener("blur", flushOnRelease); // a release outside the window never arrives

  // ── side indicator / flip ──
  function updateSide() {
    const side = editor?.visibleSide?.() ?? "front";
    sideBtn.dataset.side = side;
    sideBtn.querySelector(".c3-side-label")!.textContent = side === "front" ? "Front" : "Back";
  }
  sideBtn.addEventListener("click", () => stage.flip());
  $<HTMLButtonElement>("reset-view").addEventListener("click", () => stage.reset());

  // ── turntable preview ──
  let spinFrame = 0;
  let spinLast = 0;
  function setSpin(on: boolean) {
    if (on) stopPreview();
    ui.spin = on;
    cancelAnimationFrame(spinFrame);
    spinLast = performance.now();
    if (!on) return;
    const step = (now: number) => {
      const it = stage.interaction;
      if (it) {
        const dt = Math.min(0.05, (now - spinLast) / 1000);
        it.setRotation({ x: it.rot.x, y: it.rot.y - 24 * dt });
        updateSide();
      }
      spinLast = now;
      spinFrame = requestAnimationFrame(step);
    };
    spinFrame = requestAnimationFrame(step);
  }

  // ── go ──
  scheduleRebuild();
  pluginParts?.ready?.();
  if (restored === "autosave") {
    showToast({
      message: "Restored your last design.",
      actionLabel: "Start fresh",
      onAction: () => applyDesign(defaultDesign(), "Start fresh"),
      duration: 6000,
    });
  } else if (restored === "shared") {
    if (gated.length) showGate("this link");
    else showToast("Loaded a shared design.");
  }

  // Preset thumbnails: from the cache when possible, else rendered lazily once the main card is up —
  // the category on screen first, the others only when the user is idle (export/thumbs.ts).
  const PRESETS_FOLDER = "Presets";
  const presetsOpen = () => loadPrefs().folds?.[PRESETS_FOLDER] !== false;
  const presetThumbBase = () => {
    const base = defaultDesign();
    base.cardholderName = "";
    return base;
  };
  /** Animated presets are rendered as stills: shader clocks frozen, vines grown. */
  const presetThumbRequest = (p: (typeof CARD_PRESETS)[number], base: CardDesign): ThumbRequest => ({
    id: p.id,
    design: stillDesign(withPreset(base, p), 1.6, { vinesGrown: true }),
    width: 240,
    height: 150,
  });
  const onPresetThumb = (id: string, url: string) => {
    thumbs.set(id, url);
    panel.setThumb(id, url);
  };
  const visiblePresetIds = () => (presetsOpen() ? CARD_PRESETS.filter((p) => p.category === ui.presetCategory).map((p) => p.id) : []);
  let thumbsStarted = false;
  function startThumbs() {
    if (thumbsStarted) return;
    thumbsStarted = true;
    const base = presetThumbBase();
    const visible = new Set(visiblePresetIds());
    const req = (pick: boolean) => CARD_PRESETS.filter((p) => visible.has(p.id) === pick && !thumbs.has(p.id)).map((p) => presetThumbRequest(p, base));
    thumbScheduler.request(req(true), "visible", onPresetThumb);
    thumbScheduler.request(req(false), "idle", onPresetThumb);
  }
  function prioritizePresetThumbs() {
    if (thumbsStarted) thumbScheduler.prioritize(visiblePresetIds());
  }

  if (import.meta.env.DEV)
    Object.assign(window, { studio: { stage, design, history, editor, panel, ui, shaderEditor, thumbScheduler, applyDesign, getExportStage, arModel } });
}

/** Replace `target`'s contents with `src`, keeping the `target` and `target.recipe` objects. */
function assign(target: CardDesign, src: CardDesign): void {
  const next = cloneDesign(src);
  const recipe = target.recipe;
  for (const k of Object.keys(target) as (keyof CardDesign)[]) if (!(k in next)) delete target[k];
  Object.assign(target, next);
  for (const k of Object.keys(recipe)) if (!(k in next.recipe)) delete (recipe as unknown as Record<string, unknown>)[k];
  Object.assign(recipe, next.recipe);
  target.recipe = recipe;
}

function applyBackdrop(b: Backdrop, lighting: CardDesign["lighting"]): void {
  const root = document.documentElement;
  const preset = getLightingPreset(lighting);
  root.dataset.backdrop = b;
  root.dataset.tone = b === "checker" || preset.backdrop.dark ? "dark" : "light";
  root.style.setProperty("--stage-backdrop", lightingBackdropCss(preset.id));
}

/** A small progress pill over the stage (turntable recording), with Cancel. */
function createProgress(host: HTMLElement) {
  const bar = h("span.c3-progress-bar");
  const label = h("span.c3-progress-label");
  const cancel = h("button.c3-progress-x", { type: "button", text: "Cancel" });
  const el = h("div.c3-progress", { role: "status", hidden: true }, label, h("span.c3-progress-track", {}, bar), cancel);
  host.append(el);
  let onCancel: (() => void) | null = null;
  cancel.addEventListener("click", () => onCancel?.());
  return {
    start(text: string, cancelFn: () => void) {
      label.textContent = text;
      bar.style.transform = "scaleX(0)";
      onCancel = cancelFn;
      el.hidden = false;
    },
    set(p: number) {
      bar.style.transform = `scaleX(${p.toFixed(3)})`;
    },
    stop() {
      el.hidden = true;
      onCancel = null;
    },
  };
}

boot().catch((err) => {
  console.error(err);
  statusEl.textContent = `Couldn't start the studio: ${(err as Error).message}`;
  statusEl.classList.add("is-on", "is-error");
});
