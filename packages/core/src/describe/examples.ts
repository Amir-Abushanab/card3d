/**
 * Worked examples for the design-space description: a description and the design JSON it maps to.
 * describe.test.ts lints every one (no errors, no warnings), so they stay valid as the model changes.
 */
export interface DesignExample {
  description: string;
  design: Record<string, unknown>;
}

export const DESIGN_EXAMPLES: readonly DesignExample[] = [
  {
    description: "Champagne gold with a fine brushed grain and a faint silvery holo",
    design: {
      recipe: {
        material: "silver",
        color: "#d8bd86",
        texture: "brushed",
        grain: 34,
        polish: 72,
        relief: 30,
        spectrum: 8,
        frontHolo: true,
        matchHoloSides: true,
        holoStyle: "shiny",
        foilTexture: "etched",
        foilIntensity: 26,
        holoGlare: 30,
      },
      cardholderName: "Ada Lovelace",
      cardholderBio: "",
      decals: [],
      surfaceSources: {},
      surfaceTreatments: {},
    },
  },
  {
    description: "Matte black anodised slab, engraved name, electric-blue anodised edge, dramatic light",
    design: {
      recipe: { material: "oxide", color: "#16181a", texture: "sandblasted", grain: 40, polish: 18, relief: 35, spectrum: 0 },
      cardholderName: "Ada Lovelace",
      cardholderBio: "",
      decals: [],
      surfaceSources: {},
      surfaceTreatments: {},
      finish: { name: "engraved", logo: "engraved" },
      edge: { finish: "anodized", color: "#2f6fd6", chamfer: true },
      lighting: "dramatic",
    },
  },
  {
    description: "Gunmetal with a slow oil-slick sheen (a built-in shader layer)",
    design: {
      recipe: { material: "titanium", color: "#3d3e3c", texture: "none", grain: 0, polish: 64, relief: 0, spectrum: 12 },
      cardholderName: "Ada Lovelace",
      cardholderBio: "",
      decals: [],
      surfaceSources: {},
      surfaceTreatments: {},
      shaders: [{ id: "oil-slick", side: "both", target: "overlay", blend: "screen", params: { strength: 0.3, speed: 0.15 } }],
    },
  },
  {
    description: "Coarse brushed steel whose streaks read on the whole card (a custom WGSL skin under the metal)",
    design: {
      recipe: { material: "silver", color: "#b9bcc0", texture: "brushed", grain: 60, polish: 66, relief: 70, spectrum: 0 },
      cardholderName: "Ada Lovelace",
      cardholderBio: "",
      decals: [],
      surfaceSources: {},
      surfaceTreatments: {},
      shaders: [
        {
          id: "custom",
          language: "wgsl",
          side: "both",
          target: "skin",
          params: { uContrast: 0.12, uLines: 440 },
          code: [
            "// Brushed streaks that read at card size: hairlines of the base colour, long along x.",
            'var<private> uContrast: f32; // @param 0 0.4 0.12 label="Streak contrast"',
            'var<private> uLines: f32;    // @param 60 600 440 label="Hairlines per card height"',
            "",
            "fn mainImage(uv: vec2f) -> vec4f {",
            "  let p = facePos;",
            "  let n = 0.6 * noise(vec2f(p.x * 9.0, p.y * uLines)) + 0.4 * noise(vec2f(p.x * 1.7 + 9.0, p.y * uLines * 0.41));",
            "  return vec4f(uBaseColor * (1.0 + (n - 0.5) * 2.0 * uContrast), 1.0);",
            "}",
          ].join("\n"),
        },
      ],
    },
  },
  {
    description: "Midnight-blue metal with gold contour lines (a custom WGSL skin)",
    design: {
      recipe: { material: "silver", color: "#1b2340", texture: "none", grain: 0, polish: 66, relief: 0, spectrum: 0 },
      cardholderName: "Ada Lovelace",
      cardholderBio: "",
      decals: [],
      surfaceSources: {},
      surfaceTreatments: {},
      shaders: [
        {
          id: "custom",
          language: "wgsl",
          side: "front",
          target: "skin",
          code: [
            "// Gold topographic contour lines over the base colour, calm around the chip.",
            'var<private> uLine: vec3f;  // @color #d9b25f label="Line colour"',
            'var<private> uScale: f32;   // @param 1 10 3.5 label="Scale"',
            'var<private> uLines: f32;   // @param 4 40 14 label="Lines"',
            "",
            "fn mainImage(uv: vec2f) -> vec4f {",
            "  let h = fbm(facePos * uScale);",
            "  let f = fract(h * uLines);",
            "  let w = fwidth(h * uLines);",
            "  var line = 1.0 - smoothstep(0.0, 1.5 * w, min(f, 1.0 - f));",
            "  line *= smoothstep(0.0, 0.05, chipDistance(uv));",
            "  return vec4f(mix(uBaseColor, uLine, line), 1.0);",
            "}",
          ].join("\n"),
        },
      ],
    },
  },
];
