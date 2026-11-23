//! The chip module of a clear (glass) card (`card/chip-module.ts`): what a transparent card shows behind
//! its contact plate. A carrier tape under the plate, the black mould cap under it, two antenna pads on
//! the tape's back, and a fine copper coil (a four-turn spiral in the inlay plane) with its two leads
//! running up to the pads. Everything is inside the glass: seen only through it.
//!
//! [`build_chip_module`] returns CPU data only (positions, normals, UVs, indices, material scalars and
//! transforms), in the order three's scene graph holds them: the module meshes (children of the "chip
//! module body" group, which is placed at the plate and turned with it), then the wires (children of the
//! "chip module" group, in card space).

use crate::extrude::{self, CatmullRomCurve3, ExtrudeOptions, Shape};
use crate::geometry::{Mesh, CARD_W};
use crate::iso::{self, MmRect, ID1_WIDTH_MM, MM_PER_UNIT};
use crate::layout::{chip_rect, CardFrame, CARD_H};
use glam::DVec3;
use std::f64::consts::PI;

/// `CHIP_FLUSH.top` (card/chip.ts): the flush plate's top this far proud of the face.
pub const CHIP_FLUSH_TOP: f64 = 0.0012;
/// `CHIP_PLATE_DEPTH` (card/chip.ts): the flush plate's thickness, card units.
pub const CHIP_PLATE_DEPTH: f64 = 0.005;

/// `CHIP_MODULE.tape`: thickness, and footprint x the plate's.
const TAPE_DEPTH: f64 = 0.007;
const TAPE_INSET: f64 = 0.96;
/// `CHIP_MODULE.cap`: footprint x the plate's, depth below the tape, rounded edge.
const CAP_WIDTH: f64 = 0.5;
const CAP_HEIGHT: f64 = 0.56;
const CAP_DEPTH: f64 = 0.0138;
const CAP_ROUND: f64 = 0.012;
/// `CHIP_MODULE.pad`: the antenna pads on the tape's back.
const PAD_WIDTH: f64 = 0.075;
const PAD_HEIGHT: f64 = 0.16;
const PAD_DEPTH: f64 = 0.002;
/// `CHIP_MODULE.coil` (the default card's coil): inset of the outer turn from the slab's edge, turn pitch,
/// turns, wire radius, plane (x half-thickness, below the middle), how high the outer lead bridges (x radius).
const COIL_INSET: f64 = 0.15;
const COIL_PITCH: f64 = 0.024;
const COIL_TURNS: f64 = 4.0;
const COIL_RADIUS: f64 = 0.0032;
const COIL_PLANE: f64 = -0.55;
const COIL_BRIDGE: f64 = 2.5;

/// `ISO_ANTENNA` (geometry/iso.ts): the public clear card's coil, mm.
const ISO_ANTENNA_OUTER: MmRect = MmRect { x0: 2.0, x1: ID1_WIDTH_MM - 2.0, y0: 13.0, y1: 38.3 };
const ISO_ANTENNA_CORNER_RADIUS: f64 = 4.0;
const ISO_ANTENNA_TURNS: f64 = 4.0;
const ISO_ANTENNA_PITCH: f64 = 0.61;

/// `ChipModuleOptions`.
#[derive(Clone, Copy, Debug)]
pub struct ChipModuleOptions {
    /// Face-to-face thickness of the slab (the plate is flush with its front face).
    pub body_depth: f64,
    /// Outer size of the slab (standard card, no frame; default `CARD_W` x `CARD_H`).
    pub slab: Option<(f64, f64)>,
}

/// Which group of three's scene graph a mesh hangs from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModuleParent {
    /// "chip module body": translated to the plate's centre and turned about z by the plate's rotation.
    Body,
    /// "chip module": card space.
    Group,
}

/// A `MeshPhysicalMaterial`'s parameters as the module sets them (colours as sRGB bytes of the hex string).
#[derive(Clone, Debug, PartialEq)]
pub struct ChipMaterial {
    pub name: &'static str,
    pub color: [u8; 3],
    pub metalness: f32,
    pub roughness: f32,
    pub clearcoat: f32,
    pub clearcoat_roughness: f32,
}

/// One `THREE.Mesh` of the module.
#[derive(Clone, Debug)]
pub struct ChipModuleMesh {
    pub name: &'static str,
    pub parent: ModuleParent,
    /// `mesh.position`, in the parent's space.
    pub position: [f64; 3],
    /// `mesh.rotation.z` (always 0 here).
    pub rotation_z: f64,
    /// Index into [`ChipModule::geometries`] (the two pads share one geometry, as in three).
    pub geometry: usize,
    pub material: ChipMaterial,
}

