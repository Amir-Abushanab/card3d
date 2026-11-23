/**
 * dependency-cruiser: the module rules behind the package boundaries.
 * `pnpm depcruise` checks packages/, apps/, scripts/ and crates/card3d-tools (the harness's page side).
 *
 * dependency-cruiser parses TypeScript with TypeScript 6 (pnpm-workspace.yaml's packageExtensions):
 * TypeScript 7 has no compiler API yet, and without it every .ts file would be skipped silently.
 */

/** The public entry points of @card3d/core: its `exports` map (package.json). */
const CORE_ENTRIES = "^packages/core/src/(index|model|engine|editor|describe|print|marquee|standalone)[.]ts$";
/** Published code: what tsdown and the standalone builds compile, and the engine's page side (wasm/*.js). */
const PUBLISHED = "^packages/(core|element|react)/(src|wasm)/";
const TESTS = "[.](test|e2e)[.]tsx?$";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "No import cycles. Type-only imports (erased at build time) don't count, nor does a lazily loaded chunk's import back into the module that loads it (import()).",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only", "dynamic-import"] } },
    },
    {
      name: "packages-not-to-apps",
      severity: "error",
      comment: "The packages never import the studio, the example or the tools.",
      from: { path: "^packages/" },
      to: { path: "^(apps|crates|scripts)/" },
    },
    {
      name: "package-layers",
      severity: "error",
      comment: "core ← element ← react: core imports neither wrapper, element doesn't import react.",
      from: { path: "^packages/core/" },
      to: { path: "^packages/(element|react)/" },
    },
    {
      name: "element-not-to-react",
      severity: "error",
      from: { path: "^packages/element/" },
      to: { path: "^packages/react/" },
    },
    {
      name: "wrappers-use-core-entry-points",
      severity: "error",
      comment: "@card3d/element and @card3d/react reach @card3d/core only through its public entry points (no deep imports).",
      from: { path: "^packages/(element|react)/src/" },
      to: { path: "^packages/core/", pathNot: CORE_ENTRIES },
    },
    {
      name: "react-uses-element-entry-point",
      severity: "error",
      comment: "@card3d/react wraps @card3d/element through its public entry point.",
      from: { path: "^packages/react/src/" },
      to: { path: "^packages/element/", pathNot: "^packages/element/src/index[.]ts$" },
    },
    {
      name: "three-free",
      severity: "error",
      comment:
        "three.js is the archived reference engine: only the comparison harness (crates/card3d-tools) and the local archive use it, never the packages, the apps or the scripts.",
      from: { pathNot: "^crates/card3d-tools/" },
      to: { path: "(^|/)node_modules/(@types/)?three/" },
    },
    {
      name: "engine-not-to-studio",
      severity: "error",
      comment: "The engine's page side (engine.ts, wasm/) imports no studio, tool or test code.",
      from: { path: "^packages/core/(src/engine[.]ts|wasm/)" },
      to: { path: `^(apps|crates|scripts)/|${TESTS}` },
    },
    {
      name: "local-pack-workspace-only",
      severity: "error",
      comment: "The local asset pack's loader (@card3d/core/reference) and dev plugin stay out of the published code.",
      from: { path: PUBLISHED, pathNot: `^packages/core/src/reference[.]ts$|${TESTS}` },
      to: { path: "^packages/core/(src/reference[.]ts$|dev/)" },
    },
    {
      name: "no-dev-deps-in-published-code",
      severity: "error",
      comment: "Published code imports only dependencies and peers: a dev dependency isn't installed for consumers.",
      from: { path: PUBLISHED, pathNot: TESTS },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["npm", "npm-peer", "type-only"] },
    },
    {
      name: "not-to-test",
      severity: "error",
      comment: "Only tests import tests (and their fixtures).",
      from: { pathNot: TESTS },
      to: { path: TESTS },
    },
    {
      name: "no-orphans",
      severity: "error",
      comment: "A source module nothing imports and that imports nothing is dead (or a missing entry).",
      from: { orphan: true, path: "^(packages/[^/]+|apps/studio)/src/", pathNot: "[.]d[.]ts$" },
      to: {},
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment:
        "Every import resolves. Not checked: Vite's virtual modules, and the harness pages' @three-engine/* (the local archive's alias, absent in a fresh clone).",
      from: { pathNot: "^crates/card3d-tools/ref/" },
      to: { couldNotResolve: true, pathNot: "^virtual:" },
    },
    {
      name: "no-undeclared-dependencies",
      severity: "error",
      comment: "Every npm import is declared in the importing package's package.json.",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // The workspace's build output, the local archive and reference, the engine's wasm builds.
    exclude: { path: "^((packages|apps)/[^/]+/dist|[.]archive|[.]reference|target|packages/core/wasm/pkg[^/]*)/" },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "default", "types"],
      extensions: [".ts", ".tsx", ".mts", ".js", ".mjs", ".d.ts"],
      mainFields: ["module", "main", "types"],
    },
    skipAnalysisNotInRules: true,
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
