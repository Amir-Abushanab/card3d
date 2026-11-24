//! `bench [--runs <n>] <design.json>...`: how long a stage takes to swap to each design (Card Studio's
//! `setDesign` on every panel change), natively: per design, one warm-up build, then `n` (default 10)
//! rebuilds of the same design over the last one, each timed as the build (`Stage::set_design`) and
//! its first frame (1200 × 750, waited for). Prints the medians in ms.
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
    let mut runs = 10;
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
