# card3d-workspace skill spec

The @card3d packages draw 3D metal cards on a Rust + wgpu engine (two wasm builds: WebGPU and WebGL 2).
`@card3d/core` is the engine and the design model, `@card3d/element` the `<metal-card>` custom element
(with CDN bundles) and `@card3d/react` a thin `<MetalCard>` wrapper. The skills target developers'
agents in projects that consume these packages; the repository's own contributor skill
(`.claude/skills/describe-finish`) is separate and not shipped.

## Domains

| Domain | Description | Skills |
| --- | --- | --- |
| design-model | the CardDesign JSON, validation, share links | card-design-json |
| face-shaders | custom WGSL face shader layers | custom-face-shaders-wgsl |
| engine | stages, offscreen frames, AR and print exports, bundling | engine-stage |
| embedding | the drop-in element and the React component | embed-metal-card, metal-card-react |

## Skill inventory

| Skill | Package | Type | References |
| --- | --- | --- | --- |
| card-design-json | @card3d/core | core | design-fields, presets, shaders-and-effects (face shaders and add-ons), examples (generated) |
| custom-face-shaders-wgsl | @card3d/core | core | prelude (generated) |
| engine-stage | @card3d/core | core | stage-api, exports |
| embed-metal-card | @card3d/element | core | attributes, serving-and-csp |
| metal-card-react | @card3d/react | framework (react) | — |

## Decisions

- Field tables, presets, built-in shader parameters, add-ons, examples and the custom-shader contract
  are generated from `designSpaceSections()` (@card3d/core/describe, the text Card Studio's
  describe-a-finish uses) by `scripts/skill-references.mjs`; `pnpm check` fails when they are stale.
  The generated text keeps its "— leave out" markers (fields a generated design shouldn't set) with a
  note that hosts may still set image fields.
- Hand-written references (stage API, exports, attributes, serving and CSP) were checked against
  `src/engine.ts`, `src/print/`, `packages/element/src/` and `wasm/loader.js`. Every TS / JS fence is
  typechecked by `intent validate` against the workspace packages.
- The React skill's prerequisite on the element skill is package-qualified
  (`@card3d/element#embed-metal-card`): Intent checks plain slugs within the owning package only.
- `maintainer setup`'s `check-skills.yml` workflow was first not kept (CI ran `intent validate` through
  `pnpm check` and `pnpm pack:check` checked that every skill file ships; the review gate needs Git
  history, which the repository didn't have). Superseded 2026-11-20 at the maintainer's request (Intent's
  flow in CI): `.github/workflows/check-skills.yml` is back, adapted from the setup template
  (intent-workflow-version 6, @tanstack/intent 0.5.6). Its two analysis jobs run on this repository's
  toolchain instead of TanStack's reusable check-skills.yml / review-skills.yml, which install pnpm with
  `corepack enable` (not shipped with Node 25+; CI uses Node 26) and default to Node 22; same posture
  (contents: read, no persisted credentials, `--ignore-scripts`, Intent from the lockfile). The opt-in
  review-PR publisher stays TanStack's publish-skill-review.yml, pinned to b9f205d (v0.5.6, the commit in
  dist/workflow-ref.json); bump it with the devDependency. The PR job runs `maintainer check --base <PR
  base>` and reports `intent stale` drift as warnings. Nothing in it needs the engine wasm (`intent
  validate` passes without packages/core/wasm/pkg*). Make "Validate intent skills" a required check
  (DEPLOY.md).
- `review.ignore` in skill_tree.yaml (2026-11-20): paths that can't change what the npm packages ship or
  what the skills claim (release bookkeeping, CI, the Studio and example apps, the native hosts and their
  crates, the comparison tools, docs, build scripts, Rust manifests and lockfile, repo config). Still
  reviewed: `packages/**`, the engine compiled into @card3d/core (`crates/card3d-engine`,
  `crates/card3d-web`) and README.md. Without it every Studio or docs PR would need a review record.
  Revisit if a skill starts covering one of those areas.
