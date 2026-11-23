//! The scene staging's CPU side pinned to the TypeScript (scene/staging.ts, scene/marketing/: the
//! resolved scene and its framing, the colour shades, half floats, the gain-map and Radiance decoders,
//! the environment statistics, the sweep's geometry, the staged, mirrored and shadow cameras). Values
//! from a node script over packages/core/src.

use card3d_engine::json::parse;
use card3d_engine::renderer::Camera;
use card3d_engine::scene::*;
use glam::DVec3;

fn close(a: f64, b: f64, tol: f64, what: &str) {
    assert!((a - b).abs() <= tol, "{what}: {a} vs {b}");
}

#[test]
fn half_floats() {
    let vals = [0.0, 1.0, -1.0, 0.5, 1e-5, 3e-8, 65504.0, 70000.0, 0.1, 123.456, 2.5e-7, 6.1e-5];
    let want: [u16; 12] = [0, 15360, 48128, 14336, 167, 0, 31743, 31743, 11878, 22455, 4, 1023];
    for (v, w) in vals.iter().zip(want) {
        assert_eq!(to_half(*v), w, "toHalfFloat({v})");
    }
    let halfs: [u16; 8] = [0, 1, 0x3c00, 0x0001, 0x03ff, 0x7bff, 0x8400, 0x3555];
    let want = [0.0, 5.960464477539063e-08, 1.0, 5.960464477539063e-08, 6.097555160522461e-05, 65504.0, -6.103515625e-05, 0.333251953125];
    for (h, w) in halfs.iter().zip(want) {
        assert_eq!(from_half(*h) as f64, w, "fromHalfFloat({h})");
    }
}

#[test]
fn shades() {
    assert_eq!((shade_color("#2a6f5a", 0.12), shade_color("#2a6f5a", -0.72)), ("#40a082".to_string(), "#133c2f".to_string()));
    assert_eq!((shade_color("#d8d2c4", 0.12), shade_color("#d8d2c4", -0.72)), ("#ddd8cc".to_string(), "#7d776a".to_string()));
    assert_eq!((shade_color("#000000", 0.12), shade_color("#000000", -0.72)), ("#616161".to_string(), "#000000".to_string()));
    assert_eq!((shade_color("#ffffff", 0.12), shade_color("#ffffff", -0.72)), ("#ffffff".to_string(), "#909090".to_string()));
    assert_eq!((shade_color("#ff8800", 0.12), shade_color("#ff8800", -0.72)), ("#ff9d61".to_string(), "#904a00".to_string()));
}

fn scene(json: &str) -> Option<ResolvedScene> {
    let v = parse(json).unwrap();
    resolve_scene(v.as_object().unwrap())
}

