/**
 * The three.js engine, moved out of the packages, lives in a local,
 * gitignored archive: `.archive/three-engine/`, its files at their old paths (for example
 * `.archive/three-engine/packages/core/src/scene/stage.ts`). The archive holds only what moved, plus
 * the original of each module that was split (the three-free part stayed in packages/core). This module
 * lets Vite run it in place:
 *
 * - `@three-engine/<path>` imports `packages/core/src/<path>` from the archive (the reference pages in
 *   ref/ use it). Without the archive it resolves to a module that throws, so pages that import it
 *   lazily (ref/marquee.ts for the engine's marquee) still load.
 * - A relative import from inside the archive takes the archive's file when it has one, else the
 *   live tree's (`packages/core/src/types.ts`, the design model, the fonts…): the archive is an overlay.
 * - Bare imports (`three`, `vite`, `playwright`, `vitest`) resolve through `.archive/three-engine/node_modules`,
 *   a link to this package's node_modules (`linkArchiveModules`): three.js is a dev dependency of
 *   card3d-tools only, never of a published package.
 *
 * compare.mjs and ar-compare.mjs use it; so do the archive's own configs (its unit tests and its old
 * harness, `.archive/three-engine/vitest.config.mjs` and `.archive/three-engine/packages/core/parity/`).
 */
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
export const ARCHIVE = resolve(ROOT, ".archive/three-engine");
const ARCHIVE_CORE_SRC = resolve(ARCHIVE, "packages/core/src");
const MISSING = "\0card3d-three-archive-missing";

/**
 * Whether the local three.js archive is here (it never is in a fresh clone). CARD3D_NO_ARCHIVE=1 ignores it, to run
 * the harnesses as a fresh clone (CI) does.
 */
export const hasThreeArchive = () => !process.env.CARD3D_NO_ARCHIVE && existsSync(resolve(ARCHIVE_CORE_SRC, "scene/stage.ts"));

/** Links `.archive/three-engine/node_modules` to this package's, so the archive's bare imports resolve. */
export function linkArchiveModules() {
  const link = resolve(ARCHIVE, "node_modules");
  let present = false;
  try {
    lstatSync(link);
    present = true;
  } catch {
    // not there yet
  }
  if (!present && hasThreeArchive()) symlinkSync(relative(ARCHIVE, resolve(import.meta.dirname, "node_modules")), link, "dir");
}

/** `path` itself when it exists, else the live tree's file at the same place relative to the archive. */
function overlay(path) {
  if (existsSync(path)) return path;
  const rel = relative(ARCHIVE, path);
  if (rel.startsWith("..")) return null;
  const live = resolve(ROOT, rel);
  return existsSync(live) ? live : null;
}

/** Vite plugin: `@three-engine/*` and the archive's relative imports (see above). */
export function threeArchive() {
  return {
    name: "card3d:three-archive",
    enforce: "pre",
    resolveId(source, importer) {
      const [path, query] = source.split("?");
      const q = query === undefined ? "" : `?${query}`;
      if (path.startsWith("@three-engine/")) {
        if (!hasThreeArchive()) return MISSING;
        const hit = overlay(resolve(ARCHIVE_CORE_SRC, path.slice("@three-engine/".length)));
        return hit && hit + q;
      }
      if (!importer || !path.startsWith(".")) return null;
      const from = importer.split("?")[0];
      if (!from.startsWith(ARCHIVE + sep)) return null;
      const hit = overlay(resolve(dirname(from), path));
      return hit && hit + q;
    },
    load(id) {
      if (id === MISSING)
        return `throw new Error("the three.js engine isn't here: .archive/three-engine/ is missing (crates/card3d-tools/three-archive.mjs)");`;
      return null;
    },
  };
}
