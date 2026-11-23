//! Face shader layers (`shaders/layers.ts`): the design's
//! `shaders`, each a built-in by id with its params, on a face as a **skin** (composited in order into
//! that face's sRGB target over the card's base colour; the target becomes the face skin's map) or an
//! **overlay** (a mesh on the face plane above the artwork, blended with the canvas).
//!
//! Shaders are WGSL (shaders/face/): the prelude (`prelude.wgsl`), the layer's parameter
//! declarations, the shader's `mainImage`, and the entry points (`prelude-end.wgsl`). Live layers
//! (animated, not frozen) advance a shared clock and the card's tilt spring each frame; skins
//! re-render at ≤ 30 Hz.

use std::rc::Rc;

use glam::{Mat4, Vec3};

use crate::json::{Map, Value};
use crate::layout::CardFrame;
use crate::renderer::{CustomDraw, Item, Material, MeshId, Renderer, TextureId, MSAA};

const PRELUDE: &str = wgsl!("face/prelude.wgsl");
const PRELUDE_END: &str = wgsl!("face/prelude-end.wgsl");

/// Overlay plane offset above the body cap and its base render order (between artwork 8 and holo 9).
const OVERLAY_Z: f64 = 0.002;
const OVERLAY_ORDER: f32 = 8.5;
const OVERLAY_STEP: f32 = 0.001;
/// Parameter slots in the layer uniform (`Face.params`).
pub const MAX_PARAMS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Skin,
    Overlay,
}

/// `BlendMode` (`BLEND_MODE_DEFINE`: 0 replace, 1 normal, 2 add, 3 multiply, 4 screen).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Blend {
    Replace,
    Normal,
    Add,
    Multiply,
    Screen,
}

