//! Quality tiers (`QUALITY_PRESETS`, quality.ts): the per-tier rendering budget.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Quality {
    /// Phones and embeds: the stage's default.
    Performance,
    /// The desktop tier (the comparison harness renders this).
    #[default]
    Full,
}

/// `QualityPreset`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct QualityPreset {
    /// Device-pixel-ratio range (min, max) for a standalone canvas.
    pub dpr: (f64, f64),
    /// Cube resolution of the studio environment (`environmentResolution`).
    pub environment_resolution: u32,
    /// Side of the generated surface maps, every texture mode (`brushedTextureSize`).
    pub surface_size: u32,
    /// Cap on the body / face and chip anisotropy; the inlay overlay is uncapped (`bodyAnisotropy`).
    pub body_anisotropy: f32,
}

impl Quality {
    /// "performance" or "full"; anything else is `None`.
    pub fn parse(s: &str) -> Option<Quality> {
        match s {
            "performance" => Some(Quality::Performance),
            "full" => Some(Quality::Full),
            _ => None,
        }
    }

    pub fn preset(self) -> QualityPreset {
        match self {
            Quality::Performance => QualityPreset { dpr: (1.0, 1.25), environment_resolution: 128, surface_size: 256, body_anisotropy: 0.48 },
            Quality::Full => QualityPreset { dpr: (1.0, 2.0), environment_resolution: 256, surface_size: 512, body_anisotropy: 0.68 },
        }
    }

    /// `resolvePixelRatio`: the device's ratio clamped to the tier's range.
    pub fn pixel_ratio(self, device_pixel_ratio: f64) -> f64 {
        let (lo, hi) = self.preset().dpr;
        hi.min(lo.max(device_pixel_ratio))
    }
}