#[test]
fn resolved_scenes_and_views() {
    assert_eq!(scene("{}"), None);
    assert_eq!(scene(r#"{"environment":"studio"}"#), None);
    let g = scene(r#"{"backdrop":"gradient"}"#).unwrap();
    assert_eq!((g.environment.as_str(), g.backdrop, g.backdrop_blur, g.floor), ("studio", Backdrop::Gradient, 0.45, None));
    let l = scene(r#"{"environment":"loft","environmentIntensity":1.5,"environmentRotation":90,"backdrop":"environment","backdropBlur":0}"#).unwrap();
    assert_eq!(
        (l.environment.as_str(), l.environment_intensity, l.environment_rotation, l.backdrop, l.backdrop_blur),
        ("loft", 1.5, 90.0, Backdrop::Environment, 0.0)
    );
    let f = scene(r#"{"floor":{"shadow":0.3}}"#).unwrap();
    assert_eq!(f.floor, Some(Floor { reflectivity: 0.45, shadow: 0.3, blur: 0.35 }));

    let floor = staging_view(&scene(r#"{"floor":{}}"#).unwrap(), card3d_engine::layout::CARD_H).unwrap();
    close(floor.elevation, 0.15707963267948966, 1e-15, "elevation");
    close(floor.target_y, -0.34, 1e-15, "target");
    close(floor.distance, 1.12, 0.0, "distance");
    close(floor.floor_y.unwrap(), -1.1225, 1e-15, "floor");
    let sweep = staging_view(&scene(r#"{"backdrop":"sweep"}"#).unwrap(), card3d_engine::layout::CARD_H).unwrap();
    assert_eq!((sweep.target_y, sweep.distance), (0.0, 1.0));
    close(sweep.floor_y.unwrap(), -1.1225, 1e-15, "sweep floor");
    assert_eq!(staging_view(&scene(r#"{"backdrop":"gradient"}"#).unwrap(), card3d_engine::layout::CARD_H), None);
    let tall = staging_view(&scene(r#"{"floor":{}}"#).unwrap(), card3d_engine::layout::CARD_W).unwrap();
    close(tall.target_y, -0.5392, 1e-15, "portrait target");
    close(tall.floor_y.unwrap(), -1.745, 1e-15, "portrait floor");
}

/// The synthetic gain-mapped image of the node script: LCG bytes, a bright spot in the gain plane.
fn synthetic() -> Vec<u8> {
    let (w, h) = (64usize, 32usize);
    let mut rgba = vec![0u8; w * h * 2 * 4];
    let mut seed: u64 = 7;
    for b in rgba.iter_mut() {
        seed = (seed * 16807) % 2147483647;
        *b = (seed % 256) as u8;
    }
    for y in 0..h {
        for x in 0..w {
            let g = ((h + y) * w + x) * 4;
            let d = ((x as f64 - 40.0).powi(2) + (y as f64 - 10.0).powi(2)).sqrt();
            rgba[g] = if d < 4.0 { 240 } else { rgba[g] % 60 };
        }
    }
    rgba
}

#[test]
fn gain_map_and_stats() {
    let px = decode_gain_map(&synthetic(), 64, 64);
    assert_eq!((px.width, px.height), (64, 32));
    assert_eq!(px.data[..16], [14159, 14333, 15830, 15360, 14159, 13551, 15669, 15360, 15433, 9731, 10388, 15360, 15482, 10660, 15630, 15360]);
    let sum = px.data.iter().fold(0u64, |s, &v| (s * 31 + v as u64) % 1000000007);
    assert_eq!(sum, 571402974);
    let s = environment_stats(&px);
    assert_eq!((s.room, s.lights), (2.04296875, 13.29296875));
    let key = [0.6068013535909373, 0.43220566184125453, 0.6670759950354752];
    for k in 0..3 {
        close(s.key[k], key[k], 1e-12, "key");
    }
}

#[test]
fn radiance() {
    let files: [Vec<u8>; 2] = [
        vec![
            35, 63, 82, 65, 68, 73, 65, 78, 67, 69, 10, 35, 32, 116, 101, 115, 116, 10, 70, 79, 82, 77, 65, 84, 61, 51, 50, 45, 98, 105, 116, 95, 114, 108,
            101, 95, 114, 103, 98, 101, 10, 10, 45, 89, 32, 50, 32, 43, 88, 32, 50, 10, 128, 64, 32, 129, 255, 0, 10, 120, 1, 2, 3, 140, 200, 200, 200, 128,
        ],
        vec![
            35, 63, 82, 65, 68, 73, 65, 78, 67, 69, 10, 35, 32, 116, 101, 115, 116, 10, 70, 79, 82, 77, 65, 84, 61, 51, 50, 45, 98, 105, 116, 95, 114, 108,
            101, 95, 114, 103, 98, 101, 10, 10, 45, 89, 32, 50, 32, 43, 88, 32, 56, 10, 2, 2, 0, 8, 136, 100, 130, 10, 6, 1, 2, 3, 4, 5, 6, 136, 7, 136, 130,
            2, 2, 0, 8, 136, 50, 130, 10, 6, 1, 2, 3, 4, 5, 6, 136, 7, 136, 130,
        ],
    ];
    let want: [(u32, u32, Vec<u16>); 2] = [
        (2, 2, vec![15364, 14340, 13316, 15360, 7168, 0, 2309, 15360, 19460, 20484, 20998, 15360, 14918, 14918, 14918, 15360]),
        (
            8,
            2,
            vec![
                15942, 12549, 12039, 15360, 15942, 12549, 12039, 15360, 15942, 9220, 12039, 15360, 15942, 10244, 12039, 15360, 15942, 10758, 12039, 15360,
                15942, 11268, 12039, 15360, 15942, 11525, 12039, 15360, 15942, 11782, 12039, 15360, 14918, 12549, 12039, 15360, 14918, 12549, 12039, 15360,
                14918, 9220, 12039, 15360, 14918, 10244, 12039, 15360, 14918, 10758, 12039, 15360, 14918, 11268, 12039, 15360, 14918, 11525, 12039, 15360,
                14918, 11782, 12039, 15360,
            ],
        ),
    ];
    for (file, (w, h, data)) in files.iter().zip(want) {
        let px = decode_rgbe(file).expect("parses");
        assert_eq!((px.width, px.height), (w, h));
        assert_eq!(px.data, data);
    }
    assert!(decode_rgbe(
        b"not a radiance file
"
    )
    .is_none());
}

#[test]
fn sweep() {
    let m = sweep_geometry(-1.1225 - 0.004);
    assert_eq!((m.positions.len(), m.indices.len()), (102, 300));
    assert_eq!(m.positions[0], [-4e+01_f32, -1.1265_f32, 16.0_f32]);
    assert_eq!(m.positions[1], [4e+01_f32, -1.1265_f32, 16.0_f32]);
    assert_eq!(m.positions[17], [4e+01_f32, -1.1265_f32, 8.0_f32]);
    assert_eq!(m.positions[40], [-4e+01_f32, -1.1042566_f32, -1.9393681_f32]);
    assert_eq!(m.positions[101], [4e+01_f32, 16.4735_f32, -4.2_f32]);
}

fn same(m: glam::DMat4, want: [f64; 16], tol: f64, what: &str) {
    for (k, (a, b)) in m.to_cols_array().iter().zip(want).enumerate() {
        close(*a, b, tol, &format!("{what}[{k}]"));
    }
}

#[test]
fn cameras() {
    let cam = Camera::look_at(DVec3::new(1.2, 0.9, 5.4), DVec3::new(0.0, -0.34, 0.0), 0.0);
    same(
        cam.view,
        [
            0.976187060183953,
            -0.04744992141097844,
            0.21167741610172716,
            0.0,
            -6.93889390390723e-18,
            0.9757846741773795,
            0.2187333299717847,
            0.0,
            -0.21693045781865616,
            -0.213524646349403,
            0.9525483724577724,
            0.0,
            -2.567390744445675e-16,
            0.33176678922030894,
            -5.59463410756865,
            1.0,
        ],
        1e-14,
        "view",
    );
    same(
        mirror_camera(&cam, -1.1225).view,
        [
            -0.976187060183953,
            -0.04744992141097846,
            0.21167741610172716,
            0.0,
            -1.387778780781446e-17,
            -0.9757846741773794,
            -0.21873332997178482,
            0.0,
            0.2169304578186562,
            -0.2135246463494031,
            0.9525483724577721,
            0.0,
            1.8735013540549522e-16,
            -1.8588698043079073,
            -6.085690433355306,
            1.0,
        ],
        1e-14,
        "mirror",
    );
    // three's orthographic projection maps depth to −1..1; the engine's to 0..1: compare x and y.
    let vp = shadow_view_proj(-1.1225).to_cols_array();
    let want = [
        0.2857142857142857,
        0.0,
        0.0,
        0.0,
        0.0,
        6.344131569286608e-17,
        1.4285714285714286,
        0.0,
        0.0,
        0.2857142857142857,
        -3.1720657846433045e-16,
        0.0,
        0.0,
        7.121287686524219e-17,
        0.6035714285714286,
        1.0,
    ];
    for c in 0..4 {
        for r in [0, 1, 3] {
            close(vp[c * 4 + r], want[c * 4 + r], 1e-14, "shadow");
        }
    }
}

#[test]
fn gradient_noise_rounds_like_uint8_clamped() {
    // Park–Miller from seed 1: the first values ±0.8 · …, onto mid grey and the ends.
    let mut px = vec![128u8, 128, 128, 255, 0, 0, 0, 255, 255, 255, 255, 255];
    gradient_noise(&mut px);
    assert_eq!(px, vec![127, 127, 127, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
}
