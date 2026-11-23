//! CPU-side checks of the glass card's geometry (`scene/glass.ts` `getGlassBodyGeometry`, `card/chip-module.ts`
//! `buildChipModule`) and of the three.js r180 internals they run on (`extrude.rs`) against three itself.
//!
//! How the numbers were made: `dump.ts` and `dump2.ts` (kept outside the repository, in the session scratchpad
//! `glassgeo/`, run with Node 24 against the repository's `three@0.180.0` and the TypeScript modules themselves)
//! build `getGlassBodyGeometry()` and `buildChipModule(...)` for four inputs (the public landscape frame, the
//! portrait frame, the standard (frame-less) card, and the standard card on a custom slab) and print, per
//! mesh: vertex count, index count (`null`: three's geometry is non-indexed), the bounding box of the f32
//! positions, and sums of the attributes weighted by the vertex index i, in the style of `tests/shape.rs`:
//!   position = sum x * (i % 7 + 1) + y * (i % 5 + 1) + z * (i % 3 + 1)
//!   normal   = the same over the normal components
//!   u, v     = sum u * (i % 7 + 1), sum v * (i % 5 + 1)
//!   index    = sum index[k] * (k % 7 + 1) (exact)
//! plus the meshes' transforms and material scalars. `dump2.ts` pins `ShapeUtils.triangulateShape`,
//! `Shape.getPoints`, `CatmullRomCurve3` arc-length sampling, tangents and Frenet frames, and a
//! `TubeGeometry`. The Rust computes in f64 and stores f32 like three, so the sums agree to ~1e-4 relative
//! (the libm `sin`, `cos` and `pow` may differ from V8's in the last bit).
//!
//! Three's extrusions have no index: the Rust meshes carry the identity index instead (asserted).

use card3d_engine::chip_module::{build_chip_module, ChipModule, ChipModuleOptions, ModuleParent};
use card3d_engine::extrude::{self, CatmullRomCurve3, Shape};
use card3d_engine::geometry::Mesh;
use card3d_engine::glass_geometry::{glass_body_geometry, glass_shape, GLASS_BEVEL, GLASS_BODY_DEPTH, GLASS_THICKNESS};
use card3d_engine::layout::{public_frame, CardFrame};
use glam::{DVec2, DVec3};

/// Counts, bounds and weighted checksums of one mesh.
struct Sum {
    vertices: usize,
    /// `None`: non-indexed in three.
    indices: Option<usize>,
    lo: [f64; 3],
    hi: [f64; 3],
    position: f64,
    u: f64,
    v: f64,
    normal: f64,
    index: Option<u64>,
}

/// One mesh of the module: parent, position, material and geometry checksums.
struct Expect {
    name: &'static str,
    parent: ModuleParent,
    position: [f64; 3],
    color: &'static str,
    metalness: f32,
    roughness: f32,
    clearcoat: f32,
    clearcoat_roughness: f32,
    sum: Sum,
}

fn summary(m: &Mesh) -> Sum {
    let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
    let (mut position, mut u, mut v, mut normal) = (0.0, 0.0, 0.0, 0.0);
    for i in 0..m.positions.len() {
        let p = m.positions[i];
        for k in 0..3 {
            lo[k] = lo[k].min(p[k] as f64);
            hi[k] = hi[k].max(p[k] as f64);
        }
        position += p[0] as f64 * (i % 7 + 1) as f64 + p[1] as f64 * (i % 5 + 1) as f64 + p[2] as f64 * (i % 3 + 1) as f64;
        u += m.uvs[i][0] as f64 * (i % 7 + 1) as f64;
        v += m.uvs[i][1] as f64 * (i % 5 + 1) as f64;
        let n = m.normals[i];
        normal += n[0] as f64 * (i % 7 + 1) as f64 + n[1] as f64 * (i % 5 + 1) as f64 + n[2] as f64 * (i % 3 + 1) as f64;
    }
    Sum {
        vertices: m.positions.len(),
        indices: Some(m.indices.len()),
        lo,
        hi,
        position,
        u,
        v,
        normal,
        index: Some(m.indices.iter().enumerate().map(|(k, &i)| i as u64 * (k % 7 + 1) as u64).sum()),
    }
}

fn close(what: &str, got: f64, want: f64) {
    assert!((got - want).abs() <= 1e-4 * want.abs().max(1.0), "{what}: {got} vs {want}");
}