impl Blend {
    fn parse(s: &str) -> Option<Blend> {
        match s {
            "normal" => Some(Blend::Normal),
            "add" => Some(Blend::Add),
            "multiply" => Some(Blend::Multiply),
            "screen" => Some(Blend::Screen),
            _ => None,
        }
    }
    fn define(self) -> u32 {
        match self {
            Blend::Replace => 0,
            Blend::Normal => 1,
            Blend::Add => 2,
            Blend::Multiply => 3,
            Blend::Screen => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamType {
    Float,
    Int,
    Bool,
    Color,
    Vec2,
    Vec3,
}

/// A parameter's default, as the TypeScript spec writes it.
#[derive(Clone, Copy, Debug)]
pub enum ParamDefault {
    Num(f64),
    Bool(bool),
    Color(&'static str),
    Vec2([f64; 2]),
    Vec3([f64; 3]),
}

/// `ShaderParamSpec` (the parts the engine uses: the studio's labels and ranges stay in TypeScript).
#[derive(Clone, Copy, Debug)]
pub struct ParamSpec {
    pub key: &'static str,
    pub ty: ParamType,
    pub default: ParamDefault,
    /// The uniform's name; default `u` + PascalCase(key).
    pub uniform: Option<&'static str>,
    /// A select's values (ints / floats), enforced by `coerce`.
    pub options: &'static [f64],
}

impl ParamSpec {
    pub const fn new(key: &'static str, ty: ParamType, default: ParamDefault) -> ParamSpec {
        ParamSpec { key, ty, default, uniform: None, options: &[] }
    }
    pub const fn with_options(self, options: &'static [f64]) -> ParamSpec {
        ParamSpec { options, ..self }
    }
}

/// A parameter as a layer uses it (from a built-in's spec or a custom shader's annotations).
#[derive(Clone, Debug, PartialEq)]
pub struct Param {
    pub key: String,
    pub uniform: String,
    pub ty: ParamType,
    pub default: ParamValue,
    pub options: Vec<f64>,
}

impl From<&ParamSpec> for Param {
    fn from(spec: &ParamSpec) -> Param {
        let mut p = Param { key: spec.key.into(), uniform: uniform_name(spec), ty: spec.ty, default: ParamValue::Num(0.0), options: spec.options.to_vec() };
        p.default = match spec.default {
            ParamDefault::Num(n) => ParamValue::Num(n),
            ParamDefault::Bool(b) => ParamValue::Bool(b),
            ParamDefault::Color(c) => coerce(&p, &Value::String(c.into())).unwrap_or(ParamValue::Vec(vec![0.0; 3])),
            ParamDefault::Vec2(v) => ParamValue::Vec(v.to_vec()),
            ParamDefault::Vec3(v) => ParamValue::Vec(v.to_vec()),
        };
        p
    }
}

/// A resolved parameter value (`ShaderParamValue`): numbers, a bool, or components (colours as 0..1 sRGB).
#[derive(Clone, Debug, PartialEq)]
pub enum ParamValue {
    Num(f64),
    Bool(bool),
    Vec(Vec<f64>),
}

impl ParamValue {
    /// The value's uniform slot.
    #[inline(always)]
    fn slot(&self) -> [f32; 4] {
        match self {
            ParamValue::Num(n) => [*n as f32, 0.0, 0.0, 0.0],
            ParamValue::Bool(b) => [if *b { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0],
            ParamValue::Vec(v) => std::array::from_fn(|i| v.get(i).copied().unwrap_or(0.0) as f32),
        }
    }
    pub fn num(&self) -> f64 {
        match self {
            ParamValue::Num(n) => *n,
            ParamValue::Bool(b) => *b as i32 as f64,
            ParamValue::Vec(v) => v.first().copied().unwrap_or(0.0),
        }
    }
}

/// A built-in face shader (`ShaderDefinition`, the engine's half).
pub struct ShaderDef {
    pub id: &'static str,
    pub targets: &'static [Target],
    pub default_target: Target,
    pub default_blend: Blend,
    /// Uses the clock or the tilt spring, so it needs live frames.
    pub animated: bool,
    /// `mainImage` returns scene-linear colour (tone-mapped on overlays).
    pub linear_output: bool,
    pub params: &'static [ParamSpec],
    /// WGSL defining `fn mainImage(uv: vec2f) -> vec4f` (and helpers).
    pub wgsl: &'static str,
    /// The layer draws the face's artwork itself, so the card hides its artwork layer.
    pub replaces_artwork: Option<fn(&[ParamValue]) -> bool>,
}

/// `BASE_SHADER`: the card's base colour under a face's skin layers.
const BASE: ShaderDef = ShaderDef {
    id: "base",
    targets: &[Target::Skin],
    default_target: Target::Skin,
    default_blend: Blend::Replace,
    animated: false,
    linear_output: false,
    params: &[],
    wgsl: "fn mainImage(uv: vec2f) -> vec4f { return vec4f(uBaseColor, 1.0); }",
    replaces_artwork: None,
};

/// The built-in library the engine draws (`BUILTIN_SHADERS`, as it is ported).
pub fn library() -> &'static [ShaderDef] {
    crate::face_library::LIBRARY
}

pub fn definition(id: &str) -> Option<&'static ShaderDef> {
    library().iter().find(|d| d.id == id)
}

/// Whether the engine draws a `FaceShader` layer (an enabled layer must be a built-in it has).
pub fn supported(layer: &Value) -> bool {
    if layer.get("enabled").and_then(Value::as_bool) == Some(false) || custom_wgsl(layer).is_some() {
        return true;
    }
    layer.get("id").and_then(Value::as_str).is_some_and(|id| definition(id).is_some())
}

/// `parseShaderColor`: "#rgb" / "#rrggbb" (or an [r, g, b] 0..1 triple) → 0..1, no conversion.
pub fn parse_color(v: &Value) -> Option<[f64; 3]> {
    if let Some(a) = v.as_array() {
        let n: Vec<f64> = a.iter().filter_map(|x| x.as_f64()).collect();
        return (a.len() == 3 && n.len() == 3).then(|| [n[0], n[1], n[2]]);
    }
    let s = v.as_str()?.trim();
    let hex = s.strip_prefix('#').unwrap_or(s);
    let ok = |h: &str| h.bytes().all(|b| b.is_ascii_hexdigit());
    if hex.len() == 6 && ok(hex) {
        let n = u32::from_str_radix(hex, 16).ok()?;
        return Some([((n >> 16) & 255) as f64 / 255.0, ((n >> 8) & 255) as f64 / 255.0, (n & 255) as f64 / 255.0]);
    }
    if hex.len() == 3 && ok(hex) {
        let c = |i: usize| u32::from_str_radix(&hex[i..i + 1].repeat(2), 16).unwrap_or(0) as f64 / 255.0;
        return Some([c(0), c(1), c(2)]);
    }
    None
}

/// `coerceParam`: a value of the spec's type, or `None` (the default applies).
pub fn coerce(spec: &Param, v: &Value) -> Option<ParamValue> {
    match spec.ty {
        ParamType::Float | ParamType::Int => {
            let n = v.as_bool().map(|b| b as i32 as f64).or_else(|| v.as_f64())?;
            // JS Math.round: halves toward +∞.
            let n = if spec.ty == ParamType::Int { (n + 0.5).floor() } else { n };
            if !spec.options.is_empty() && !spec.options.contains(&n) {
                return None;
            }
            Some(ParamValue::Num(n))
        }
        ParamType::Bool => v.as_bool().or_else(|| v.as_f64().map(|n| n != 0.0)).map(ParamValue::Bool),
        ParamType::Color => {
            // A hex string round-trips through toHexColor (8 bits); a triple keeps its values.
            let c = parse_color(v)?;
            if v.as_array().is_some() {
                return Some(ParamValue::Vec(c.to_vec()));
            }
            Some(ParamValue::Vec(c.iter().map(|x| (x.clamp(0.0, 1.0) * 255.0 + 0.5).floor() / 255.0).collect()))
        }
        ParamType::Vec2 | ParamType::Vec3 => {
            let n = if spec.ty == ParamType::Vec2 { 2 } else { 3 };
            let a = v.as_array()?;
            let xs: Vec<f64> = a.iter().filter_map(|x| x.as_f64()).collect();
            (a.len() == n && xs.len() == n).then_some(ParamValue::Vec(xs))
        }
    }
}

/// `resolveShaderParams`: every declared param, the given value when it fits, else the default.
pub fn resolve_params(params: &[Param], given: Option<&Map>) -> Vec<ParamValue> {
    params.iter().map(|p| given.and_then(|m| m.get(&p.key)).and_then(|v| coerce(p, v)).unwrap_or_else(|| p.default.clone())).collect()
}

/// `uniformName`: `spec.uniform`, else `u` + PascalCase(key).
pub fn uniform_name(spec: &ParamSpec) -> String {
    if let Some(u) = spec.uniform {
        return u.to_string();
    }
    let k: String = spec.key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
    let mut cs = k.chars();
    match cs.next() {
        Some(f) => format!("u{}{}", f.to_ascii_uppercase(), cs.as_str()),
        None => "u".into(),
    }
}

/// The WGSL module of a shader: prelude, param declarations (`declare`: built-ins; custom code
/// declares its own), the loader that fills them, its code, entry points.
pub fn module_source(params: &[Param], code: &str, declare: bool) -> String {
    let mut decl = String::new();
    let mut load = String::from("fn card3d_params() {\n");
    for (i, p) in params.iter().enumerate().take(MAX_PARAMS) {
        let name = &p.uniform;
        let (ty, read) = match p.ty {
            ParamType::Float => ("f32", format!("face.params[{i}].x")),
            ParamType::Int => ("i32", format!("i32(round(face.params[{i}].x))")),
            ParamType::Bool => ("bool", format!("face.params[{i}].x > 0.5")),
            ParamType::Color | ParamType::Vec3 => ("vec3f", format!("face.params[{i}].xyz")),
            ParamType::Vec2 => ("vec2f", format!("face.params[{i}].xy")),
        };
        if declare {
            decl.push_str(&format!("var<private> {name}: {ty};\n"));
        }
        load.push_str(&format!("    {name} = {read};\n"));
    }
    load.push_str("}\n");
    format!("{PRELUDE}\n{decl}{load}\n{code}\n{PRELUDE_END}")
}

/// The line of a module (`module_source`) on which the shader's own code starts (1-based), for mapping
/// compile errors: after the prelude's lines, the declarations, `card3d_params` (its two lines and one
/// per parameter) and an empty line.
pub fn code_start_line(params: &[Param], declare: bool) -> u32 {
    let n = params.len().min(MAX_PARAMS) as u32;
    PRELUDE.split('\n').count() as u32 + if declare { n } else { 0 } + n + 4
}

/// One design layer (`FaceShader`), on one side.
struct LayerSpec {
    /// Index in `CardDesign.shaders`.
    index: usize,
    /// The module's WGSL, and the line its user code starts on.
    source: Rc<String>,
    code_line: u32,
    custom: bool,
    linear: bool,
    hides_artwork: bool,
    side: usize, // 0 front, 1 back
    target: Target,
    blend: Blend,
    opacity: f64,
    params: Vec<ParamValue>,
    live: bool,
    time: f64,
    /// A liquid-metal layer's look (its runtime draws the surface it samples as `uSource`).
    liquid: Option<crate::liquid_metal::LayerLook>,
}

/// A layer that couldn't be built (`FaceShaderLayerError`): `index` in `CardDesign.shaders`.
#[derive(Clone, Debug, PartialEq)]
pub struct LayerError {
    pub index: usize,
    pub side: usize,
    pub errors: Vec<crate::face_custom::ShaderError>,
}

/// What a layer's shader is: a built-in's definition or a custom shader's parse.
struct LayerSource {
    targets: &'static [Target],
    default_target: Target,
    default_blend: Blend,
    animated: bool,
    linear: bool,
    params: Vec<Param>,
    source: String,
    code_line: u32,
    custom: bool,
    replaces: Option<fn(&[ParamValue]) -> bool>,
}

/// Whether a layer is custom WGSL (`id: "custom"`, `language: "wgsl"`).
fn custom_wgsl(s: &Value) -> Option<&str> {
    (s.get("id").and_then(Value::as_str) == Some("custom") && s.get("language").and_then(Value::as_str) == Some("wgsl"))
        .then(|| s.get("code").and_then(Value::as_str).unwrap_or(""))
}

/// The layers of a design the engine draws, in order (`sidesOf` expands "both"), and the errors of
/// those it can't build (custom code with annotation errors).
fn layer_specs(shaders: &[Value], reduced_motion: bool) -> (Vec<LayerSpec>, Vec<LayerError>) {
    let (mut out, mut errors) = (Vec::new(), Vec::new());
    for (index, s) in shaders.iter().enumerate() {
        if s.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let sides: &[usize] = match s.get("side").and_then(Value::as_str) {
            Some("both") => &[0, 1],
            Some("back") => &[1],
            _ => &[0],
        };
        let liquid_metal = !custom_wgsl(s).is_some() && s.get("id").and_then(Value::as_str) == Some("liquid-metal");
        let LayerSource { targets, default_target, default_blend, animated, linear, params, source, code_line, custom, replaces } =
            if let Some(code) = custom_wgsl(s) {
                let parse = crate::face_custom::parse(code);
                if !parse.errors.is_empty() {
                    for &side in sides {
                        errors.push(LayerError { index, side, errors: parse.errors.clone() });
                    }
                    continue;
                }
                let params: Vec<Param> = parse.params.iter().map(crate::face_custom::to_param).collect();
                let source = module_source(&params, &crate::face_custom::guard_loops(code), false);
                let line = code_start_line(&params, false);
                let replaces = crate::face_custom::replaces_artwork(code);
                fn yes(_: &[ParamValue]) -> bool {
                    true
                }
                LayerSource {
                    targets: &[Target::Skin, Target::Overlay],
                    default_target: Target::Skin,
                    default_blend: Blend::Normal,
                    animated: crate::face_custom::animated(code),
                    linear: false,
                    params,
                    source,
                    code_line: line,
                    custom: true,
                    replaces: replaces.then_some(yes as fn(&[ParamValue]) -> bool),
                }
            } else {
                let Some(def) = s.get("id").and_then(Value::as_str).and_then(definition) else { continue };
                let params: Vec<Param> = def.params.iter().map(Param::from).collect();
                let source = module_source(&params, def.wgsl, true);
                let line = code_start_line(&params, true);
                LayerSource {
                    targets: def.targets,
                    default_target: def.default_target,
                    default_blend: def.default_blend,
                    animated: def.animated,
                    linear: def.linear_output,
                    params,
                    source,
                    code_line: line,
                    custom: false,
                    replaces: def.replaces_artwork,
                }
            };
        let target = match s.get("target").and_then(Value::as_str) {
            Some("skin") if targets.contains(&Target::Skin) => Target::Skin,
            Some("overlay") if targets.contains(&Target::Overlay) => Target::Overlay,
            _ => default_target,
        };
        let blend = s.get("blend").and_then(Value::as_str).and_then(Blend::parse).unwrap_or(default_blend);
        let opacity = s.get("opacity").and_then(Value::as_f64).filter(|o| o.is_finite()).unwrap_or(1.0).clamp(0.0, 1.0);
        let values = resolve_params(&params, s.get("params").and_then(Value::as_object));
        let frozen = s.get("time").and_then(Value::as_f64).filter(|t| t.is_finite());
        let live = animated && s.get("animated").and_then(Value::as_bool) != Some(false) && frozen.is_none() && !reduced_motion;
        let hides_artwork = replaces.is_some_and(|f| f(&values));
        let liquid = liquid_metal.then(|| {
            let keys: Vec<&str> = params.iter().map(|p| p.key.as_str()).collect();
            crate::liquid_metal::layer_look(&keys, &values, s.get("params").and_then(Value::as_object))
        });
        let source = Rc::new(source);
        for &side in sides {
            out.push(LayerSpec {
                index,
                source: source.clone(),
                code_line,
                custom,
                linear,
                hides_artwork,
                side,
                target,
                blend,
                opacity,
                params: values.clone(),
                live,
                time: frozen.unwrap_or(0.0),
                liquid,
            });
        }
    }
    (out, errors)
}

/// Which sides get a skin target, and which hide their artwork (`hidesArtwork`), before the card is
/// built.
#[derive(Clone, Copy, Default)]
pub struct FacePlan {
    pub skins: [bool; 2],
    pub hides_artwork: [bool; 2],
}

/// A design's face shader layers, parsed and assembled, and the plan they make.
pub struct FaceSpecs {
    specs: Vec<LayerSpec>,
    errors: Vec<LayerError>,
    pub plan: FacePlan,
    /// Builds the layers once the card has its skin targets and artwork ([`FaceLayers::build`]): set
    /// by the `faces` chunk, so the build and the layers' per-frame code stay in it.
    pub build: Build,
    /// Compiles the custom layers' modules and returns every layer error as JSON (`check_custom`).
    pub check: Check,
}

/// Checks custom layers without building a card (`FaceSpecs::check`).
pub type Check = for<'a> fn(&'a wgpu::Device, FaceSpecs) -> LocalFuture<'a, String>;

/// Checks custom WGSL face shader code on `device` without building a card (Card Studio's editor
/// checks each edit before the card takes it): the annotation errors, then the compiler's, as
/// `errors_json` gives them (lines of `code`, 0 for the whole shader). The `faces` chunk does the work.
pub async fn check_custom(device: &wgpu::Device, code: String) -> Result<String, crate::LoadError> {
    use crate::json::Map;
    let s = |v: &str| Value::String(v.into());
    let layer = Value::Object(Map(vec![("id".into(), s("custom")), ("language".into(), s("wgsl")), ("code".into(), Value::String(code))]));
    let specs = specs(&[layer], false).await.map_err(crate::chunk("faces"))?;
    let check = specs.check;
    Ok(check(device, specs).await)
}

/// `FaceSpecs::check`: each custom layer's module compiled inside a validation scope.
async fn check(device: &wgpu::Device, specs: FaceSpecs) -> String {
    let FaceSpecs { specs, mut errors, .. } = specs;
    for l in specs.iter().filter(|l| l.custom) {
        // Pop before awaiting anything: other work on the device (a card being built) pushes scopes of its
        // own meanwhile, and scopes must be popped in reverse order.
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let m = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("face shader check"),
            source: wgpu::ShaderSource::Wgsl(l.source.as_str().into()),
        });
        let popped = scope.pop();
        let info = m.get_compilation_info().await;
        let failed = popped.await.is_some();
        let mut messages: Vec<crate::face_custom::ShaderError> = info
            .messages
            .iter()
            .filter(|m| m.message_type == wgpu::CompilationMessageType::Error)
            .map(|m| crate::face_custom::ShaderError {
                line: m.location.map_or(0, |p| p.line_number.saturating_sub(l.code_line - 1)),
                message: m.message.clone(),
            })
            .collect();
        if failed && messages.is_empty() {
            messages.push(crate::face_custom::ShaderError { line: 0, message: "the shader didn't compile".into() });
        }
        if !messages.is_empty() {
            errors.push(LayerError { index: l.index, side: l.side, errors: messages });
        }
    }
    errors_json(&errors)
}

