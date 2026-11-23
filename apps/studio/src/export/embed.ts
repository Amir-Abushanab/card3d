/**
 * "Embed": copy-paste snippets that put the current design on any page with the drop-in packages —
 * `<metal-card>` from a CDN, `<metal-card>` from npm, and React's `<MetalCard>`. The design travels
 * in the snippet: as JSON (uploads inlined as data URLs within `EMBED_INLINE_LIMIT`, larger ones
 * replaced by placeholder paths), or as a share token (shorter; leaves uploads out like a share link).
 */
import { embeddedFont, encodeDesignToken, type CardDesign } from "@card3d/core/model";
import { cardFrameSize } from "@card3d/core/editor";
import { isEmbeddedMedia } from "../state/design.ts";
import { LOGO_PLACEHOLDER, artworkPlaceholder, fontPlaceholder, portableDesign, stickerPlaceholder } from "./code.ts";

export type EmbedTarget = "cdn" | "element" | "react";

export const EMBED_TARGETS: { id: EmbedTarget; label: string; file: string }[] = [
  { id: "cdn", label: "HTML · CDN", file: "card.html" },
  { id: "element", label: "npm · <metal-card>", file: "card.html" },
  { id: "react", label: "React", file: "Card.tsx" },
];

/** Inline uploads (data URLs) in total, characters. More than this and the rest become placeholders. */
export const EMBED_INLINE_LIMIT = 256 * 1024;

/** The published version line the CDN URL pins (major.minor of @card3d/element). */
const VERSION = __CARD3D_ELEMENT_VERSION__.split(".").slice(0, 2).join(".");
export const CDN_URL = `https://cdn.jsdelivr.net/npm/@card3d/element@${VERSION}/dist/standalone/metal-card.js`;

export interface EmbedMedia {
  /** "Logo", "Front artwork", "Sticker 2", … */
  what: string;
  /** Data URL length (characters). */
  chars: number;
  inlined: boolean;
  /** The path the snippet uses instead, when not inlined. */
  placeholder?: string;
}

export interface EmbedOptions {
  /** Design as a share token instead of JSON (uploads other than the logo are left out). */
  compact?: boolean;
  inlineLimit?: number;
}

export interface EmbedResult {
  code: string;
  media: EmbedMedia[];
  /** Uploads a share token leaves out (compact only). */
  stripped: number;
}

/** Every inline upload of the design, in inlining priority (logo, font, artwork, stickers). */
function uploads(d: CardDesign): { what: string; src: string; placeholder: string }[] {
  const out: { what: string; src: string; placeholder: string }[] = [];
  if (d.logo?.src && isEmbeddedMedia(d.logo.src)) out.push({ what: "Logo", src: d.logo.src, placeholder: LOGO_PLACEHOLDER });
  const font = embeddedFont(d);
  if (font) out.push({ what: "Font", src: font, placeholder: fontPlaceholder(font) });
  for (const side of ["front", "back"] as const) {
    const src = d.surfaceSources[side];
    if (src && isEmbeddedMedia(src)) out.push({ what: `${side === "front" ? "Front" : "Back"} artwork`, src, placeholder: artworkPlaceholder(side) });
  }
  d.decals.forEach((x, i) => {
    if (isEmbeddedMedia(x.src)) out.push({ what: `Sticker ${i + 1}`, src: x.src, placeholder: stickerPlaceholder(x.src, i) });
  });
  return out;
}

/** Which uploads to inline: data URLs (blob: URLs only live in this tab), in order, while they fit. */
export function planMedia(d: CardDesign, limit = EMBED_INLINE_LIMIT): { keep: Set<string>; media: EmbedMedia[] } {
  const keep = new Set<string>();
  const media: EmbedMedia[] = [];
  let used = 0;
  for (const u of uploads(d)) {
    const fits = /^data:/i.test(u.src) && (keep.has(u.src) || used + u.src.length <= limit);
    if (fits && !keep.has(u.src)) {
      keep.add(u.src);
      used += u.src.length;
    }
    media.push({ what: u.what, chars: u.src.length, inlined: fits, ...(fits ? {} : { placeholder: u.placeholder }) });
  }
  return { keep, media };
}

