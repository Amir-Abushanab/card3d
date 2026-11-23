//! The AR model's file formats (`ar.rs`): GLB (binary glTF 2.0, as three's `GLTFExporter` writes the
//! model) and USDZ (as three's `USDZExporter` writes it, with ar/index.ts's `fixUsdz` fixes: primvar
//! reader names as strings, transform inputs as float2, scale and bias on 8-bit normal maps, the
//! materials under the default prim, and an uncompressed zip with every file's data 64-byte aligned).
//! Textures arrive encoded (PNG, by the host's canvas), and numbers are written as JavaScript writes
//! them (`Host::number`: the browser's own formatting on the web, `js_number` / `js_precision`
//! natively), as three's files are. On the web this is the `ar` chunk's code.

use crate::ar::{Model, Surface};
use crate::canvas::Host;

/// `join` of this chunk's own (the standard one is shared with the web build's main module, so using
/// it here would keep it out of line there).
trait Joined {
    fn joined(&self, sep: &str) -> String;
}

impl<S: AsRef<str>> Joined for [S] {
    fn joined(&self, sep: &str) -> String {
        let mut out = String::new();
        for (i, s) in self.iter().enumerate() {
            if i > 0 {
                out.push_str(sep);
            }
            out.push_str(s.as_ref());
        }
        out
    }
}

/// The significant digits of a non-negative decimal string (`123.4500`, `0.00012`) and the power of ten
/// of the first: (`12345`, 2), (`12`, −4). Written with `Display` only (no `LowerExp`, which would
/// land in the web build's main module).
fn digits(text: &str) -> (String, i32) {
    let (int, frac) = text.split_once('.').unwrap_or((text, ""));
    let int = int.trim_start_matches('0');
    if !int.is_empty() {
        return (format!("{int}{frac}").trim_end_matches('0').to_string(), int.len() as i32 - 1);
    }
    let zeros = frac.len() - frac.trim_start_matches('0').len();
    (frac[zeros..].trim_end_matches('0').to_string(), -(zeros as i32) - 1)
}

/// `d.ddd` + `e±n`, JavaScript's exponential form.
fn exponential(sign: &str, d: &str, e: i32) -> String {
    let (head, tail) = d.split_at(1.min(d.len()));
    let dot = if tail.is_empty() { String::new() } else { format!(".{tail}") };
    format!("{sign}{head}{dot}e{}{}", if e < 0 { "-" } else { "+" }, e.abs())
}