/// Builds a card's face shader layers (`FaceSpecs::build`).
pub type Build =
    for<'a> fn(&'a mut Renderer, &'a wgpu::Device, &'a wgpu::Queue, FaceSpecs, &'a FaceInputs<'a>) -> LocalFuture<'a, Result<FaceLayers, crate::LoadError>>;

/// A boxed future (not `Send`: the web is single-threaded).
pub type LocalFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + 'a>>;

/// The layers of `shaders` (`layer_specs`) and their plan. On the web this is the `faces` chunk (the
/// custom shader parser, parameter resolution, module assembly), downloaded only by cards with face
/// shaders.
#[wasm_split_helpers::wasm_split(faces, fallible)]
pub fn specs(shaders: &[Value], reduced_motion: bool) -> Result<FaceSpecs, crate::ChunkUnavailable> {
    let (specs, errors) = layer_specs(shaders, reduced_motion);
    let mut plan = FacePlan::default();
    for l in &specs {
        plan.skins[l.side] |= l.target == Target::Skin;
        plan.hides_artwork[l.side] |= l.hides_artwork;
    }
    Ok(FaceSpecs {
        specs,
        errors,
        plan,
        build: |r, device, queue, specs, o| Box::pin(FaceLayers::build(r, device, queue, specs, o)),
        check: |device, specs| Box::pin(check(device, specs)),
    })
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct FaceUniform {
    model_view: [[f32; 4]; 4],
    time: [f32; 4],
    pub(crate) tilt: [f32; 4],
    pointer: [f32; 4],
    base: [f32; 4],
    chip: [f32; 4],
    misc: [f32; 4],
    eye: [f32; 4],
    pub(crate) params: [[f32; 4]; MAX_PARAMS],
}

/// A layer's uniform (`createCommonUniforms` with the frame's aspect and chip, then the layer's own
/// values): `base` is the base colour and whether the face has artwork.
#[inline(always)]
pub(crate) fn face_uniform(
    frame: &CardFrame,
    face_width: u32,
    base: [f32; 4],
    side: usize,
    target: Target,
    opacity: f64,
    time: f64,
    params: &[ParamValue],
) -> FaceUniform {
    let aspect = frame.width / frame.height;
    let chip = crate::layout::chip_rect(Some(frame));
    let chip_uv = [chip.x / frame.width + 0.5, 0.5 - chip.y / frame.height, chip.w / frame.width / 2.0, chip.h / frame.height / 2.0].map(|v| v as f32);
    FaceUniform {
        model_view: Mat4::IDENTITY.to_cols_array_2d(),
        time: [time as f32, face_width as f32, (face_width as f64 / aspect).round() as f32, opacity as f32],
        tilt: [0.0; 4],
        pointer: [0.5, 0.5, 0.0, 0.0],
        base,
        chip: chip_uv,
        misc: [aspect as f32, side as f32, (target == Target::Overlay) as i32 as f32, 0.0],
        eye: [0.0, 0.0, 5.0, 0.0],
        params: std::array::from_fn(|i| params.get(i).map_or([0.0; 4], ParamValue::slot)),
    }
}

struct Layer {
    side: usize,
    target: Target,
    live: bool,
    time: f64,
    uniform: Rc<wgpu::Buffer>,
    data: FaceUniform,
    pipeline: Rc<wgpu::RenderPipeline>,
    /// The overlay into half-float views (`Renderer::offscreen`).
    buffer_pipeline: Option<Rc<wgpu::RenderPipeline>>,
    bind_group: Rc<wgpu::BindGroup>,
    /// The overlay's item and its transform within the card.
    overlay: Option<(usize, Mat4)>,
    /// What draws its `uSource` (liquid metal).
    runtime: Option<Box<dyn crate::liquid_metal::Runtime>>,
}

struct Skin {
    texture: TextureId,
    base: Layer,
    dirty: bool,
    live: bool,
}

/// The tilt spring shared by the animated shaders (`TiltSpring`).
#[derive(Default)]
struct TiltSpring {
    position: [f64; 2],
    velocity: [f64; 2],
    initialised: bool,
}

impl TiltSpring {
    fn step(&mut self, target: [f64; 2], h: f64) {
        if !self.initialised {
            self.position = target; // snapOnFirst
        }
        self.initialised = true;
        for k in 0..2 {
            let a = (target[k] - self.position[k]) * 32.0 - 5.8 * self.velocity[k];
            self.velocity[k] += a * h;
            self.position[k] += self.velocity[k] * h;
        }
    }
}

/// What the layers need from the card: the face meshes, artwork and geometry.
pub struct FaceInputs<'a> {
    pub faces: [MeshId; 2],
    pub artwork: [Option<TextureId>; 2],
    /// Body depth / 2.
    pub j: f64,
    pub frame: &'a CardFrame,
    /// The card's base colour (display sRGB 0..1).
    pub base_color: [f64; 3],
    /// The skin textures (`skin_texture`), per side.
    pub skins: [Option<TextureId>; 2],
    pub face_width: u32,
    pub host: &'a dyn crate::canvas::Host,
    /// Each side's artwork `src` (liquid metal's artwork mask), unless a one-off replaced it.
    pub artwork_src: [Option<&'a str>; 2],
}

/// The face shader layers of one card. Their state lives behind a trait object made in the `faces`
/// chunk, so that the per-frame code stays there (main only calls through the vtable).
pub struct FaceLayers {
    /// Layers that couldn't be built (custom code that doesn't parse or compile).
    pub errors: Vec<LayerError>,
    /// `errors` as the page reads them (`errors_json`), written here (the `faces` chunk).
    pub errors_json: String,
    /// Some layer is live (animated, not frozen, no reduced motion).
    pub animated: bool,
    state: Box<dyn Frame>,
}

/// Layer errors as JSON: `[{ index, side: "front" | "back", errors: [{ line, message }] }]`
/// (`FaceShaderLayerError`; lines of the layer's own code, 0 for the whole shader).
pub fn errors_json(errors: &[LayerError]) -> String {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    let items: Vec<String> = errors
        .iter()
        .map(|e| {
            let errs: Vec<String> = e.errors.iter().map(|x| format!("{{\"line\":{},\"message\":\"{}\"}}", x.line, esc(&x.message))).collect();
            format!("{{\"index\":{},\"side\":\"{}\",\"errors\":[{}]}}", e.index, if e.side == 0 { "front" } else { "back" }, errs.join(","))
        })
        .collect();
    format!("[{}]", items.join(","))
}

/// What main calls each frame.
trait Frame {
    fn update(&mut self, dt: f64, model: Mat4);
    fn prepare(&mut self, r: &Renderer, device: &wgpu::Device, queue: &wgpu::Queue, model: Mat4, cam: &crate::renderer::Camera);
    fn set_pointer(&mut self, ndc: [f64; 2]);
    fn wheel(&mut self, delta: f64);
}

/// The layers' state.
struct State {
    layers: Vec<Layer>,
    skins: [Option<Skin>; 2],
    clock: f64,
    elapsed: f64,
    spring: TiltSpring,
}

/// The skin size for a face (`SkinTarget`): `face_width` × width / aspect, at least 16 each.
pub fn skin_size(face_width: u32, frame: &CardFrame) -> (u32, u32) {
    let w = face_width.max(16);
    (w, ((w as f64 / (frame.width / frame.height)).round() as u32).max(16))
}

/// GPU objects shared by every layer of a card.
pub(crate) struct Gpu<'a> {
    device: &'a wgpu::Device,
    layout: wgpu::PipelineLayout,
    bind_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    pub(crate) blank: wgpu::TextureView,
    format: wgpu::TextureFormat,
}