fn check(name: &str, m: &Mesh, want: &Sum) {
    let got = summary(m);
    assert_eq!(got.vertices, want.vertices, "{name}: vertex count");
    assert_eq!(m.normals.len(), m.positions.len(), "{name}: normals");
    assert_eq!(m.uvs.len(), m.positions.len(), "{name}: uvs");
    match want.indices {
        // Non-indexed in three: the identity index here.
        None => assert!(m.indices.iter().enumerate().all(|(k, &i)| i as usize == k) && m.indices.len() == want.vertices, "{name}: identity index"),
        Some(n) => {
            assert_eq!(got.indices, Some(n), "{name}: index count");
            assert_eq!(got.index, want.index, "{name}: index checksum");
        }
    }
    for k in 0..3 {
        assert!(
            (got.lo[k] - want.lo[k]).abs() < 1e-6 && (got.hi[k] - want.hi[k]).abs() < 1e-6,
            "{name}: bounds {:?} {:?} vs {:?} {:?}",
            got.lo,
            got.hi,
            want.lo,
            want.hi
        );
    }
    close(&format!("{name}: position checksum"), got.position, want.position);
    close(&format!("{name}: u checksum"), got.u, want.u);
    close(&format!("{name}: v checksum"), got.v, want.v);
    close(&format!("{name}: normal checksum"), got.normal, want.normal);
}

const GLASS: Sum = Sum {
    vertices: 7908,
    indices: None,
    lo: [-1.684999942779541, -1.0625735521316528, -0.014960279688239098],
    hi: [1.684999942779541, 1.0625735521316528, 0.014960279688239098],
    position: 69.65773832798004,
    u: 51.093287885189056,
    v: 21218.132092237473,
    normal: 1.3430623235180974,
    index: None,
};

/// Body group position and turn, then the meshes in traversal order.
const LANDSCAPE: ([f64; 3], f64, &[Expect]) = (
    [-1.0921004672897194, 0.12204439252336441, 0.0],
    0.0,
    &[
        Expect {
            name: "chip module tape",
            parent: ModuleParent::Body,
            position: [0.0, 0.0, 0.011160280373831776],
            color: "#a07a2c",
            metalness: 0.25,
            roughness: 0.42,
            clearcoat: 0.5,
            clearcoat_roughness: 0.3,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.2381046712398529, -0.21542803943157196, -0.007000000216066837],
                hi: [0.2381046712398529, 0.21542803943157196, 2.1606683109354208e-10],
                position: 3.7820357960466424,
                u: 4.9896895587444305,
                v: 1221.4874632060528,
                normal: -0.13934023678302765,
                index: None,
            },
        },
        Expect {
            name: "chip mould cap",
            parent: ModuleParent::Body,
            position: [0.0, 0.0, 0.004160280373831776],
            color: "#0c0d10",
            metalness: 0.0,
            roughness: 0.32,
            clearcoat: 0.8,
            clearcoat_roughness: 0.18,
            sum: Sum {
                vertices: 3252,
                indices: None,
                lo: [-0.12401285022497177, -0.12566635012626648, -0.013799999840557575],
                hi: [0.12401285022497177, 0.12566635012626648, 2.0414590851114411e-10],
                position: -37.55335933524478,
                u: 3.726296067237854,
                v: 8548.20446716249,
                normal: -0.06817089021205902,
                index: None,
            },
        },
        Expect {
            name: "antenna pad",
            parent: ModuleParent::Body,
            position: [-0.181058761682243, 0.0, 0.004160280373831776],
            color: "#d8b25e",
            metalness: 1.0,
            roughness: 0.28,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.03750000149011612, -0.07999999821186066, -0.0020000000949949026],
                hi: [0.03750000149011612, 0.07999999821186066, 9.499490083442197e-11],
                position: 0.7334329307824223,
                u: 0.1406086217612028,
                v: 1223.6098429560661,
                normal: -0.13938122242689133,
                index: None,
            },
        },
        Expect {
            name: "antenna pad",
            parent: ModuleParent::Body,
            position: [0.181058761682243, 0.0, 0.004160280373831776],
            color: "#d8b25e",
            metalness: 1.0,
            roughness: 0.28,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.03750000149011612, -0.07999999821186066, -0.0020000000949949026],
                hi: [0.03750000149011612, 0.07999999821186066, 9.499490083442197e-11],
                position: 0.7334329307824223,
                u: 0.1406086217612028,
                v: 1223.6098429560661,
                normal: -0.13938122242689133,
                index: None,
            },
        },
        Expect {
            name: "antenna coil",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 9630,
                indices: Some(48120),
                lo: [-1.6093050241470337, -0.4470406472682953, -0.010817009024322033],
                hi: [1.598597526550293, 0.5406056642532349, -0.005028154235333204],
                position: 1113.7478969535805,
                u: 19258.999376917258,
                v: 14445.000215247273,
                normal: 3197.8761563450353,
                index: Some(926685294),
            },
        },
        Expect {
            name: "antenna lead",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 498,
                indices: Some(2460),
                lo: [-1.6093050241470337, -0.03913996368646622, -0.008228153921663761],
                hi: [-1.2691525220870972, 0.12508776783943176, 0.0035385412629693747],
                position: -2777.3746037805686,
                u: 997.0609754323959,
                v: 745.0000111609697,
                normal: -43.80567159212736,
                index: Some(2444212),
            },
        },
        Expect {
            name: "antenna lead",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 450,
                indices: Some(2220),
                lo: [-1.5100951194763184, -0.06724197417497635, -0.010955517180263996],
                hi: [-0.9066418409347534, 0.12463324517011642, 0.002160280477255583],
                position: -2097.9886926328763,
                u: 899.0540524497628,
                v: 675.0000100582838,
                normal: 128.5581831387245,
                index: Some(1993992),
            },
        },
    ],
);