/// A number as JavaScript's `String(x)` writes it (shortest round trip; exponents below 1e-6 and
/// from 1e21), so the files read as three's: `0.0254`, `2.220446049250313e-16`, `-1`.
pub fn js_number(x: f64) -> String {
    if !x.is_finite() {
        return if x.is_nan() {
            "NaN".into()
        } else if x > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if x == 0.0 {
        return "0".into();
    }
    if (1e-6..1e21).contains(&x.abs()) {
        return format!("{x}");
    }
    let (d, e) = digits(&format!("{}", x.abs()));
    exponential(if x < 0.0 { "-" } else { "" }, &d, e)
}

/// JavaScript's `x.toPrecision(p)` (p ≥ 1; exact decimal rounding, as `Display` with a precision).
pub fn js_precision(x: f64, p: usize) -> String {
    let (a, sign) = (x.abs(), if x < 0.0 { "-" } else { "" });
    if a == 0.0 || !a.is_finite() {
        return if a == 0.0 { format!("0{}{}", if p > 1 { "." } else { "" }, "0".repeat(p - 1)) } else { js_number(x) };
    }
    // The first digit's power of ten, then that many decimals for p digits (one fewer if rounding
    // carried into a new digit).
    let (_, e0) = digits(&format!("{a}"));
    let fixed = |e: i32| format!("{:.*}", (p as i32 - 1 - e).max(0) as usize, a);
    let (mut text, mut e) = (fixed(e0), e0);
    if digits(&text).1 > e {
        e += 1;
        text = fixed(e);
    }
    if e < -6 || e >= p as i32 {
        let (mut d, _) = digits(&text);
        d.truncate(p);
        while d.len() < p {
            d.push('0');
        }
        return exponential(sign, &d, e);
    }
    format!("{sign}{text}")
}

// ── GLB ─────────────────────────────────────────────────────────────────────────

/// The GLB of `model`; `images`: PNGs of the faces' maps, [front, back] × [colour, orm, normal].
pub fn glb(model: &Model, images: &[[Vec<u8>; 3]; 2], host: &dyn Host, generator: &str) -> Vec<u8> {
    let js_number = |x: f64| host.number(x, 0);
    let mut bin: Vec<u8> = Vec::new();
    let mut views: Vec<String> = Vec::new();
    let mut accessors: Vec<String> = Vec::new();
    let nums = |v: &[f64]| v.iter().map(|&x| host.number(x, 0)).collect::<Vec<_>>().joined(",");
    // A vertex attribute: its buffer view (ARRAY_BUFFER, with its stride) and accessor (min / max).
    let mut attribute = |data: &[f32], size: usize| -> usize {
        let count = data.len() / size;
        let (mut lo, mut hi) = (vec![f64::INFINITY; size], vec![f64::NEG_INFINITY; size]);
        for (k, &v) in data.iter().enumerate() {
            lo[k % size] = lo[k % size].min(v as f64);
            hi[k % size] = hi[k % size].max(v as f64);
        }
        let offset = bin.len();
        for v in data {
            bin.extend_from_slice(&v.to_le_bytes());
        }
        views.push(format!("{{\"buffer\":0,\"byteOffset\":{offset},\"byteLength\":{},\"target\":34962,\"byteStride\":{}}}", 4 * data.len(), 4 * size));
        let ty = ["SCALAR", "VEC2", "VEC3", "VEC4"][size - 1];
        accessors.push(format!(
            "{{\"bufferView\":{},\"componentType\":5126,\"count\":{count},\"max\":[{}],\"min\":[{}],\"type\":\"{ty}\"}}",
            views.len() - 1,
            nums(&hi),
            nums(&lo)
        ));
        accessors.len() - 1
    };
    let mut meshes = Vec::new();
    for (k, s) in [&model.edge, &model.front, &model.back].into_iter().enumerate() {
        let flat = |v: &[[f32; 3]]| v.iter().flatten().copied().collect::<Vec<f32>>();
        let position = attribute(&flat(&s.positions), 3);
        let normal = attribute(&flat(&s.normals), 3);
        let uv = s.uvs.as_ref().map(|uv| attribute(&uv.iter().flatten().copied().collect::<Vec<f32>>(), 2));
        let uv = uv.map_or(String::new(), |a| format!(",\"TEXCOORD_0\":{a}"));
        meshes.push(format!("{{\"primitives\":[{{\"mode\":4,\"attributes\":{{\"POSITION\":{position},\"NORMAL\":{normal}{uv}}},\"material\":{k}}}]}}"));
    }
    // The faces' images, in three's order: metal-roughness, base colour, normal.
    let mut image_defs = Vec::new();
    for side in images {
        for &m in &[1usize, 0, 2] {
            let offset = bin.len();
            bin.extend_from_slice(&side[m]);
            views.push(format!("{{\"buffer\":0,\"byteOffset\":{offset},\"byteLength\":{}}}", side[m].len()));
            while !bin.len().is_multiple_of(4) {
                bin.push(0);
            }
            image_defs.push(format!("{{\"mimeType\":\"image/png\",\"bufferView\":{}}}", views.len() - 1));
        }
    }
    let blend = if model.glass { ",\"alphaMode\":\"BLEND\"" } else { "" };
    let e = &model.edge_material;
    let opacity = if model.glass { crate::ar::GLASS_OPACITY } else { 1.0 };
    let mut materials = vec![format!(
        "{{\"pbrMetallicRoughness\":{{\"baseColorFactor\":[{}],\"metallicFactor\":{},\"roughnessFactor\":{}}}{blend},\"name\":\"edge\"}}",
        nums(&[e.color[0], e.color[1], e.color[2], opacity]),
        js_number(e.metalness),
        js_number(e.roughness)
    )];
    for (k, name) in ["front face", "back face"].iter().enumerate() {
        let t = 3 * k;
        let factor = if model.glass { format!("\"baseColorFactor\":[1,1,1,{}],", js_number(opacity)) } else { String::new() };
        materials.push(format!(
            "{{\"pbrMetallicRoughness\":{{{factor}\"metallicFactor\":1,\"roughnessFactor\":1,\"metallicRoughnessTexture\":{{\"index\":{t},\"texCoord\":0}},\"baseColorTexture\":{{\"index\":{},\"texCoord\":0}}}},\"normalTexture\":{{\"index\":{},\"texCoord\":0}}{blend},\"name\":\"{name}\"}}",
            t + 1,
            t + 2
        ));
    }
    let textures: Vec<String> = (0..6).map(|k| format!("{{\"sampler\":{k},\"source\":{k}}}")).collect();
    // CanvasTexture: linear, trilinear, clamped.
    let samplers = ["{\"magFilter\":9729,\"minFilter\":9987,\"wrapS\":33071,\"wrapT\":33071}"; 6];
    let json = format!(
        "{{\"asset\":{{\"version\":\"2.0\",\"generator\":\"{generator}\"}},\"scene\":0,\"scenes\":[{{\"nodes\":[0]}}],\"nodes\":[{{\"name\":\"card\",\"children\":[1]}},{{\"matrix\":[{}],\"name\":\"card body\",\"children\":[2,3,4]}},{{\"name\":\"edge\",\"mesh\":0}},{{\"name\":\"front face\",\"mesh\":1}},{{\"name\":\"back face\",\"mesh\":2}}],\"meshes\":[{}],\"materials\":[{}],\"textures\":[{}],\"samplers\":[{}],\"images\":[{}],\"accessors\":[{}],\"bufferViews\":[{}],\"buffers\":[{{\"byteLength\":{}}}]}}",
        nums(&model.matrix),
        meshes.joined(","),
        materials.joined(","),
        textures.joined(","),
        samplers.joined(","),
        image_defs.joined(","),
        accessors.joined(","),
        views.joined(","),
        bin.len()
    );
    let mut json = json.into_bytes();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let total = 12 + 8 + json.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(total);
    let u32le = |out: &mut Vec<u8>, v: usize| out.extend_from_slice(&(v as u32).to_le_bytes());
    out.extend_from_slice(b"glTF");
    u32le(&mut out, 2);
    u32le(&mut out, total);
    u32le(&mut out, json.len());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json);
    u32le(&mut out, bin.len());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&bin);
    out
}

