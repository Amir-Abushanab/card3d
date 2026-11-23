/**
 * Vite plugin for the single-file standalone builds (core and element): keeps the card fonts as
 * separate files loaded at runtime instead of letting lib mode inline ~380 KB of woff2 as base64.
 *
 * src/fonts.ts writes each face as `new URL("../assets/fonts/<file>", import.meta.url)`. In the
 * standalone bundle `import.meta.url` is the bundle's own URL (on a CDN:
 * …/dist/standalone/<bundle>.js), so the path is rewritten relative to it (`base`), and split so
 * Vite's asset plugin leaves it alone. With `copyTo`, the font files and their licences are copied
 * there (the element ships its own copy next to its bundle).
 */
import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FONTS_DIR = resolve(import.meta.dirname, "../assets/fonts");
const ENV_DIR = resolve(import.meta.dirname, "../assets/environments");

/**
 * In an IIFE (classic script) there is no `import.meta`: `scriptUrl` names a variable holding the
 * script's own URL instead, which `standaloneIntro()` defines inside the bundle's wrapper.
 *
 * @param {{ base?: string, copyTo?: string, scriptUrl?: string }} [opts]
 */
export function standaloneFonts(opts = {}) {
  const base = opts.base ?? "../../assets/fonts/";
  const envBase = opts.envBase ?? "../../assets/environments/";
  const urlBase = opts.scriptUrl ?? "import.meta.url";
  return {
    name: "card3d:standalone-fonts",
    enforce: "pre",
    transform(code, id) {
      // The scene environments (scene/marketing/environment-files.ts) load from next to the bundle too.
      if (/[\\/]core[\\/]src[\\/]scene[\\/]marketing[\\/]environment-files\.ts$/.test(id)) {
        let n = 0;
        const out = code.replace(/new URL\("\.\.\/\.\.\/\.\.\/assets\/environments\/([\w.-]+\.webp)", import\.meta\.url\)/g, (_m, file) => {
          n++;
          return `new URL(${JSON.stringify(envBase)} + ${JSON.stringify(file)}, ${urlBase})`;
        });
        if (!n) this.error("card3d:standalone-fonts: no environment URLs found in scene/marketing/environment-files.ts");
        return { code: out, map: null };
      }
      if (!/[\\/]core[\\/]src[\\/]fonts\.ts$/.test(id)) return null;
      let n = 0;
      const out = code.replace(/new URL\("\.\.\/assets\/fonts\/([\w.-]+\.woff2)", import\.meta\.url\)/g, (_m, file) => {
        n++;
        return `new URL(${JSON.stringify(base)} + ${JSON.stringify(file)}, ${urlBase})`;
      });
      if (!n) this.error("card3d:standalone-fonts: no font URLs found in src/fonts.ts");
      return { code: out, map: null };
    },
    writeBundle(options) {
      if (!opts.copyTo) return;
      const to = resolve(options.dir ?? "", opts.copyTo);
      mkdirSync(to, { recursive: true });
      cpSync(FONTS_DIR, to, { recursive: true });
      if (opts.envCopyTo) {
        const env = resolve(options.dir ?? "", opts.envCopyTo);
        mkdirSync(env, { recursive: true });
        cpSync(ENV_DIR, env, { recursive: true });
      }
    },
  };
}

const ENGINE_DIR = resolve(import.meta.dirname, "../wasm");

/**
 * The Rust engine in a standalone bundle: wasm/loader.js imports each build as `./pkg/…` and
 * `./pkg-webgl/…`; lib mode would inline their wasm as base64. The imports become runtime URLs
 * relative to the bundle (`base`), which Vite leaves alone, and `copyTo` copies both builds there
 * (hashed file names, loaded on first use: a page downloads one build and only the parts its designs use).
 *
 * @param {{ base?: string, copyTo?: string, scriptUrl?: string }} [opts]
 */
