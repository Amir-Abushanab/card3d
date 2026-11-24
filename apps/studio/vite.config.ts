import { defineConfig, type Plugin } from "vite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { LOCAL_PACK_DIR, localPackAssets } from "../../packages/core/dev/local-pack.mjs";

const root = import.meta.dirname;

// Card Studio, plus the marquee showcase page (showcase.html) when it exists. In dev, a local asset pack
// (`.reference/pack`, `.reference/assets`, gitignored) is served at /@ref/ when present, and a local
// plugin module is loaded when present (`localPlugin`); the studio uses the public assets otherwise.
const pages: Record<string, string> = { main: resolve(root, "index.html") };
if (existsSync(resolve(root, "showcase.html"))) pages.showcase = resolve(root, "showcase.html");

/**
 * Engine build id for the thumbnail cache key: a hash of the engine sources (and the studio's still /
 * thumbnail code), so changing anything that renders invalidates cached thumbnails. Computed when the
 * config loads (dev server start, build).
 */
function engineBuildId(): string {
  const h = createHash("sha1");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|glsl|json)$/.test(e.name) && !e.name.endsWith(".test.ts")) h.update(e.name).update(readFileSync(p));
    }
  };
  try {
    walk(resolve(root, "../../packages/core/src"));
    for (const f of ["src/state/fx.ts", "src/state/design.ts", "src/export/offscreen.ts", "src/export/exporters.ts"]) h.update(readFileSync(resolve(root, f)));
    // The engine's builds (thumbnails draw on it): their entry names every part by its content hash.
    for (const pkg of ["pkg", "pkg-webgl"]) h.update(readFileSync(resolve(root, `../../packages/core/wasm/${pkg}/card3d_web.js`)));
  } catch {
    return "unknown";
  }
  return h.digest("hex").slice(0, 12);
}

/** Files whose changes alter what a thumbnail looks like (the inputs of `engineBuildId`). */
const engineDir = resolve(root, "../../packages/core/src");
const STUDIO_RENDER_FILES = [
  "src/state/fx.ts",
  "src/state/design.ts",
  "src/export/offscreen.ts",
  "src/export/exporters.ts",
  "../../packages/core/wasm/pkg/card3d_web.js",
  "../../packages/core/wasm/pkg-webgl/card3d_web.js",
].map((f) => resolve(root, f));
const affectsBuild = (file: string) =>
  STUDIO_RENDER_FILES.includes(file) || (file.startsWith(engineDir + "/") && /\.(ts|glsl|json)$/.test(file) && !file.endsWith(".test.ts"));

/**
 * `virtual:card3d-build`: the engine build id as a module. On a dev server it is recomputed whenever an
 * engine source changes (and the page reloads), so a long-running dev server never serves thumbnails
 * cached from older engine code.
 */
function engineBuild(): Plugin {
  const ID = "virtual:card3d-build";
  const RESOLVED = "\0" + ID;
  let id = engineBuildId();
  return {
    name: "card3d-engine-build",
    resolveId: (source) => (source === ID ? RESOLVED : null),
    load: (mod) => (mod === RESOLVED ? `export const ENGINE_BUILD = ${JSON.stringify(id)};` : null),
    configureServer(server) {
      const refresh = (file: string) => {
        if (!affectsBuild(resolve(file))) return;
        const next = engineBuildId();
        if (next === id) return;
        id = next;
        for (const env of Object.values(server.environments ?? {})) {
          const m = env.moduleGraph.getModuleById(RESOLVED);
          if (m) env.moduleGraph.invalidateModule(m);
        }
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.add([engineDir, ...STUDIO_RENDER_FILES]);
      for (const ev of ["change", "add", "unlink"] as const) server.watcher.on(ev, refresh);
    },
  };
}

/**
 * `virtual:card3d-local-plugin`: the optional local plugin (`.reference/studio-plugin.ts`, gitignored;
 * see src/local-plugin.ts) on a dev server that finds it, else `null`. A build always gets `null`, so no
 * plugin code ships. The plugin's own bare imports resolve as the studio's do.
 */
function localPlugin(): Plugin {
  const ID = "virtual:card3d-local-plugin";
  const RESOLVED = "\0" + ID;
  const file = resolve(LOCAL_PACK_DIR, "studio-plugin.ts");
  let serve = false;
  const present = () => serve && existsSync(file);
  return {
    name: "card3d-local-plugin",
    config(_config, { command }) {
      serve = command === "serve";
      return { define: { __CARD3D_LOCAL_PLUGIN__: JSON.stringify(present()) } };
    },
    resolveId(source, importer, options) {
      if (source === ID) return RESOLVED;
      if (serve && importer?.startsWith(LOCAL_PACK_DIR + sep) && !/^[./\0]|^[a-z]+:/i.test(source)) {
        return this.resolve(source, resolve(root, "src/main.ts"), { ...options, skipSelf: true });
      }
      return null;
    },
    load: (id) => (id === RESOLVED ? (present() ? `export { default } from ${JSON.stringify(file)};` : "export default null;") : null),
  };
}

export default defineConfig({
  root,
  define: {
    __CARD3D_ELEMENT_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(root, "../../packages/element/package.json"), "utf8")).version),
  },
  plugins: [localPackAssets(), localPlugin(), engineBuild()],
  server: {
    port: 5180,
    fs: { allow: [resolve(root, "../..")] },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: pages,
      // The chunk the studio and the showcase share is named after its first module, which can be a small
      // helper: call the one holding the engine "engine", so the network panel says what it is.
      output: {
        chunkFileNames: (c) => `assets/${c.moduleIds.some((id) => id.endsWith("/packages/core/src/engine.ts")) ? "engine" : "[name]"}-[hash].js`,
      },
    },
  },
});