impl Gpu<'_> {
    /// The layers' bind group layout, pipeline layout, sampler and blank texture.
    #[inline(always)]
    pub(crate) fn new<'d>(r: &mut Renderer, device: &'d wgpu::Device, queue: &wgpu::Queue) -> Gpu<'d> {
        let entry = |binding, ty| wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty, count: None };
        let tex = wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        };
        let smp = wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering);
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("face shader"),
            entries: &[
                entry(0, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }),
                entry(1, tex),
                entry(2, smp),
                entry(3, tex),
                entry(4, smp),
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("face shader"),
            bind_group_layouts: &[Some(r.frame_layout()), Some(&bind_layout)],
            immediate_size: 0,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("face shader"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let blank_tex = r.texture(device, queue, &[(1, 1, vec![0; 4])], true, crate::renderer::Wrap::Clamp);
        Gpu { device, layout, bind_layout, sampler, blank: r.texture_view(blank_tex).clone(), format: r.format() }
    }

    pub(crate) fn pipeline(&self, module: &wgpu::ShaderModule, target: Target, blend: Blend, linear: bool) -> wgpu::RenderPipeline {
        self.pipeline_into(module, target, blend, linear, false)
    }

    /// `pipeline`; `buffer`: an overlay drawn into the half-float views (a scene floor's reflection).
    pub(crate) fn pipeline_into(&self, module: &wgpu::ShaderModule, target: Target, blend: Blend, linear: bool, buffer: bool) -> wgpu::RenderPipeline {
        let comp = |s, d| wgpu::BlendComponent { src_factor: s, dst_factor: d, operation: wgpu::BlendOperation::Add };
        use wgpu::BlendFactor as F;
        let keep = target == Target::Skin;
        let blend_state = match blend {
            Blend::Replace => None,
            Blend::Normal => Some(wgpu::BlendState {
                color: comp(F::SrcAlpha, F::OneMinusSrcAlpha),
                alpha: if keep { comp(F::Zero, F::One) } else { comp(F::One, F::OneMinusSrcAlpha) },
            }),
            Blend::Add => Some(wgpu::BlendState { color: comp(F::One, F::One), alpha: comp(F::Zero, F::One) }),
            Blend::Multiply => Some(wgpu::BlendState { color: comp(F::Dst, F::Zero), alpha: comp(F::Zero, F::One) }),
            Blend::Screen => Some(wgpu::BlendState { color: comp(F::OneMinusDst, F::One), alpha: comp(F::Zero, F::One) }),
        };
        let overlay = target == Target::Overlay;
        let constants = [("BLEND_MODE", blend.define() as f64), ("FACE_OVERLAY", overlay as i32 as f64), ("LINEAR_OUTPUT", linear as i32 as f64)];
        let options = wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() };
        let format = if buffer {
            crate::renderer::GLASS_BUFFER_FORMAT
        } else if overlay {
            self.format
        } else {
            wgpu::TextureFormat::Rgba8UnormSrgb
        };
        self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("face shader"),
            layout: Some(&self.layout),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some(if overlay { "vs_overlay" } else { "vs_skin" }),
                buffers: if overlay { crate::renderer::VERTEX_LAYOUT } else { &[] },
                compilation_options: options.clone(),
            },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some("fs_face"),
                targets: &[Some(wgpu::ColorTargetState { format, blend: blend_state, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: options,
            }),
            primitive: wgpu::PrimitiveState { cull_mode: overlay.then_some(wgpu::Face::Back), ..Default::default() },
            depth_stencil: overlay.then(|| wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: Some(false),
                depth_compare: Some(wgpu::CompareFunction::LessEqual),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState { count: if overlay && !buffer { MSAA } else { 1 }, ..Default::default() },
            multiview_mask: None,
            cache: None,
        })
    }

    pub(crate) fn bind_group(&self, uniform: &wgpu::Buffer, artwork: &wgpu::TextureView) -> wgpu::BindGroup {
        self.bind_group_with(uniform, artwork, &self.blank)
    }

    /// With `source` as `uSource`.
    fn bind_group_with(&self, uniform: &wgpu::Buffer, artwork: &wgpu::TextureView, source: &wgpu::TextureView) -> wgpu::BindGroup {
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("face shader"),
            layout: &self.bind_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(artwork) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(source) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        })
    }
}

