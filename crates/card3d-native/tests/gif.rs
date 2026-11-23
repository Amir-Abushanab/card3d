//! Animated GIF stickers on the native host (`card3d_native::gif`).

use card3d_native::gif::{bordered_frame, AnimatedStickers, GifSticker};
use card3d_native::NativeHost;

/// A GIF of `frames` (solid colours on transparency, `delay` ms each), 40 × 20.
fn gif(frames: &[([u8; 4], u32)]) -> Vec<u8> {
    use image::codecs::gif::{GifEncoder, Repeat};
    let mut out = Vec::new();
    {
        let mut enc = GifEncoder::new(&mut out);
        enc.set_repeat(Repeat::Infinite).unwrap();
        for (color, delay) in frames {
            let img = image::RgbaImage::from_fn(40, 20, |x, _| if x < 30 { image::Rgba(*color) } else { image::Rgba([0, 0, 0, 0]) });
            let delay = image::Delay::from_numer_denom_ms(*delay, 1);
            enc.encode_frame(image::Frame::from_parts(img, 0, 0, delay)).unwrap();
        }
    }
    out
}

#[test]
fn borders_each_frame_like_the_page() {
    let host = NativeHost::default();
    let g = GifSticker::decode(&gif(&[([230, 60, 60, 255], 100)]), &host).expect("decodes");
    assert_eq!(g.frames.len(), 1);
    let f = &g.frames[0];
    // Padding: max(7, round(0.035 · 40)) = 7 px each side.
    assert_eq!((f.width, f.height), (54, 34));
    let px = |x: u32, y: u32| &f.rgba[(4 * (y * f.width + x)) as usize..][..4];
    assert_eq!(px(20, 17), [230, 60, 60, 255]);
    // The cream die-cut border around the silhouette, transparent beyond it.
    assert_eq!(px(3, 17)[..3], [0xf4, 0xf1, 0xe7]);
    assert!(px(3, 17)[3] > 200);
    assert_eq!(px(0, 0)[3], 0);
    // Right of the silhouette (x ≥ 30 in the frame) only the border's reach is inked.
    assert_eq!(px(7 + 38, 17)[3], 0);
    assert_eq!(g.until_next(0.0), None);
    // Large frames are scaled to 720 px first.
    let big = image::RgbaImage::from_pixel(1440, 360, image::Rgba([0, 0, 255, 255]));
    let (w, h, _) = bordered_frame(&host, &card3d_engine::canvas::Image { width: 1440, height: 360, rgba: big.into_raw() });
    assert_eq!((w, h), (720 + 2 * 25, 180 + 2 * 25));
}

#[test]
fn plays_frames_on_the_host_clock() {
    let host = NativeHost::default();
    let bytes = gif(&[([255, 0, 0, 255], 50), ([0, 255, 0, 255], 0), ([0, 0, 255, 255], 200)]);
    let g = GifSticker::decode(&bytes, &host).unwrap();
    let secs: Vec<f64> = g.frames.iter().map(|f| f.seconds).collect();
    assert_eq!(secs, [0.05, 1.0 / 30.0, 0.2]);
    let total = 0.05 + 1.0 / 30.0 + 0.2;
    assert_eq!([0.0, 0.049, 0.06, 0.09, total + 0.01].map(|t| g.frame_at(t)), [0, 0, 1, 2, 0]);
    assert!((g.until_next(0.06).unwrap() - (0.05 + 1.0 / 30.0 - 0.06)).abs() < 1e-12);

    // The design's sticker 1 is the GIF (a data URL): frames are sent only when they change.
    use base64::Engine;
    let src = format!("data:image/gif;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
    let json = format!(r#"{{"recipe":{{}},"decals":[{{"id":"a","src":"x.png"}},{{"id":"b","src":"{src}"}}]}}"#);
    let design = card3d_engine::CardDesign::from_json(&json).unwrap();
    let mut s = AnimatedStickers::load(&host, &design, &[1]);
    let mut sent = Vec::new();
    for t in [0.0, 0.01, 0.06, 0.07, 0.1] {
        s.update(t, |decal, w, h, rgba| sent.push((t, decal, w, h, rgba[4 * (17 * w as usize + 20) + 1])));
    }
    assert_eq!(sent.iter().map(|x| (x.0, x.1, x.4)).collect::<Vec<_>>(), [(0.0, 1, 0), (0.06, 1, 255), (0.1, 1, 0)]);
    s.reset();
    assert!(s.update(0.1, |_, _, _, _| {}).is_some());
}