// ── USDZ ────────────────────────────────────────────────────────────────────────

/// A USD prim as three's `USDNode` writes it.
struct Node {
    name: String,
    kind: &'static str,
    metadata: Vec<(String, Meta)>,
    properties: Vec<(String, Vec<String>)>,
    children: Vec<Node>,
}

enum Meta {
    Value(String),
    Lines(Vec<String>),
}

impl Node {
    fn new(name: &str, kind: &'static str) -> Node {
        Node { name: name.into(), kind, metadata: Vec::new(), properties: Vec::new(), children: Vec::new() }
    }
    fn meta(&mut self, key: &str, value: &str) {
        self.metadata.push((key.into(), Meta::Value(value.into())));
    }
    fn prop(&mut self, p: impl Into<String>) {
        self.properties.push((p.into(), Vec::new()));
    }
    fn prop_with(&mut self, p: impl Into<String>, meta: &[&str]) {
        self.properties.push((p.into(), meta.iter().map(|s| s.to_string()).collect()));
    }

    fn write(&self, indent: usize) -> String {
        let pad = "\t".repeat(indent);
        let meta: Vec<String> = self
            .metadata
            .iter()
            .map(|(key, value)| match value {
                Meta::Lines(lines) => {
                    let mut l = vec![format!("{key} = {{")];
                    l.extend(lines.iter().map(|line| format!("{pad}\t\t{line}")));
                    l.push(format!("{pad}\t}}"));
                    l.joined("\n")
                }
                Meta::Value(v) => format!("{key} = {v}"),
            })
            .collect();
        let meta = match meta.is_empty() {
            true => String::new(),
            false => format!(" (\n{}\n{pad})", meta.iter().map(|l| format!("{pad}\t{l}")).collect::<Vec<_>>().joined("\n")),
        };
        let mut body: Vec<String> = self
            .properties
            .iter()
            .map(|(p, m)| match m.is_empty() {
                true => format!("{pad}\t{p}"),
                false => format!("{pad}\t{p} (\n{}\n{pad}\t)", m.iter().map(|m| format!("{pad}\t\t{m}")).collect::<Vec<_>>().joined("\n")),
            })
            .collect();
        if !self.children.is_empty() && !body.is_empty() {
            body.push(String::new());
        }
        for (i, c) in self.children.iter().enumerate() {
            body.push(c.write(indent + 1));
            if i + 1 < self.children.len() {
                body.push(String::new());
            }
        }
        let kind = if self.kind.is_empty() { String::new() } else { format!("{} ", self.kind) };
        format!("{pad}def {kind}\"{}\"{meta}\n{pad}{{\n{}\n{pad}}}", self.name, body.joined("\n"))
    }
}

