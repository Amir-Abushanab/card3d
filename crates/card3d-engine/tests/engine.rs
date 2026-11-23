//! CPU-side checks of the engine against the TypeScript engine's values (no GPU needed).

use card3d_engine::design::CardDesign;
use card3d_engine::geometry::{self, BODY_DEPTH, CARD_W};
use card3d_engine::material::{self, surface_maps};

/// What `generateSurfaceData` (materials/surface-data.ts) gives: a few texels and a checksum of the
/// whole normal + roughness buffers, `hash = hash * 31 + normal[i] + 7 * roughness[i]` (u32).
fn checksum(m: &material::SurfaceMaps) -> u32 {
    m.normal.iter().zip(&m.roughness).fold(0u32, |h, (n, r)| h.wrapping_mul(31).wrapping_add(*n as u32 + 7 * *r as u32))
}
fn texel(m: &material::SurfaceMaps, x: usize, y: usize) -> [u8; 3] {
    let o = 4 * (y * m.size as usize + x);
    [m.normal[o], m.normal[o + 1], m.roughness[o]]
}

#[test]
fn surface_maps_match_the_typescript_generator() {
    let b = surface_maps(512, 30.0, 72.0, "brushed", false);
    assert_eq!([texel(&b, 0, 0), texel(&b, 17, 3), texel(&b, 511, 511)], [[127, 127, 216], [128, 129, 219], [128, 127, 215]]);
    assert_eq!(checksum(&b), 2806128125);
    assert_eq!(b.repeat, [1.5, 7.0]);
    assert!((b.normal_scale[0] - 0.0265).abs() < 1e-6 && (b.normal_scale[1] - 0.1474).abs() < 1e-6);

    let o = surface_maps(256, 70.0, 90.0, "brushed", true);
    assert_eq!([texel(&o, 0, 0), texel(&o, 17, 3), texel(&o, 255, 255)], [[127, 123, 212], [128, 134, 224], [128, 129, 219]]);
    assert_eq!(checksum(&o), 2399807354);

    let f = surface_maps(64, 0.0, 0.0, "none", false);
    assert_eq!(texel(&f, 17, 3), [128, 128, 250]);
    assert_eq!(checksum(&f), 4037562368);
    assert_eq!(f.normal_scale, [0.0, 0.0]);
}

#[test]
fn material_resolver_matches_resolve_material() {
    // materials/scalar.test.ts worked table: silver at polish 58 and 100.
    let mut d = CardDesign::default();
    d.recipe.polish = 58.0;
    let r = material::resolve(&d.recipe, None);
    assert!((r.roughness - 0.4182).abs() < 5e-5 && (r.clearcoat - 0.0469).abs() < 5e-5 && (r.clearcoat_roughness - 0.3228).abs() < 5e-5);
    d.recipe.polish = 100.0;
    let r = material::resolve(&d.recipe, None);
    assert!((r.roughness - 0.08).abs() < 1e-9 && (r.clearcoat - 0.07).abs() < 1e-9);
    // Override keys win.
    let o = card3d_engine::design::MaterialOverride { roughness: Some(0.034), clearcoat: Some(0.34), ..Default::default() };
    let r = material::resolve(&d.recipe, Some(&o));
    assert_eq!((r.roughness, r.clearcoat), (0.034, 0.34));
}

#[test]
fn reads_a_design_and_names_what_is_not_drawn_yet() {
    let d = CardDesign::from_json(
        r##"{"recipe":{"material":"brass","texture":"guilloche","color":"#e8c27a","frontHolo":true},"cardholderName":"Ada",
            "decals":[{"id":"a"}],"frontEffect":null,"bespoke":null,"shaders":[],"someFutureField":1}"##,
    )
    .unwrap();
    assert_eq!(d.recipe.material, "brass");
    assert_eq!(d.recipe.polish, 58.0); // default
    assert!(d.unsupported().is_empty(), "{:?}", d.unsupported());
    assert!(CardDesign::from_json(r#"{"cardholderName":"Ada"}"#).unwrap().unsupported().is_empty());
    // Fields of removed features are ignored like any unknown field: the standard card.
    let legacy = CardDesign::from_json(
        r#"{"cardholderName":"Ada","frontEffect":"moss","objectStyle":"instant-camera","bespoke":"pool","bespokeParams":{"x":1},"effectParams":{"loops":3}}"#,
    )
    .unwrap();
    assert!(legacy.unsupported().is_empty());
    assert!(CardDesign::from_json("{").is_err());
}

#[test]
fn iso_body_geometry() {
    let body = geometry::card_body();
    let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
    for p in &body.positions {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    assert!((hi[0] - lo[0] - CARD_W as f32).abs() < 1e-5);
    assert!((hi[1] - lo[1] - (53.98 / 85.6 * CARD_W) as f32).abs() < 1e-5); // ISO height
    assert!((hi[2] - lo[2] - BODY_DEPTH as f32).abs() < 1e-6);
    assert!(body.normals.iter().all(|n| ((n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt() - 1.0).abs() < 1e-4));
    assert_eq!(body.indices.len() % 3, 0);
    let face = geometry::face_plane();
    assert!(face.uvs.iter().all(|uv| (0.0..=1.0).contains(&uv[0]) && (0.0..=1.0).contains(&uv[1])));
}

#[test]
fn patterned_surface_maps_match_the_typescript_generator() {
    // generateSurfaceData(128, 55, 40, pattern, texture) checksums from materials/surface-data.ts.
    let expected = [
        ("guilloche", false, 3187732258u32),
        ("guilloche", true, 2556040838),
        ("crosshatch", false, 700110072),
        ("hammered", false, 1179771110),
        ("sandblasted", false, 2718223081),
        ("pinpoint", false, 2995961396),
        ("linen", false, 3888234124),
        ("carbon-fiber", false, 3357592887),
    ];
    for (texture, orbit, sum) in expected {
        assert_eq!(checksum(&surface_maps(128, 55.0, 40.0, texture, orbit)), sum, "{texture} orbit={orbit}");
    }
}
