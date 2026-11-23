#!/usr/bin/env node
/**
 * Keeps each shipped skill's `metadata.library_version` (packages/<pkg>/skills/<name>/SKILL.md, TanStack
 * Intent) at its package's version. Runs in the root `version` script right after `changeset version`, so
 * the bump rides the Version Packages PR (.github/workflows/version.yml) with the package.json and
 * CHANGELOG bumps.
 *
 * Intent's rule is to change library_version only when the guidance is verified for that version. Here
 * that holds when every source and guidance change since the last release already has a recorded review
 * (`intent maintainer check` runs on every PR: .github/workflows/check-skills.yml). So:
 *
 *   1. `intent maintainer review --json` before touching anything. A pending item (a change merged
 *      without its review record) → leave the versions alone, warn, exit 0: `intent stale` and the next
 *      `maintainer check` keep reporting it until someone reviews it.
 *   2. `intent validate packages/<pkg>/skills --set-version <version>` for each package whose skills lag.
 *   3. Check that the only pending changes are now the SKILL.md files just edited, record them as
 *      unchanged guidance (`intent maintainer review --unchanged`), and run `intent maintainer check`.
 *      Without that record, the edit would reopen every skill's review and fail the next PR's check.
 *
 * Without Git history (no commit yet) the review can't run: the script warns and changes nothing.
 *
 *   node scripts/skill-versions.mjs             # what `pnpm run version` runs
 *   node scripts/skill-versions.mjs --dry-run   # report what it would do
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const DRY = process.argv.includes("--dry-run");
const intentBin = join(root, "node_modules/.bin/intent");
const warn = (msg) => console.warn(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `warning: ${msg}`);
const intent = (args, opts = {}) => execFileSync(intentBin, args, { cwd: root, encoding: "utf8", ...opts });

/** The library_version in a SKILL.md's leading frontmatter, or null. */
function libraryVersion(file) {
  const md = readFileSync(file, "utf8");
  const end = md.indexOf("\n---", 4);
  if (!md.startsWith("---") || end === -1) return null;
  return md.slice(0, end).match(/^\s*library_version:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1] ?? null;
}

// Packages that ship skills, and the skill files whose library_version isn't the package's version.
const lagging = [];
for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  const dir = join(root, "packages", entry.name);
  const skillsDir = join(dir, "skills");
  if (!entry.isDirectory() || !existsSync(skillsDir)) continue;
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  // 0.0.0 is the never-published placeholder (the first `pnpm run version` replaces it): skills name the
  // version they target, not the placeholder.
  if (version === "0.0.0") continue;
  const files = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
    .map((e) => join(skillsDir, e.name, "SKILL.md"))
    .filter((f) => libraryVersion(f) !== version);
  if (files.length) lagging.push({ skillsDir: relative(root, skillsDir), version, files: files.map((f) => relative(root, f)) });
}
if (lagging.length === 0) {
  console.log("✓ no skill's library_version needs setting");
  process.exit(0);
}
const summary = lagging.map((l) => `${l.skillsDir} → ${l.version}`).join(", ");

/** Pending items of `intent maintainer review --json`, or null when the review can't run. */
function pendingReview() {
  try {
    return JSON.parse(intent(["maintainer", "review", "--json"], { stdio: ["ignore", "pipe", "pipe"] })).items ?? [];
  } catch (err) {
    warn(`intent maintainer review failed, so the guidance can't be shown reviewed: ${String(err?.stderr || err?.stdout || err).trim()}`);
    return null;
  }
}

const before = pendingReview();
if (before === null || before.length > 0) {
  if (before?.length) {
    warn(
      `skill reviews are pending (${before.map((i) => i.id).join(", ")}), so library_version stays as it is (${summary} not applied). ` +
        "Review them (pnpm exec intent maintainer review), then run node scripts/skill-versions.mjs.",
    );
  }
  process.exit(0);
}
if (DRY) {
  console.log(`(dry run) would set library_version: ${summary}, then record the edit as unchanged guidance`);
  process.exit(0);
}

for (const l of lagging) intent(["validate", l.skillsDir, "--set-version", l.version], { stdio: "inherit" });

// Only the version lines just written may be pending now (each edited skill, and the planning record,
// whose snapshot includes the skills).
const edited = new Set(lagging.flatMap((l) => l.files));
const after = pendingReview();
const unexpected = (after ?? [{ id: "(review failed)", changedFiles: [] }]).filter(
  (i) => !i.changedFiles?.length || i.changedFiles.some((f) => !edited.has(f)),
);
if (unexpected.length) {
  console.error(
    `✗ after setting library_version, more than the version lines is pending review: ${unexpected.map((i) => `${i.id} (${(i.changedFiles ?? []).join(", ")})`).join("; ")}`,
  );
  process.exit(1);
}
const reason =
  `metadata.library_version set (${summary}) by scripts/skill-versions.mjs after changeset version. ` +
  "No source or guidance change was pending review before this edit, so the reviewed guidance stands for this version; the version line is the only change.";
intent(["maintainer", "review", "--unchanged", reason], { stdio: "inherit" });
intent(["maintainer", "check"], { stdio: "inherit" });
console.log(`✓ skills' library_version: ${summary}`);
