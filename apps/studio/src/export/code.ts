/**
 * Code snippets that render the current design with the card engine's stage API
 * (`createEngineStage`, `@card3d/core/engine`: WebGPU, else its WebGL 2 build), and the framework
 * snippets that mount the same API from a lifecycle hook. The drop-in embeds (`<metal-card>`,
 * `<MetalCard>`) are in embed.ts.
 */
import { DEFAULT_RECIPE, type CardDesign, type Recipe } from "@card3d/core/model";
import { cardFrameSize } from "@card3d/core/editor";
import { isEmbeddedMedia } from "../state/design.ts";

export type CodeTarget = "vanilla" | "react" | "vue" | "svelte" | "json";

export const CODE_TARGETS: { id: CodeTarget; label: string; file: string }[] = [
  { id: "vanilla", label: "Vanilla TS", file: "card.ts" },
  { id: "react", label: "React", file: "Card.tsx" },
  { id: "vue", label: "Vue", file: "Card.vue" },
  { id: "svelte", label: "Svelte", file: "Card.svelte" },
  { id: "json", label: "Design JSON", file: "card.json" },
];

export interface SnippetResult {
  code: string;
  /** Inline uploads replaced by placeholder paths. */
  placeholders: string[];
}

const SHADER_MARK = (i: number) => `__card3d_shader_${i}__`;

/** Where the snippets point uploads they can't inline (the user hosts the files there). */
export const artworkPlaceholder = (side: string) => `/card/${side}-artwork.png`;
export const stickerPlaceholder = (src: string, i: number) => `/card/sticker-${i + 1}.${/^data:image\/gif/i.test(src) ? "gif" : "png"}`;
export const LOGO_PLACEHOLDER = "/card/logo.png";
/** An uploaded font that isn't inlined becomes a same-origin `url` font at this path. */
export const fontPlaceholder = (src: string) => `/card/font.${/^data:font\/(woff2|woff|ttf|otf)/i.exec(src)?.[1].toLowerCase() ?? "woff2"}`;

/**
 * The design with inline uploads swapped for placeholder file paths, and a lean recipe. With
 * `hoistShaders`, custom WGSL is replaced by markers and returned in `shaderSources` (the JS snippets
 * declare it as template literals above the design). Uploads whose data URL is in `keep` stay inline.
 */
export function portableDesign(
  d: CardDesign,
  hoistShaders = false,
  keep: ReadonlySet<string> = new Set(),
): { design: Record<string, unknown>; placeholders: string[]; shaderSources: string[] } {
  const placeholders: string[] = [];
  const inline = (src: string) => !isEmbeddedMedia(src) || keep.has(src);
  const recipe: Partial<Recipe> = {};
  for (const k of Object.keys(d.recipe) as (keyof Recipe)[]) {
    if (d.recipe[k] !== DEFAULT_RECIPE[k]) (recipe as Record<string, unknown>)[k] = d.recipe[k];
  }
  const surfaceSources: Record<string, string> = {};
  for (const [side, src] of Object.entries(d.surfaceSources)) {
    if (!src) continue;
    if (!inline(src)) {
      const path = artworkPlaceholder(side);
      placeholders.push(path);
      surfaceSources[side] = path;
    } else surfaceSources[side] = src;
  }
  const decals = d.decals.map((x, i) => {
    if (inline(x.src)) return x;
    const path = stickerPlaceholder(x.src, i);
    placeholders.push(path);
    return { ...x, src: path };
  });
  const design: Record<string, unknown> = {
    recipe,
    cardholderName: d.cardholderName,
    cardholderBio: d.cardholderBio,
    decals,
    surfaceSources,
    surfaceTreatments: d.surfaceTreatments,
  };
  if (d.materialOverride) design.materialOverride = d.materialOverride;
  if (d.brandingOverride) design.brandingOverride = d.brandingOverride;
  if (d.frontLayout) design.frontLayout = d.frontLayout;
  if (d.addons && Object.keys(d.addons).length) design.addons = d.addons;
  if (d.font && typeof d.font === "object" && d.font.source === "upload" && d.font.src && !inline(d.font.src)) {
    // The file is hosted by the user: the snippet loads it from there.
    const path = fontPlaceholder(d.font.src);
    placeholders.push(path);
    design.font = { source: "url", family: d.font.family, src: path };
  } else if (d.font) design.font = d.font;
  if (d.logo) {
    if (d.logo.src && !inline(d.logo.src)) {
      const path = LOGO_PLACEHOLDER;
      placeholders.push(path);
      design.logo = { ...d.logo, src: path };
    } else design.logo = d.logo;
  }
  // The stage applies the design's lighting preset itself; the page backdrop is the host's
  // (lightingBackdropCss(design.lighting) gives the preset's).
  if (d.lighting) design.lighting = d.lighting;
  // Card body and typography beyond the standard card (all optional; absent = the standard card).
  if (d.finish && Object.keys(d.finish).length) design.finish = d.finish;
  if (d.edge) design.edge = d.edge;
  if (d.shape) design.shape = d.shape;
  if (d.contactless) design.contactless = d.contactless;
  if (d.textLines?.length) design.textLines = d.textLines;
  // Product-shot staging (environment, backdrop, floor): the stage loads it on first use.
  if (d.scene && Object.keys(d.scene).length) design.scene = d.scene;
  const shaderSources: string[] = [];
  if (d.shaders?.length) {
    design.shaders = d.shaders.map((l) => {
      if (!hoistShaders || l.id !== "custom" || !l.code) return l;
      shaderSources.push(l.code);
      return { ...l, code: SHADER_MARK(shaderSources.length) };
    });
  }
  return { design, placeholders, shaderSources };
}

