/**
 * Vite dev middleware: serves the local asset pack at `/@ref/` when `.reference/` exists. Used by the
 * studio's dev server and by local tooling.
 *
 * Only `.reference/pack/` and `.reference/assets/` are exposed, nothing else in that folder.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_PACK_DIR = resolve(fileURLToPath(new URL("../../../.reference", import.meta.url)));

const ALLOWED = new Set(["pack", "assets"]);

const MIME = {
  ".json": "application/json; charset=utf-8",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** @returns {import("vite").Plugin} */
export function localPackAssets({ dir = LOCAL_PACK_DIR } = {}) {
  return {
    name: "card3d:local-pack",
    // Lets pages skip every /@ref/ request (and drop the code that makes them) unless a dev server
    // can actually serve the pack. Builds never ship the pack, so it is false there.
    config(_config, { command }) {
      return { define: { __CARD3D_LOCAL_PACK__: JSON.stringify(command === "serve" && existsSync(resolve(dir, "pack"))) } };
    },
    configureServer(server) {
      if (!existsSync(dir)) {
        server.config.logger.info("[card3d] no local pack; /@ref/ disabled (public assets only)");
        return;
      }
      server.middlewares.use("/@ref", (req, res, next) => {
        let rel;
        try {
          rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
        } catch {
          return next();
        }
        const top = rel.split("/")[0];
        const file = resolve(dir, rel);
        if (!ALLOWED.has(top) || !file.startsWith(dir + sep)) {
          res.statusCode = 404;
          return res.end("not found");
        }
        const st = statSync(file, { throwIfNoEntry: false });
        if (!st?.isFile()) {
          res.statusCode = 404;
          return res.end("not found");
        }
        res.setHeader("Content-Type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
        res.setHeader("Content-Length", String(st.size));
        res.setHeader("Cache-Control", "no-cache");
        if (req.method === "HEAD") return res.end();
        createReadStream(file).pipe(res);
      });
    },
  };
}
