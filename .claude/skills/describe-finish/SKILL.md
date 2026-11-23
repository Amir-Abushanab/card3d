---
name: describe-finish
description: Turn a text description of a card finish (e.g. "smoked bronze with a fine hairline brush and a faint oil-slick holo") into a valid Card Studio design, optionally with a custom WGSL shader layer, render previews to check it, and hand back a studio link and the JSON. Use when someone asks to describe, design or generate a card finish/look for Card Studio.
argument-hint: <description of the finish>
---

# Describe a finish

You are the model here: no API key involved. The repo's `pnpm finish` CLI gives you the design
space, a validator, studio links and headless previews. Requested finish: **$ARGUMENTS**

If no description was given, ask for one. Run everything from the repo root. Once per machine:
`pnpm install` and `pnpm --filter card-studio e2e:install` (Playwright's Chromium, for renders).

## 1. Read the design space

```sh
pnpm -s finish describe
```

Read all of it before writing anything: every field, range and option, the presets, the built-in
face shaders and the custom-shader contract are generated from the engine, so trust it over memory.
Key facts: hue is `recipe.color` for every material; `texture` + `grain` + `relief` make the surface
(`texture: "none"` only renders flat with grain 0 and relief 0; engine textures such as `brushed` are
fine and mostly show close up); `spectrum` is a built-in iridescent
tint; holo foil is a separate additive layer (`frontHolo`, `holoStyle`, `foilIntensity` 15–35 for
"faint"); shaders only for what the recipe can't do, custom WGSL (`language: "wgsl"`) only when no built-in fits.

## 2. Write the design JSON

Write a complete `CardDesign` to a scratch file outside the repo (your scratchpad, or
`$TMPDIR/describe-finish/<slug>.json`), starting from the closest preset or example. Keep the user's
name if they gave one. No real people's or brands' names, logos or trademarks.

## 3. Validate

```sh
pnpm -s finish check <file>.json
```

Fix every error (unknown fields, bad ids, WGSL annotation errors with `:line`) and re-check. Read
the warnings: a clamped or ignored value usually means the design isn't what you meant.

## 4. Render, look, iterate

```sh
pnpm -s finish render <file>.json --out <scratch dir>
```

It re-checks, compiles every custom shader on the card engine (fix any "WGSL compile errors"), and
writes `<name>-front.png`, `<name>-tilt.png` and `<name>-detail.png` (a 3× close-up of the tilted face;
`--back` adds the back, `--gpu` is faster than the default SwiftShader). Then judge it honestly:

1. Before rendering, list every attribute the description names, each with its qualifier: base
   colour, metal / gloss, surface texture, each effect and how strong ("faint", "bold", …), placement.
2. Open all three PNGs with Read. First write what you actually see, without looking at the JSON.
3. Fill a table, one row per attribute: what the description asks · what the front / tilt / detail
   show · pass or fail. Check textures on the detail as well as at card size, where most engine textures
   read as a sheen. Read qualifiers literally: "faint" or "subtle" means the base material still
   dominates and the effect is a hint you have to look for. An effect covering the face is not faint.
   "Visible brushing" means streaks you can see on the whole card, not only in the close-up.
4. Any fail: change the value that controls it, re-render and redo the table. Do 1–3 rounds; stop
   early only when every row passes. If you stop with a fail, say so plainly in the hand-back.

## 5. Hand back

- the studio link(s) the CLI printed (`http://localhost:5180/#d=…` works with `pnpm dev`; a second
  link appears when `CARD_STUDIO_URL` is set). Custom shader layers from a link open paused: the user
  clicks "Run it";
- the final JSON in a ```json block;
- the preview PNG paths, the final attribute table, and one line on the main choices (preset started
  from, key values).

## 6. Keeping it (optional)

Card Studio has no preset files on disk: drafts live in the browser. If the user wants a file,
`render` already wrote `<name>.card.json` (the studio's "Save design" format) next to the PNGs; copy
it where they ask and tell them to open it with **Save & share → Open design (.json)**. Don't add
designs to the repo's presets unless asked.
