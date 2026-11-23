/** The studio rig's values (no three.js: lighting presets and the design model read them). */

export const STUDIO_LIGHTS = {
  ambient: { color: "#ffffff", intensity: 0.36 },
  key: { color: "#ffffff", intensity: 0.34, position: [-4, 5, 7] as const },
};
/** The marquee's frontal fill light. Active hero only. @archive the local three.js archive imports it */
export const MARQUEE_FRONTAL_FILL = { color: "#ffffff", intensity: 0.28, position: [0, 1.2, 8] as const };

/** ACES filmic exposure of every card renderer. */
export const TONE_MAPPING_EXPOSURE = 0.9;
