# Deploying

## CI

Five workflows, no secrets needed except the optional studio deploy's (npm publishing uses OIDC, below):

[`.github/workflows/ci.yml`](.github/workflows/ci.yml), on every push / PR to `main` (and by hand):

| Job | What it runs |
| --- | --- |
| `rust` | `cargo fmt --check`, `cargo deny check licenses` (deny.toml), `cargo clippy --workspace --all-targets -D warnings`, `cargo test --workspace` (card3d-ffi's GPU test on lavapipe, Mesa's software Vulkan), `validate-catalog.ts --check`, `validate-compare.ts --count 4000` |
| `web` | clippy for wasm32 (both feature sets), `crates/card3d-web/build-web.sh` (fails over the size budgets) → the **`engine-wasm`** artifact (`packages/core/wasm/pkg*`, gitignored, so every later job downloads it) |
| `typescript` | `pnpm check` (oxfmt `--check`, oxlint, typecheck, knip, dependency-cruiser's module rules, the Rust crates' notices, the agent skills' generated references and `intent validate`, unit tests), `pnpm build`, `pnpm pack:check` (what each `@card3d` package would ship, skills included; nothing is published) |
| `e2e` | `pnpm e2e`: the built studio and showcase, and `<metal-card>` from the built CDN bundle, in headless Chromium (WebGL on SwiftShader) |
| `webgpu` | both web builds in headless Chromium with **WebGPU on SwiftShader** (`CARD3D_SWIFTSHADER=1`): `crates/card3d-web/web/fallback.test.mjs` and the comparison harness's fresh-clone mode (web builds vs the native render on lavapipe) over a subset of designs |
| `deploy-studio` | on a push to `main`, after `rust`, `typescript` and `e2e`: the studio to Cloudflare Pages, **if** the Cloudflare secrets are set |
| `changeset` | pull requests only: `changeset status --since=origin/main`; a **warning** (never a failure) when a published `@card3d` package changed without a changeset |

[`.github/workflows/native.yml`](.github/workflows/native.yml), on pushes to `main` that touch the engine or
the native hosts, and by hand (Actions → Native → Run workflow): `apple` (macOS: the XCFramework's macOS and
iOS-simulator slices, `apple/test.sh`, the example app for the iOS simulator, unsigned) and `android`
(`android/build.sh`: `libcard3d.so`, the AAR and the example APK, plus the instrumented tests' APK; the
tests themselves need a device and don't run in CI).

[`.github/workflows/check-skills.yml`](.github/workflows/check-skills.yml), TanStack Intent's checks for the
agent skills the packages ship (`packages/*/skills/`; [AGENTS.md](AGENTS.md) has the maintainer rule):

| Job | What it runs |
| --- | --- |
| `validate` ("Validate intent skills") | pull requests: `intent maintainer check --base <PR base>`: valid skills, generated metadata in sync, and a **recorded review** (`.intent/review-state.json`) for every change to a skill, its sources, the planning records (`_artifacts/`) or an unmapped path; `_artifacts/skill_tree.yaml`'s `review.ignore` lists the paths that can't affect the skills (the Studio, native hosts, docs, CI…). Mechanical repairs that would change anything fail it, with patches in the `intent-repairs` artifact. `intent stale` drift shows as warnings |
| `review` | by hand (Actions → Check Skills → Run workflow) or on a release published by a person: a read-only report of guidance due for review (`intent-review-report` artifact) |
| `publish-review` | only if the repository variable `INTENT_REVIEW_PULL_REQUESTS` is `true`: TanStack's pinned publisher opens a "Review intent skills" PR from that report (an empty commit plus the report as data). Off by default |

When `validate` fails on a pending review, follow AGENTS.md: `pnpm exec intent meta generate-skill`, update
the affected guidance if the change needs it, then record the outcome and commit `.intent/review-state.json`
with the change:

```sh
pnpm exec intent maintainer review --json                 # what is pending, and why
pnpm exec intent maintainer review --unchanged "<why the guidance still holds>"   # or --updated "<what changed>"
pnpm exec intent maintainer check
```

[`.github/workflows/version.yml`](.github/workflows/version.yml) and
[`.github/workflows/release.yml`](.github/workflows/release.yml) version and publish the packages: see
[Publish the packages → npm](#publish-the-packages--npm).

The same in a terminal: `CARD3D_SWIFTSHADER=1 node crates/card3d-web/web/fallback.test.mjs` runs the
fallback test headless on SwiftShader, as CI does; `CARD3D_NO_ARCHIVE=1 CARD3D_SWIFTSHADER=1 node
crates/card3d-tools/compare.mjs --web --webgl --only <designs>` runs the harness as CI does (no three.js
archive, no GPU for the web builds).

The deploy needs some one-time account setup, below. Until you do it, CI still runs green — it just skips the deploy.

## Deploy the studio + showcase → Cloudflare Pages

The **`apps/studio`** app is one multi-page Vite build: the studio at `/` and the card marquee showcase at
`/showcase.html`. `pnpm --filter card-studio build` produces `apps/studio/dist`, deployed to Cloudflare
Pages as project **`card3d-studio`**. The build uses only the public assets (procedural card and chip, a
generic mark, the self-hosted OFL card fonts emitted as hashed `.woff2` files); a local asset pack and the
local plugin (`.reference/`, gitignored) are dev-only and never part of it.

One-time:

1. **Create a Cloudflare API token.** Dashboard → _My Profile_ → _API Tokens_ → _Create Token_ → template **"Edit Cloudflare Workers"** (or a custom token with **Account → Cloudflare Pages → Edit**). Copy it.
2. **Get your Account ID** from the Cloudflare dashboard (Workers & Pages overview, or the dashboard URL).
3. **Add two GitHub repo secrets** (repo → _Settings_ → _Secrets and variables_ → _Actions_):
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. _(Not needed — the workflow creates the project on its first deploy. Do it by hand only if you prefer.)_ Create it explicitly:
   ```sh
   pnpm dlx wrangler login
   pnpm dlx wrangler pages project create card3d-studio --production-branch=main
   ```

Then **push to `main`** → CI checks, builds, runs the e2e tests and deploys. The live URLs are
`https://card3d-studio.pages.dev` (studio) and `https://card3d-studio.pages.dev/showcase.html` (showcase),
until you add a custom domain (Pages project → _Custom domains_).

## Describe a finish (feature flag)

Card Studio has a "✎ Describe…" button (Presets) that turns a text description into a design with a model.
It is **off by default, in dev and in the deployed build**. Without it, the same thing works today in
Claude Code with no key: `/describe-finish <description>` (README).

**Turning it on**

- For a whole build: `VITE_DESCRIBE_FINISH=1 pnpm build` (e.g. a Pages environment variable). Nothing in CI
  sets it.
- Locally only (the dev server, `vite preview`, the e2e tests): open the studio with `?describe-finish=1`.
  It is remembered in localStorage (`card-studio.describe-finish`) until `?describe-finish=0`. The override is
  ignored on any non-local origin, so a deployed studio shows it only when built with the flag.

**Providers** (`apps/studio/src/describe/`). With the flag on but no provider, the dialog explains the
options and gives a copyable `/describe-finish …` command for Claude Code.

1. *Bring your own key.* The user pastes an Anthropic API key in the dialog. It stays in that browser's
   localStorage (`card-studio.anthropic-api-key`): never in the URL, a share link, a design or an export, and
   it is shown masked. Requests go from the page straight to `api.anthropic.com` (the official SDK with
   browser access enabled): Claude Opus 5.5, adaptive thinking, structured output, the design-space
   description as a cached system prompt. The user's key is billed.
2. *A proxy* (not deployed yet). Build with `VITE_DESCRIBE_FINISH_PROXY=https://…` and the dialog posts there
   instead (a key the user saved still wins). A proxy keeps the key server side; a Cloudflare Worker is the
   natural fit. Contract:

   ```http
   POST <VITE_DESCRIBE_FINISH_PROXY>
   Content-Type: application/json

   { "version": 1,
     "description": "smoked bronze with a fine hairline brush",          // ≤ 2000 characters
     "current": { "cardholderName": "Ada Lovelace", "cardholderBio": "" }, // optional
     "retry": { "designJson": "{…}", "errors": ["recipe.material: …"] } }  // optional: the previous answer failed validation
   ```

   - `200` with the model's structured output as the body: `{ "summary": "…", "design_json": "{…CardDesign…}" }`.
   - Otherwise a non-2xx status with `{ "error": "message shown to the user" }` (429 for rate limits).

   The Worker should build the request exactly as the browser does, from `@card3d/core/describe`:
   `system: finishSystemPrompt()` (cache it), `messages: [{ role: "user", content: finishUserMessage(body) }]`,
   `output_config.format: { type: "json_schema", schema: FINISH_OUTPUT_SCHEMA }`, and return the text block.
   See `apps/studio/src/describe/anthropic.ts` (`buildMessageParams`) for the model and settings. It should
   allow only the studio's origin (CORS), cap the body size, rate-limit per client, and keep the key in a
   Worker secret. The studio validates every answer (`lintDesign`, plus a GLSL compile of custom layers),
   retries once with the problems listed, and applies the result as one undo step.

## Running the e2e tests locally

```sh
pnpm --filter card-studio e2e:install   # once: Playwright's Chromium
pnpm e2e                                # builds the studio, serves it with vite preview, runs apps/studio/e2e
```

WebGL runs on SwiftShader, as in CI. `E2E_GL=gpu pnpm e2e` uses your GPU instead (faster; pixels then
depend on the machine).

## Publish the packages → npm

`@card3d/core`, `@card3d/element` and `@card3d/react` version as one **fixed** group through
[Changesets](https://github.com/changesets/changesets) and publish from CI with npm **trusted publishing**
(OIDC, with provenance; no npm token is stored). They have never been published: they sit at the `0.0.0`
placeholder, and the pending changesets (`.changeset/first-release.md`, `.changeset/agent-skills.md`, both
minor) make the first release **0.1.0**, the version the READMEs, the skills and the CDN URLs name.

**Day to day.** A PR that changes a package adds a changeset (`pnpm changeset`: pick the packages and the
bump, write the summary, commit the `.changeset/*.md`). The `changeset` job in CI warns when one is missing.

**Version PR** ([`version.yml`](.github/workflows/version.yml), on pushes to `main` under `packages/` or
`.changeset/`): `changesets/action` opens or updates the **"chore: version packages"** PR, running
`pnpm run version` = `changeset version` (bumps the group, writes the CHANGELOGs with PR links) and
`scripts/skill-versions.mjs` (sets the skills' `metadata.library_version` to the new version and records
that edit as reviewed, but only when no skill review is pending; otherwise it leaves them and warns).
`scripts/version-pr-guard.sh` keeps the PR in step with the current `main`. The job ends with
`intent validate` and `intent maintainer check` on the versioned tree.

**Publish** ([`release.yml`](.github/workflows/release.yml)): merging the Version PR pushes to `main`; when
CI passes on that commit, Release runs (`workflow_run`). Its gate checks npm for each package's version
and skips unless one is missing (and the packages already exist on npm). The publish job checks out the
commit CI tested, downloads that run's `engine-wasm` artifact (no Rust rebuild), runs `intent validate`
and `changesets/action` with `pnpm release` (`build:packages` + `pack:check` +
`scripts/publish-if-needed.mjs`, which publishes only the versions npm lacks, with `--provenance` under
OIDC). The action pushes a tag per package (`@card3d/core@0.1.0`, …, at that commit) and cuts the GitHub
Releases. A failed publish: re-run that Release run (same commit and artifact, kept 14 days).

The same by hand:

```sh
pnpm changeset          # write a changeset
pnpm run version        # changeset version + skills' library_version
pnpm build:packages     # tsdown + the standalone bundles (needs the engine's wasm builds, below)
pnpm pack:all           # optional: a .tgz per package (gitignored), to inspect or install elsewhere
pnpm release            # build:packages + pack:check + scripts/publish-if-needed.mjs
```

`node scripts/publish-if-needed.mjs --dry-run` lists what would be published. It refuses the `0.0.0`
placeholder. Each package's `prepack` copies `LICENSE` (and, for core and element, `THIRD_PARTY_NOTICES.md`)
into it, so `pnpm pack` / `pnpm publish` always ship them.

### One-time setup

GitHub (repository → Settings):

1. **Actions → General → Workflow permissions**: tick **"Allow GitHub Actions to create and approve pull
   requests"** (the Version workflow opens its PR with `GITHUB_TOKEN`). The workflows set their own
   permissions; the default can stay read-only.
2. **Branch protection** (or a ruleset) on `main`: require pull requests and these status checks:
   `Rust (fmt, deny, clippy, tests, validator)`, `Web builds (wasm)`, `TypeScript (check, build, pack)`,
   `E2E (Studio, Playwright)` and **`Validate intent skills`** (Check Skills). Add
   `WebGPU + WebGL on SwiftShader (fallbacks, harness subset)` once it has proven stable. Don't require
   `Changeset` (it only warns). If a ruleset restricts tag creation, let GitHub Actions create `@card3d/*`
   tags.
3. **The Version PR runs no checks by itself**: a PR opened with `GITHUB_TOKEN` starts no workflows, so its
   required checks wait. Close and reopen it (as yourself) to run CI and Check Skills on it, then merge.
   (Its Version job already ran `intent maintainer check` on the versioned tree.)
4. Optional: the Actions variable `INTENT_REVIEW_PULL_REQUESTS=true` lets Check Skills' manual runs open
   review PRs.

The first release (npm can't do a package's first publish over OIDC, so it goes from a laptop):

1. On npmjs.com, create the **`card3d`** organization (the `@card3d` scope), and enable 2FA on your account.
2. Merge the first Version PR (0.0.0 → 0.1.0). When CI passes on `main`, Release's gate notes that the
   packages aren't on npm yet and skips.
3. On your machine, at that commit:

   ```sh
   git pull
   # the engine's wasm builds: CI's artifact for this commit (or build them: crates/card3d-web/build-web.sh)
   gh run download <CI run id> -n engine-wasm -D packages/core/wasm
   npm login
   pnpm release                       # builds, checks the tarballs, publishes 0.1.0 of each package
   git push origin --tags             # the @card3d/*@0.1.0 tags it created
   ```

4. For each package on npmjs.com (`@card3d/core`, `@card3d/element`, `@card3d/react`) → Settings →
   **Trusted Publisher** → GitHub Actions: owner `Amir-Abushanab`, repository `card3d`, workflow filename
   **`release.yml`**, no environment. Then, under Publishing access, you can require 2FA and disallow
   tokens: CI publishes over OIDC.

After that every merged Version PR publishes from CI. If OIDC publishing misbehaves, release.yml has a
commented `NODE_AUTH_TOKEN` fallback (a granular npm token as the `NPM_TOKEN` secret).

### Agent skills: right after the first commit

Intent records each skill review against a commit, so the initial review can only be recorded once the
repository has one (until then `intent maintainer review` / `check` stop at "Cannot resolve review base
HEAD"). Run this right after the first commit and before the first push, as a second commit (the record
names the first commit as its baseline: don't amend or squash it away), then push both. Without it, Check
Skills fails on every PR, and so does the first Version run's Intent check.

```sh
pnpm exec intent maintainer status   # 6 pending items: the 5 skills and _artifacts
pnpm exec intent maintainer review --updated "Initial skill batch 1 (2026-11-20): card-design-json, custom-face-shaders-wgsl, engine-stage, embed-metal-card and metal-card-react, and the _artifacts planning records, authored from the @card3d/* sources at this commit (after the 2026-11-23 removal of the one-off cards and front effects: skill_spec.md, Coverage and batch history); generated references from designSpaceSections() via scripts/skill-references.mjs. Checks: intent validate passes (5 skills, TS fences typechecked), skill-references --check current, pnpm pack:check ships every skill file, intent list in a scratch pnpm project shows the transitive skills. Not run: fresh-consumer task checks (skill_spec.md, Remaining work)."
pnpm exec intent maintainer check    # 0 pending review items, checks passed
git add .intent/review-state.json && git commit -m "Record the initial Intent skill review"
```

Once published, the CDN builds are served straight from the package:

- `https://cdn.jsdelivr.net/npm/@card3d/element@0.1/dist/standalone/metal-card.js` (ES module) and
  `…/metal-card.iife.js` (classic script); the card fonts load from `…/dist/standalone/fonts/`.
- `https://cdn.jsdelivr.net/npm/@card3d/core@0.1/dist/standalone/card3d.standalone.js` (the engine API).
- unpkg: the same paths under `https://unpkg.com/@card3d/element@0.1/…`.

Card Studio's Embed dialog already writes snippets with the jsDelivr URL (`@<major.minor>` of
`@card3d/element`'s version).
