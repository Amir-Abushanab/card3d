//! Headless native renders: `render <out-dir> <design.json>...` writes
//! `<out-dir>/<design>/rust-<pose>.png` (1200 × 750) at the parity poses, and lists the design
//! features the engine does not draw yet.
//!
//! `render --marquee <out-dir> <w>x<h> <tag>:<offset>:<time>,... <design.json>...`: the marquee
//! (`card3d_engine::marquee`) with those designs in order, at the default layout for a `w` × `h`
//! container (pixel ratio 1), nothing animating, at each strip state, into
//! `<out-dir>/marquee-<w>x<h>/rust-<tag>.png` (compare.mjs --marquee).
//!
//! `render --ar <out-dir> <design.json>...`: each design's AR model (`card3d_engine::ar`), as
//! `<out-dir>/<design>/rust.glb` and `rust.usdz`.
#![allow(clippy::print_stdout, clippy::print_stderr, clippy::exit, reason = "a command-line tool: printing is its output")]

use card3d_engine::quality::Quality;
use card3d_engine::stage::{CameraOrbit, Fit, Stage, StageOptions};
use card3d_engine::{CardDesign, CardRenderer};
use card3d_native::NativeHost;
use std::path::{Path, PathBuf};

const POSES: [(&str, [f32; 3]); 4] =
    [("front", [0.0, 0.0, 0.0]), ("tilt", [-0.22, 0.38, 0.04]), ("back", [0.0, std::f32::consts::PI, 0.0]), ("edge", [0.1, 1.25, 0.0])];
const W: u32 = 1200;
const H: u32 = 750;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((out, designs)) = args.split_first() else {
        eprintln!("usage: render <out-dir> <design.json>...");
        std::process::exit(2);
    };
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("no GPU adapter");
    eprintln!("adapter: {} ({:?})", adapter.get_info().name, adapter.get_info().backend);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).expect("no device");
    let format = wgpu::TextureFormat::Rgba8Unorm;
    if out == "--marquee" {
        return marquee(&device, &queue, designs);
    }
    if out == "--ar" {
        return ar(&device, &queue, designs);
    }
    let target = Target::new(&device, W, H);

    // CARD3D_QUALITY=performance renders the phone tier (compare.mjs --quality performance).
    let quality = std::env::var("CARD3D_QUALITY").ok().and_then(|q| Quality::parse(&q)).unwrap_or_default();
    // CARD3D_FIT=contain frames the card as `<metal-card>` does (compare.mjs --fit contain).
    let fit = std::env::var("CARD3D_FIT").ok().and_then(|f| Fit::parse(&f)).unwrap_or_default();
    let options = StageOptions { quality, fit, interactive: false, intro: false, ..Default::default() };
    // The scene environments' files, in place.
    let environments = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/assets/environments");
    for path in designs {
        let path = Path::new(path);
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let text = std::fs::read_to_string(path).expect("read design");
        let design = CardDesign::from_json(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
        let missing = design.unsupported();
        println!("{name}\t{}", if missing.is_empty() { "-".to_string() } else { missing.join(", ") });
        let mut stage = Stage::new(options.clone());
        let doc = card3d_engine::json::parse(&text).expect("design json");
        // The fixture's asset provider (designs/generate.ts): its name font.
        let assets = doc.get("__harness").and_then(|h| h.get("assets"));
        let host = NativeHost {
            base: path.parent().map(|p| p.to_path_buf()),
            environments: Some(environments.clone()),
            name_font: assets.and_then(|a| a.get("nameFontFamily")).and_then(|f| f.as_str()).map(str::to_string),
        };
        pollster::block_on(stage.set_design(&device, &queue, format, &design, &host, None)).expect("card");
        // Animated GIF stickers at their first frame (the web harness waits for it too).
        card3d_native::gif::AnimatedStickers::load(&host, &design, &stage.animated_stickers()).update(0.0, |decal, w, h, rgba| {
            stage.show_sticker_frame(&device, &queue, decal, w, h, rgba);
        });
        // A camera path frozen at a moment (designs/generate.ts): the camera's orbit and the card's lift.
        if let Some(h) = doc.get("__harness").filter(|h| h.get("orbit").is_some()) {
            let n = |v: Option<&card3d_engine::json::Value>| v.and_then(|v| v.as_f64()).unwrap_or(0.0);
            let o = h.get("orbit");
            let orbit = CameraOrbit {
                azimuth: n(o.and_then(|o| o.get("azimuth"))),
                elevation: n(o.and_then(|o| o.get("elevation"))),
                distance: n(o.and_then(|o| o.get("distance"))),
            };
            stage.set_camera_orbit(Some(orbit));
            stage.set_lift(n(h.get("lift")));
        }
        let dir = PathBuf::from(out).join(&name);
        std::fs::create_dir_all(&dir).unwrap();
        for (pose, euler) in POSES {
            stage.set_rotation(euler.map(|v| v as f64));
            stage.render(&device, &queue, &target.view, W, H);
            target.save(&device, &queue, &dir.join(format!("rust-{pose}.png")));
        }
    }
}

/// A render target and its readback buffer.
struct Target {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    readback: wgpu::Buffer,
    row: u32,
}

