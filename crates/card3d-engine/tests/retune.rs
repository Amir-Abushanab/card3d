//! Which design changes a built card takes in place (`BuildKey`, `CardRenderer::retune`): only its
//! foils' uniform values. Anything else, or other card options or host assets, needs a build. (The
//! retuned card drawing as a fresh build does: crates/card3d-tools/tests/retune.rs, on a GPU.)

use card3d_engine::card::BuildKey;
use card3d_engine::json::{self, Value};
use card3d_engine::quality::Quality;
use card3d_engine::CardOptions;

const BASE: &str = r##"{
  "recipe": { "material": "silver", "color": "#d9d6cc", "grain": 30, "polish": 58, "frontHolo": true, "backHolo": false,
    "matchHoloSides": true, "holoStyle": "vmax", "foilTexture": "etched", "foilIntensity": 78, "holoGlare": 68,
    "holoMotion": true, "foilScale": 100, "foilCoverage": "cover" },
  "cardholderName": "Ada Lovelace",
  "decals": []
}"##;

/// `BASE` with recipe key `key` set to `value` (JSON).
fn with_recipe(key: &str, value: &str) -> Value {
    let mut v = json::parse(BASE).unwrap();
    let Value::Object(top) = &mut v else { unreachable!() };
    let Some((_, Value::Object(recipe))) = top.0.iter_mut().find(|(k, _)| k == "recipe") else { unreachable!() };
    recipe.0.retain(|(k, _)| k != key);
    recipe.0.push((key.to_string(), json::parse(value).unwrap()));
    v
}

fn key(design: Value) -> BuildKey {
    BuildKey::new(design, &CardOptions::default(), vec!["artwork.png".into()]).unwrap()
}

#[test]
fn foil_values_keep_the_key() {
    let base = key(json::parse(BASE).unwrap());
    for (k, v) in [
        ("foilIntensity", "40"),
        ("holoGlare", "10"),
        ("holoMotion", "false"),
        ("foilScale", "180"),
        ("foilCoverage", "\"tile\""),
        ("holoStyle", "\"cosmos\""),
        ("foilTexture", "\"sparkle\""),
        ("backFoilIntensity", "20"),
        ("backHoloStyle", "\"gold\""),
        ("backFoilCoverage", "\"tile\""),
    ] {
        assert!(key(with_recipe(k, v)) == base, "{k}");
    }
}

#[test]
fn anything_else_changes_the_key() {
    let base = key(json::parse(BASE).unwrap());
    // Which sides have a foil, the body's recipe, the rest of the design.
    for (k, v) in [("frontHolo", "false"), ("backHolo", "true"), ("matchHoloSides", "false"), ("grain", "31"), ("polish", "60"), ("color", "\"#000000\"")] {
        assert!(key(with_recipe(k, v)) != base, "{k}");
    }
    let other = BASE.replace("Ada Lovelace", "Grace Hopper");
    assert!(key(json::parse(&other).unwrap()) != base);
    let other = BASE.replace(r#""decals": []"#, r#""decals": [], "lighting": "noir""#);
    assert!(key(json::parse(&other).unwrap()) != base);
    // The card's options, and the host's assets.
    let doc = || json::parse(BASE).unwrap();
    let options = |o: CardOptions| BuildKey::new(doc(), &o, vec!["artwork.png".into()]).unwrap();
    assert!(options(CardOptions { quality: Quality::Performance, ..Default::default() }) != base);
    assert!(options(CardOptions { custom_font_family: Some("Inter".into()), ..Default::default() }) != base);
    assert!(options(CardOptions { reduced_motion: true, ..Default::default() }) != base);
    assert!(BuildKey::new(doc(), &CardOptions::default(), vec![]).unwrap() != base);
}
