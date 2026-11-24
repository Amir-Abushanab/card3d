#!/bin/sh
# Builds both web packages and prints their download sizes:
#   packages/core/wasm/pkg        WebGPU (the default)
#   packages/core/wasm/pkg-webgl  WebGL 2 fallback, for browsers without WebGPU
# (beside the loader, packages/core/wasm/loader.js, and shipped with @card3d/core)
# Each package is a main module plus lazily loaded chunks, one per `#[wasm_split(name)]` split point
# (split_<name>.wasm; chunk_<n>.wasm holds code that several of them share). A page downloads a chunk
# the first time a design needs it, or earlier: the package's `preload(names)` starts the named parts'
# downloads (split-preload.mjs), which the page does with the main module's for the design it shows.
# Needs: rustup target add wasm32-unknown-unknown; cargo install wasm-bindgen-cli --version 0.2.130;
# cargo install wasm_split_cli_support --version 0.2.5 --features build-binary --locked; wasm-opt
# (binaryen); Node. The wasm link keeps relocations for the splitter (.cargo/config.toml).
# Every file but the entry, <pkg>/card3d_web.js, carries a content hash in its name (fingerprint).
# Size budgets (gzip -9 bytes of the main module) fail the build when exceeded: raise them on purpose.
set -e
cd "$(dirname "$0")"
WASM=../../target/wasm32-unknown-unknown/web/card3d_web.wasm
OUT=../../packages/core/wasm
BUDGET_pkg=${BUDGET_pkg:-185000}
BUDGET_pkg_webgl=${BUDGET_pkg_webgl:-800000}
# Panic messages carry the source paths of the crates they come from: drop the machine-specific
# prefixes (the cargo registry, the toolchain's library sources), which shortens them and makes the
# build the same on every machine.
remap=""
for d in "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/ "$(rustc --print sysroot)/lib/rustlib/src/rust/"; do
  remap="$remap\"--remap-path-prefix=$d=\", "
done
build() { # out-dir cargo-feature-args...
  out=$1; shift
  cargo build --profile web --target wasm32-unknown-unknown -p card3d-web --config "target.wasm32-unknown-unknown.rustflags=[${remap%, }]" "$@"
  split=$(mktemp -d)
  # Every split point is a deliberate lazy feature, so keep them all (no cost-model merging).
  wasm-split-cli "$WASM" "$split" --target web --out-name card3d_web --cost-model none
  rm -rf "$OUT/$out"
  # The chunks import the main module's function table: keep the linker's exports.
  wasm-bindgen --target web --keep-lld-exports --out-dir "$OUT/$out" "$split/card3d_web.wasm"
  rm "$split/card3d_web.wasm" "$OUT/$out/card3d_web_bg.wasm.d.ts"
  cp "$split"/* "$OUT/$out/"
  rm -rf "$split"
  # --low-memory-unused: Rust puts the stack first, so the low 1 KB of memory is only touched by a
  # nearly overflowing stack; wasm-opt may then fold constant offsets into loads and stores.
  for f in "$OUT/$out"/*.wasm; do
    wasm-opt -Oz --low-memory-unused --converge --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
      --enable-reference-types --enable-multivalue "$f" -o "$f"
  done
  fingerprint "$OUT/$out"
}

hash() { { command -v sha256sum >/dev/null && sha256sum "$1" || shasum -a 256 "$1"; } | cut -c1-12; }
# rename DIR FILE REFERRER: FILE becomes name.<content hash>.ext, and REFERRER's `"./FILE"` with it.
rename() {
  base=$2
  new="${base%.*}.$(hash "$1/$base").${base##*.}"
  mv "$1/$base" "$1/$new"
  grep -q "\"./$base\"" "$1/$3" || { echo "error: $3 doesn't load $base" >&2; exit 1; }
  sed -i.bak "s#\"\./$base\"#\"./$new\"#g" "$1/$3" && rm "$1/$3.bak"
}
# Every file but the entry (card3d_web.js) gets its content hash in its name, children first, so a
# page only ever fetches the parts of its own build: after a deploy, an open page asks for names that
# are gone (a clean Card3dLoadError) instead of loading parts built for another main module.
fingerprint() {
  # The chunks are small (a few KB), so compile them from their bytes rather than streaming: that works
  # whatever MIME type the server sends for .wasm (instantiateStreaming needs application/wasm, and
  # wasm-split's loader has no fallback), and a missing file (HTTP 404) rejects as a download failure.
  perl -0pi -e 's/return async \(imports\) => \(WebAssembly\.instantiateStreaming\(src, imports\)\);/return async (imports) => {\n        const r = await src;\n        if (!r.ok) throw new Error(`HTTP \${r.status}: \${r.url}`);\n        return WebAssembly.instantiate(await r.arrayBuffer(), imports);\n    };/g' "$1/__wasm_split.js"
  if grep -q instantiateStreaming "$1/__wasm_split.js"; then
    echo "error: __wasm_split.js still streams (wasm-split's loader changed?)" >&2
    exit 1
  fi
  # `preload(names)`: the page starts downloading the parts a design needs with the main module.
  node split-preload.mjs "$1"
  for f in "$1"/split_*.wasm "$1"/chunk_*.wasm; do
    [ -e "$f" ] && rename "$1" "${f##*/}" __wasm_split.js
  done
  # Only the ES imports name the file; the wasm's import-object keys keep the module name.
  base=__wasm_split.js
  new="__wasm_split.$(hash "$1/$base").js"
  mv "$1/$base" "$1/$new"
  sed -i.bak -e "s#^import \* as \(import[0-9]*\) from \"\./__wasm_split\.js\"#import * as \1 from \"./$new\"#" \
    -e "s#^export { preload } from \"\./__wasm_split\.js\"#export { preload } from \"./$new\"#" "$1/card3d_web.js" && rm "$1/card3d_web.js.bak"
  main="card3d_web_bg.$(hash "$1/card3d_web_bg.wasm").wasm"
  mv "$1/card3d_web_bg.wasm" "$1/$main"
  sed -i.bak "s#new URL('card3d_web_bg\.wasm', import\.meta\.url)#new URL('$main', import.meta.url)#" "$1/card3d_web.js" && rm "$1/card3d_web.js.bak"
  if grep -q "from \"./__wasm_split.js\"\|'card3d_web_bg.wasm'" "$1/card3d_web.js"; then
    echo "error: card3d_web.js still loads an unhashed file" >&2
    exit 1
  fi
}
size() { printf "%-44s raw %8d  gzip %7d  brotli %7d\n" "${1#$OUT/}" "$(wc -c <"$1")" "$(gzip -9c "$1" | wc -c)" "$(brotli -c "$1" | wc -c)"; }
build pkg
build pkg-webgl --no-default-features --features webgl
status=0
for out in pkg pkg-webgl; do
  for f in "$OUT/$out"/card3d_web_bg.*.wasm "$OUT/$out/card3d_web.js" "$OUT/$out"/__wasm_split.*.js; do size "$f"; done
  for f in "$OUT/$out"/split_*.wasm "$OUT/$out"/chunk_*.wasm; do [ -e "$f" ] && size "$f"; done
  main=$(gzip -9c "$OUT/$out"/card3d_web_bg.*.wasm | wc -c)
  budget=$(eval echo "\$BUDGET_$(echo $out | tr - _)")
  if [ "$main" -gt "$budget" ]; then
    echo "error: $OUT/$out main module is $main bytes gzipped, over its budget of $budget" >&2
    status=1
  fi
done
exit $status
