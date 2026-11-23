//! The holo / foil overlay (`holo/`): per side a face foil on the cap silhouette at ±(J + 0.0024) and a
//! bevel foil coinciding with the body, sharing that side's uniforms, drawn additively at render order 9
//! with raw output (shaders/holo.wgsl).

use crate::design::Recipe;
use crate::geometry::{Mesh, CARD_W};

/// normalize(−4, 5, 7), world space.
pub fn light_direction() -> [f32; 3] {
    let l = (16.0f64 + 25.0 + 49.0).sqrt();
    [(-4.0 / l) as f32, (5.0 / l) as f32, (7.0 / l) as f32]
}
pub const FACE_OFFSET: f64 = 0.0024;
pub const RENDER_ORDER: f32 = 9.0;

const STYLES: [&str; 15] =
    ["common", "uncommon", "rare", "holo", "reverse", "cosmos", "radiant", "amazing", "rainbow", "shiny", "gallery", "ultra", "vmax", "vstar", "gold"];
const TEXTURES: [&str; 3] = ["etched", "sparkle", "microdot"];

/// One side's uniform values (`holoUniformValues`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HoloValues {
    pub style: f32,
    pub texture: f32,
    pub intensity: f32,
    pub glare: f32,
    pub responsive: f32,
    pub scale: f32,
    pub coverage: f32,
}

fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    x.max(lo).min(hi)
}

/// `holoSide` + `holoUniformValues` for a recipe side, `None` when it renders nothing.
fn values(style: &str, texture: &str, intensity: f64, glare: f64, motion: bool, scale: f64, coverage: &str) -> Option<HoloValues> {
    if intensity.is_nan() || intensity <= 0.0 {
        return None;
    }
    Some(HoloValues {
        style: STYLES.iter().position(|s| *s == style).unwrap_or(0) as f32,
        texture: TEXTURES.iter().position(|t| *t == texture).unwrap_or(0) as f32,
        intensity: clamp(intensity / 100.0, 0.0, 1.0) as f32,
        glare: if glare.is_finite() { clamp(glare / 100.0, 0.0, 1.0) as f32 } else { 0.0 },
        responsive: if motion { 1.0 } else { 0.0 },
        scale: if scale.is_finite() { clamp(scale / 100.0, 0.25, 4.0) as f32 } else { 1.0 },
        coverage: if coverage == "tile" { 1.0 } else { 0.0 },
    })
}

/// The recipe's front and back foils (`partialRecipeToMaterialConfig`'s holo / backHolo).
pub fn sides(r: &Recipe) -> (Option<HoloValues>, Option<HoloValues>) {
    let front =
        r.front_holo.then(|| values(&r.holo_style, &r.foil_texture, r.foil_intensity, r.holo_glare, r.holo_motion, r.foil_scale, &r.foil_coverage)).flatten();
    let back = if r.match_holo_sides {
        front
    } else if r.back_holo {
        values(&r.back_holo_style, &r.back_foil_texture, r.back_foil_intensity, r.back_holo_glare, r.back_holo_motion, r.back_foil_scale, &r.back_foil_coverage)
    } else {
        None
    };
    (front, back)
}

/// Whether the recipe has a foil on either side (`sides` isn't `(None, None)`), without the values
/// (which only the `holo` chunk needs).
pub fn any(r: &Recipe) -> bool {
    let on = |intensity: f64| intensity > 0.0;
    let front = r.front_holo && on(r.foil_intensity);
    front || if r.match_holo_sides { false } else { r.back_holo && on(r.back_foil_intensity) }
}

/// `cardUv`: the holo meshes' UVs.
fn card_uv(x: f32, y: f32, card_h: f64) -> [f32; 2] {
    [(x as f64 / CARD_W + 0.5) as f32, (y as f64 / card_h + 0.5) as f32]
}