/** JSON for a single-quoted HTML attribute. */
const attrJson = (v: unknown) => JSON.stringify(v).replace(/&/g, "&amp;").replace(/'/g, "&#39;");
/** JSON → JS object literal style: identifier keys unquoted. */
const jsLiteral = (json: string) => json.replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:");
const indent = (s: string, n: number) => s.replace(/\n/g, "\n" + " ".repeat(n));

export async function generateEmbed(d: CardDesign, target: EmbedTarget, opts: EmbedOptions = {}): Promise<EmbedResult> {
  const backdrop = d.lighting && d.lighting !== "studio";
  let designAttr: string;
  let token = "";
  let designObject: Record<string, unknown> | null = null;
  let media: EmbedMedia[];
  let stripped = 0;

  if (opts.compact) {
    const r = await encodeDesignToken(d);
    stripped = r.stripped;
    token = r.token;
    designAttr = `share="${token}"`;
    media = uploads(d).map((u) => ({ what: u.what, chars: u.src.length, inlined: u.what === "Logo" }));
  } else {
    const plan = planMedia(d, opts.inlineLimit);
    media = plan.media;
    designObject = portableDesign(d, false, plan.keep).design;
    designAttr = `design='${attrJson(designObject)}'`;
  }

  const missing = media.filter((m) => !m.inlined && m.placeholder);
  const paths = missing.map((m) => `${m.placeholder} (${m.what})`);
  const jsNote = paths.length
    ? `// Too large to inline: host these uploads at these paths (or change them in the design):\n${paths.map((p) => `//   ${p}`).join("\n")}\n`
    : "";
  const htmlNote = paths.length
    ? `<!-- Too large to inline: host these uploads at these paths (or change them in the design):\n${paths.map((p) => `     ${p}`).join("\n")} -->\n`
    : "";
  const attrs = [designAttr, ...(backdrop ? ["backdrop"] : [])];
  // A portrait card gets a portrait box (the element's default is 8:5).
  const portrait = cardFrameSize(d).portrait;
  const css = portrait ? "width: 300px; aspect-ratio: 5 / 8" : "width: 480px";
  const jsx = portrait ? `{{ width: 300, aspectRatio: "5 / 8" }}` : "{{ width: 480 }}";

  if (target === "cdn") {
    return {
      media,
      stripped,
      code: `<!-- <metal-card> from a CDN: one script; the card engine loads its parts as the design needs them. -->
${htmlNote}<script type="module" src="${CDN_URL}"></script>

<metal-card
  ${attrs.join("\n  ")}
  style="${css}"
></metal-card>
`,
    };
  }

  if (target === "element") {
    const assign = designObject
      ? `card.design = ${indent(jsLiteral(JSON.stringify(designObject, null, 2)), 2)};`
      : `card.setAttribute("share", ${JSON.stringify(token)});`;
    return {
      media,
      stripped,
      code: `<!-- pnpm add @card3d/element
     Vue: tell the compiler it's a custom element (compilerOptions.isCustomElement = (t) => t === "metal-card"). -->
${htmlNote}<metal-card id="card"${backdrop ? " backdrop" : ""} style="${css}"></metal-card>

<script type="module">
  import "@card3d/element";

  const card = document.getElementById("card");
  ${assign}
</script>
`,
    };
  }

  const designProp = designObject ? "design={design}" : `share="${token}"`;
  return {
    media,
    stripped,
    code: `// pnpm add @card3d/react
${jsNote}import { MetalCard } from "@card3d/react";
${designObject ? `\nconst design = ${jsLiteral(JSON.stringify(designObject, null, 2))};\n` : ""}
export function Card() {
  return <MetalCard ${designProp}${backdrop ? " backdrop" : ""} style=${jsx} />;
}
`,
  };
}
