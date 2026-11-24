// Gives a web package's wasm-split loader (__wasm_split.js) a `preload(names)`, re-exported by the
// package's entry (card3d_web.js): it starts downloading the named lazily loaded parts, and the chunks
// each shares with other parts, all at once and without instantiating them; a part's first load then
// takes its download instead of starting one (a retried load downloads again). The page calls it with
// the parts a design will need while the main module is still downloading (packages/core/wasm/loader.js),
// so a build doesn't wait for each part in turn. build-web.sh runs it before fingerprinting, so the
// file names in the table are renamed with the rest.
//   node crates/card3d-web/split-preload.mjs <package-dir>
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const dir = process.argv[2];
const file = `${dir}/__wasm_split.js`;
let js = readFileSync(file, "utf8");
const FETCH = "const src = fetch(new URL(";
const chunks = new Map(); // `__chunk_N` → its file
for (const m of js.matchAll(/const (__chunk_\d+) = makeLoad\(\(\) => \{\s*const src = fetch\(new URL\("(\.\/[^"]+)"/g)) chunks.set(m[1], m[2]);
const parts = {}; // part → its file, then the chunks it loads first
for (const m of js.matchAll(/export const __wasm_split_load_(\w+) = wrapAsyncCb\(makeLoad\(\(\) => \{\s*const src = fetch\(new URL\("(\.\/[^"]+)"[\s\S]*?\n, \[([^\]]*)\]\)\);/g)) {
  const deps = m[3].split(",").map((d) => d.trim());
  parts[m[1]] = [m[2], ...deps.filter(Boolean).map((d) => chunks.get(d))];
}
const loads = js.split(FETCH).length - 1;
if (!Object.keys(parts).length || Object.values(parts).flat().some((f) => !f) || loads !== chunks.size + Object.keys(parts).length) {
  console.error(`error: ${file}: the parts' files couldn't be read (wasm-split's loader changed?)`);
  process.exit(1);
}
js = js.replaceAll(FETCH, "const src = fetchPart(new URL(");
js += `
/** Each part's file, then the chunks it loads first. */
const PARTS = ${JSON.stringify(parts)};
/** Downloads \`preload\` started, by URL, until a load takes them. */
const prefetched = new Map();
/** Files a load has fetched (\`preload\` leaves them be). */
const taken = new Set();
function fetchPart(url) {
    taken.add(url.href);
    const p = prefetched.get(url.href);
    prefetched.delete(url.href);
    return p ?? fetch(url);
}
/** Starts downloading the lazily loaded parts \`names\` (split point names) for their first load. */
export function preload(names) {
    for (const name of names) {
        for (const f of PARTS[name] ?? []) {
            const url = new URL(f, import.meta.url);
            if (taken.has(url.href) || prefetched.has(url.href)) continue;
            const p = fetch(url);
            p.catch(() => prefetched.get(url.href) === p && prefetched.delete(url.href));
            prefetched.set(url.href, p);
        }
    }
}
`;
writeFileSync(file, js);
appendFileSync(`${dir}/card3d_web.js`, `export { preload } from "./__wasm_split.js";\n`);
appendFileSync(`${dir}/card3d_web.d.ts`, `/** Starts downloading the lazily loaded parts \`names\` (crates/card3d-web/split-preload.mjs). */\nexport function preload(names: string[]): void;\n`);
