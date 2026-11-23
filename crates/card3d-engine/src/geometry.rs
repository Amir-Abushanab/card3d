//! Card geometry: a port of `geometry/procedural.ts` (`buildRoundedSlab`), `derive.ts`
//! (`buildFacePlaneGeometry`) and `rounded-rect.ts`. Lengths in card units (1 unit = 1 inch,
//! the ISO/IEC 7810 ID-1 card is 3.37 wide).

/// Card layout width (spec: `CARD_W`).
pub const CARD_W: f64 = 3.37;
/// Native body units (the body's 860 units span 85.60 mm).
const NATIVE_W: f64 = 860.0;
const NATIVE_PER_MM: f64 = NATIVE_W / 85.6;
/// ISO/IEC 7810 ID-1 body in native units: 85.60 × 53.98 × 0.70 mm, 3.18 mm corners, 2-unit bevel.
pub const ID1_HEIGHT: f64 = 53.98 * NATIVE_PER_MM;
pub const ID1_DEPTH: f64 = 7.0;
pub const ID1_CORNER: f64 = 3.18 * NATIVE_PER_MM;
pub const ID1_BEVEL: f64 = 2.0;
/// Native → card units.
pub const BODY_SCALE: f64 = CARD_W / NATIVE_W;
/// Body thickness, card units (0.0274302).
pub const BODY_DEPTH: f64 = ID1_DEPTH * BODY_SCALE;
/// Face plane: 0.998 of the body, quadratic corners scaled with the body's (0.17 for 40-unit corners).
const FACE_PLANE_SCALE: f64 = 0.998;
const FACE_PLANE_RADIUS: f64 = 0.17 * ID1_CORNER / 40.0;

#[derive(Default, Clone)]
pub struct Mesh {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    pub indices: Vec<u32>,
}

/// The ISO body: `buildRoundedSlab(ID1_BODY_NATIVE, sharedCapEdge: false)`, normals recomputed and
/// scaled into card units, as `deriveCardGeometrySet` does.
pub fn card_body() -> Mesh {
    rounded_slab(NATIVE_W, ID1_HEIGHT, ID1_DEPTH, ID1_CORNER, ID1_BEVEL, 12, BODY_SCALE, false)
}

/// The chip plate's front shell (`buildIsoChipSlab` + the derivation's `keepTriangles`): the public
/// plate (`ISO_CHIP_PLATE`, 12.6 × 11.4 mm, R1.5) as a 6.5-unit slab with the 2-unit bevel, analytic
/// normals, keeping the triangles whose mean normal faces the front (z > 0.5). Native units: draw it
/// scaled by `CHIP_SCALE`.
pub fn chip_shell() -> Mesh {
    let mut m = rounded_slab(12.6 * NATIVE_PER_MM, 11.4 * NATIVE_PER_MM, CHIP_DEPTH_NATIVE, 1.5 * NATIVE_PER_MM, 2.0, 12, 1.0, true);
    let keep: Vec<u32> =
        m.indices.as_chunks::<3>().0.iter().filter(|t| t.iter().map(|&i| m.normals[i as usize][2]).sum::<f32>() / 3.0 > 0.5).flatten().copied().collect();
    m.indices = keep;
    m
}
/// The chip slab's depth, native units.
pub const CHIP_DEPTH_NATIVE: f64 = 6.5;
/// Native → card units for the chip (the plate's width in card units over its native width).
pub const CHIP_SCALE: f64 = CARD_W / NATIVE_W;

/// The face plane drawn over each cap (`buildFacePlaneGeometry`): UVs 0..1 across it.
pub fn face_plane() -> Mesh {
    let w = FACE_PLANE_SCALE * CARD_W;
    let h = FACE_PLANE_SCALE * ID1_HEIGHT * BODY_SCALE;
    let pts = quadratic_rounded_rect(w, h, FACE_PLANE_RADIUS, 12);
    let mut m = Mesh::default();
    for &(x, y) in &pts {
        m.positions.push([x as f32, y as f32, 0.0]);
        m.normals.push([0.0, 0.0, 1.0]);
        m.uvs.push([((x + w / 2.0) / w) as f32, ((y + h / 2.0) / h) as f32]);
    }
    // Convex and counter-clockwise: a fan covers it exactly like the ear-clipped original.
    for i in 1..pts.len() as u32 - 1 {
        m.indices.extend([0, i, i + 1]);
    }
    m
}