/// The module's meshes and group transforms.
#[derive(Clone)]
pub struct ChipModule {
    /// `group.userData[CARD_FACE_KEY]`: refracted by the front face it is seen through, never the far one.
    pub card_face: u32,
    /// "chip module body" group: position (`chip.x`, `chip.y`, 0).
    pub body_position: [f64; 3],
    /// "chip module body" group: `rotation.z`, the plate's turn.
    pub body_rotation_z: f64,
    pub geometries: Vec<Mesh>,
    /// In three's traversal order: tape, mould cap, the two pads, the antenna coil, the two antenna leads.
    pub meshes: Vec<ChipModuleMesh>,
}

fn rounded_rect(w: f64, h: f64, r: f64) -> Shape {
    let (x, y) = (w / 2.0, h / 2.0);
    let mut s = Shape::new();
    s.move_to(-x + r, -y);
    s.line_to(x - r, -y);
    s.absarc(x - r, -y + r, r, -PI / 2.0, 0.0, false);
    s.line_to(x, y - r);
    s.absarc(x - r, y - r, r, 0.0, PI / 2.0, false);
    s.line_to(-x + r, y);
    s.absarc(-x + r, y - r, r, PI / 2.0, PI, false);
    s.line_to(-x, -y + r);
    s.absarc(-x + r, -y + r, r, PI, 1.5 * PI, false);
    s
}

/// `slab(w, h, r, depth, round)`: a rounded slab, z in [-depth, 0] (top at its origin), with soft edges when `round` > 0.
fn slab(w: f64, h: f64, r: f64, depth: f64, round: f64) -> Mesh {
    let b = round.min(depth / 3.0).min(r * 0.8);
    let mut g = extrude::extrude_geometry(
        &rounded_rect(w - 2.0 * b, h - 2.0 * b, f64::max(1e-4, r - b)),
        &ExtrudeOptions {
            depth: depth - 2.0 * b,
            bevel_enabled: b > 0.0,
            bevel_thickness: b,
            bevel_size: Some(b),
            bevel_segments: 3,
            curve_segments: 8,
            ..Default::default()
        },
    );
    extrude::translate(&mut g, 0.0, 0.0, -(depth - b));
    g
}

/// `roundedRectPoint(hx, hy, r, t)`: the point on a rounded rectangle at arc-length fraction `t` (0..1,
/// counter-clockwise from the middle of the right side), as (x, y).
fn rounded_rect_point(hx: f64, hy: f64, r: f64, t: f64) -> (f64, f64) {
    let sx = hx - r;
    let sy = hy - r;
    let arc = (PI / 2.0) * r;
    // Segments: right (upper half), TR arc, top, TL arc, left, BL arc, bottom, BR arc, right (lower half).
    let segs = [sy, arc, 2.0 * sx, arc, 2.0 * sy, arc, 2.0 * sx, arc, sy];
    let total: f64 = segs.iter().sum();
    let mut d = (((t % 1.0) + 1.0) % 1.0) * total;
    let corner = |cx: f64, cy: f64, a0: f64, u: f64| (cx + r * (a0 + u * (PI / 2.0)).cos(), cy + r * (a0 + u * (PI / 2.0)).sin());
    for (i, &len) in segs.iter().enumerate() {
        if d > len && i < segs.len() - 1 {
            d -= len;
            continue;
        }
        let u = if len > 0.0 { d / len } else { 0.0 };
        return match i {
            0 => (hx, u * sy),
            1 => corner(sx, sy, 0.0, u),
            2 => (sx - u * 2.0 * sx, hy),
            3 => corner(-sx, sy, PI / 2.0, u),
            4 => (-hx, sy - u * 2.0 * sy),
            5 => corner(-sx, -sy, PI, u),
            6 => (-sx + u * 2.0 * sx, -hy),
            7 => corner(sx, -sy, 1.5 * PI, u),
            _ => (hx, -sy + u * sy),
        };
    }
    (0.0, 0.0)
}

/// `a.clone().lerp(b, alpha)`.
fn lerp(a: DVec3, b: DVec3, alpha: f64) -> DVec3 {
    DVec3::new(a.x + (b.x - a.x) * alpha, a.y + (b.y - a.y) * alpha, a.z + (b.z - a.z) * alpha)
}