/// Body group position and turn, then the meshes in traversal order.
const PORTRAIT: ([f64; 3], f64, &[Expect]) = (
    [0.12204439252336441, 1.0921004672897194, 0.0],
    -std::f64::consts::FRAC_PI_2,
    &[
        Expect {
            name: "chip module tape",
            parent: ModuleParent::Body,
            position: [0.0, 0.0, 0.011160280373831776],
            color: "#a07a2c",
            metalness: 0.25,
            roughness: 0.42,
            clearcoat: 0.5,
            clearcoat_roughness: 0.3,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.2381046712398529, -0.21542803943157196, -0.007000000216066837],
                hi: [0.2381046712398529, 0.21542803943157196, 2.1606683109354208e-10],
                position: 3.7820357960466424,
                u: 4.9896895587444305,
                v: 1221.4874632060528,
                normal: -0.13934023678302765,
                index: None,
            },
        },
        Expect {
            name: "chip mould cap",
            parent: ModuleParent::Body,
            position: [0.0, 0.0, 0.004160280373831776],
            color: "#0c0d10",
            metalness: 0.0,
            roughness: 0.32,
            clearcoat: 0.8,
            clearcoat_roughness: 0.18,
            sum: Sum {
                vertices: 3252,
                indices: None,
                lo: [-0.12401285022497177, -0.12566635012626648, -0.013799999840557575],
                hi: [0.12401285022497177, 0.12566635012626648, 2.0414590851114411e-10],
                position: -37.55335933524478,
                u: 3.726296067237854,
                v: 8548.20446716249,
                normal: -0.06817089021205902,
                index: None,
            },
        },
        Expect {
            name: "antenna pad",
            parent: ModuleParent::Body,
            position: [-0.181058761682243, 0.0, 0.004160280373831776],
            color: "#d8b25e",
            metalness: 1.0,
            roughness: 0.28,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.03750000149011612, -0.07999999821186066, -0.0020000000949949026],
                hi: [0.03750000149011612, 0.07999999821186066, 9.499490083442197e-11],
                position: 0.7334329307824223,
                u: 0.1406086217612028,
                v: 1223.6098429560661,
                normal: -0.13938122242689133,
                index: None,
            },
        },
        Expect {
            name: "antenna pad",
            parent: ModuleParent::Body,
            position: [0.181058761682243, 0.0, 0.004160280373831776],
            color: "#d8b25e",
            metalness: 1.0,
            roughness: 0.28,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.03750000149011612, -0.07999999821186066, -0.0020000000949949026],
                hi: [0.03750000149011612, 0.07999999821186066, 9.499490083442197e-11],
                position: 0.7334329307824223,
                u: 0.1406086217612028,
                v: 1223.6098429560661,
                normal: -0.13938122242689133,
                index: None,
            },
        },
        Expect {
            name: "antenna coil",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 9618,
                indices: Some(48060),
                lo: [-1.6093050241470337, -0.445690393447876, -0.010817009024322033],
                hi: [1.5976091623306274, 0.5391760468482971, -0.005028154235333204],
                position: 1070.2772221589694,
                u: 19240.002496487927,
                v: 14425.000215008855,
                normal: 3207.2300562049204,
                index: Some(924376403),
            },
        },
        Expect {
            name: "antenna lead",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 498,
                indices: Some(2460),
                lo: [-1.6093050241470337, 0.3837292194366455, -0.008228153921663761],
                hi: [0.12968064844608307, 0.9140850901603699, 0.0047155325300991535],
                position: -405.6097181897494,
                u: 997.0609754323959,
                v: 745.0000111609697,
                normal: 12.084317015951966,
                index: Some(2444212),
            },
        },
        Expect {
            name: "antenna lead",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 450,
                indices: Some(2220),
                lo: [-1.5102009773254395, 0.3586828410625458, -0.011273203417658806],
                hi: [0.13269217312335968, 1.2757481336593628, 0.002160280477255583],
                position: -2.137521618977189,
                u: 899.0540524497628,
                v: 675.0000100582838,
                normal: 142.11538415454552,
                index: Some(1993992),
            },
        },
    ],
);