fn header(creator: &str) -> String {
    format!(
        "#usda 1.0\n(\n\tcustomLayerData = {{\n\t\tstring creator = \"{creator}\"\n\t}}\n\tdefaultPrim = \"Root\"\n\tmetersPerUnit = 1\n\tupAxis = \"Y\"\n)\n"
    )
}

fn matrix(m: &[f64; 16], host: &dyn Host) -> String {
    let js_number = |x: f64| host.number(x, 0);
    let row = |o: usize| format!("({}, {}, {}, {})", js_number(m[o]), js_number(m[o + 1]), js_number(m[o + 2]), js_number(m[o + 3]));
    format!("( {}, {}, {}, {} )", row(0), row(4), row(8), row(12))
}

const IDENTITY: [f64; 16] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

/// A mesh's geometry file (`buildMeshObject`).
fn geometry(s: &Surface, host: &dyn Host, creator: &str) -> String {
    let (js_number, js_precision) = (|x: f64| host.number(x, 0), |x: f64, p: u8| host.number(x, p));
    let n = s.positions.len();
    let v3 = |v: &[[f32; 3]]| {
        v.iter()
            .map(|p| format!("({}, {}, {})", js_precision(p[0] as f64, 7), js_precision(p[1] as f64, 7), js_precision(p[2] as f64, 7)))
            .collect::<Vec<_>>()
            .joined(", ")
    };
    let mut mesh = Node::new("Geometry", "Mesh");
    mesh.prop(format!("int[] faceVertexCounts = [{}]", vec!["3"; n / 3].joined(", ")));
    mesh.prop(format!("int[] faceVertexIndices = [{}]", (0..n).map(|i| i.to_string()).collect::<Vec<_>>().joined(", ")));
    mesh.prop_with(format!("normal3f[] normals = [{}]", v3(&s.normals)), &["interpolation = \"vertex\""]);
    mesh.prop(format!("point3f[] points = [{}]", v3(&s.positions)));
    if let Some(uv) = &s.uvs {
        // st's origin is at the bottom: v flips (three writes `1 - v.toPrecision(7)`).
        let st: Vec<String> =
            uv.iter().map(|t| format!("({}, {})", js_precision(t[0] as f64, 7), js_number(1.0 - crate::json::number(&js_precision(t[1] as f64, 7))))).collect();
        mesh.prop_with(format!("texCoord2f[] primvars:st = [{}]", st.joined(", ")), &["interpolation = \"vertex\""]);
    }
    mesh.prop("uniform token subdivisionScheme = \"none\"");
    let mut root = Node::new("Geometry", "");
    root.children.push(mesh);
    format!("{}\n{}", header(creator), root.write(0))
}