export function standaloneEngine(opts = {}) {
  const base = opts.base ?? "./engine/";
  const urlBase = opts.scriptUrl ?? "import.meta.url";
  return {
    name: "card3d:standalone-engine",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]core[\\/]wasm[\\/]loader\.js$/.test(id)) return null;
      let n = 0;
      const out = code.replace(/import\("\.\/(pkg(?:-webgl)?)\/card3d_web\.js"\)/g, (_m, dir) => {
        n++;
        return `import(/* @vite-ignore */ new URL(${JSON.stringify(base)} + ${JSON.stringify(`${dir}/card3d_web.js`)}, ${urlBase}).href)`;
      });
      if (n !== 2) this.error(`card3d:standalone-engine: expected the two build imports in wasm/loader.js, found ${n}`);
      return { code: out, map: null };
    },
    writeBundle(options) {
      if (!opts.copyTo) return;
      const to = resolve(options.dir ?? "", opts.copyTo);
      for (const dir of ["pkg", "pkg-webgl"]) {
        mkdirSync(resolve(to, dir), { recursive: true });
        cpSync(resolve(ENGINE_DIR, dir), resolve(to, dir), { recursive: true, filter: (f) => !f.endsWith(".d.ts") });
      }
    },
  };
}

/**
 * Dynamic imports the ES standalone builds keep as separate chunks, loaded on first use:
 * - the marquee (`src/marquee.ts`, the bundles' `loadMarquee()`);
 * - the AR export's page side (`wasm/ar.js`; its wasm part is the engine's `ar` chunk).
 * Every other dynamic import becomes a static one (inlined into whichever chunk asked).
 */
const LAZY_CHUNKS = [/\/core\/src\/marquee\.ts$/, /\/core\/wasm\/ar\.js$/];

/**
 * `output.codeSplitting` for the ES standalone builds. With several lazy chunks, rolldown on its own
 * moves what they share with the entry (the engine's page side, the model) into common chunks the entry
 * imports statically: a plain card would need several files. One group of every module the entry loads
 * statically (`$initial`) keeps them in the entry itself (with `preserveEntrySignatures:
 * "allow-extension"`): the bundle stays one file, and the lazy chunks import what they share from it.
 */
export const STANDALONE_CODE_SPLITTING = { groups: [{ name: "main", tags: ["$initial"] }] };

/**
 * The ES standalone builds split off only LAZY_CHUNKS; every other dynamic import becomes a static
 * import of the chunk that asked for it. The IIFE (which can't load chunks) doesn't use this: code splitting is off
 * there, inlining everything.
 */
export function standaloneLazyChunks() {
  return {
    name: "card3d:standalone-lazy-chunks",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]core[\\/]src[\\/].*\.ts$/.test(id) || !code.includes("import(")) return null;
      const imports = [];
      let n = 0;
      // (Not type positions: `import("…").SomeType`.)
      const out = code.replace(/\bimport\(\s*"([^"]+)"\s*\)(?!\.[A-Z])/g, (m, spec) => {
        const target = spec.startsWith(".") ? resolve(dirname(id.split("?")[0]), spec).replaceAll("\\", "/") : spec;
        if (LAZY_CHUNKS.some((re) => re.test(target))) return m;
        const name = `__card3dInline${n++}`;
        imports.push(`import * as ${name} from ${JSON.stringify(spec)};`);
        return `Promise.resolve(${name})`;
      });
      if (!imports.length) return null;
      return { code: `${imports.join("\n")}\n${out}`, map: null };
    },
  };
}

/**
 * The licence banner of a standalone bundle: the card engine it loads (the wasm builds) carries code
 * ported from three.js and Paper Shaders, and it loads the OFL card fonts.
 */
export function standaloneBanner(name) {
  return `/*! ${name} standalone | MIT | https://github.com/Amir-Abushanab/card3d | the card engine it loads includes code ported from three.js (MIT, Copyright 2010-2025 three.js authors) and Paper Shaders (Apache-2.0); the card fonts are SIL OFL 1.1. See THIRD_PARTY_NOTICES.md in the package. */`;
}

/** The IIFE's own URL, read while it runs (a classic script, `defer` included, sees itself as currentScript). */
export const SCRIPT_URL_VAR = "__card3dScriptUrl";
export const standaloneIntro = () =>
  `var ${SCRIPT_URL_VAR} = (typeof document !== "undefined" && document.currentScript && document.currentScript.src) || (typeof location !== "undefined" ? location.href : "http://localhost/");`;
