/**
 * The headless preview page of `pnpm finish render` (cli.mjs serves it with Vite and drives it with
 * Playwright). It renders a design exactly as Card Studio's image export does (the studio's own
 * export stage on the card engine; clocks frozen like its stills, the lighting preset's backdrop behind
 * the card). The engine compiles custom WGSL layers and reports those that don't build as skipped;
 * GLSL layers (the three.js engine's language) are skipped and reported as compile errors.
 * Workspace-only: never part of the studio build.
 */
import { ensureDesign, getLightingPreset, paintLightingBackdrop, registerCardFonts } from "@card3d/core/model";
import { createPublicAssets, type ShaderError } from "@card3d/core/editor";
import { ExportStage, rotationQuaternion } from "../src/export/offscreen.ts";
import { stillDesign } from "../src/state/fx.ts";

export interface PreviewPose {
  name: string;
  /** Degrees, the card interaction's composition (pitch about X, then yaw about Y). */
  pitch: number;
  yaw: number;
  /**
   * Close-up: render this many times larger and keep the window of the output size centred at
   * `focus` (fractions of the frame, default the centre), so fine surface texture is visible.
   */
  zoom?: number;
  focus?: [number, number];
}

export interface PreviewRequest {
  design: unknown;
  width: number;
  height: number;
  poses: PreviewPose[];
  /** Shader clocks frozen at this time (s), like the studio's stills. */
  time: number;
}

export interface PreviewResult {
  /** PNG data URLs by pose name. */
  images: Record<string, string>;
  /** Custom layers in GLSL (index into design.shaders): the card engine skips them. */
  compile: { index: number; errors: ShaderError[] }[];
  /** Layers the card skipped when it drew them. */
  skipped: { index: number; side: string; errors: ShaderError[] }[];
}

registerCardFonts();
let off: ExportStage | null = null;

async function finishPreview(req: PreviewRequest): Promise<PreviewResult> {
  const design = ensureDesign(req.design);
  off ??= new ExportStage(createPublicAssets(), "full");
  // GLSL layers don't run on the card engine (it reports WGSL layers that don't build as skipped).
  const compile = (design.shaders ?? []).flatMap((l, index) =>
    l.id === "custom" && l.language !== "wgsl"
      ? [{ index, errors: [{ line: 0, message: 'custom layers are WGSL: set language: "wgsl" and write fn mainImage(uv: vec2f) -> vec4f' }] }]
      : [],
  );

  await off.setDesign(stillDesign(design, req.time, { vinesGrown: true }), null);
  const backdrop = getLightingPreset(design.lighting).id;
  const images: Record<string, string> = {};
  for (const pose of req.poses) {
    const zoom = Math.max(1, pose.zoom ?? 1);
    const w = Math.round(req.width * zoom);
    const h = Math.round(req.height * zoom);
    const opts = { width: w, height: h, quaternion: rotationQuaternion(pose.pitch, pose.yaw) };
    off.frame(opts); // first draw fills face-shader skins and compiles programs
    const src = off.frame(opts);
    const out = document.createElement("canvas");
    out.width = req.width;
    out.height = req.height;
    const ctx = out.getContext("2d")!;
    const [fx, fy] = pose.focus ?? [0.5, 0.5];
    const sx = Math.min(w - req.width, Math.max(0, Math.round(fx * w - req.width / 2)));
    const sy = Math.min(h - req.height, Math.max(0, Math.round(fy * h - req.height / 2)));
    if (zoom > 1) {
      // the backdrop of the whole (zoomed) frame, then the same window of the card
      const full = document.createElement("canvas");
      full.width = w;
      full.height = h;
      const fctx = full.getContext("2d")!;
      paintLightingBackdrop(fctx, w, h, backdrop);
      fctx.drawImage(src, 0, 0, w, h);
      ctx.drawImage(full, sx, sy, req.width, req.height, 0, 0, req.width, req.height);
    } else {
      paintLightingBackdrop(ctx, req.width, req.height, backdrop);
      ctx.drawImage(src, 0, 0, req.width, req.height);
    }
    images[pose.name] = out.toDataURL("image/png");
  }
  const skipped = off.shaderErrors().map((e) => ({ index: e.index, side: e.side, errors: e.errors as ShaderError[] }));
  return { images, compile, skipped };
}

Object.assign(window, { finishPreview, finishReady: true });