/// Body group position and turn, then the meshes in traversal order.
const STANDARD: ([f64; 3], f64, &[Expect]) = (
    [1.0952499999999998, -0.16351785714285702, 0.0],
    0.0,
    &[
        Expect {
            name: "chip module tape",
            parent: ModuleParent::Body,
            position: [0.0, 0.0, 0.011160280373831776],
            color: "#a07a2c",
            metalness: 0.25,
            roughness: 0.42,
            clearcoat: 0.5,
            clearcoat_roughness: 0.3,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.24264000356197357, -0.20797714591026306, -0.007000000216066837],
                hi: [0.24264000356197357, 0.20797714591026306, 2.1606683109354208e-10],
                position: 3.8087646943334335,
                u: 5.1874580681324005,
                v: 1221.4266785085201,
                normal: -0.1393401101231575,
                index: None,
            },
        },
        Expect {
            name: "chip mould cap",
            parent: ModuleParent::Body,
            position: [0.0, 0.0, 0.004160280373831776],
            color: "#0c0d10",
            metalness: 0.0,
            roughness: 0.32,
            clearcoat: 0.8,
            clearcoat_roughness: 0.18,
            sum: Sum {
                vertices: 3252,
                indices: None,
                lo: [-0.1263750046491623, -0.12132000178098679, -0.013799999840557575],
                hi: [0.1263750046491623, 0.12132000178098679, 2.0414590851114411e-10],
                position: -37.53982495325923,
                u: 3.8145235627889633,
                v: 8548.165164165199,
                normal: -0.06816211342811584,
                index: None,
            },
        },
        Expect {
            name: "antenna pad",
            parent: ModuleParent::Body,
            position: [-0.1845075, 0.0, 0.004160280373831776],
            color: "#d8b25e",
            metalness: 1.0,
            roughness: 0.28,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.03750000149011612, -0.07999999821186066, -0.0020000000949949026],
                hi: [0.03750000149011612, 0.07999999821186066, 9.499490083442197e-11],
                position: 0.7334329307824223,
                u: 0.1406086217612028,
                v: 1223.6098429560661,
                normal: -0.13938122242689133,
                index: None,
            },
        },
        Expect {
            name: "antenna pad",
            parent: ModuleParent::Body,
            position: [0.1845075, 0.0, 0.004160280373831776],
            color: "#d8b25e",
            metalness: 1.0,
            roughness: 0.28,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.03750000149011612, -0.07999999821186066, -0.0020000000949949026],
                hi: [0.03750000149011612, 0.07999999821186066, 9.499490083442197e-11],
                position: 0.7334329307824223,
                u: 0.1406086217612028,
                v: 1223.6098429560661,
                normal: -0.13938122242689133,
                index: None,
            },
        },
        Expect {
            name: "antenna coil",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 7698,
                indices: Some(38460),
                lo: [-1.5274568796157837, -0.9002570509910583, -0.010817009024322033],
                hi: [1.5380433797836304, 0.91236412525177, -0.005028154235333204],
                position: 88.89452026495564,
                u: 15394.999208625872,
                v: 11545.00017209351,
                normal: 2581.3472535981855,
                index: Some(592045506),
            },
        },
        Expect {
            name: "antenna lead",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 498,
                indices: Some(2460),
                lo: [1.2758715152740479, -0.3189597427845001, -0.008228153921663761],
                hi: [1.5380433797836304, -0.1604744791984558, 0.0033679588232189417],
                position: 2284.4489358410356,
                u: 997.0609754323959,
                v: 745.0000111609697,
                normal: 339.26545431884006,
                index: Some(2444212),
            },
        },
        Expect {
            name: "antenna lead",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 450,
                indices: Some(2220),
                lo: [0.9062061309814453, -0.332541286945343, -0.010965928435325623],
                hi: [1.4390881061553955, -0.16092900931835175, 0.002160280477255583],
                position: 1572.6496668923646,
                u: 899.0540524497628,
                v: 675.0000100582838,
                normal: 127.77954995632152,
                index: Some(1993992),
            },
        },
    ],
);