/// The USDZ of `model` for AR Quick Look (anchored to a plane, horizontal or `upright`); `images` as
/// for [`glb`].
pub fn usdz(model: &Model, images: &[[Vec<u8>; 3]; 2], upright: bool, host: &dyn Host, creator: &str) -> Vec<u8> {
    let js_number = |x: f64| host.number(x, 0);
    // Ids as three numbers its objects: geometries 1–3, materials 1–3 (edge, front, back), textures and
    // images 1–6 (front colour, normal, orm; back ...).
    let mut scene = Node::new("Scene", "Xform");
    scene.metadata.push(("customData".into(), Meta::Lines(vec!["bool preliminary_collidesWithEnvironment = 0".into(), "string sceneName = \"Scene\"".into()])));
    scene.meta("sceneName", "\"Scene\"");
    scene.prop("token preliminary:anchoring:type = \"plane\"");
    scene.prop(format!("token preliminary:planeAnchoring:alignment = \"{}\"", if upright { "vertical" } else { "horizontal" }));
    let xform = |name: &str, m: &[f64; 16]| {
        let mut n = Node::new(name, "Xform");
        n.prop(format!("matrix4d xformOp:transform = {}", matrix(m, host)));
        n.prop("uniform token[] xformOpOrder = [\"xformOp:transform\"]");
        n
    };
    let mut body = xform("cardbody", &model.matrix);
    for (k, name) in ["edge", "frontface", "backface"].iter().enumerate() {
        let mut n = xform(name, &IDENTITY);
        n.meta("prepend references", &format!("@./geometries/Geometry_{}.usda@</Geometry>", k + 1));
        n.meta("prepend apiSchemas", "[\"MaterialBindingAPI\"]");
        n.prop(format!("rel material:binding = </Materials/Material_{}>", k + 1));
        body.children.push(n);
    }
    scene.children.push(body);
    let mut scenes = Node::new("Scenes", "Scope");
    scenes.meta("kind", "\"sceneLibrary\"");
    scenes.children.push(scene);
    let mut root = Node::new("Root", "Xform");
    root.children.push(scenes);

    let mut materials = Node::new("Materials", "");
    let glass = model.glass;
    let opacity = if glass { crate::ar::GLASS_OPACITY } else { 1.0 };
    let e = &model.edge_material;
    let mut edge = Node::new("Material_1", "Material");
    let mut surface = Node::new("PreviewSurface", "Shader");
    surface.prop("uniform token info:id = \"UsdPreviewSurface\"");
    surface.prop(format!("color3f inputs:diffuseColor = ({}, {}, {})", js_number(e.color[0]), js_number(e.color[1]), js_number(e.color[2])));
    surface.prop(format!("float inputs:roughness = {}", js_number(e.roughness)));
    surface.prop(format!("float inputs:metallic = {}", js_number(e.metalness)));
    surface.prop(format!("float inputs:opacity = {}", js_number(opacity)));
    surface.prop("int inputs:useSpecularWorkflow = 0");
    surface.prop("token outputs:surface");
    edge.children.push(surface);
    edge.prop("token outputs:surface.connect = </Materials/Material_1/PreviewSurface.outputs:surface>");
    materials.children.push(edge);
    for side in 0..2 {
        let id = side + 2;
        let mat = format!("Material_{id}");
        let mut node = Node::new(&mat, "Material");
        // `buildTextureNodes`: a primvar reader, a transform and the texture, per map.
        let texture = |node: &mut Node, file: usize, tex: usize, kind: &str, scale: Option<&str>, srgb: bool| {
            let mut reader = Node::new(&format!("PrimvarReader_{kind}"), "Shader");
            reader.prop("uniform token info:id = \"UsdPrimvarReader_float2\"");
            reader.prop("float2 inputs:fallback = (0.0, 0.0)");
            reader.prop("string inputs:varname = \"st\"");
            reader.prop("float2 outputs:result");
            let mut t2d = Node::new(&format!("Transform2d_{kind}"), "Shader");
            t2d.prop("uniform token info:id = \"UsdTransform2d\"");
            t2d.prop(format!("float2 inputs:in.connect = </Materials/{mat}/PrimvarReader_{kind}.outputs:result>"));
            t2d.prop("float inputs:rotation = 0.0000000");
            t2d.prop("float2 inputs:scale = (1, 1)");
            t2d.prop("float2 inputs:translation = (0, 0)");
            t2d.prop("float2 outputs:result");
            let mut t = Node::new(&format!("Texture_{tex}_{kind}"), "Shader");
            t.prop("uniform token info:id = \"UsdUVTexture\"");
            t.prop(format!("asset inputs:file = @textures/Texture_{file}_true.png@"));
            if kind == "normal" {
                // 8-bit normals: [0, 1] → [−1, 1].
                t.prop("float4 inputs:scale = (2, 2, 2, 1)");
                t.prop("float4 inputs:bias = (-1, -1, -1, 0)");
            }
            t.prop(format!("float2 inputs:st.connect = </Materials/{mat}/Transform2d_{kind}.outputs:result>"));
            if let Some(s) = scale {
                t.prop(format!("float4 inputs:scale = {s}"));
            }
            t.prop(format!("token inputs:sourceColorSpace = \"{}\"", if srgb { "sRGB" } else { "raw" }));
            t.prop("token inputs:wrapS = \"clamp\"");
            t.prop("token inputs:wrapT = \"clamp\"");
            t.prop("float outputs:r");
            t.prop("float outputs:g");
            t.prop("float outputs:b");
            t.prop("float3 outputs:rgb");
            if glass {
                t.prop("float outputs:a");
            }
            node.children.extend([reader, t2d, t]);
        };
        let (color, normal, orm) = (3 * side + 1, 3 * side + 2, 3 * side + 3);
        let mut ps = Node::new("PreviewSurface", "Shader");
        ps.prop("uniform token info:id = \"UsdPreviewSurface\"");
        ps.prop(format!("color3f inputs:diffuseColor.connect = </Materials/{mat}/Texture_{color}_diffuse.outputs:rgb>"));
        if glass {
            ps.prop(format!("float inputs:opacity.connect = </Materials/{mat}/Texture_{color}_diffuse.outputs:a>"));
        }
        texture(&mut node, color, color, "diffuse", Some("(1, 1, 1, 1.0)"), true);
        ps.prop(format!("normal3f inputs:normal.connect = </Materials/{mat}/Texture_{normal}_normal.outputs:rgb>"));
        texture(&mut node, normal, normal, "normal", None, false);
        ps.prop(format!("float inputs:roughness.connect = </Materials/{mat}/Texture_{orm}_roughness.outputs:g>"));
        texture(&mut node, orm, orm, "roughness", Some("(1, 1, 1, 1.0)"), false);
        ps.prop(format!("float inputs:metallic.connect = </Materials/{mat}/Texture_{orm}_metallic.outputs:b>"));
        texture(&mut node, orm, orm, "metallic", Some("(1, 1, 1, 1.0)"), false);
        // three writes the material's opacity too (with the texture's alpha connected, for glass).
        ps.prop(format!("float inputs:opacity = {}", js_number(opacity)));
        ps.prop("int inputs:useSpecularWorkflow = 0");
        ps.prop("token outputs:surface");
        node.children.push(ps);
        node.prop(format!("token outputs:surface.connect = </Materials/{mat}/PreviewSurface.outputs:surface>"));
        materials.children.push(node);
    }
    // The materials under the default prim (`nestMaterials`), so a stage that references the file
    // binds them too.
    let text = format!("{}\n{}\n\n{}", header(creator), root.write(0), materials.write(0));
    let model_usda = nest_materials(&text);

    let mut files: Vec<(String, Vec<u8>)> = vec![("model.usda".into(), model_usda.into_bytes())];
    for (k, s) in [&model.edge, &model.front, &model.back].into_iter().enumerate() {
        files.push((format!("geometries/Geometry_{}.usda", k + 1), geometry(s, host, creator).into_bytes()));
    }
    for (side, maps) in images.iter().enumerate() {
        // three's order: colour, normal, orm (as `buildMaterial` meets them).
        for (m, id) in [(0, 1), (2, 2), (1, 3)] {
            files.push((format!("textures/Texture_{}_true.png", 3 * side + id), maps[m].clone()));
        }
    }
    zip_aligned(&files)
}

