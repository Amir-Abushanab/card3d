//! Custom face shaders in WGSL: the annotation parser and the loop guard (the cases of
//! packages/core/src/shaders/shaders.test.ts, rewritten for WGSL declarations).

use card3d_engine::face_custom::{animated, guard_loops, parse, replaces_artwork, CustomDefault};
use card3d_engine::face_shaders::ParamType;

const CODE: &str = r#"// a starter
var<private> uSpeed: f32; // @param 0 5 1 label="Speed"
var<private> uCount: i32;   // @param 1 12 6
var<private> uGlow: bool;   // @param default=true
var<private> uCenter: vec2f; // @param 0 1 default=0.25,0.75
var<private> uTint: vec3f;  // @color #ff8800 label="Tint"
var<private> uMode: f32;  // @param options="Soft:0,Hard:1" default=1
var<private> uPlain: f32;
// var<private> uCommented: f32; // @param 0 1 0.5
var<private> uPrec: vec2<f32>; // @param -1 1 0 step=0.25
fn mainImage(uv: vec2f) -> vec4f { return vec4f(uTint, 1.0); }"#;

#[test]
fn parses_every_annotated_type() {
    let r = parse(CODE);
    assert_eq!(r.errors, vec![]);
    let names: Vec<&str> = r.params.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["uSpeed", "uCount", "uGlow", "uCenter", "uTint", "uMode", "uPrec"]);
    let by = |n: &str| r.params.iter().find(|p| p.name == n).unwrap().clone();
    assert_eq!((by("uSpeed").ty, by("uSpeed").default), (ParamType::Float, CustomDefault::Num(1.0)));
    assert_eq!((by("uCount").ty, by("uCount").default), (ParamType::Int, CustomDefault::Num(6.0)));
    assert_eq!((by("uGlow").ty, by("uGlow").default), (ParamType::Bool, CustomDefault::Bool(true)));
    assert_eq!((by("uCenter").ty, by("uCenter").default), (ParamType::Vec2, CustomDefault::Vec(vec![0.25, 0.75])));
    assert_eq!(by("uTint").ty, ParamType::Color);
    assert_eq!(by("uTint").default, CustomDefault::Vec(vec![1.0, 136.0 / 255.0, 0.0]));
    assert_eq!((by("uMode").default, by("uMode").options), (CustomDefault::Num(1.0), vec![0.0, 1.0]));
    // A vec2 with a scalar default fills both components.
    assert_eq!(by("uPrec").default, CustomDefault::Vec(vec![0.0, 0.0]));
}

#[test]
fn reports_annotation_errors_with_user_line_numbers() {
    let bad = [
        "var<private> uTint: vec2f; // @color #ff0000",
        "var<private> uTime: f32;",
        "var<private> uX: f32; // @param a 1",
        "var<private> uY: f32; // @param 2 1",
        "var<private> uM: mat3x3f; // @param",
        "var<private> uB: bool; // @param default=maybe",
        "fn mainImage(uv: vec2f) -> vec4f { return vec4f(1.0); }",
    ]
    .join("\n");
    let r = parse(&bad);
    let at = |line: u32| r.errors.iter().filter(|e| e.line == line).map(|e| e.message.clone()).collect::<Vec<_>>().join(" | ");
    assert!(at(1).contains("@color needs a vec3f"), "{}", at(1));
    assert!(at(2).contains("provided by the face shader prelude"), "{}", at(2));
    assert!(at(3).contains("min \"a\" is not a number"), "{}", at(3));
    assert!(at(4).contains("greater than max"), "{}", at(4));
    assert!(at(5).contains("@param supports"), "{}", at(5));
    assert!(at(6).contains("bool default"), "{}", at(6));
}

#[test]
fn requires_main_image_and_forbids_entry_points() {
    assert_eq!(parse("fn foo(uv: vec2f) -> vec4f { return vec4f(1.0); }").errors[0].line, 0);
    let r = parse("fn mainImage(p: vec2<f32>) -> vec4<f32> { return vec4f(1.0); }\n@fragment fn main() {}\n");
    assert_eq!(r.errors.len(), 1);
    assert_eq!(r.errors[0].line, 2);
    assert!(r.errors[0].message.contains("entry points"));
}

#[test]
fn derives_animation_and_artwork_from_the_code() {
    assert!(animated("fn mainImage(uv: vec2f) -> vec4f { return vec4f(sin(uTime)); }"));
    assert!(animated("fn mainImage(uv: vec2f) -> vec4f { return vec4f(uTilt); }"));
    assert!(!animated("fn mainImage(uv: vec2f) -> vec4f { return vec4f(1.0); } // uTime in a comment"));
    assert!(!animated("fn mainImage(uv: vec2f) -> vec4f { let uTimex = 1.0; return vec4f(uTimex); }"));
    assert!(replaces_artwork("// @replaces-artwork\nfn mainImage(uv: vec2f) -> vec4f { return artwork(uv); }"));
    assert!(!replaces_artwork("fn mainImage(uv: vec2f) -> vec4f { return artwork(uv); }"));
}

#[test]
fn guards_loops_without_changing_line_numbers() {
    let src = [
        "fn mainImage(uv: vec2f) -> vec4f {",
        "  var s = 0.0;",
        "  for (var i = 0; i < 10; i++) { s += f(i, (1.0)); }",
        "  for (;;) { s += 1.0; }",
        "  while (s < 3.0\n    && s > -1.0) { s += 1.0; }",
        "  while s > 0.0 { s -= 1.0; }",
        "  loop { s -= 1.0; if (s < 0.0) { break; } }",
        "  // while (true) stays a comment",
        "  return vec4f(s);",
        "}",
    ]
    .join("\n");
    let out = guard_loops(&src);
    assert_eq!(out.split('\n').count(), src.split('\n').count());
    assert!(out.contains("for (var i = 0;( i < 10) && card3dGuard(); i++)"), "{out}");
    assert!(out.contains("for (; card3dGuard() ;)"), "{out}");
    assert!(out.contains("while ( (s < 3.0\n    && s > -1.0) ) && card3dGuard() {"), "{out}");
    assert!(out.contains("while ( s > 0.0 ) && card3dGuard() {"), "{out}");
    assert!(out.contains("loop { if (!card3dGuard()) { break; }  s -= 1.0;"), "{out}");
    assert!(out.contains("// while (true) stays a comment"), "{out}");
}

#[test]
fn leaves_code_without_loops_untouched() {
    let src = "fn mainImage(uv: vec2f) -> vec4f { return vec4f(uv, 0.0, 1.0); }";
    assert_eq!(guard_loops(src), src);
}

#[test]
fn compile_errors_map_to_the_line_the_code_starts_on() {
    use card3d_engine::face_custom::to_param;
    use card3d_engine::face_shaders::{code_start_line, module_source};
    for code in [CODE, "fn mainImage(uv: vec2f) -> vec4f { return vec4f(1.0); }"] {
        let params: Vec<_> = parse(code).params.iter().map(to_param).collect();
        for declare in [false, true] {
            let module = module_source(&params, &format!("// first line of the code\n{code}"), declare);
            let at = module.split('\n').position(|l| l == "// first line of the code").unwrap() as u32 + 1;
            assert_eq!(code_start_line(&params, declare), at, "declare {declare}");
        }
    }
}