/// Body group position and turn, then the meshes in traversal order.
const STANDARD_SLAB: ([f64; 3], f64, &[Expect]) = (
    [1.0952499999999998, -0.16351785714285702, 0.0],
    0.0,
    &[
        Expect {
            name: "chip module tape",
            parent: ModuleParent::Body,
            position: [0.0, 0.0, 0.011199999999999998],
            color: "#a07a2c",
            metalness: 0.25,
            roughness: 0.42,
            clearcoat: 0.5,
            clearcoat_roughness: 0.3,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.24264000356197357, -0.20797714591026306, -0.007000000216066837],
                hi: [0.24264000356197357, 0.20797714591026306, 2.1606683109354208e-10],
                position: 3.8087646943334335,
                u: 5.1874580681324005,
                v: 1221.4266785085201,
                normal: -0.1393401101231575,
                index: None,
            },
        },
        Expect {
            name: "chip mould cap",
            parent: ModuleParent::Body,
            position: [0.0, 0.0, 0.004199999999999998],
            color: "#0c0d10",
            metalness: 0.0,
            roughness: 0.32,
            clearcoat: 0.8,
            clearcoat_roughness: 0.18,
            sum: Sum {
                vertices: 3252,
                indices: None,
                lo: [-0.1263750046491623, -0.12132000178098679, -0.013799999840557575],
                hi: [0.1263750046491623, 0.12132000178098679, 2.0414590851114411e-10],
                position: -37.53982495325923,
                u: 3.8145235627889633,
                v: 8548.165164165199,
                normal: -0.06816211342811584,
                index: None,
            },
        },
        Expect {
            name: "antenna pad",
            parent: ModuleParent::Body,
            position: [-0.1845075, 0.0, 0.004199999999999998],
            color: "#d8b25e",
            metalness: 1.0,
            roughness: 0.28,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.03750000149011612, -0.07999999821186066, -0.0020000000949949026],
                hi: [0.03750000149011612, 0.07999999821186066, 9.499490083442197e-11],
                position: 0.7334329307824223,
                u: 0.1406086217612028,
                v: 1223.6098429560661,
                normal: -0.13938122242689133,
                index: None,
            },
        },
        Expect {
            name: "antenna pad",
            parent: ModuleParent::Body,
            position: [0.1845075, 0.0, 0.004199999999999998],
            color: "#d8b25e",
            metalness: 1.0,
            roughness: 0.28,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 804,
                indices: None,
                lo: [-0.03750000149011612, -0.07999999821186066, -0.0020000000949949026],
                hi: [0.03750000149011612, 0.07999999821186066, 9.499490083442197e-11],
                position: 0.7334329307824223,
                u: 0.1406086217612028,
                v: 1223.6098429560661,
                normal: -0.13938122242689133,
                index: None,
            },
        },
        Expect {
            name: "antenna coil",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 7698,
                indices: Some(38460),
                lo: [-1.592867374420166, -0.9878031611442566, -0.010838854126632214],
                hi: [1.6030433177947998, 0.9999241828918457, -0.005049999803304672],
                position: 94.31642297407961,
                u: 15394.999208625872,
                v: 11545.00017209351,
                normal: 2581.65863550629,
                index: Some(592045506),
            },
        },
        Expect {
            name: "antenna lead",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 498,
                indices: Some(2460),
                lo: [1.275832176208496, -0.3191934823989868, -0.008249999955296516],
                hi: [1.6030434370040894, -0.1604744791984558, 0.0034917728044092655],
                position: 2335.734486889036,
                u: 997.0609754323959,
                v: 745.0000111609697,
                normal: 350.9768000077456,
                index: Some(2444212),
            },
        },
        Expect {
            name: "antenna lead",
            parent: ModuleParent::Group,
            position: [0.0, 0.0, 0.0],
            color: "#c47a45",
            metalness: 1.0,
            roughness: 0.34,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            sum: Sum {
                vertices: 450,
                indices: Some(2220),
                lo: [0.906261682510376, -0.33423852920532227, -0.01096402108669281],
                hi: [1.5040826797485352, -0.16092900931835175, 0.002199999988079071],
                position: 1622.9185649659485,
                u: 899.0540524497628,
                v: 675.0000100582838,
                normal: 116.77063598670065,
                index: Some(1993992),
            },
        },
    ],
);

