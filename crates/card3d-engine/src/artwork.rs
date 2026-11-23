//! The artwork layers (`card/design-layer.ts`, rows 5/5b): an image on the face plane at ±(J + 0.00165),
//! render order 8. "inlay" is lit metallic ink on the recipe's relief and roughness maps; anything
//! else ("printed") is unlit and not tone mapped, so the pixels show as authored.

use glam::{Mat4, Vec3};

use crate::canvas::Image;
use crate::material::{mip_chain, Resolved, SurfaceMaps};
use crate::renderer::{Item, Material, MeshId, Renderer, TextureId, Wrap};

/// z above the body cap and render order (`LAYER.design`).
pub const DESIGN_Z: f32 = 0.00165;
pub const RENDER_ORDER: f32 = 8.0;

/// The artwork texture (`designTexture`): sRGB, trilinear, flipY (the image's top row at v = 1).
pub fn texture(r: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, img: &Image, anisotropy: u16) -> TextureId {
    let row = 4 * img.width as usize;
    let flipped: Vec<u8> = img.rgba.chunks_exact(row).rev().flatten().copied().collect();
    r.texture_with(device, queue, &mip_chain(&flipped, img.width, img.height, true), true, Wrap::Clamp, anisotropy)
}

/// `createDesignMaterial`.
pub fn material(map: TextureId, inlay: bool, m: &Resolved, surface: &SurfaceMaps, normal: TextureId, rough: TextureId) -> Material {
    let common = Material { map: Some(map), transparent: true, depth_write: false, ..Default::default() };
    if inlay {
        Material {
            alpha_test: 0.01,
            metalness: 0.56,
            roughness: (m.roughness + 0.08).clamp(0.16, 0.66) as f32,
            roughness_map: Some(rough),
            normal_map: Some(normal),
            normal_scale: surface.normal_scale,
            surface_repeat: surface.repeat,
            // The inlay overlay keeps the full anisotropy (no quality cap).
            anisotropy: surface.anisotropy,
            anisotropy_rotation: surface.anisotropy_rotation,
            clearcoat: (m.clearcoat * 0.7) as f32,
            clearcoat_roughness: m.clearcoat_roughness as f32,
            ..common
        }
    } else {
        Material { unlit: true, ..common }
    }
}

/// The artwork plane for one side (`createDesignMesh`): the face plane, turned π about y on the back.
pub fn add(r: &mut Renderer, face: MeshId, body_depth: f64, back: bool, material: Material) -> usize {
    let z = (body_depth / 2.0) as f32 + DESIGN_Z;
    let transform = if back {
        Mat4::from_translation(Vec3::new(0.0, 0.0, -z)) * Mat4::from_rotation_y(std::f32::consts::PI)
    } else {
        Mat4::from_translation(Vec3::new(0.0, 0.0, z))
    };
    r.add(Item { mesh: face, material, transform, render_order: RENDER_ORDER, visible: true })
}
