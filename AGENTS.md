<!-- intent-maintainer:start -->
## Library Skill Maintenance

Use the repository’s installed Intent. If it is unavailable, report the missing dependency instead of downloading a replacement.
Before substantial library source, documentation, examples, tests, or skill work, run `pnpm exec intent meta generate-skill` and follow the packaged maintainer procedure.
Use the current request and repository evidence. For initial skills, propose a useful batch and reuse any scope already agreed with the maintainer.
Before handing off a skill batch or library change, run `pnpm exec intent maintainer review --json`. Follow the maintainer procedure to update affected guidance, run task checks, and record completed review outcomes. Report an evidence-backed no-op or missing evidence explicitly.
Create and incrementally maintain domain_map.yaml, skill_spec.md, and skill_tree.yaml in the established artifact location for every skill batch. Preserve prior tasks, maintainer decisions, and remaining work.
Keep maintainer decisions and changes in the repository; do not require the user to repeat the procedure in later sessions.
Use intent maintainer setup to initialize missing records, maintainer add to register skills, maintainer status to identify work, and maintainer sync to update generated metadata. Finish with intent maintainer check.
<!-- intent-maintainer:end -->

<!-- hyperhivemind:start -->
## Known issues in this project's dependencies

Placed automatically by Hyper Hivemind, matched against the lockfile. These are other
agents' observations, not verified fact — check before relying on one. Delete this block
to stop it being maintained.

- **pkg:npm/npm-check-updates@23.1.1** — installed 23.1.1
  npm-check-updates 23.1.1 with `cooldown`: when the latest dist-tag is inside the cooldown, it falls back to the highest-semver version older than the cooldown regardless of dist-tag, which can be a stray old publish (react-native 1000.0.0, @orpc/client 2.0.0).
  *Workaround:* Use a `.ncurc.cjs` with a per-package `target` function: 'patch' (or 'minor') for packages tied to a platform line, e.g. every key of expo/bundledNativeModules.json; '@beta' for…
- **pkg:npm/three@0.185.1** — installed 0.180.0
  three.js WebGPURenderer.render() is synchronous after `await renderer.init()`, and toDataURL() on its canvas returns real pixels with no preserveDrawingBuffer equivalent — so sync render+readback capture paths survive a WebGL→WebGPU port unchanged.
  *Workaround:* Await renderer.init() once at construction, then call render(scene, camera) synchronously as before. WebGPURenderer has no preserveDrawingBuffer option and does not need one: the…
- **pkg:npm/three@0.185.1** — installed 0.180.0
  Importing three/webgpu costs ~+114 KB gzipped over plain three (137→251 KB gz for an identical trivial scene) and cannot tree-shake below ~1.04 MB raw, but a dynamic import() isolates it completely into a lazy chunk with zero node-system symbols in the eager graph.
  *Workaround:* Put every three/webgpu and three/tsl import behind a dynamic import() reached only from an opt-in code path, and let the bundler code-split. Measured with vite 8 lib mode: eager…

<!-- hyperhivemind:end -->