fn check_module(case: &str, m: &ChipModule, want: &([f64; 3], f64, &[Expect])) {
    assert_eq!(m.card_face, 0);
    for k in 0..3 {
        assert!((m.body_position[k] - want.0[k]).abs() < 1e-9, "{case}: body position {:?} vs {:?}", m.body_position, want.0);
    }
    assert!((m.body_rotation_z - want.1).abs() < 1e-12, "{case}: body turn");
    assert_eq!(m.meshes.len(), want.2.len(), "{case}: mesh count");
    for (mesh, e) in m.meshes.iter().zip(want.2) {
        let what = format!("{case}/{}", e.name);
        assert_eq!(mesh.name, e.name);
        assert_eq!(mesh.parent, e.parent, "{what}: parent");
        for k in 0..3 {
            assert!((mesh.position[k] - e.position[k]).abs() < 1e-9, "{what}: position {:?} vs {:?}", mesh.position, e.position);
        }
        assert_eq!(mesh.rotation_z, 0.0);
        let c = mesh.material.color;
        assert_eq!(format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]), e.color, "{what}: colour");
        let material_name = if e.name.starts_with("antenna coil") || e.name == "antenna lead" { "antenna wire" } else { e.name };
        assert_eq!(mesh.material.name, material_name);
        assert_eq!(
            (mesh.material.metalness, mesh.material.roughness, mesh.material.clearcoat, mesh.material.clearcoat_roughness),
            (e.metalness, e.roughness, e.clearcoat, e.clearcoat_roughness),
            "{what}: material"
        );
        check(&what, &m.geometries[mesh.geometry], &e.sum);
    }
    // The two pads share one geometry, as in three.
    let pads: Vec<usize> = m.meshes.iter().filter(|x| x.name == "antenna pad").map(|x| x.geometry).collect();
    assert_eq!(pads.len(), 2);
    assert_eq!(pads[0], pads[1]);
}

fn portrait_frame() -> CardFrame {
    // `isoFrame(true, cornerRadius, [])`.
    card3d_engine::iso::iso_frame(true, public_frame().corner_radius, &[])
}

#[test]
fn glass_body_matches_three() {
    check("glass body", glass_body_geometry(), &GLASS);
    // `glass-dims.ts`: 0.2 mm bevel, 0.76 mm slab, 85.60 mm over 3.37 units.
    assert!((GLASS_BEVEL - 0.2 * 3.37 / 85.6).abs() < 1e-12);
    assert!((GLASS_THICKNESS - 0.76 * 3.37 / 85.6).abs() < 1e-12);
    assert!((GLASS_BODY_DEPTH - (GLASS_THICKNESS - 2.0 * GLASS_BEVEL)).abs() < 1e-15);
    // The outline: 4 lines + 4 arcs of 32 steps = 4 * 33 + 4 (+ the joins) points, before merging.
    assert!(glass_shape().get_points(16).len() > 130);
}

#[test]
fn glass_body_is_a_centred_faceted_slab() {
    let g = glass_body_geometry();
    // Every triangle is flat-shaded: its three normals are equal.
    for t in g.normals.as_chunks::<3>().0 {
        assert_eq!(t[0], t[1]);
        assert_eq!(t[1], t[2]);
    }
    // Centred: z within +-thickness / 2, and the normals are unit.
    let zmax = g.positions.iter().map(|p| p[2]).fold(f32::MIN, f32::max) as f64;
    assert!((zmax - GLASS_THICKNESS / 2.0).abs() < 1e-6);
    for n in &g.normals {
        assert!(((n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) as f64 - 1.0).abs() < 1e-6);
    }
}

#[test]
fn chip_module_matches_three() {
    let opts = ChipModuleOptions { body_depth: GLASS_THICKNESS, slab: None };
    check_module("landscape", &build_chip_module(Some(&public_frame()), &opts), &LANDSCAPE);
    check_module("portrait", &build_chip_module(Some(&portrait_frame()), &opts), &PORTRAIT);
    check_module("standard", &build_chip_module(None, &opts), &STANDARD);
    let slab = ChipModuleOptions { body_depth: 0.03, slab: Some((3.5, 2.3)) };
    check_module("standard slab", &build_chip_module(None, &slab), &STANDARD_SLAB);
}

// ── three internals ─────────────────────────────────────────────────────────

fn v2(x: f64, y: f64) -> DVec2 {
    DVec2::new(x, y)
}

