//! `bench [--runs <n>] <design.json>...`: how long a stage takes to swap to each design (Card Studio's
//! `setDesign` on every panel change), natively: per design, one warm-up build, then `n` (default 10)
//! rebuilds of the same design over the last one, each timed as the build (`Stage::set_design`) and
//! its first frame (1200 × 750, waited for). Prints the medians in ms.
//!
//! `bench --marquee [--runs <n>] <design.json>...`: the marquee (`card3d_engine::marquee`) with those
//! designs at 1200 × 750, its strip at rest with a card between slots: `n` (default 100) frames, each
//! timed as recorded and submitted (CPU) and to the GPU's finish (waited for). Prints the medians in ms.
#![allow(clippy::print_stdout, clippy::print_stderr, clippy::exit, reason = "a command-line tool: printing is its output")]

use card3d_engine::stage::{Stage, StageOptions};
use card3d_engine::CardDesign;
use card3d_native::NativeHost;
use std::path::Path;
use std::time::Instant;

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let marquee = args.first().is_some_and(|a| a == "--marquee");
    if marquee {
        args.remove(0);
    }
    let mut runs = if marquee { 100 } else { 10 };
    if args.first().is_some_and(|a| a == "--runs") {
        runs = args.get(1).and_then(|n| n.parse().ok()).unwrap_or_else(|| {
            eprintln!("usage: bench [--runs <n>] <design.json>...");
            std::process::exit(2);
        });
        args.drain(..2);
    }
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("no GPU adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).expect("no device");
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let (w, h) = (1200, 750);
    let target = device
        .create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        })
        .create_view(&Default::default());
    if marquee {
        return marquee_frames(&device, &queue, &target, (w, h), runs, &args);
    }
    let environments = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/assets/environments");
    println!("{:<40} {:>9} {:>9}", "design", "build ms", "frame ms");
    for path in &args {
        let path = Path::new(path);
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let design = CardDesign::from_json(&std::fs::read_to_string(path).expect("read design")).unwrap_or_else(|e| panic!("{name}: {e}"));
        let host = NativeHost { base: path.parent().map(Path::to_path_buf), environments: Some(environments.clone()), name_font: None };
        let mut stage = Stage::new(StageOptions { interactive: false, intro: false, quality: Default::default(), ..Default::default() });
        let (mut build, mut frame) = (Vec::new(), Vec::new());
        for run in 0..=runs {
            let t = Instant::now();
            pollster::block_on(stage.set_design(&device, &queue, format, &design, &host, None)).expect("card");
            let b = t.elapsed().as_secs_f64() * 1e3;
            let t = Instant::now();
            stage.render(&device, &queue, &target, w, h);
            device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
            if run > 0 {
                build.push(b);
                frame.push(t.elapsed().as_secs_f64() * 1e3);
            }
        }
        println!("{name:<40} {:>9.1} {:>9.1}", median(build), median(frame));
    }
}

fn marquee_frames(device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::TextureView, (w, h): (u32, u32), runs: usize, files: &[String]) {
    use card3d_engine::marquee::{create, Options};
    use card3d_engine::marquee_model::{compute_layout, Strip};
    let designs: Vec<CardDesign> = files.iter().map(|f| CardDesign::from_json(&std::fs::read_to_string(f).expect("read design")).expect("design")).collect();
    let options = Options { active: true, quality: Default::default(), lighting: "studio".into(), play_intro: false, reduced_motion: false };
    let mut m = pollster::block_on(create(device, queue, wgpu::TextureFormat::Rgba8Unorm, options)).expect("marquee");
    m.set_designs(designs.len());
    m.set_layout(compute_layout(w as f64, h as f64, None, false));
    let host = NativeHost { base: files.first().and_then(|f| Path::new(f).parent()).map(Path::to_path_buf), ..Default::default() };
    m.set_strip(&Strip::new(1.5, 1.3).to_array());
    m.step(1000.0, false, w as f64 / h as f64, None);
    for b in m.take_builds() {
        let card = pollster::block_on(card3d_engine::CardRenderer::new(
            device,
            queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &designs[b.design],
            &host,
            &m.card_options(None),
        ));
        m.install(b.slot, b.token, card.expect("card"));
    }
    m.step(1000.0, false, w as f64 / h as f64, None);
    let (mut cpu, mut gpu) = (Vec::new(), Vec::new());
    for run in 0..=runs {
        let t = Instant::now();
        m.render(device, queue, target, w, h);
        let c = t.elapsed().as_secs_f64() * 1e3;
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        if run > 0 {
            cpu.push(c);
            gpu.push(t.elapsed().as_secs_f64() * 1e3);
        }
    }
    let cards = m.slots().chunks(5).filter(|s| s[4] != 0.0).count();
    println!("marquee {w}x{h}, {cards} cards: frame {:.2} ms recorded, {:.2} ms finished", median(cpu), median(gpu));
}