/// The `lead` helper: from an end of the coil along the inlay to below its pad, up beside the cap and
/// to the pad, easing the last rise so the wire bends rather than kinks.
fn lead(from: DVec3, to: DVec3, z: f64) -> Vec<DVec3> {
    let mut out = vec![from];
    // Coincident points would give the centripetal spline zero-length segments (NaN).
    let run = |out: &mut Vec<DVec3>, a: DVec3, b: DVec3, n: usize| {
        if a.distance(b) < 1e-5 {
            return;
        }
        for i in 1..=n {
            out.push(lerp(a, b, i as f64 / n as f64));
        }
    };
    let a = DVec3::new(from.x, from.y, z);
    let b = DVec3::new(to.x, from.y, z);
    let c = DVec3::new(to.x, to.y, z);
    run(&mut out, from, a, 4);
    run(&mut out, a, b, 16);
    run(&mut out, b, c, 8);
    for i in 1..=12 {
        let u = i as f64 / 12.0;
        out.push(DVec3::new(to.x, to.y, z + (to.z - z) * (1.0 - ((u * PI) / 2.0).cos())));
    }
    out
}

fn material(name: &'static str, color: [u8; 3], metalness: f32, roughness: f32, clearcoat: f32, clearcoat_roughness: f32) -> ChipMaterial {
    ChipMaterial { name, color, metalness, roughness, clearcoat, clearcoat_roughness }
}

