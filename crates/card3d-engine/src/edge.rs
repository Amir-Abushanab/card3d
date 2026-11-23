//! Coloured / anodised edges (`CardDesign.edge`): a port of `card/edge.ts` and `sanitizeEdge`. The
//! body keeps its geometry; a card with an edge finish draws it as three index groups sorted by face
//! normal (caps, bevel ring, side walls including the cutouts'), a material each.
//!
//! A "match" edge takes the body colour only; the artwork-colour variant (`setMatchColor`) comes with
//! the artwork layers.

use crate::geometry::Mesh;
use crate::material::{srgb_hex_to_linear, Resolved};
use crate::renderer::Material;

use crate::json::Value;

/// Default colours per finish (when `edge.color` is unset).
pub const EDGE_DEFAULT_METAL: &str = "#c9a45c";
pub const EDGE_DEFAULT_ANODIZED: &str = "#2f6fd6";

/// Triangle classes by |n_z| of the face normal.
const CAP_NZ: f64 = 0.985;
const WALL_NZ: f64 = 0.12;

/// `CardEdge`, as `sanitizeEdge` leaves it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CardEdge {
    /// "metal", "anodized" or "match".
    pub finish: Option<String>,
    /// "#rrggbb", lowercase; only with metal / anodized.
    pub color: Option<String>,
    pub chamfer: bool,
}

