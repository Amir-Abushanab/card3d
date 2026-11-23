#!/usr/bin/env node
/**
 * A tiny static server for the example pages that mimics a package CDN: `/npm/<package>/<file>`
 * serves the built files of the workspace packages (only what they publish: dist/ and assets/), the
 * way https://cdn.jsdelivr.net/npm/@card3d/element@0.1/dist/standalone/metal-card.js would.
 *
 *   node serve.mjs [--port 4181]      (build first: pnpm --filter @card3d/element build:standalone)
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const here = import.meta.dirname;
const packages = resolve(here, "../../packages");
const portArg = process.argv.indexOf("--port");
const port = Number(portArg > 0 ? process.argv[portArg + 1] : (process.env.PORT ?? 4181));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** URL path → file on disk, or null (outside the served roots). */
function locate(pathname) {
  const p = decodeURIComponent(pathname);
  const npm = p.match(/^\/npm\/@card3d\/(core|element|react)\/((?:dist|assets)\/.+)$/);
  if (npm) return safeJoin(resolve(packages, npm[1]), npm[2]);
  return safeJoin(here, p === "/" ? "index.html" : p.slice(1));
}

function safeJoin(root, rel) {
  const file = normalize(join(root, rel));
  return file === root || file.startsWith(root + sep) ? file : null;
}

createServer((req, res) => {
  const file = locate(new URL(req.url ?? "/", "http://localhost").pathname);
  if (!file || !existsSync(file) || !statSync(file).isFile() || file.endsWith(".mjs")) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`embed example: http://localhost:${port}/`));