impl FaceLayers {
    /// Builds the layers: pipelines, uniforms, overlay items. Skin textures were made beforehand
    /// (`Renderer::render_texture` at `skin_size`) so the face skins could sample them.
    /// Custom WGSL is compiled inside a validation error scope: a broken shader drops its layer (and
    /// reports it in `errors`) instead of failing the device. Reached through `FaceSpecs::build`.
    async fn build(r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, specs: FaceSpecs, o: &FaceInputs<'_>) -> Result<FaceLayers, crate::LoadError> {
        let FaceSpecs { specs, mut errors, .. } = specs;
        let gpu = Gpu::new(r, device, queue);

        // Side-level uniforms (`createCommonUniforms`, the shaped frame's aspect and chip).
        let common = |side: usize, target: Target, opacity: f64, time: f64, params: &[ParamValue]| {
            let base = [o.base_color[0] as f32, o.base_color[1] as f32, o.base_color[2] as f32, o.artwork[side].is_some() as i32 as f32];
            face_uniform(o.frame, o.face_width, base, side, target, opacity, time, params)
        };

        // One module per distinct source (a shader on both faces, or twice, compiles once); custom ones
        // checked first.
        let mut modules: Vec<(Rc<String>, Rc<wgpu::ShaderModule>)> = Vec::new();
        let base_source = Rc::new(module_source(&[], BASE.wgsl, true));
        let new_buffer = |data: &FaceUniform| {
            let uniform = Rc::new(device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("face shader"),
                size: size_of::<FaceUniform>() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
            queue.write_buffer(&uniform, 0, bytemuck::bytes_of(data));
            uniform
        };

        let mut skins: [Option<Skin>; 2] = [None, None];
        for side in 0..2 {
            if let Some(texture) = o.skins[side] {
                let module = Rc::new(device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("face base"),
                    source: wgpu::ShaderSource::Wgsl(base_source.as_str().into()),
                }));
                let data = common(side, Target::Skin, 1.0, 0.0, &[]);
                let uniform = new_buffer(&data);
                let artwork = o.artwork[side].map_or_else(|| gpu.blank.clone(), |t| r.texture_view(t).clone());
                let bind_group = Rc::new(gpu.bind_group(&uniform, &artwork));
                let pipeline = Rc::new(gpu.pipeline(&module, Target::Skin, Blend::Replace, false));
                let base = Layer {
                    side,
                    target: Target::Skin,
                    live: false,
                    time: 0.0,
                    uniform,
                    data,
                    pipeline,
                    buffer_pipeline: None,
                    bind_group,
                    overlay: None,
                    runtime: None,
                };
                skins[side] = Some(Skin { texture, base, dirty: true, live: false });
            }
        }
        let mut layers = Vec::new();
        let mut overlays = 0;
        // Liquid metal's code (the `liquid_metal` chunk), once a layer needs it.
        let mut kit = None;
        for l in specs {
            if l.target == Target::Skin && skins[l.side].is_none() {
                continue;
            }
            let module = match modules.iter().find(|(src, _)| Rc::ptr_eq(src, &l.source) || **src == *l.source) {
                Some((_, m)) => m.clone(),
                None => {
                    let scope = l.custom.then(|| device.push_error_scope(wgpu::ErrorFilter::Validation));
                    let m = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                        label: Some("face shader"),
                        source: wgpu::ShaderSource::Wgsl(l.source.as_str().into()),
                    });
                    // Popped before any await (scopes must be popped in reverse order, and other work on
                    // the device, such as a shader check, may push its own meanwhile).
                    if let Some(popped) = scope.map(|s| s.pop()) {
                        let info = m.get_compilation_info().await;
                        let failed = popped.await.is_some();
                        let messages: Vec<crate::face_custom::ShaderError> = info
                            .messages
                            .iter()
                            .filter(|m| m.message_type == wgpu::CompilationMessageType::Error)
                            .map(|m| crate::face_custom::ShaderError {
                                line: m.location.map_or(0, |p| p.line_number.saturating_sub(l.code_line - 1)),
                                message: m.message.clone(),
                            })
                            .collect();
                        if failed || !messages.is_empty() {
                            let messages = if messages.is_empty() {
                                vec![crate::face_custom::ShaderError { line: 0, message: "the shader didn't compile".into() }]
                            } else {
                                messages
                            };
                            errors.push(LayerError { index: l.index, side: l.side, errors: messages });
                            continue;
                        }
                    }
                    let m = Rc::new(m);
                    modules.push((l.source.clone(), m.clone()));
                    m
                }
            };
            let data = common(l.side, l.target, l.opacity, l.time, &l.params);
            let uniform = new_buffer(&data);
            let artwork = o.artwork[l.side].map_or_else(|| gpu.blank.clone(), |t| r.texture_view(t).clone());
            let runtime = match l.liquid {
                Some(look) => {
                    let kit = match kit {
                        Some(k) => k,
                        None => *kit.insert(crate::liquid_metal::kit().await.map_err(crate::chunk("liquid metal"))?),
                    };
                    let face = crate::liquid_metal::FaceLayer {
                        device,
                        queue,
                        host: o.host,
                        look,
                        artwork: o.artwork_src[l.side],
                        face_width: o.face_width,
                        frame: o.frame,
                        live: l.live,
                        time: l.time,
                    };
                    Some(kit(r, &face))
                }
                None => None,
            };
            let source = runtime.as_ref().and_then(|rt| rt.source()).unwrap_or(&gpu.blank);
            let bind_group = Rc::new(gpu.bind_group_with(&uniform, &artwork, source));
            let scope = l.custom.then(|| device.push_error_scope(wgpu::ErrorFilter::Validation));
            let pipeline = gpu.pipeline(&module, l.target, l.blend, l.linear);
            let buffer_pipeline = (r.offscreen && l.target == Target::Overlay).then(|| Rc::new(gpu.pipeline_into(&module, l.target, l.blend, l.linear, true)));
            let failed = match scope {
                Some(scope) => scope.pop().await.is_some(),
                None => false,
            };
            if failed {
                errors.push(LayerError {
                    index: l.index,
                    side: l.side,
                    errors: vec![crate::face_custom::ShaderError { line: 0, message: "the shader didn't link".into() }],
                });
                continue;
            }
            let mut layer = Layer {
                side: l.side,
                target: l.target,
                live: l.live,
                time: l.time,
                uniform,
                data,
                pipeline: Rc::new(pipeline),
                buffer_pipeline,
                bind_group,
                overlay: None,
                runtime,
            };
            match l.target {
                Target::Skin => {
                    if let Some(s) = skins[l.side].as_mut() {
                        s.live |= l.live;
                    }
                }
                Target::Overlay => {
                    let k = overlays;
                    overlays += 1;
                    let z = (o.j + OVERLAY_Z + 0.00002 * k as f64) as f32;
                    let transform = if l.side == 0 {
                        Mat4::from_translation(Vec3::new(0.0, 0.0, z))
                    } else {
                        Mat4::from_translation(Vec3::new(0.0, 0.0, -z)) * Mat4::from_rotation_y(std::f32::consts::PI)
                    };
                    let draw = CustomDraw {
                        buffer_pipeline: layer.buffer_pipeline.clone(),
                        ..CustomDraw::new(layer.pipeline.clone(), layer.bind_group.clone(), layer.uniform.clone())
                    };
                    let item = Item {
                        mesh: o.faces[l.side],
                        material: Material { transparent: true, ..Default::default() },
                        transform,
                        render_order: OVERLAY_ORDER + OVERLAY_STEP * k as f32,
                        visible: true,
                    };
                    layer.overlay = Some((r.add_custom(item, draw), transform));
                    // uEye, every draw (the overlay's view uniforms): the renderer writes it per view.
                    r.eyes.push(crate::effects::Eye { transform, buffer: layer.uniform.clone(), offset: std::mem::offset_of!(FaceUniform, eye) as u64 });
                }
            }
            layers.push(layer);
        }
        let animated = layers.iter().any(|l| l.live);
        let state = Box::new(State { layers, skins, clock: 0.0, elapsed: 0.0, spring: TiltSpring::default() });
        let errors_json = errors_json(&errors);
        Ok(FaceLayers { errors, errors_json, animated, state })
    }

    /// Advances live layers by `dt` seconds (`update`): the shared clock and the tilt spring (the
    /// card's world normal), and marks live skins for a redraw at ≤ 30 Hz.
    pub fn update(&mut self, dt: f64, model: Mat4) {
        if self.animated {
            self.state.update(dt, model);
        }
    }

    /// Before a frame: the overlays' eye (the camera in each face's space), every uniform, and the
    /// dirty skins re-rendered.
    pub fn prepare(&mut self, r: &Renderer, device: &wgpu::Device, queue: &wgpu::Queue, model: Mat4, cam: &crate::renderer::Camera) {
        self.state.prepare(r, device, queue, model, cam);
    }

    /// The page's pointer (normalised device coordinates), for the runtimes that follow it.
    pub fn set_pointer(&mut self, ndc: [f64; 2]) {
        self.state.set_pointer(ndc);
    }

    /// A wheel event (its larger delta).
    pub fn wheel(&mut self, delta: f64) {
        self.state.wheel(delta);
    }
}