/// `nestMaterials` (ar/index.ts): the `Materials` scope moved under `/Root`, its paths with it.
fn nest_materials(usda: &str) -> String {
    // (Byte searches: `str` patterns would land in the web build's main module.)
    let find = |hay: &[u8], needle: &[u8]| hay.windows(needle.len()).position(|w| w == needle);
    let Some(at) = find(usda.as_bytes(), b"\ndef \"Materials\"") else { return usda.to_string() };
    let head = &usda[..at];
    let Some(close) = head.bytes().rposition(|b| b == b'}') else { return usda.to_string() };
    let materials: Vec<String> = usda[at + 1..].trim_end().split('\n').map(|l| format!("\t{l}")).collect();
    let text = format!("{}\n{}\n}}\n", &head[..close], materials.joined("\n"));
    let (from, to) = (b"</Materials/".as_slice(), "</Root/Materials/");
    let mut out = String::with_capacity(text.len() + 1024);
    let mut rest = text.as_str();
    while let Some(i) = find(rest.as_bytes(), from) {
        out.push_str(&rest[..i]);
        out.push_str(to);
        rest = &rest[i + from.len()..];
    }
    out.push_str(rest);
    out
}

/// CRC-32 (IEEE), as zip stores it.
pub fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, t) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *t = c;
    }
    !data.iter().fold(!0u32, |c, &b| table[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8))
}