/// The face foil mesh (`holoFace`): the body's front-cap triangles (mean normal z > 0.96) on z = 0,
/// with card UVs.
pub fn face_mesh(body: &Mesh, card_h: f64) -> Mesh {
    let mut m = Mesh::default();
    let mut map = std::collections::HashMap::new();
    for t in body.indices.as_chunks::<3>().0 {
        let nz = t.iter().map(|&i| body.normals[i as usize][2]).sum::<f32>() / 3.0;
        if nz <= 0.96 {
            continue;
        }
        for &i in t {
            let j = *map.entry(i).or_insert_with(|| {
                let p = body.positions[i as usize];
                m.positions.push([p[0], p[1], 0.0]);
                m.normals.push([0.0, 0.0, 1.0]);
                m.uvs.push(card_uv(p[0], p[1], card_h));
                m.positions.len() as u32 - 1
            });
            m.indices.push(j);
        }
    }
    m
}

/// The bevel foil mesh (`holoEdge`): body triangles with a vertex beyond 0.9 of the half-extent, with
/// the body's normals and card UVs.
pub fn edge_mesh(body: &Mesh, card_h: f64) -> Mesh {
    let (mut hx, mut hy) = (0.0f32, 0.0f32);
    for p in &body.positions {
        hx = hx.max(p[0].abs());
        hy = hy.max(p[1].abs());
    }
    let c = |i: u32| {
        let p = body.positions[i as usize];
        (p[0].abs() / hx).max(p[1].abs() / hy)
    };
    let mut m = Mesh { positions: body.positions.clone(), normals: body.normals.clone(), uvs: Vec::new(), indices: Vec::new() };
    m.uvs = body.positions.iter().map(|p| card_uv(p[0], p[1], card_h)).collect();
    m.indices = body.indices.as_chunks::<3>().0.iter().filter(|t| t.iter().any(|&i| c(i) > 0.9)).flatten().copied().collect();
    m
}

/// Layer 6 (`buildHolo`): the face foil and the bevel foil for each holo side, render order 9. `j`:
/// half the body depth. On the web this is the `holo` chunk, downloaded only by holo cards.
#[wasm_split_helpers::wasm_split(holo, fallible)]
pub fn build(r: &mut crate::renderer::Renderer, device: &wgpu::Device, recipe: &Recipe, body_mesh: &Mesh, j: f32) -> Result<(), crate::ChunkUnavailable> {
    use glam::{Mat4, Vec3};
    let (front, back) = sides(recipe);
    let card_h = crate::layout::CARD_H;
    let holo_face = r.mesh(device, &face_mesh(body_mesh, card_h));
    let holo_edge = r.mesh(device, &edge_mesh(body_mesh, card_h));
    let z = j + FACE_OFFSET as f32;
    for (values, sign) in [(front, 1.0f32), (back, -1.0)] {
        let Some(values) = values else { continue };
        let mut t = Mat4::from_translation(Vec3::new(0.0, 0.0, sign * z));
        if sign < 0.0 {
            t *= Mat4::from_rotation_y(std::f32::consts::PI);
        }
        r.add_holo(device, holo_face, t, crate::renderer::HoloDraw { values, edge_only: false, edge_side: 1.0 });
        r.add_holo(device, holo_edge, Mat4::IDENTITY, crate::renderer::HoloDraw { values, edge_only: true, edge_side: sign });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::design::Recipe;

    /// `any` answers as `sides` does.
    #[test]
    fn any_matches_sides() {
        for bits in 0..64u32 {
            let b = |k: u32| bits & (1 << k) != 0;
            let r = Recipe {
                front_holo: b(0),
                back_holo: b(1),
                match_holo_sides: b(2),
                foil_intensity: if b(3) {
                    60.0
                } else if b(5) {
                    f64::NAN
                } else {
                    0.0
                },
                back_foil_intensity: if b(4) { 40.0 } else { -1.0 },
                ..Default::default()
            };
            assert_eq!(super::any(&r), super::sides(&r) != (None, None), "{bits:06b}");
        }
    }
}