/// `buildChipModule(geometry, { bodyDepth, slab }, bag)`: the module (tape, mould cap, antenna pads)
/// behind a flush contact plate, and the antenna coil in the inlay with its leads to the pads. Card
/// space; the plate follows `frame.chip` (`None`: the standard card's right-hand chip).
pub fn build_chip_module(frame: Option<&CardFrame>, o: &ChipModuleOptions) -> ChipModule {
    let j = o.body_depth / 2.0;
    let chip = chip_rect(frame);
    let turn = frame.map_or(0.0, |f| f.chip.rotation);
    // Module space: the plate's own axes (its width along x before the chip's turn).
    let turned = turn.sin().abs() > 0.5;
    let pw = if turned { chip.h } else { chip.w };
    let ph = if turned { chip.w } else { chip.h };

    let plate_bottom = j + CHIP_FLUSH_TOP - CHIP_PLATE_DEPTH;
    let tape_bottom = plate_bottom - TAPE_DEPTH;
    let corner = pw.min(ph) * 0.17;

    let mut out = ChipModule { card_face: 0, body_position: [chip.x, chip.y, 0.0], body_rotation_z: turn, geometries: Vec::new(), meshes: Vec::new() };

    let tape_mat = material("chip module tape", [0xa0, 0x7a, 0x2c], 0.25, 0.42, 0.5, 0.3);
    let tape = out.geometry(slab(pw * TAPE_INSET, ph * TAPE_INSET, corner, TAPE_DEPTH, 0.0));
    out.mesh("chip module tape", ModuleParent::Body, [0.0, 0.0, plate_bottom], tape, &tape_mat);

    let cap_mat = material("chip mould cap", [0x0c, 0x0d, 0x10], 0.0, 0.32, 0.8, 0.18);
    let cw = pw * CAP_WIDTH;
    let ch = ph * CAP_HEIGHT;
    let cap = out.geometry(slab(cw, ch, cw.min(ch) * 0.22, CAP_DEPTH, CAP_ROUND));
    out.mesh("chip mould cap", ModuleParent::Body, [0.0, 0.0, tape_bottom], cap, &cap_mat);

    let gold_mat = material("antenna pad", [0xd8, 0xb2, 0x5e], 1.0, 0.28, 0.0, 0.0);
    let pad_geo = out.geometry(slab(PAD_WIDTH, PAD_HEIGHT, 0.012, PAD_DEPTH, 0.0));
    let pad_x = cw / 2.0 + (pw * TAPE_INSET - cw) / 4.0;
    let mut pads: Vec<DVec3> = Vec::new();
    for sx in [-1.0, 1.0] {
        // The two pads share one geometry, as in three.
        out.mesh("antenna pad", ModuleParent::Body, [sx * pad_x, 0.0, tape_bottom], pad_geo, &gold_mat);
        pads.push(DVec3::new(sx * pad_x, 0.0, tape_bottom - PAD_DEPTH));
    }

    let zc = j * COIL_PLANE;
    let cap_bottom = chip.y - (if turned { cw } else { ch }) / 2.0;
    let tape_bottom_edge = chip.y - (if turned { pw } else { ph }) * TAPE_INSET / 2.0;
    let y_outer = cap_bottom - 0.35 * (cap_bottom - tape_bottom_edge);
    let y_inner = cap_bottom - 0.75 * (cap_bottom - tape_bottom_edge);
    let mut pts: Vec<DVec3> = Vec::new();
    if frame.is_some() {
        // ID-1 frame (the public card): the coil of `ISO_ANTENNA`, round the upper card and between the
        // embossing areas, its ends coming off its left run beside the chip.
        let bx = iso::iso_rect(&ISO_ANTENNA_OUTER, false);
        let hx0 = bx.w / 2.0;
        let hy0 = bx.h / 2.0;
        let r0 = ISO_ANTENNA_CORNER_RADIUS / MM_PER_UNIT;
        let pitch = ISO_ANTENNA_PITCH / MM_PER_UNIT;
        let sx = hx0 - r0;
        let sy = hy0 - r0;
        let arc = (PI / 2.0) * r0;
        let total = 4.0 * (sx + sy + arc);
        // Arc-length fraction of the point at card height y on the left run (CCW from the right run's middle).
        let left_at = |y: f64| (sy + arc + 2.0 * sx + arc + (sy - f64::max(-sy, f64::min(sy, y - bx.y)))) / total;
        let t_start = left_at(y_outer);
        let t_end = ISO_ANTENNA_TURNS + left_at(y_inner);
        let steps = (200.0 * (t_end - t_start)).ceil() as usize;
        for i in 0..=steps {
            let t = t_start + ((t_end - t_start) * i as f64) / steps as f64;
            let inset = (t - t_start) * pitch;
            let (px, py) = rounded_rect_point(hx0 - inset, hy0 - inset, f64::max(0.04, r0 - inset), t);
            pts.push(DVec3::new(bx.x + px, bx.y + py, zc));
        }
    } else {
        // Coil: a spiral of `turns` turns, outer turn `inset` in from the slab's edge, whose ends stop on the
        // side nearest the module (landscape: the right edge) just below the mould cap.
        let (sw, sh) = o.slab.unwrap_or((CARD_W, CARD_H));
        let hx0 = sw / 2.0 - COIL_INSET;
        let hy0 = sh / 2.0 - COIL_INSET;
        let r0 = 0.2;
        let perimeter = 4.0 * (hx0 + hy0) - (8.0 - 2.0 * PI) * r0;
        let along = |y: f64| f64::max(-(hy0 - r0), f64::min(hy0 - r0, y)) / perimeter;
        let t_start = along(y_outer);
        let t_end = COIL_TURNS + along(y_inner);
        let steps = (160.0 * (t_end - t_start)).ceil() as usize;
        for i in 0..=steps {
            let t = t_start + ((t_end - t_start) * i as f64) / steps as f64;
            let inset = (t - t_start) * COIL_PITCH;
            let (px, py) = rounded_rect_point(hx0 - inset, hy0 - inset, f64::max(0.04, r0 - inset), t);
            pts.push(DVec3::new(px, py, zc));
        }
    }
    // Pads in card space (`applyAxisAngle(z, turn)` then the plate's centre); the outer end takes the pad nearer to it.
    let (s, c) = ((turn / 2.0).sin(), (turn / 2.0).cos());
    let pad_world: Vec<DVec3> = pads
        .iter()
        .map(|p| {
            // Quaternion (0, 0, s, c) applied to p.
            let (tx, ty) = (2.0 * (-s * p.y), 2.0 * (s * p.x));
            DVec3::new(p.x + c * tx - s * ty + chip.x, p.y + c * ty + s * tx + chip.y, p.z + 0.0)
        })
        .collect();
    let outer_end = pts[0];
    let inner_end = pts[pts.len() - 1];
    let near = if pad_world[0].distance_squared(outer_end) < pad_world[1].distance_squared(outer_end) { 0 } else { 1 };

    let wire_mat = material("antenna wire", [0xc4, 0x7a, 0x45], 1.0, 0.34, 0.0, 0.0);
    let mut wires: Vec<(&'static str, Vec<DVec3>)> = vec![("antenna coil", pts)];
    wires.push(("antenna lead", lead(outer_end, pad_world[near], zc + COIL_BRIDGE * COIL_RADIUS)));
    wires.push(("antenna lead", lead(inner_end, pad_world[1 - near], zc)));
    for (name, points) in wires {
        let segments = usize::max(8, points.len() * 2);
        let curve = CatmullRomCurve3::new(points, false);
        let tube = out.geometry(extrude::tube_geometry(&curve, segments, COIL_RADIUS, 5, false));
        out.mesh(name, ModuleParent::Group, [0.0, 0.0, 0.0], tube, &wire_mat);
    }
    out
}

impl ChipModule {
    fn geometry(&mut self, mesh: Mesh) -> usize {
        self.geometries.push(mesh);
        self.geometries.len() - 1
    }

    fn mesh(&mut self, name: &'static str, parent: ModuleParent, position: [f64; 3], geometry: usize, material: &ChipMaterial) {
        self.meshes.push(ChipModuleMesh { name, parent, position, rotation_z: 0.0, geometry, material: material.clone() });
    }
}