- Skills' `metadata.library_version` follows releases: the root `version` script is `changeset version &&
  node scripts/skill-versions.mjs`. The script sets the version (`intent validate --set-version`) only when
  `intent maintainer review` shows nothing pending before the edit (every change since the last release
  was reviewed on its PR), checks that the version lines are then the only pending change, records them
  with `maintainer review --unchanged` and runs `maintainer check`; with reviews pending it leaves the
  versions alone and warns (`intent stale` then shows the drift). Without the record, the edit would
  reopen every skill's review and fail the next PR's check. Rehearsed in a scratch clone (0.1.0 → 0.1.1,
  both paths).
- The packages were never published; they sit at the 0.0.0 placeholder so the first-release changesets
  (minor) produce 0.1.0, the version every skill (`library_version`), README and CDN URL already names.
  `scripts/publish-if-needed.mjs` refuses to publish 0.0.0.
- The root package.json has `repository` so the `Amir-Abushanab/card3d:` sources of
  custom-face-shaders-wgsl resolve without depending on the clone's `origin` remote (Intent reports
  "unverified repository" otherwise).
- engine-stage's `metadata.purpose` was re-wrapped to the layout `intent validate --set-version` writes
  (same value), so a version step changes only the version line.

## Coverage and batch history

- Registered `card-design-json` in `packages/core` (domain `design-model`). Developer tasks: Write a valid CardDesign for a described finish; Validate an untrusted design and explain what was dropped or clamped; Decode or create a Card Studio share link.

- Registered `custom-face-shaders-wgsl` in `packages/core` (domain `face-shaders`). Developer tasks: Write a custom WGSL skin or overlay layer with editable params; Fix annotation and WGSL compile errors in a custom layer; Port a GLSL or Shadertoy shader to a card face.

- Registered `engine-stage` in `packages/core` (domain `engine`). Developer tasks: Mount an interactive card on a canvas with createEngineStage; Export a PNG, a video frame sequence or an AR model of a design; Bundle or self-host the engine files.

- Registered `embed-metal-card` in `packages/element` (domain `embedding`). Developer tasks: Embed a card designed in Card Studio from a CDN; Install and use <metal-card> with a bundler; Show many cards on one page within GPU limits; Serve the CDN bundle under a Content-Security-Policy.

- Registered `metal-card-react` in `packages/react` (domain `embedding`). Developer tasks: Render a card from a Card Studio design in a React component; Control the card imperatively through its ref; Use the card in a Next.js server-rendered page.

- Batch 1 (2026-11-20, packages at 0.1.0, @tanstack/intent 0.5.6): the five skills authored.
  Checks: `intent validate` passes (5 skills, typechecked examples); `pnpm pack:check` shows every
  skill file in the tarballs; `intent stale` reports all current. Not run: fresh-consumer task checks
  and discovery checks; `maintainer review` / `check` (no Git history yet). In a scratch pnpm project
  with only the packed @card3d/element tarball installed, `intent list` showed its skill and
  @card3d/core's three (transitive skills are discovered).

- Maintenance pass (2026-11-20, release and CI setup; no guidance change): `intent meta generate-skill`
  procedure followed; `maintainer sync` had nothing to synchronize; `intent validate` passes (5 skills);
  `intent stale` reports all current. Added review.ignore, scripts/skill-versions.mjs and
  check-skills.yml (Decisions). `maintainer status`, `review` and `check` can't run until the repository
  has a commit ("Cannot resolve review base HEAD"); in a scratch clone with one commit they report the 6
  expected items (5 skills, the planning record), the initial record below clears them, and later PRs
  and version steps behave as described in Decisions. Discovery: a scratch pnpm project depending only
  on the packed @card3d/react finds all five skills (`intent list`) and loads
  `@card3d/element#embed-metal-card`, metal-card-react's package-qualified prerequisite.

- Removal of the one-off cards and front effects (2026-11-23, packages at 0.1.0 unreleased, @tanstack/intent
  0.5.6; maintainer decision, a scope decision: the hand-built one-off cards were removed, and with
  them the moss / infinity-mirror front effects and the instant-camera object style; they leave the
  library and are no longer tested). Source change: `CardDesign` lost `bespoke`,
  `bespokeParams`, `frontEffect`, `objectStyle` and `effectParams`; `AssetProvider` lost
  `bespokeAssets`; `EFFECT_PARAMS` / `EFFECT_CATALOG` list the shine and vines add-ons only; the
  "oneoffs" preset category and the moss / mirror presets are gone; the design-space text has an
  "Add-ons" section instead of "Effects and add-ons" and "One-off cards". Face-shader layers (thermal,
  liquid metal, caustics …) and their presets stay. Legacy designs that still carry the keys load as
  the standard card (`ensureDesign` drops them; `lintDesign` reports them as unknown fields).
  Guidance: card-design-json (description, the optional-parts table, a common-mistakes entry for the
  removed keys), custom-face-shaders-wgsl (skins under moss), engine-stage and its stage-api reference
  (`bespokeAssets`, `ENGINE_FRONT_EFFECTS` / `ENGINE_BESPOKE`, one-offs in `animated`); generated
  references regenerated with `pnpm skills:refs` (the shaders-and-effects reference keeps its file name;
  its title is now "Face shaders and add-ons"). embed-metal-card and metal-card-react: verified no
  change (they never described the removed features). Records: domain_map gains the removed-keys
  failure mode; skill_tree's card-design-json description re-synced.

- Naming cleanup (2026-11-23, packages at 0.1.0 unreleased, @tanstack/intent 0.5.6; maintainer
  decision: descriptive names for two exports, and doc comments tidied). Source change:
  `@card3d/core/model`'s materials catalog is now `RECIPE_MATERIALS` (type `RecipeMaterial`), and
  `@card3d/core/marquee`'s order helper is now `shuffleMarqueeOrder`. No behaviour change. Guidance:
  verified no change: no skill or reference names these exports (engine-stage shows `mountMarquee`
  only; card-design-json's material table is generated from the catalog, and `pnpm skills:refs` leaves
  it unchanged). Records: domain_map and skill_tree verified accurate (neither names these exports).

## Remaining work

- Record the first source review right after the repository's first commit and before the first push (a
  separate, second commit: the record names the first commit as its baseline, so don't amend or squash
  that commit away; then push both, or the first Version run's Intent check fails). Also in DEPLOY.md:

  ```sh
  pnpm exec intent maintainer status   # expect 6 pending items: the 5 skills and _artifacts
  pnpm exec intent maintainer review --updated "Initial skill batch 1 (2026-11-20): card-design-json, custom-face-shaders-wgsl, engine-stage, embed-metal-card and metal-card-react, and the _artifacts planning records, authored from the @card3d/* sources at this commit (after the 2026-11-23 removal of the one-off cards and front effects: skill_spec.md, Coverage and batch history); generated references from designSpaceSections() via scripts/skill-references.mjs. Checks: intent validate passes (5 skills, TS fences typechecked), skill-references --check current, pnpm pack:check ships every skill file, intent list in a scratch pnpm project shows the transitive skills. Not run: fresh-consumer task checks (skill_spec.md, Remaining work)."
  pnpm exec intent maintainer check    # expect: 0 pending review item(s), checks passed
  git add .intent/review-state.json && git commit -m "Record the initial Intent skill review"
  ```
- Fresh-consumer task checks for each skill (install the packed tarballs in a scratch project, run an
  agent with `intent install`, grade the result).