#[test]
fn triangulate_shape_matches_three() {
    // A concave L.
    let mut l = vec![v2(0.0, 0.0), v2(2.0, 0.0), v2(2.0, 1.0), v2(1.0, 1.0), v2(1.0, 2.0), v2(0.0, 2.0)];
    assert_eq!(extrude::triangulate_shape(&mut l, &mut []), [[4, 5, 0], [0, 1, 2], [3, 4, 0], [0, 2, 3]]);
    // A square with a square hole.
    let mut square = vec![v2(0.0, 0.0), v2(4.0, 0.0), v2(4.0, 4.0), v2(0.0, 4.0)];
    let mut holes = vec![vec![v2(1.0, 1.0), v2(1.0, 3.0), v2(3.0, 3.0), v2(3.0, 1.0)]];
    assert_eq!(extrude::triangulate_shape(&mut square, &mut holes), [[0, 4, 5], [7, 4, 0], [3, 0, 5], [7, 0, 1], [2, 3, 5], [6, 7, 1], [2, 5, 6], [6, 1, 2]]);
    // A closing duplicate point is dropped (from the caller's list too).
    let mut dup = vec![v2(0.0, 0.0), v2(1.0, 0.0), v2(1.0, 1.0), v2(0.0, 1.0), v2(0.0, 0.0)];
    assert_eq!(extrude::triangulate_shape(&mut dup, &mut []), [[2, 3, 0], [0, 1, 2]]);
    assert_eq!(dup.len(), 4);
    // More than 80 vertices: the z-order hashed ear test.
    let mut wavy: Vec<DVec2> = (0..100)
        .map(|i| {
            let a = (i as f64 / 100.0) * 2.0 * std::f64::consts::PI;
            let r = 1.0 + 0.3 * (5.0 * a).sin();
            v2(r * a.cos(), r * a.sin())
        })
        .collect();
    let got: Vec<usize> = extrude::triangulate_shape(&mut wavy, &mut []).into_iter().flatten().collect();
    assert_eq!(got, WAVY);
}

const WAVY: [usize; 294] = [
    98, 99, 0, 0, 1, 2, 2, 3, 4, 4, 5, 6, 6, 7, 8, 8, 9, 10, 10, 11, 12, 18, 19, 20, 20, 21, 22, 22, 23, 24, 24, 25, 26, 26, 27, 28, 28, 29, 30, 30, 31, 32,
    38, 39, 40, 40, 41, 42, 42, 43, 44, 44, 45, 46, 46, 47, 48, 48, 49, 50, 50, 51, 52, 58, 59, 60, 60, 61, 62, 62, 63, 64, 64, 65, 66, 66, 67, 68, 68, 69, 70,
    70, 71, 72, 78, 79, 80, 80, 81, 82, 82, 83, 84, 84, 85, 86, 86, 87, 88, 88, 89, 90, 90, 91, 92, 97, 98, 0, 0, 2, 4, 4, 6, 8, 8, 10, 12, 17, 18, 20, 20, 22,
    24, 24, 26, 28, 28, 30, 32, 37, 38, 40, 40, 42, 44, 44, 46, 48, 48, 50, 52, 57, 58, 60, 60, 62, 64, 64, 66, 68, 68, 70, 72, 77, 78, 80, 80, 82, 84, 84, 86,
    88, 88, 90, 92, 97, 0, 4, 4, 8, 12, 17, 20, 24, 24, 28, 32, 37, 40, 44, 44, 48, 52, 57, 60, 64, 64, 68, 72, 77, 80, 84, 84, 88, 92, 96, 97, 4, 4, 12, 13,
    16, 17, 24, 24, 32, 33, 36, 37, 44, 44, 52, 53, 56, 57, 64, 64, 72, 73, 76, 77, 84, 84, 92, 93, 96, 4, 13, 16, 24, 33, 36, 44, 53, 56, 64, 73, 76, 84, 93,
    95, 96, 13, 15, 16, 33, 35, 36, 53, 55, 56, 73, 75, 76, 93, 94, 95, 13, 14, 15, 33, 34, 35, 53, 54, 55, 73, 74, 75, 93, 94, 13, 14, 14, 33, 34, 34, 53, 54,
    54, 73, 74, 74, 93, 94, 94, 14, 34, 34, 54, 74, 74, 94, 34,
];