impl Target {
    fn new(device: &wgpu::Device, w: u32, h: u32) -> Target {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let row = (4 * w).div_ceil(256) * 256;
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (row * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        Target { texture, view, readback, row }
    }

    /// Reads the target back and writes it as a PNG.
    fn save(&self, device: &wgpu::Device, queue: &wgpu::Queue, path: &Path) {
        let (target, readback, row) = (&self.texture, &self.readback, self.row);
        let (w, h) = (target.width(), target.height());
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: readback,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) },
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        queue.submit([enc.finish()]);
        readback.slice(..).map_async(wgpu::MapMode::Read, |r| r.unwrap());
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let data = readback.slice(..).get_mapped_range().unwrap();
        // Un-premultiply, as the browser does for canvas.toDataURL().
        let mut px = Vec::with_capacity((4 * w * h) as usize);
        for y in 0..h {
            for p in data[(y * row) as usize..(y * row + 4 * w) as usize].as_chunks::<4>().0 {
                let a = p[3] as f32 / 255.0;
                let un = |c: u8| {
                    if a > 0.0 {
                        (c as f32 / a).round().min(255.0) as u8
                    } else {
                        0
                    }
                };
                px.extend([un(p[0]), un(p[1]), un(p[2]), p[3]]);
            }
        }
        drop(data);
        readback.unmap();
        let file = std::fs::File::create(path).unwrap();
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&px).unwrap();
    }
}

/// `render --marquee <out-dir> <w>x<h> <tag>:<offset>:<time>,... <design.json>...`.
fn marquee(device: &wgpu::Device, queue: &wgpu::Queue, args: &[String]) {
    use card3d_engine::marquee::{create, Options};
    use card3d_engine::marquee_model::{compute_layout, Strip};
    let [out, size, states, files @ ..] = args else {
        eprintln!("usage: render --marquee <out-dir> <w>x<h> <tag>:<offset>:<time>,... <design.json>...");
        std::process::exit(2);
    };
    let (w, h) = size.split_once('x').map(|(a, b)| (a.parse::<u32>().unwrap(), b.parse::<u32>().unwrap())).expect("<w>x<h>");
    let quality = std::env::var("CARD3D_QUALITY").ok().and_then(|q| Quality::parse(&q)).unwrap_or_default();
    let designs: Vec<CardDesign> = files.iter().map(|f| CardDesign::from_json(&std::fs::read_to_string(f).expect("read design")).expect("design")).collect();
    let options = Options { active: true, quality, lighting: "studio".into(), play_intro: false, reduced_motion: false };
    let mut m = pollster::block_on(create(device, queue, wgpu::TextureFormat::Rgba8Unorm, options)).expect("marquee");
    m.set_designs(designs.len());
    m.set_layout(compute_layout(w as f64, h as f64, None, false));
    let host = NativeHost { base: files.first().and_then(|f| Path::new(f).parent()).map(Path::to_path_buf), ..Default::default() };
    let target = Target::new(device, w, h);
    let dir = PathBuf::from(out).join(format!("marquee-{w}x{h}"));
    std::fs::create_dir_all(&dir).unwrap();
    for state in states.split(',') {
        let mut parts = state.split(':');
        let (tag, offset, time) = (parts.next().unwrap(), parts.next().unwrap().parse().unwrap(), parts.next().unwrap().parse().unwrap());
        m.set_strip(&Strip::new(offset, time).to_array());
        m.step(1000.0, false, w as f64 / h as f64, None);
        for b in m.take_builds() {
            let card = pollster::block_on(CardRenderer::new(device, queue, wgpu::TextureFormat::Rgba8Unorm, &designs[b.design], &host, &m.card_options(None)));
            m.install(b.slot, b.token, card.expect("card"));
        }
        m.step(1000.0, false, w as f64 / h as f64, None);
        m.render(device, queue, &target.view, w, h);
        target.save(device, queue, &dir.join(format!("rust-{tag}.png")));
    }
}

/// `render --ar <out-dir> <design.json>...`.
fn ar(device: &wgpu::Device, queue: &wgpu::Queue, args: &[String]) {
    let Some((out, designs)) = args.split_first() else {
        eprintln!("usage: render --ar <out-dir> <design.json>...");
        std::process::exit(2);
    };
    let environments = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/assets/environments");
    for path in designs {
        let path = Path::new(path);
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let design = CardDesign::from_json(&std::fs::read_to_string(path).expect("read design")).unwrap_or_else(|e| panic!("{name}: {e}"));
        let host = || NativeHost { base: path.parent().map(|p| p.to_path_buf()), environments: Some(environments.clone()), ..Default::default() };
        let dir = PathBuf::from(out).join(&name);
        std::fs::create_dir_all(&dir).unwrap();
        for (usdz, file) in [(false, "rust.glb"), (true, "rust.usdz")] {
            let options = card3d_engine::CardOptions { quality: Quality::Full, print: true, ..Default::default() };
            let card = pollster::block_on(CardRenderer::new(device, queue, wgpu::TextureFormat::Rgba8UnormSrgb, &design, &host(), &options)).expect("card");
            let o = card3d_engine::ar::ArOptions { usdz, ..Default::default() };
            let export = pollster::block_on(card3d_engine::ar::export(card, device, queue, Box::new(host()), o)).expect("ar chunk");
            let bytes = pollster::block_on(export).expect("ar export");
            std::fs::write(dir.join(file), bytes).unwrap();
        }
        println!("{name}");
    }
}
