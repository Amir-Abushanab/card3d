//! The design the engine draws: `CardDesign` from `@card3d/core` (types.ts), read from JSON. The
//! TypeScript `ensureDesign` validates designs on the web; these types accept any complete design
//! and fill missing fields with the engine defaults (`DEFAULT_RECIPE`); a field of the wrong type
//! counts as missing. Fields the engine does not draw yet are listed by `CardDesign::unsupported`.

use std::collections::HashMap;

use crate::json::{self, Map, Value};

/// Field readers: `None` when the key is missing, `null` or of another type.
pub(crate) fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k)?.as_str().map(str::to_string)
}
pub(crate) fn n(v: &Value, k: &str) -> Option<f64> {
    v.get(k)?.as_f64()
}
pub(crate) fn b(v: &Value, k: &str) -> Option<bool> {
    v.get(k)?.as_bool()
}
/// The objects of array `k` read by `f` (other entries skipped).
pub(crate) fn list<T>(v: &Value, k: &str, f: impl Fn(&Value) -> T) -> Vec<T> {
    v.get(k).and_then(Value::as_array).map_or_else(Vec::new, |a| a.iter().filter(|x| x.as_object().is_some()).map(f).collect())
}
/// Object `k` read by `f`.
pub(crate) fn obj<T>(v: &Value, k: &str, f: impl Fn(&Value) -> T) -> Option<T> {
    v.get(k).filter(|x| x.as_object().is_some()).map(f)
}
fn pair(v: &Value, k: &str) -> Option<[f64; 2]> {
    match v.get(k)?.as_array()? {
        [a, b] => Some([a.as_f64()?, b.as_f64()?]),
        _ => None,
    }
}
fn strings(v: &Value, k: &str) -> HashMap<String, String> {
    v.get(k).and_then(Value::as_object).map_or_else(HashMap::new, |m| m.iter().filter_map(|(k, x)| Some((k.to_string(), x.as_str()?.to_string()))).collect())
}

/// `Self { field: reader(v, "key").unwrap_or(default.field), … }`.
macro_rules! read_fields {
    ($v:ident, $d:ident; $($field:ident: $reader:ident($key:literal)),* $(,)?) => {
        Self { $($field: $reader($v, $key).unwrap_or($d.$field)),* }
    };
}

/// `Recipe` (types.ts), defaults from `DEFAULT_RECIPE` (recipe/defaults.ts).
#[derive(Clone, Debug)]
pub struct Recipe {
    pub material: String,
    pub pattern: String,
    pub texture: String,
    pub color: String,
    pub grain: f64,
    pub polish: f64,
    pub relief: f64,
    pub spectrum: f64,
    pub front_holo: bool,
    pub back_holo: bool,
    pub match_holo_sides: bool,
    pub holo_style: String,
    pub foil_texture: String,
    pub foil_intensity: f64,
    pub holo_glare: f64,
    pub holo_motion: bool,
    pub foil_scale: f64,
    pub foil_coverage: String,
    pub back_holo_style: String,
    pub back_foil_texture: String,
    pub back_foil_intensity: f64,
    pub back_holo_glare: f64,
    pub back_holo_motion: bool,
    pub back_foil_scale: f64,
    pub back_foil_coverage: String,
}

impl Recipe {
    pub fn read(v: &Value) -> Self {
        let d = Self::default();
        read_fields!(v, d;
            material: s("material"), pattern: s("pattern"), texture: s("texture"), color: s("color"),
            grain: n("grain"), polish: n("polish"), relief: n("relief"), spectrum: n("spectrum"),
            front_holo: b("frontHolo"), back_holo: b("backHolo"), match_holo_sides: b("matchHoloSides"),
            holo_style: s("holoStyle"), foil_texture: s("foilTexture"), foil_intensity: n("foilIntensity"),
            holo_glare: n("holoGlare"), holo_motion: b("holoMotion"), foil_scale: n("foilScale"),
            foil_coverage: s("foilCoverage"), back_holo_style: s("backHoloStyle"),
            back_foil_texture: s("backFoilTexture"), back_foil_intensity: n("backFoilIntensity"),
            back_holo_glare: n("backHoloGlare"), back_holo_motion: b("backHoloMotion"),
            back_foil_scale: n("backFoilScale"), back_foil_coverage: s("backFoilCoverage"),
        )
    }
}

