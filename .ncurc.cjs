/**
 * npm-check-updates: `pnpm deps:outdated` (a report) and `pnpm deps:update` (writes the package.json
 * ranges, then `pnpm install`). Every workspace package and the root; GitHub Actions pins are updated by
 * hand, not here.
 */
module.exports = {
  workspaces: true,
  root: true,
  packageManager: "pnpm",
  // The same 3-day cooldown as pnpm-workspace.yaml's minimumReleaseAge (which `pnpm install` enforces too).
  cooldown: 3,
  // Only ever the `latest` dist-tag, once it's out of the cooldown: a package whose latest is newer than
  // 3 days is skipped until it isn't (ncu's default would fall back to the highest older version, which can
  // be a stray publish off the latest line).
  target: "@latest",
  format: ["group"],
  // three.js stays at r180: it's the archived reference engine the comparison harness holds the Rust
  // engine to, not a dependency to keep current.
  reject: ["three", "@types/three"],
};
