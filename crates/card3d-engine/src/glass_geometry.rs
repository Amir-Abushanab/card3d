//! The glass card's body (`scene/glass.ts`, `scene/glass-dims.ts`): an ISO/IEC 7810 ID-1 rounded-rect
//! extrusion, 85.60 x 53.98 x 0.76 mm with 3.18 mm corners and a 0.2 mm bevel, built exactly as three
//! r180's `ExtrudeGeometry` builds it (see [`crate::extrude`]). Non-indexed in three, so the bevel
//! normals are faceted; keep them.

use crate::extrude::{self, ExtrudeOptions, Shape};
use crate::geometry::Mesh;
use crate::iso::{ID1_HEIGHT_MM, ID1_WIDTH_MM, MM_PER_UNIT};
use std::f64::consts::PI;
use std::sync::OnceLock;

/// Card units per millimetre (`MM` in glass.ts).
const MM: f64 = 1.0 / MM_PER_UNIT;
/// Outer corner radius (over the walls): ISO's nominal 3.18 mm (`CORNER`).
const CORNER: f64 = 3.18 * MM;

/// Bevel thickness (and size) of the slab: each face sits this far beyond the extrusion (`GLASS_BEVEL`, 0.2 mm).
pub const GLASS_BEVEL: f64 = 0.2 * MM;
/// Face-to-face thickness of the slab (`GLASS_THICKNESS`: ISO's nominal 0.76 mm; z in +-0.015).
pub const GLASS_THICKNESS: f64 = 0.76 * MM;
/// Extrusion depth of the glass slab between its bevels (`GLASS_BODY_DEPTH`).
pub const GLASS_BODY_DEPTH: f64 = GLASS_THICKNESS - 2.0 * GLASS_BEVEL;

/// `glassShape()`: the slab's outline inset by the bevel (the extrusion's bevel grows it back out to the
/// ID-1 size): a rounded rectangle with circular corners (`absarc`), so the walls have the true corner radius.
pub fn glass_shape() -> Shape {
    let w = (ID1_WIDTH_MM * MM) / 2.0 - GLASS_BEVEL;
    let h = (ID1_HEIGHT_MM * MM) / 2.0 - GLASS_BEVEL;
    let r = CORNER - GLASS_BEVEL;
    let mut s = Shape::new();
    s.move_to(-w + r, -h);
    s.line_to(w - r, -h);
    s.absarc(w - r, -h + r, r, -PI / 2.0, 0.0, false);
    s.line_to(w, h - r);
    s.absarc(w - r, h - r, r, 0.0, PI / 2.0, false);
    s.line_to(-w + r, h);
    s.absarc(-w + r, h - r, r, PI / 2.0, PI, false);
    s.line_to(-w, -h + r);
    s.absarc(-w + r, -h + r, r, PI, 1.5 * PI, false);
    s
}

/// `getGlassBodyGeometry()`, built fresh: `ExtrudeGeometry` (depth `GLASS_BODY_DEPTH`, 1 step, 16 curve
/// segments, 4 bevel segments), `center()` (z in +-`GLASS_THICKNESS` / 2), `computeVertexNormals()`.
///
/// Three's geometry is non-indexed; `indices` is the identity (`0..n`), so the mesh draws like any other.
pub fn build_glass_body_geometry() -> Mesh {
    let mut g = extrude::extrude_geometry(
        &glass_shape(),
        &ExtrudeOptions {
            depth: GLASS_BODY_DEPTH,
            steps: 1,
            curve_segments: 16,
            bevel_enabled: true,
            bevel_segments: 4,
            bevel_size: Some(GLASS_BEVEL),
            bevel_thickness: GLASS_BEVEL,
            bevel_offset: 0.0,
        },
    );
    extrude::center(&mut g);
    extrude::compute_vertex_normals(&mut g);
    g
}

/// `getGlassBodyGeometry()`: built once and shared.
pub fn glass_body_geometry() -> &'static Mesh {
    static SHARED: OnceLock<Mesh> = OnceLock::new();
    SHARED.get_or_init(build_glass_body_geometry)
}