#[test]
fn shape_points_match_three() {
    let mut s = Shape::new();
    s.move_to(-1.0, -1.0).line_to(1.0, -1.0).absarc(1.0, -0.5, 0.5, -std::f64::consts::FRAC_PI_2, 0.0, false);
    s.line_to(1.5, 1.0).absarc(1.0, 1.0, 0.5, 0.0, std::f64::consts::FRAC_PI_2, false);
    let want: [(f64, f64); 19] = [
        (-1.0, -1.0),
        (1.0, -1.0),
        (1.0975451610080642, -0.9903926402016152),
        (1.1913417161825448, -0.9619397662556434),
        (1.277785116509801, -0.9157348061512727),
        (1.3535533905932737, -0.8535533905932737),
        (1.4157348061512727, -0.7777851165098011),
        (1.4619397662556435, -0.6913417161825449),
        (1.4903926402016152, -0.5975451610080641),
        (1.5, -0.5),
        (1.5, 1.0),
        (1.4903926402016152, 1.0975451610080642),
        (1.4619397662556435, 1.1913417161825448),
        (1.4157348061512727, 1.277785116509801),
        (1.3535533905932737, 1.3535533905932737),
        (1.277785116509801, 1.4157348061512727),
        (1.1913417161825448, 1.4619397662556435),
        (1.0975451610080642, 1.4903926402016152),
        (1.0, 1.5),
    ];
    let got = s.get_points(4);
    assert_eq!(got.len(), want.len());
    for (g, w) in got.iter().zip(want) {
        assert!((g.x - w.0).abs() < 1e-12 && (g.y - w.1).abs() < 1e-12, "{g:?} vs {w:?}");
    }
}

fn helix() -> CatmullRomCurve3 {
    let p = |x, y, z| DVec3::new(x, y, z);
    CatmullRomCurve3::new(vec![p(0.0, 0.0, 0.0), p(1.0, 0.2, 0.1), p(1.5, 1.0, 0.5), p(0.5, 1.6, 1.0), p(-0.5, 1.2, 0.3)], false)
}

fn near(got: DVec3, want: [f64; 3]) {
    assert!((got - DVec3::from(want)).abs().max_element() < 1e-9, "{got:?} vs {want:?}");
}

#[test]
fn curve_and_frames_match_three() {
    let c = helix();
    // `getPointAt` (arc-length mapped, 200 divisions) and `getTangentAt`.
    near(c.get_point_at(0.0), [0.0, 0.0, 0.0]);
    near(c.get_point_at(0.13), [0.609314698475863, 0.07272596821347287, 0.03636298410673643]);
    near(c.get_point_at(0.5), [1.374894661912691, 1.1856304774367359, 0.6409411117161119]);
    near(c.get_point_at(0.77), [0.2931937323109025, 1.5828743212450205, 0.933951806602423]);
    near(c.get_point_at(1.0), [-0.5, 1.2, 0.3]);
    near(c.get_tangent_at(0.0), [0.9759325769385978, 0.19504995312993578, 0.09752497656496789]);
    near(c.get_tangent_at(0.4), [0.26142310197694674, 0.8548760714209512, 0.4481571870054425]);
    near(c.get_tangent_at(1.0), [-0.7783809026669215, -0.31150941314332675, -0.5450550943588445]);
    // Frenet frames of 8 segments.
    let (_, n, b) = c.compute_frenet_frames(8, false);
    near(n[0], [0.09563368001693555, 0.019113353981337747, -0.9952330776988888]);
    near(b[0], [-0.1959841945576379, 0.9806070545756816, 0.0]);
    near(n[4], [0.30912663020938014, 0.7854791181829899, -0.5361560233680727]);
    near(b[4], [-0.7195726449071795, -0.1754338242429594, -0.6718914957139851]);
    near(n[8], [0.0012007638917882896, 0.8674689478687444, -0.4974898819569795]);
    near(b[8], [0.6277911504071276, -0.3878911058616753, -0.6748472134223433]);
}

#[test]
fn tube_matches_three() {
    let m = extrude::tube_geometry(&helix(), 10, 0.05, 5, false);
    assert_eq!((m.positions.len(), m.indices.len()), (66, 300));
    let p0 = m.positions[0];
    let pl = m.positions[65];
    for (g, w) in p0.iter().zip([-0.004781683906912804, -0.0009556676959618926, 0.04976165294647217]) {
        assert!((*g as f64 - w).abs() < 1e-6, "{p0:?}");
    }
    for (g, w) in pl.iter().zip([-0.4999822676181793, 1.1565786600112915, 0.3247908353805542]) {
        assert!((*g as f64 - w).abs() < 1e-6, "{pl:?}");
    }
}