/// An uncompressed zip whose files' data each start at a multiple of 64 bytes (USDZ): a padding extra
/// field in each local header (id 12345, as three's exporter writes), no extra field in the central
/// directory.
pub fn zip_aligned(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    let le16 = |v: &mut Vec<u8>, x: usize| v.extend_from_slice(&(x as u16).to_le_bytes());
    let le32 = |v: &mut Vec<u8>, x: u32| v.extend_from_slice(&x.to_le_bytes());
    for (name, data) in files {
        let offset = out.len();
        let base = offset + 30 + name.len();
        // An extra field is at least 4 bytes (id, size).
        let pad = if base % 64 == 0 { None } else { Some((64 - (base + 4) % 64) % 64) };
        let extra = pad.map_or(0, |p| 4 + p);
        let crc = crc32(data);
        // Local header: version 2.0, no flags, stored, a fixed DOS time (1980-01-01).
        le32(&mut out, 0x0403_4b50);
        le16(&mut out, 20);
        le16(&mut out, 0);
        le16(&mut out, 0);
        le16(&mut out, 0);
        le16(&mut out, 0x21);
        le32(&mut out, crc);
        le32(&mut out, data.len() as u32);
        le32(&mut out, data.len() as u32);
        le16(&mut out, name.len());
        le16(&mut out, extra);
        out.extend_from_slice(name.as_bytes());
        if let Some(p) = pad {
            le16(&mut out, 12345);
            le16(&mut out, p);
            out.extend(std::iter::repeat_n(0, p));
        }
        debug_assert_eq!(out.len() % 64, 0);
        out.extend_from_slice(data);
        le32(&mut central, 0x0201_4b50);
        le16(&mut central, 20);
        le16(&mut central, 20);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le16(&mut central, 0x21);
        le32(&mut central, crc);
        le32(&mut central, data.len() as u32);
        le32(&mut central, data.len() as u32);
        le16(&mut central, name.len());
        le16(&mut central, 0);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le32(&mut central, 0);
        le32(&mut central, offset as u32);
        central.extend_from_slice(name.as_bytes());
    }
    let at = out.len();
    out.extend_from_slice(&central);
    le32(&mut out, 0x0605_4b50);
    le16(&mut out, 0);
    le16(&mut out, 0);
    le16(&mut out, files.len());
    le16(&mut out, files.len());
    le32(&mut out, central.len() as u32);
    le32(&mut out, at as u32);
    le16(&mut out, 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ar::{EdgeMaterial, Map, Model, Surface};

    /// A host that only writes numbers (the writers don't draw).
    struct Numbers;
    impl Host for Numbers {
        fn canvas(&self, _: u32, _: u32) -> Box<dyn crate::canvas::Canvas> {
            unreachable!()
        }
    }

    fn model(glass: bool) -> (Model, [[Vec<u8>; 3]; 2]) {
        let tri = |z: f32| Surface {
            positions: vec![[-1.0, -0.5, z], [1.0, -0.5, z], [0.0, 0.5, z]],
            normals: vec![[0.0, 0.0, z.signum()]; 3],
            uvs: Some(vec![[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]]),
        };
        let edge = Surface { uvs: None, ..tri(0.0) };
        let map = || Map { width: 2, height: 1, rgba: vec![255; 8] };
        let maps = [[map(), map(), map()], [map(), map(), map()]];
        let m = Model {
            edge,
            front: tri(0.01),
            back: tri(-0.01),
            maps,
            edge_material: EdgeMaterial { color: [0.5, 0.25, 0.125], metalness: 1.0, roughness: 0.3 },
            glass,
            matrix: crate::ar::compose([0.0, 0.00038, 0.0], -std::f64::consts::FRAC_PI_2, [0.0254, 0.0254, 0.0277]),
        };
        // Fake "images" of odd lengths, to exercise the padding.
        let img = |k: u8| vec![k; 5 + k as usize];
        (m, [[img(1), img(2), img(3)], [img(4), img(5), img(6)]])
    }

    #[test]
    fn glb_keeps_the_formats_invariants() {
        for glass in [false, true] {
            let (m, images) = model(glass);
            let b = glb(&m, &images, &Numbers, "test");
            let u32at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) as usize;
            assert_eq!(&b[0..4], b"glTF");
            assert_eq!((u32at(4), u32at(8)), (2, b.len()));
            let jl = u32at(12);
            assert_eq!((&b[16..20], jl % 4), (b"JSON".as_slice(), 0));
            let json: serde_json::Value = serde_json::from_slice(&b[20..20 + jl]).expect("JSON chunk");
            let bl = u32at(20 + jl);
            assert_eq!((&b[24 + jl..28 + jl], bl % 4, 28 + jl + bl), (b"BIN\0".as_slice(), 0, b.len()));
            assert_eq!(json["buffers"][0]["byteLength"].as_u64().unwrap() as usize, bl);
            let views = json["bufferViews"].as_array().unwrap();
            for v in views {
                let (o, l) = (v["byteOffset"].as_u64().unwrap() as usize, v["byteLength"].as_u64().unwrap() as usize);
                assert!(o + l <= bl && o % 4 == 0);
            }
            for (k, a) in json["accessors"].as_array().unwrap().iter().enumerate() {
                let v = &views[a["bufferView"].as_u64().unwrap() as usize];
                let n = if a["type"] == "VEC3" { 3 } else { 2 };
                assert_eq!(v["byteStride"].as_u64().unwrap(), 4 * n, "accessor {k}");
                assert_eq!(v["byteLength"].as_u64().unwrap(), 4 * n * a["count"].as_u64().unwrap(), "accessor {k}");
                assert_eq!(a["min"].as_array().unwrap().len() as u64, n);
            }
            // Images: in their views, byte for byte.
            for (i, im) in json["images"].as_array().unwrap().iter().enumerate() {
                let v = &views[im["bufferView"].as_u64().unwrap() as usize];
                let o = 28 + jl + v["byteOffset"].as_u64().unwrap() as usize;
                let side = &images[i / 3];
                assert_eq!(&b[o..o + v["byteLength"].as_u64().unwrap() as usize], &side[[1, 0, 2][i % 3]][..]);
            }
            // The scene graph: card ⊃ card body ⊃ edge, front face, back face.
            assert_eq!(json["nodes"][1]["children"], serde_json::json!([2, 3, 4]));
            assert_eq!(json["nodes"][1]["matrix"].as_array().unwrap().len(), 16);
            let blend = json["materials"].as_array().unwrap().iter().filter(|m| m["alphaMode"] == "BLEND").count();
            assert_eq!(blend, if glass { 3 } else { 0 });
        }
    }

    #[test]
    fn usdz_is_an_aligned_stored_zip() {
        let (m, images) = model(false);
        let z = usdz(&m, &images, false, &Numbers, "test");
        let (u16at, u32at) =
            (|o: usize| u16::from_le_bytes([z[o], z[o + 1]]) as usize, |o: usize| u32::from_le_bytes(z[o..o + 4].try_into().unwrap()) as usize);
        let mut at = 0;
        let mut names = Vec::new();
        while u32at(at) == 0x0403_4b50 {
            let (size, nl, xl) = (u32at(at + 18), u16at(at + 26), u16at(at + 28));
            let name = String::from_utf8(z[at + 30..at + 30 + nl].to_vec()).unwrap();
            let data = at + 30 + nl + xl;
            assert_eq!(data % 64, 0, "{name}");
            assert_eq!(u16at(at + 8), 0, "stored");
            assert_eq!(u32at(at + 14) as u32, crc32(&z[data..data + size]), "{name}");
            if name == "model.usda" {
                let text = std::str::from_utf8(&z[data..data + size]).unwrap();
                assert!(text.contains("defaultPrim = \"Root\"") && text.contains("upAxis = \"Y\""));
                assert!(!text.contains("token inputs:varname") && !text.contains("</Materials/"));
                assert!(text.contains("float4 inputs:bias = (-1, -1, -1, 0)"));
                // The materials are inside /Root.
                let root_end = text.rfind('}').unwrap();
                assert!(text[..root_end].contains("def \"Materials\""));
            }
            names.push(name);
            at = data + size;
        }
        assert_eq!(names[0], "model.usda");
        assert_eq!(names.len(), 1 + 3 + 6);
        // The central directory lists them all, and the end record points at it.
        let end = z.len() - 22;
        assert_eq!(u32at(end), 0x0605_4b50);
        assert_eq!((u16at(end + 10), u32at(end + 16)), (names.len(), at));
    }

    #[test]
    fn numbers_read_as_javascript_writes_them() {
        for (x, js) in [
            (0.0254, "0.0254"),
            (-1.0, "-1"),
            (0.0, "0"),
            (2.220446049250313e-16, "2.220446049250313e-16"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (123.5, "123.5"),
        ] {
            assert_eq!(js_number(x), js, "{x}");
        }
        for (x, js) in [
            (0.0, "0.000000"),
            (1.0, "1.000000"),
            (-1.685, "-1.685000"),
            (0.013715116307139397, "0.01371512"),
            (-4.371139e-8, "-4.371139e-8"),
            (9.99999999, "10.00000"),
            (0.5, "0.5000000"),
        ] {
            assert_eq!(js_precision(x, 7), js, "{x}");
        }
    }
}