fn is_hex(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// `sanitizeEdge`: a known finish and/or the chamfer; a colour only with metal / anodized.
pub fn parse_edge(v: &Value) -> Option<CardEdge> {
    let obj = v.as_object()?;
    let mut out = CardEdge::default();
    if let Some(f @ ("metal" | "anodized" | "match")) = obj.get("finish").and_then(Value::as_str) {
        out.finish = Some(f.to_string());
    }
    if matches!(out.finish.as_deref(), Some("metal" | "anodized")) {
        if let Some(c) = obj.get("color").and_then(Value::as_str).map(str::trim).filter(|c| is_hex(c)) {
            out.color = Some(c.to_ascii_lowercase());
        }
    }
    out.chamfer = obj.get("chamfer").and_then(Value::as_bool) == Some(true);
    (out.finish.is_some() || out.chamfer).then_some(out)
}

/// True when the design's edge changes anything.
pub fn has_edge(edge: &CardEdge) -> bool {
    edge.finish.is_some() || edge.chamfer
}

/// The body sorted into [caps, bevel, walls] (`edgeGroupedGeometry`): each shares the body's vertices.
/// A group without triangles is `None`.
pub fn edge_grouped_geometry(body: &Mesh) -> [Option<Mesh>; 3] {
    let mut classes: [Vec<u32>; 3] = Default::default();
    let p = |i: u32| body.positions[i as usize].map(f64::from);
    for t in body.indices.as_chunks::<3>().0 {
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let nz = if len > 0.0 { (n[2] / len).abs() } else { 1.0 };
        classes[if nz > CAP_NZ {
            0
        } else if nz > WALL_NZ {
            1
        } else {
            2
        }]
        .extend_from_slice(t);
    }
    classes.map(|indices| (!indices.is_empty()).then(|| Mesh { indices, ..body.clone() }))
}

/// Materials for the bevel and walls (`EdgeMaterials`).
pub struct EdgeMaterials {
    /// Bevel ring material (the chamfer when on, else the wall's).
    pub bevel: Material,
    pub wall: Material,
}

fn lerp_white(c: [f32; 3], t: f32) -> [f32; 3] {
    c.map(|v| v + (1.0 - v) * t)
}

/// `createEdgeMaterials`: `r` is the resolved body material, `body` the card's own face material (used
/// for the parts the edge leaves alone). Colours are linear RGB.
pub fn create_edge_materials(edge: &CardEdge, r: &Resolved, body: &Material) -> EdgeMaterials {
    let base = r.color;
    let rough = r.roughness;
    let color = |fallback: &str| srgb_hex_to_linear(edge.color.as_deref().filter(|c| is_hex(c)).unwrap_or(fallback));
    let wall = match edge.finish.as_deref() {
        Some("metal") => Material {
            color: color(EDGE_DEFAULT_METAL),
            metalness: 1.0,
            roughness: (rough * 0.75).clamp(0.08, 0.5) as f32,
            clearcoat: 0.15,
            clearcoat_roughness: 0.2,
            ..Default::default()
        },
        // Dyed oxide over bright aluminium: the dye is the colour, the metal beneath gives it a coloured
        // sheen, the oxide film a faint interference shimmer.
        Some("anodized") => {
            let dye = color(EDGE_DEFAULT_ANODIZED);
            Material {
                color: dye,
                metalness: 0.55,
                roughness: 0.32,
                emissive: dye.map(|c| c * 0.08),
                clearcoat: 0.5,
                clearcoat_roughness: 0.18,
                iridescence: 0.45,
                iridescence_ior: 1.5,
                iridescence_thickness: 560.0,
                ..Default::default()
            }
        }
        Some("match") => Material {
            color: base,
            metalness: r.metalness as f32,
            roughness: rough.clamp(0.08, 0.7) as f32,
            clearcoat: r.clearcoat as f32,
            clearcoat_roughness: r.clearcoat_roughness as f32,
            ..Default::default()
        },
        _ => body.clone(),
    };
    let bevel = if edge.chamfer {
        // Diamond-cut chamfer: bright, polished bare metal of the body (or the metal edge's tint).
        let tint = if edge.finish.as_deref() == Some("metal") { color(EDGE_DEFAULT_METAL) } else { base };
        Material { color: lerp_white(tint, 0.35), metalness: 1.0, roughness: 0.05, clearcoat: 0.6, clearcoat_roughness: 0.05, ..Default::default() }
    } else {
        wall.clone()
    };
    EdgeMaterials { bevel, wall }
}

/// The body with an edge finish (`applyEdge`): caps, bevel and walls as three items, each with its
/// material. A "match" edge takes the artwork's border colour (the front's, else the back's); printed
/// artwork makes it a painted edge (`setMatchColor`). On the web this is the `edge` chunk, downloaded
/// only by cards with an edge finish.
#[wasm_split_helpers::wasm_split(edge, fallible)]
pub fn build(
    r: &mut crate::renderer::Renderer,
    device: &wgpu::Device,
    host: &dyn crate::canvas::Host,
    design: &crate::design::CardDesign,
    e: &CardEdge,
    m: &Resolved,
    body_material: Material,
    body_mesh: &Mesh,
) -> Result<(), crate::ChunkUnavailable> {
    let mut em = create_edge_materials(e, m, &body_material);
    if e.finish.as_deref() == Some("match") {
        let side = if design.surface_sources.contains_key("front") { "front" } else { "back" };
        let img = design.surface_sources.get(side).and_then(|src| host.image(src, crate::canvas::ImagePurpose::Artwork));
        if let Some(c) = img.as_ref().and_then(|img| crate::mark::image_edge_color(host, img)) {
            let lin = c.map(|v| (if v < 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }) as f32);
            let printed = design.surface_treatments.get(side).is_some_and(|t| t == "printed");
            for (mat, is_wall) in [(&mut em.wall, true), (&mut em.bevel, false)] {
                if is_wall || !e.chamfer {
                    mat.color = lin;
                    if printed {
                        mat.metalness = 0.15;
                        mat.roughness = 0.42;
                        mat.clearcoat = 0.4;
                    }
                }
            }
        }
    }
    for (group, material) in edge_grouped_geometry(body_mesh).iter().zip([body_material, em.bevel, em.wall]) {
        if let Some(group) = group {
            let mesh = r.mesh(device, group);
            r.add(crate::renderer::Item { mesh, material, transform: glam::Mat4::IDENTITY, render_order: 0.0, visible: true });
        }
    }
    Ok(())
}