/// `THREE.PlaneGeometry(w, h)`: one quad facing +z, UV (0, 0) at the bottom left.
pub fn plane(w: f32, h: f32) -> Mesh {
    let (x, y) = (w / 2.0, h / 2.0);
    Mesh {
        positions: vec![[-x, y, 0.0], [x, y, 0.0], [-x, -y, 0.0], [x, -y, 0.0]],
        normals: vec![[0.0, 0.0, 1.0]; 4],
        uvs: vec![[0.0, 1.0], [1.0, 1.0], [0.0, 0.0], [1.0, 0.0]],
        indices: vec![0, 2, 1, 2, 3, 1],
    }
}

/// Centred rounded-rectangle slab with the card body's extrusion profile: flat caps inset by `bevel`,
/// a quarter-circle bevel sampled at three rings, a straight wall, mirrored on the back. Caps get
/// their own vertices; all normals come from `compute_vertex_normals` (the body's construction).
/// `shared_cap_edge`: true, the caps reuse the bevel's cap-edge ring and the normals are analytic (the
/// chip); false, the caps get their own vertices and the normals are recomputed (the body).
fn rounded_slab(w: f64, h: f64, d: f64, r: f64, b: f64, segs: usize, scale: f64, shared_cap_edge: bool) -> Mesh {
    use std::f64::consts::{FRAC_PI_2, PI, SQRT_2};
    let s45 = SQRT_2 / 2.0;
    let corners =
        [(w / 2.0 - r, -h / 2.0 + r, -FRAC_PI_2), (w / 2.0 - r, h / 2.0 - r, 0.0), (-w / 2.0 + r, h / 2.0 - r, FRAC_PI_2), (-w / 2.0 + r, -h / 2.0 + r, PI)];
    let mut outline = Vec::new();
    for (cx, cy, a0) in corners {
        for k in 0..=segs {
            let a = a0 + (k as f64 / segs as f64) * FRAC_PI_2;
            outline.push((cx, cy, a.cos(), a.sin()));
        }
    }
    let n = outline.len();
    // (inset, z) per ring: cap edge, 45°, wall top, wall bottom, 45°, cap edge.
    let rings = [
        (b, d / 2.0),
        (b * (1.0 - s45), d / 2.0 - b * (1.0 - s45)),
        (0.0, d / 2.0 - b),
        (0.0, -d / 2.0 + b),
        (b * (1.0 - s45), -d / 2.0 + b * (1.0 - s45)),
        (b, -d / 2.0),
    ];
    let mut pos: Vec<[f64; 3]> = Vec::new();
    let mut uv: Vec<[f32; 2]> = Vec::new();
    // Normal (xy weight, z) per ring: cap edge, 45°, wall, wall, 45°, cap edge.
    let ring_normals = [(0.0, 1.0), (s45, s45), (1.0, 0.0), (1.0, 0.0), (s45, -s45), (0.0, -1.0)];
    let mut nrm: Vec<[f32; 3]> = Vec::new();
    let push = |pos: &mut Vec<[f64; 3]>, nrm: &mut Vec<[f32; 3]>, uv: &mut Vec<[f32; 2]>, o: &(f64, f64, f64, f64), inset: f64, z: f64, n: (f64, f64)| {
        let rr = r - inset;
        let (x, y) = (o.0 + o.2 * rr, o.1 + o.3 * rr);
        pos.push([x, y, z]);
        nrm.push([(o.2 * n.0) as f32, (o.3 * n.0) as f32, n.1 as f32]);
        let (u, v) = (((x + w / 2.0) / w) as f32, ((y + h / 2.0) / h) as f32);
        uv.push(if z >= 0.0 { [u, v] } else { [v, u] });
    };
    for (k, &(inset, z)) in rings.iter().enumerate() {
        for o in &outline {
            push(&mut pos, &mut nrm, &mut uv, o, inset, z, ring_normals[k]);
        }
    }
    let mut index: Vec<u32> = Vec::new();
    for ring in 0..rings.len() - 1 {
        let (a0, b0) = ((ring * n) as u32, ((ring + 1) * n) as u32);
        for i in 0..n as u32 {
            let j = (i + 1) % n as u32;
            index.extend([a0 + i, b0 + i, b0 + j, a0 + i, b0 + j, a0 + j]);
        }
    }
    for front in [true, false] {
        let ring = if front { 0 } else { rings.len() - 1 };
        let base = if shared_cap_edge {
            (ring * n) as u32
        } else {
            let base = pos.len() as u32;
            let (inset, z) = rings[ring];
            for o in &outline {
                push(&mut pos, &mut nrm, &mut uv, o, inset, z, (0.0, if front { 1.0 } else { -1.0 }));
            }
            base
        };
        // The cap outline is convex and counter-clockwise (seen from +z).
        for i in 1..n as u32 - 1 {
            if front {
                index.extend([base, base + i, base + i + 1]);
            } else {
                index.extend([base, base + i + 1, base + i]);
            }
        }
    }
    let normals = if shared_cap_edge { nrm } else { compute_vertex_normals(&pos, &index) };
    Mesh { positions: pos.iter().map(|p| [(p[0] * scale) as f32, (p[1] * scale) as f32, (p[2] * scale) as f32]).collect(), normals, uvs: uv, indices: index }
}