impl Default for Recipe {
    fn default() -> Self {
        Recipe {
            material: "silver".into(),
            pattern: "none".into(),
            texture: "none".into(),
            color: "#d9d6cc".into(),
            grain: 30.0,
            polish: 58.0,
            relief: 72.0,
            spectrum: 0.0,
            front_holo: false,
            back_holo: false,
            match_holo_sides: true,
            holo_style: "vmax".into(),
            foil_texture: "etched".into(),
            foil_intensity: 78.0,
            holo_glare: 68.0,
            holo_motion: true,
            foil_scale: 100.0,
            foil_coverage: "cover".into(),
            back_holo_style: "vmax".into(),
            back_foil_texture: "etched".into(),
            back_foil_intensity: 78.0,
            back_holo_glare: 68.0,
            back_holo_motion: true,
            back_foil_scale: 100.0,
            back_foil_coverage: "cover".into(),
        }
    }
}

/// `MaterialOverride` / `BrandingOverride` (types.ts): any key wins over the computed value.
#[derive(Clone, Debug, Default)]
pub struct MaterialOverride {
    pub color: Option<String>,
    pub metalness: Option<f64>,
    pub roughness: Option<f64>,
    pub clearcoat: Option<f64>,
    pub clearcoat_roughness: Option<f64>,
    pub transmission: Option<f64>,
    pub thickness: Option<f64>,
    pub ior: Option<f64>,
    /// Branding only.
    pub branding_clearcoat: Option<f64>,
}

impl MaterialOverride {
    pub fn read(v: &Value) -> Self {
        Self {
            color: s(v, "color"),
            metalness: n(v, "metalness"),
            roughness: n(v, "roughness"),
            clearcoat: n(v, "clearcoat"),
            clearcoat_roughness: n(v, "clearcoatRoughness"),
            transmission: n(v, "transmission"),
            thickness: n(v, "thickness"),
            ior: n(v, "ior"),
            branding_clearcoat: n(v, "brandingClearcoat"),
        }
    }
}

/// `CardLogo`: a path logo (`path` in `view_box`, from `origin`) or a raster mask (`src`).
#[derive(Clone, Debug, Default)]
pub struct CardLogo {
    pub path: Option<String>,
    pub view_box: Option<[f64; 2]>,
    pub origin: Option<[f64; 2]>,
    pub fill_rule: Option<String>,
    pub src: Option<String>,
    pub aspect: Option<f64>,
    pub position: Option<String>,
    pub scale: Option<f64>,
}

impl CardLogo {
    pub fn read(v: &Value) -> Self {
        Self {
            path: s(v, "path"),
            view_box: pair(v, "viewBox"),
            origin: pair(v, "origin"),
            fill_rule: s(v, "fillRule"),
            src: s(v, "src"),
            aspect: n(v, "aspect"),
            position: s(v, "position"),
            scale: n(v, "scale"),
        }
    }
}

/// `CardFinishes`: per mark, "default", "embossed", "engraved" or "etched".
#[derive(Clone, Debug, Default)]
pub struct CardFinishes {
    pub name: Option<String>,
    pub bio: Option<String>,
    pub logo: Option<String>,
}

impl CardFinishes {
    pub fn read(v: &Value) -> Self {
        Self { name: s(v, "name"), bio: s(v, "bio"), logo: s(v, "logo") }
    }
}

/// `CardContactless`.
#[derive(Clone, Debug, Default)]
pub struct CardContactless {
    pub finish: Option<String>,
    pub scale: Option<f64>,
}

impl CardContactless {
    pub fn read(v: &Value) -> Self {
        Self { finish: s(v, "finish"), scale: n(v, "scale") }
    }
}

/// `CardTextLine`.
#[derive(Clone, Debug, Default)]
pub struct CardTextLine {
    pub text: String,
    pub font: Option<String>,
    pub size: Option<f64>,
    pub tracking: Option<f64>,
    pub align: Option<String>,
    pub placement: Option<String>,
}

impl CardTextLine {
    pub fn read(v: &Value) -> Self {
        Self {
            text: s(v, "text").unwrap_or_default(),
            font: s(v, "font"),
            size: n(v, "size"),
            tracking: n(v, "tracking"),
            align: s(v, "align"),
            placement: s(v, "placement"),
        }
    }
}

/// `CardDesign.frontLayout`: name placement override (fractions of the card height).
#[derive(Clone, Copy, Debug, Default)]
pub struct FrontLayout {
    pub name_font_height: Option<f64>,
    pub name_bottom: Option<f64>,
}

impl FrontLayout {
    pub fn read(v: &Value) -> Self {
        Self { name_font_height: n(v, "nameFontHeight"), name_bottom: n(v, "nameBottom") }
    }
}

