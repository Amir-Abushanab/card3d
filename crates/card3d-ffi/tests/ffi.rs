//! The C ABI (`include/card3d.h`) as an app calls it: validation, an offscreen stage, exports.
#![allow(
    unsafe_code,
    clippy::undocumented_unsafe_blocks,
    clippy::multiple_unsafe_ops_per_block,
    reason = "an app's calls into the C ABI, with pointers it owns, as the header's contract asks"
)]

use card3d::*;
use std::ffi::{c_char, CStr, CString};
use std::ptr::{null, null_mut};

const DESIGNS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../card3d-tools/designs");

fn take(s: *mut c_char) -> String {
    assert!(!s.is_null());
    let out = unsafe { CStr::from_ptr(s) }.to_str().unwrap().to_string();
    unsafe { card3d_string_free(s) };
    out
}

fn design(name: &str) -> CString {
    CString::new(std::fs::read_to_string(format!("{DESIGNS}/{name}.json")).unwrap()).unwrap()
}

#[test]
fn validates_and_lists_remote_urls() {
    let json = CString::new(r#"{"recipe":{"texture":"brushed"},"cardholderName":"A","decals":[{"src":"https://example.com/s.png","x":0.5,"y":0.5}]}"#).unwrap();
    let (mut report, mut error) = (null_mut(), null_mut());
    assert_eq!(unsafe { card3d_validate(json.as_ptr(), &mut report, &mut error) }, Card3dStatus::Ok);
    assert!(error.is_null());
    let text = take(report);
    assert!(text.starts_with("{\"design\":{"), "{text}");
    assert!(text.contains("\"remote\":[\"https://example.com/s.png\"]"), "{text}");

    let bad = CString::new("[1, 2]").unwrap();
    assert_eq!(unsafe { card3d_validate(bad.as_ptr(), &mut report, &mut error) }, Card3dStatus::Design);
    assert!(report.is_null());
    assert!(!take(error).is_empty());
}

#[test]
fn assets_json() {
    let a = host::Assets::parse(r#"{"files":{"https://x/a.png":"/tmp/a.png"},"base":"/d","nameFontFamily":"F","unknown":{"k":"v"}}"#).unwrap();
    assert_eq!(a.files, vec![("https://x/a.png".to_string(), "/tmp/a.png".to_string())]);
    assert_eq!(a.base.as_deref(), Some(std::path::Path::new("/d")));
    assert_eq!(a.name_font.as_deref(), Some("F"));
    assert_eq!(host::Assets::parse("").unwrap(), host::Assets::default());
    assert!(host::Assets::parse("[]").is_err());
}

fn options() -> Card3dStageOptions {
    Card3dStageOptions {
        quality: 1,
        fit: 0,
        interactive: true,
        intro: false,
        reduced_motion: false,
        fit_to_viewport: false,
        rotation_x: 0.0,
        rotation_y: 0.0,
        environments_dir: null(),
    }
}

/// An offscreen stage, or `None` on a machine without a GPU adapter. CI installs a software Vulkan
/// driver (lavapipe) and sets `CARD3D_REQUIRE_GPU=1`, so there a missing adapter fails instead.
#[allow(clippy::print_stderr, reason = "says why the GPU tests were skipped")]
fn offscreen(w: u32, h: u32) -> Option<*mut Card3dStage> {
    let surface = Card3dSurface { kind: Card3dSurfaceKind::Offscreen as u32, handle: null_mut(), width: w, height: h };
    let (mut stage, mut error) = (null_mut(), null_mut());
    match unsafe { card3d_stage_new(&options(), &surface, &mut stage, &mut error) } {
        Card3dStatus::Ok => Some(stage),
        Card3dStatus::Gpu if std::env::var_os("CARD3D_REQUIRE_GPU").is_some() => panic!("no GPU (CARD3D_REQUIRE_GPU): {}", take(error)),
        Card3dStatus::Gpu => {
            eprintln!("skipped: {}", take(error));
            None
        }
        s => panic!("{s:?}: {}", take(error)),
    }
}

#[test]
fn renders_flips_and_exports() {
    let Some(stage) = offscreen(320, 200) else { return };
    let (mut report, mut error) = (null_mut(), null_mut());
    // Nothing to export before a card.
    let mut bytes = Card3dBytes { data: null_mut(), len: 0 };
    assert_eq!(unsafe { card3d_stage_export_png(stage, 64, 40, null(), &mut bytes, &mut error) }, Card3dStatus::InvalidArgument);
    take(error);

    let json = design("brushed-silver");
    assert_eq!(unsafe { card3d_stage_set_design(stage, json.as_ptr(), null(), &mut report, &mut error) }, Card3dStatus::Ok);
    let report = take(report);
    assert!(report.contains("\"shaderErrors\":[]"), "{report}");
    unsafe {
        card3d_stage_advance(stage, 0.0, null_mut());
        assert_eq!(card3d_stage_render(stage, &mut error), Card3dStatus::Ok);
        // A tap flips, as a click does on the web.
        assert!(card3d_stage_pointer_down(stage, 1, 160.0, 100.0, 320.0, 200.0, 10.0));
        card3d_stage_pointer_up(stage, 1, 160.0, 100.0, 60.0);
        let mut wake = 0.0;
        let flags = card3d_stage_advance(stage, 70.0, &mut wake);
        assert_ne!(flags & CARD3D_ANIMATING, 0);
        assert!(wake < 0.0);
        assert!(card3d_stage_flipped(stage));
        card3d_stage_reset(stage);
        assert!(!card3d_stage_flipped(stage));

        // The front at the harness's front pose: the card covers the middle, the corners are clear.
        let pose = [0.0f64; 3];
        assert_eq!(card3d_stage_snapshot(stage, 120, 75, pose.as_ptr(), &mut bytes, &mut error), Card3dStatus::Ok);
        let px = std::slice::from_raw_parts(bytes.data, bytes.len).to_vec();
        card3d_bytes_free(bytes);
        assert_eq!(px.len(), 120 * 75 * 4);
        assert_eq!(px[3], 0);
        assert_eq!(px[(4 * (37 * 120 + 60) + 3) as usize], 255);

        assert_eq!(card3d_stage_export_png(stage, 120, 75, null(), &mut bytes, &mut error), Card3dStatus::Ok);
        assert_eq!(std::slice::from_raw_parts(bytes.data, 8), b"\x89PNG\r\n\x1a\n");
        card3d_bytes_free(bytes);

        assert_eq!(
            card3d_stage_export_ar(stage, 1, 256, false, &mut bytes, &mut error),
            Card3dStatus::Ok,
            "{}",
            if error.is_null() { String::new() } else { take(error) }
        );
        // A USDZ is a zip.
        assert_eq!(std::slice::from_raw_parts(bytes.data, 2), b"PK");
        card3d_bytes_free(bytes);

        // A quality change rebuilds; a bad value is refused.
        assert_eq!(card3d_stage_set_quality(stage, 0, &mut error), Card3dStatus::Ok);
        assert_eq!(card3d_stage_set_quality(stage, 7, &mut error), Card3dStatus::InvalidArgument);
        take(error);
        assert_eq!(card3d_stage_set_lighting(stage, c"warm".as_ptr(), &mut error), Card3dStatus::Ok);
        assert_eq!(card3d_stage_render(stage, &mut error), Card3dStatus::Ok);
        card3d_stage_free(stage);
    }
}