impl Frame for State {
    fn update(&mut self, dt: f64, model: Mat4) {
        let h = dt.clamp(0.0, 1.0 / 30.0);
        let n = model.z_axis.truncate().normalize_or_zero();
        self.spring.step([n.x as f64, n.y as f64], h);
        self.clock += h;
        let (p, v) = (self.spring.position, self.spring.velocity);
        for l in self.layers.iter_mut().filter(|l| l.live) {
            l.data.time[0] = (l.time + self.clock) as f32;
            l.data.tilt = [p[0] as f32, p[1] as f32, v[0] as f32, v[1] as f32];
            if l.runtime.as_mut().is_some_and(|rt| rt.update(h, n)) && l.target == Target::Skin {
                if let Some(s) = self.skins[l.side].as_mut() {
                    s.dirty = true;
                }
            }
        }
        self.elapsed += h;
        if self.elapsed >= 1.0 / 30.0 {
            self.elapsed %= 1.0 / 30.0;
            for s in self.skins.iter_mut().flatten() {
                if s.live {
                    s.dirty = true;
                }
            }
        }
    }

    fn set_pointer(&mut self, ndc: [f64; 2]) {
        for rt in self.layers.iter_mut().filter_map(|l| l.runtime.as_mut()) {
            rt.set_pointer(ndc);
        }
    }

