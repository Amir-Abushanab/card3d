//! The TypeScript's catalogs (ids, parameter tables, ranges, field lists), read from catalog.json,
//! which `node crates/card3d-tools/validate-catalog.ts` writes from packages/core/src.

use super::js::{parse, JsValue};
use std::sync::OnceLock;

pub(super) struct ParamSpec {
    pub key: String,
    /// "float", "int", "bool", "color", "vec2", "vec3" (shaders); "select" too (effects).
    pub ty: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// Option values: numbers for shader params, strings for effect selects.
    pub options: Vec<JsValue>,
}

pub(super) struct Shader {
    pub id: String,
    pub targets: Vec<String>,
    pub default_target: String,
    pub params: Vec<ParamSpec>,
}

pub(super) struct RecipeControl {
    pub key: String,
    /// "enum", "range", "color", "boolean".
    pub kind: String,
    pub options: Vec<String>,
    pub min: f64,
    pub max: f64,
}

pub(super) struct Fields {
    pub design: Vec<String>,
    pub material_override: Vec<String>,
    pub branding_override: Vec<String>,
    pub finish: Vec<String>,
    pub edge: Vec<String>,
    pub shape: Vec<String>,
    pub contactless: Vec<String>,
    pub text_line: Vec<String>,
    pub logo: Vec<String>,
    pub scene: Vec<String>,
    pub floor: Vec<String>,
    pub layer: Vec<String>,
    pub addon: Vec<String>,
}

pub(super) struct Catalog {
    pub default_name: String,
    /// `DEFAULT_RECIPE`, in its key order.
    pub default_recipe: JsValue,
    pub materials: Vec<String>,
    pub textures: Vec<String>,
    pub holo_styles: Vec<String>,
    pub foil_textures: Vec<String>,
    pub recipe_controls: Vec<RecipeControl>,
    pub fonts: Vec<String>,
    pub lighting: Vec<String>,
    pub logo_positions: Vec<String>,
    pub logo_scale: (f64, f64),
    pub logo_path_chars: usize,
    pub logo_src_chars: usize,
    pub shaders: Vec<Shader>,
    pub prelude: Vec<String>,
    pub effects: Vec<(String, Vec<ParamSpec>)>,
    pub addons: Vec<String>,
    /// `CORNER_RADIUS_RANGE`: min, iso, max.
    pub corner_radius: (f64, f64, f64),
    pub contactless_scale: (f64, f64),
    pub decal_min_crop: f64,
    pub decal_aspect: (f64, f64),
    pub fields: Fields,
}

impl Catalog {
    pub(super) fn shader(&self, id: &str) -> Option<&Shader> {
        self.shaders.iter().find(|s| s.id == id)
    }
    pub(super) fn effect(&self, id: &str) -> &[ParamSpec] {
        self.effects.iter().find(|(e, _)| e == id).map_or(&[], |(_, p)| p)
    }
    pub(super) fn recipe_control(&self, key: &str) -> Option<&RecipeControl> {
        self.recipe_controls.iter().find(|c| c.key == key)
    }
}

static CATALOG: OnceLock<Catalog> = OnceLock::new();

pub(super) fn get() -> &'static Catalog {
    CATALOG.get_or_init(|| load(include_str!("catalog.json")))
}

fn strings(v: Option<&JsValue>) -> Vec<String> {
    v.and_then(JsValue::arr).unwrap_or(&[]).iter().filter_map(|s| s.str().map(str::to_string)).collect()
}

fn num(v: Option<&JsValue>) -> f64 {
    v.and_then(JsValue::num).unwrap_or(0.0)
}

fn params(v: Option<&JsValue>) -> Vec<ParamSpec> {
    v.and_then(JsValue::arr)
        .unwrap_or(&[])
        .iter()
        .map(|p| ParamSpec {
            key: p.at("key").and_then(JsValue::str).unwrap_or("").to_string(),
            ty: p.at("type").and_then(JsValue::str).unwrap_or("").to_string(),
            min: p.at("min").and_then(JsValue::num),
            max: p.at("max").and_then(JsValue::num),
            options: p.at("options").and_then(JsValue::arr).map(<[JsValue]>::to_vec).unwrap_or_default(),
        })
        .collect()
}

fn load(text: &str) -> Catalog {
    let c = parse(text).expect("catalog.json");
    let f = c.at("fields");
    let field = |k: &str| strings(f.and_then(|f| f.at(k)));
    let logo = c.at("logo");
    let corner = c.at("cornerRadius");
    let decal = c.at("decal");
    Catalog {
        default_name: c.at("defaultName").and_then(JsValue::str).unwrap_or("").to_string(),
        default_recipe: c.at("defaultRecipe").cloned().unwrap_or(JsValue::Null),
        materials: strings(c.at("materials")),
        textures: strings(c.at("textures")),
        holo_styles: strings(c.at("holoStyles")),
        foil_textures: strings(c.at("foilTextures")),
        recipe_controls: c
            .at("recipeControls")
            .and_then(JsValue::arr)
            .unwrap_or(&[])
            .iter()
            .map(|r| RecipeControl {
                key: r.at("key").and_then(JsValue::str).unwrap_or("").to_string(),
                kind: r.at("kind").and_then(JsValue::str).unwrap_or("").to_string(),
                options: strings(r.at("options")),
                min: num(r.at("min")),
                max: num(r.at("max")),
            })
            .collect(),
        fonts: strings(c.at("fonts")),
        lighting: strings(c.at("lighting")),
        logo_positions: strings(logo.and_then(|l| l.at("positions"))),
        logo_scale: (num(logo.and_then(|l| l.at("scaleMin"))), num(logo.and_then(|l| l.at("scaleMax")))),
        logo_path_chars: num(logo.and_then(|l| l.at("pathChars"))) as usize,
        logo_src_chars: num(logo.and_then(|l| l.at("srcChars"))) as usize,
        shaders: c
            .at("shaders")
            .and_then(JsValue::arr)
            .unwrap_or(&[])
            .iter()
            .map(|s| Shader {
                id: s.at("id").and_then(JsValue::str).unwrap_or("").to_string(),
                targets: strings(s.at("targets")),
                default_target: s.at("defaultTarget").and_then(JsValue::str).unwrap_or("skin").to_string(),
                params: params(s.at("params")),
            })
            .collect(),
        prelude: strings(c.at("prelude")),
        effects: c
            .at("effects")
            .and_then(JsValue::arr)
            .unwrap_or(&[])
            .iter()
            .map(|e| (e.at("id").and_then(JsValue::str).unwrap_or("").to_string(), params(e.at("params"))))
            .collect(),
        addons: strings(c.at("addons")),
        corner_radius: (num(corner.and_then(|r| r.at("min"))), num(corner.and_then(|r| r.at("iso"))), num(corner.and_then(|r| r.at("max")))),
        contactless_scale: (num(c.at("contactlessScale").and_then(|r| r.at("min"))), num(c.at("contactlessScale").and_then(|r| r.at("max")))),
        decal_min_crop: num(decal.and_then(|d| d.at("minCrop"))),
        decal_aspect: (num(decal.and_then(|d| d.at("aspectMin"))), num(decal.and_then(|d| d.at("aspectMax")))),
        fields: Fields {
            design: field("design"),
            material_override: field("materialOverride"),
            branding_override: field("brandingOverride"),
            finish: field("finish"),
            edge: field("edge"),
            shape: field("shape"),
            contactless: field("contactless"),
            text_line: field("textLine"),
            logo: field("logo"),
            scene: field("scene"),
            floor: field("floor"),
            layer: field("layer"),
            addon: field("addon"),
        },
    }
}