/// `BufferGeometry.computeVertexNormals` for indexed geometry: area-weighted face normals summed per vertex.
fn compute_vertex_normals(pos: &[[f64; 3]], index: &[u32]) -> Vec<[f32; 3]> {
    let mut acc = vec![[0.0f64; 3]; pos.len()];
    for t in index.as_chunks::<3>().0 {
        let (a, b, c) = (pos[t[0] as usize], pos[t[1] as usize], pos[t[2] as usize]);
        let cb = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
        let ab = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        let n = [cb[1] * ab[2] - cb[2] * ab[1], cb[2] * ab[0] - cb[0] * ab[2], cb[0] * ab[1] - cb[1] * ab[0]];
        for &v in t {
            for k in 0..3 {
                acc[v as usize][k] += n[k];
            }
        }
    }
    acc.iter()
        .map(|n| {
            let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if l > 0.0 {
                [(n[0] / l) as f32, (n[1] / l) as f32, (n[2] / l) as f32]
            } else {
                [0.0, 0.0, 1.0]
            }
        })
        .collect()
}

/// `quadraticRoundedRectShape(w, h, r).getPoints(divisions)` without the closing duplicate: corners
/// are quadratic Béziers with the control point at the sharp corner.
fn quadratic_rounded_rect(w: f64, h: f64, radius: f64, divisions: usize) -> Vec<(f64, f64)> {
    let (hx, hy) = (w / 2.0, h / 2.0);
    let r = radius.min(hx).min(hy);
    let mut pts = vec![(-hx + r, -hy)];
    let line = |pts: &mut Vec<(f64, f64)>, p: (f64, f64)| pts.push(p);
    let quad = |pts: &mut Vec<(f64, f64)>, c: (f64, f64), e: (f64, f64)| {
        let s = *pts.last().unwrap();
        for k in 1..=divisions {
            let t = k as f64 / divisions as f64;
            let (a, b2, c2) = ((1.0 - t) * (1.0 - t), 2.0 * (1.0 - t) * t, t * t);
            pts.push((a * s.0 + b2 * c.0 + c2 * e.0, a * s.1 + b2 * c.1 + c2 * e.1));
        }
    };
    line(&mut pts, (hx - r, -hy));
    quad(&mut pts, (hx, -hy), (hx, -hy + r));
    line(&mut pts, (hx, hy - r));
    quad(&mut pts, (hx, hy), (hx - r, hy));
    line(&mut pts, (-hx + r, hy));
    quad(&mut pts, (-hx, hy), (-hx, hy - r));
    line(&mut pts, (-hx, -hy + r));
    quad(&mut pts, (-hx, -hy), (-hx + r, -hy));
    pts.pop(); // back at the start
    pts
}