    fn wheel(&mut self, delta: f64) {
        for rt in self.layers.iter_mut().filter_map(|l| l.runtime.as_mut()) {
            rt.wheel(delta);
        }
    }

    fn prepare(&mut self, r: &Renderer, device: &wgpu::Device, queue: &wgpu::Queue, model: Mat4, cam: &crate::renderer::Camera) {
        // The runtimes' surfaces first: the skins and overlays sample them.
        for rt in self.layers.iter_mut().filter_map(|l| l.runtime.as_mut()) {
            rt.prepare(device, queue);
        }
        for l in &mut self.layers {
            if let Some((_, t)) = l.overlay {
                let eye = (model * t).inverse().transform_point3(cam.eye32());
                l.data.eye = [eye.x, eye.y, eye.z, 0.0];
            }
            queue.write_buffer(&l.uniform, 0, bytemuck::bytes_of(&l.data));
        }
        for side in 0..2 {
            let Some(s) = self.skins[side].as_mut() else { continue };
            if !s.dirty {
                continue;
            }
            s.dirty = false;
            let mut encoder = device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("face skin"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: r.texture_view(s.texture),
                        resolve_target: None,
                        depth_slice: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                    })],
                    ..Default::default()
                });
                pass.set_bind_group(0, r.frame_bind_group(), &[]);
                for l in std::iter::once(&s.base).chain(self.layers.iter().filter(|l| l.side == side && l.target == Target::Skin)) {
                    pass.set_pipeline(&l.pipeline);
                    pass.set_bind_group(1, &*l.bind_group, &[]);
                    pass.draw(0..3, 0..1);
                }
            }
            queue.submit([encoder.finish()]);
        }
    }
}