/// `CardDesign` (types.ts). Unknown fields are ignored.
#[derive(Clone, Debug, Default)]
pub struct CardDesign {
    pub recipe: Recipe,
    pub cardholder_name: String,
    pub cardholder_bio: String,
    pub material_override: Option<MaterialOverride>,
    pub branding_override: Option<MaterialOverride>,
    pub logo: Option<CardLogo>,
    pub finish: Option<CardFinishes>,
    pub contactless: Option<CardContactless>,
    pub text_lines: Vec<CardTextLine>,
    pub front_layout: Option<FrontLayout>,
    // Not drawn yet; read so `unsupported` can name them.
    pub decals: Vec<crate::decals::Decal>,
    /// Artwork per side ("front", "back"): an image `src`.
    pub surface_sources: HashMap<String, String>,
    /// "inlay" or "printed" per side.
    pub surface_treatments: HashMap<String, String>,
    /// A lighting preset id (`LIGHTING_PRESETS`).
    pub lighting: Option<String>,
    /// Face shader layers (`FaceShader`; see `face_shaders`).
    pub shaders: Vec<Value>,
    addons: Option<Map>,
    pub shape: Option<Value>,
    pub edge: Option<Value>,
    /// A catalog font id, or a custom font object (`CardCustomFont`); see `fonts::resolve`.
    pub font: Option<Value>,
    scene: Option<Value>,
}

impl CardDesign {
    pub fn from_json(text: &str) -> Result<CardDesign, String> {
        Self::from_value(&json::parse(text).map_err(|e| format!("card design: {e}"))?)
    }

    /// `from_json` for JSON already parsed.
    pub fn from_value(v: &Value) -> Result<CardDesign, String> {
        if v.as_object().is_none() {
            return Err("card design: expected an object".into());
        }
        Ok(Self::read(v))
    }

    pub fn read(v: &Value) -> Self {
        Self {
            recipe: obj(v, "recipe", Recipe::read).unwrap_or_default(),
            cardholder_name: s(v, "cardholderName").unwrap_or_default(),
            cardholder_bio: s(v, "cardholderBio").unwrap_or_default(),
            material_override: obj(v, "materialOverride", MaterialOverride::read),
            branding_override: obj(v, "brandingOverride", MaterialOverride::read),
            logo: obj(v, "logo", CardLogo::read),
            finish: obj(v, "finish", CardFinishes::read),
            contactless: obj(v, "contactless", CardContactless::read),
            text_lines: list(v, "textLines", CardTextLine::read),
            front_layout: obj(v, "frontLayout", FrontLayout::read),
            decals: list(v, "decals", crate::decals::Decal::read),
            surface_sources: strings(v, "surfaceSources"),
            surface_treatments: strings(v, "surfaceTreatments"),
            lighting: s(v, "lighting"),
            shaders: v.get("shaders").and_then(Value::as_array).map_or_else(Vec::new, <[Value]>::to_vec),
            addons: v.get("addons").and_then(Value::as_object).cloned(),
            shape: v.get("shape").cloned(),
            edge: v.get("edge").cloned(),
            font: v.get("font").cloned(),
            scene: v.get("scene").cloned(),
        }
    }

    /// `scene`: the design's staging (`CardScene`: environment, backdrop, floor), when it has one.
    pub fn scene(&self) -> Option<&Map> {
        self.scene.as_ref().and_then(Value::as_object)
    }

    /// Add-on `id` when the design asks for it (present, not null or false: `activeAddons`), with its
    /// parameters when they are an object.
    pub fn addon(&self, id: &str) -> Option<Option<&Map>> {
        let v = self.addons.as_ref()?.get(id).filter(|v| !v.is_null() && v.as_bool() != Some(false))?;
        Some(v.as_object())
    }

    /// The design features this engine does not draw yet (the migration's to-do for this design).
    pub fn unsupported(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        let mut add = |cond: bool, what| {
            if cond {
                out.push(what)
            }
        };
        // Face shaders the engine doesn't draw: custom GLSL.
        add(self.shaders.iter().any(|s| !crate::face_shaders::supported(s)), "face shaders");
        // The add-ons are shine and vines (`ADDON_IDS`); anything else is skipped as unknown.
        add(
            self.addons.as_ref().is_some_and(|a| a.iter().any(|(k, v)| !matches!(k, "shine" | "vines") && !v.is_null() && v.as_bool() != Some(false))),
            "add-ons",
        );
        out
    }
}
