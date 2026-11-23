//! Lighting presets (`scene/lighting-presets.ts`, the single-card stage): each retunes the studio rig
//! (the environment's panels by role, the punctual lights, the exposure, the environment's intensity
//! and turn). "studio" is the identity. HDRI grades and backdrops belong to scenes (phase 7).

use crate::env::Look;

#[derive(Clone, Debug)]
pub struct LightingPreset {
    pub id: &'static str,
    /// None: the untouched rig (studio).
    pub look: Option<Look>,
    /// `scene.environmentIntensity` and `environmentRotation.y` (radians).
    pub env_intensity: f64,
    pub env_rotation_y: f64,
    pub ambient: (&'static str, f64),
    /// Colour, intensity, position (the target is the origin).
    pub key: (&'static str, f64, [f64; 3]),
    pub exposure: f64,
}

fn look(
    key: f64,
    fill: f64,
    base: f64,
    key_tint: Option<&'static str>,
    fill_tint: Option<&'static str>,
    rim: Option<(f64, Option<&'static str>)>,
) -> Option<Look> {
    Some(Look { key: Some(key), fill: Some(fill), base: Some(base), key_tint, fill_tint, rim })
}

/// The preset for a design's `lighting` (unknown or absent: studio).
pub fn preset(id: Option<&str>) -> LightingPreset {
    match id.unwrap_or("studio") {
        "dramatic" => LightingPreset {
            id: "dramatic",
            look: look(1.5, 0.4, 0.6, None, None, Some((12.0, Some("#e6ecff")))),
            env_intensity: 1.0,
            env_rotation_y: 0.15,
            ambient: ("#ffffff", 0.22),
            key: ("#ffffff", 0.7, [-7.0, 3.0, 3.0]),
            exposure: 1.0,
        },
        "warm" => LightingPreset {
            id: "warm",
            look: look(1.05, 1.05, 1.0, Some("#ffe0bd"), Some("#ffeedc"), Some((8.0, Some("#ffd9b0")))),
            env_intensity: 1.0,
            env_rotation_y: 0.12,
            ambient: ("#ffe6cc", 0.38),
            key: ("#ffd2a0", 0.45, [-5.0, 4.0, 6.0]),
            exposure: 0.95,
        },
        "cool" => LightingPreset {
            id: "cool",
            look: look(1.05, 1.15, 1.0, Some("#d4e6ff"), Some("#bcd3f2"), Some((8.0, Some("#cfe0ff")))),
            env_intensity: 1.0,
            env_rotation_y: -0.12,
            ambient: ("#d6e4ff", 0.38),
            key: ("#c4dcff", 0.42, [-4.0, 6.0, 6.0]),
            exposure: 0.93,
        },
        "dark" => LightingPreset {
            id: "dark",
            look: look(0.85, 0.45, 0.5, None, None, Some((10.0, None))),
            env_intensity: 0.9,
            env_rotation_y: 0.0,
            ambient: ("#ffffff", 0.24),
            key: ("#ffffff", 0.3, [-4.0, 5.0, 7.0]),
            exposure: 0.92,
        },
        "light" => LightingPreset {
            id: "light",
            look: look(0.9, 1.5, 14.0, None, None, None),
            env_intensity: 1.05,
            env_rotation_y: 0.0,
            ambient: ("#ffffff", 0.55),
            key: ("#ffffff", 0.4, [-3.0, 6.0, 7.0]),
            exposure: 0.95,
        },
        _ => LightingPreset {
            id: "studio",
            look: None,
            env_intensity: 1.0,
            env_rotation_y: 0.0,
            ambient: ("#ffffff", 0.36),
            key: ("#ffffff", 0.34, [-4.0, 5.0, 7.0]),
            exposure: 0.9,
        },
    }
}