/** Template-literal declarations (`const shader1 = …`) for the hoisted custom shader sources. */
function shaderDeclarations(sources: string[]): string {
  return sources
    .map(
      (src, i) =>
        `const shader${i + 1} = /* wgsl */ \`\n${src.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/\n*$/, "\n")}\`;\n\n`,
    )
    .join("");
}

const linkShaders = (lit: string, n: number) => {
  let out = lit;
  for (let i = 1; i <= n; i++) out = out.replace(`"${SHADER_MARK(i)}"`, `shader${i}`);
  return out;
};

/** JSON → JS object literal style: identifier keys unquoted. */
const jsLiteral = (json: string) => json.replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:");

const indent = (s: string, n: number) => s.replace(/\n/g, "\n" + " ".repeat(n));

function designLiteral(design: Record<string, unknown>): string {
  // `recipe` goes through normalizeRecipe so the snippet only lists what differs from the default.
  const { recipe, ...rest } = design;
  const body = jsLiteral(JSON.stringify(rest, null, 2))
    .slice(1, -1)
    .trim();
  return `{\n  recipe: normalizeRecipe(${indent(jsLiteral(JSON.stringify(recipe, null, 2)), 2)}),\n  ${body}\n}`;
}

const INSTALL = `// pnpm add @card3d/core
// (not on npm yet: link the workspace package from this repo. Drop-in components: Export → Embed.)`;

export function generateSnippet(d: CardDesign, target: CodeTarget): SnippetResult {
  if (target === "json") {
    const { design, placeholders } = portableDesign(d);
    return { code: JSON.stringify(design, null, 2), placeholders };
  }
  const { design, placeholders, shaderSources } = portableDesign(d, true);
  const lit = linkShaders(designLiteral(design), shaderSources.length);
  const shaders = shaderDeclarations(shaderSources);
  const note = placeholders.length
    ? `\n// Uploads can't be inlined here: host them and keep these paths, or change them:\n${placeholders.map((p) => `//   ${p}`).join("\n")}`
    : "";
  const imports = `import { createEngineStage } from "@card3d/core/engine";
import { normalizeRecipe, type CardDesign } from "@card3d/core/model";`;
  const ratio = cardFrameSize(d).portrait ? "5 / 8" : "16 / 10";
  const backdrop = d.lighting
    ? `\n// The lighting preset's backdrop behind the (transparent) canvas.\ncanvas.parentElement!.style.background = lightingBackdropCss(design.lighting);\n`
    : "";

  if (target === "vanilla") {
    return {
      placeholders,
      code: `${INSTALL}${note}
${d.lighting ? imports.replace("normalizeRecipe, ", "lightingBackdropCss, normalizeRecipe, ") : imports}

${shaders}const design: CardDesign = ${lit};

// The canvas fills its container; size the container with CSS (e.g. 640×400).
const canvas = document.querySelector<HTMLCanvasElement>("#card")!;
const stage = createEngineStage(canvas, {
  quality: "full",       // or "performance" on low-end devices
  interactive: true,     // drag to turn, click to flip, double-click to reset
  fit: "contain",        // fill the canvas (keeps every corner in view as it turns); "studio": the studio camera
});
await stage.setDesign(design);
${backdrop}
// Later: stage.flip(), stage.reset(), stage.setDesign(next), stage.dispose()
`,
    };
  }

  if (target === "react") {
    return {
      placeholders,
      code: `${INSTALL}
// The engine API from an effect; for a drop-in component use @card3d/react (Export → Embed).${note}
import { useEffect, useRef } from "react";
${imports}

${shaders}const design: CardDesign = ${lit};

export function Card({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const stage = createEngineStage(ref.current!, { quality: "full" });
    void stage.setDesign(design);
    return () => stage.dispose();
  }, []);
  return <canvas ref={ref} className={className} style={{ width: "100%", aspectRatio: "${ratio}" }} />;
}
`,
    };
  }

  if (target === "vue") {
    return {
      placeholders,
      code: `<!-- ${INSTALL.replace(/\/\/ /g, "").replace(/\n/g, " ")}
     The engine API from onMounted; or use the <metal-card> element (Export → Embed). -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
${imports}${note}

${shaders}const design: CardDesign = ${lit};

const canvas = ref<HTMLCanvasElement>();
let stage: ReturnType<typeof createEngineStage> | undefined;
onMounted(() => {
  stage = createEngineStage(canvas.value!, { quality: "full" });
  void stage.setDesign(design);
});
onBeforeUnmount(() => stage?.dispose());
</script>

<template>
  <canvas ref="canvas" style="width: 100%; aspect-ratio: ${ratio}" />
</template>
`,
    };
  }

  return {
    placeholders,
    code: `<!-- ${INSTALL.replace(/\/\/ /g, "").replace(/\n/g, " ")}
     The engine API from onMount; or use the <metal-card> element (Export → Embed). -->
<script lang="ts">
  import { onMount } from "svelte";
  ${indent(imports, 2)}${indent(note, 2)}

  ${indent(shaders, 2)}const design: CardDesign = ${indent(lit, 2)};

  let canvas: HTMLCanvasElement;
  onMount(() => {
    const stage = createEngineStage(canvas, { quality: "full" });
    void stage.setDesign(design);
    return () => stage.dispose();
  });
</script>

<canvas bind:this={canvas} style="width: 100%; aspect-ratio: ${ratio}"></canvas>
`,
  };
}
