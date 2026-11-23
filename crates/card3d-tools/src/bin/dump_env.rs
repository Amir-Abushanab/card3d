//! Debug: writes the prefiltered environment atlas (768 × 1024) to out/env-atlas.png (×8, clamped),
//! next to three's (out/ref-env-atlas.f16, from compare.mjs --dump-env) when present, with region means.
#![allow(clippy::print_stdout, reason = "a command-line tool: printing is its output")]

fn f16(h: u16) -> f32 {
    let (s, e, m) = ((h >> 15) as u32, ((h >> 10) & 0x1f) as i32, (h & 0x3ff) as f32);
    let v = if e == 0 {
        m / 1024.0 * 2f32.powi(-14)
    } else if e == 31 {
        f32::INFINITY
    } else {
        (1.0 + m / 1024.0) * 2f32.powi(e - 15)
    };
    if s == 1 {
        -v
    } else {
        v
    }
}

fn main() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).unwrap();
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    // CARD3D_QUALITY=performance: the 128 environment (and out-performance/, as compare.mjs --quality).
    let quality = std::env::var("CARD3D_QUALITY").ok().and_then(|q| card3d_engine::quality::Quality::parse(&q)).unwrap_or_default();
    let size = card3d_engine::env::EnvSize::new(quality.preset().environment_resolution);
    let atlas = card3d_engine::env::build_environment(&device, &queue, None, quality, None);
    let (w, h) = (size.atlas_w(), size.atlas_h());
    let row = 8 * w;
    let buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (row * h) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(
        atlas.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
        atlas.size(),
    );
    queue.submit([enc.finish()]);
    buf.slice(..).map_async(wgpu::MapMode::Read, |r| r.unwrap());
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    let data = buf.slice(..).get_mapped_range().unwrap();
    let halves: &[u16] = bytemuck::cast_slice(&data);
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(if quality == Default::default() { "out" } else { "out-performance" });
    // three's atlas for the same scene, if dumped (`node ref/capture.mjs dumpenv`): same row order.
    let reference: Option<Vec<u16>> = std::fs::read(out.join("ref-env-atlas.f16")).ok().map(|b| bytemuck::cast_slice(&b).to_vec());
    let tone = |v: f32| ((v * 8.0).max(0.0).powf(1.0 / 2.2) * 255.0).clamp(0.0, 255.0) as u8;
    let mut px = Vec::new();
    for y in 0..h as usize {
        for src in [Some(halves), reference.as_deref()].into_iter().flatten() {
            for x in 0..w as usize {
                let o = 4 * (y * w as usize + x);
                px.extend([0, 1, 2].map(|c| tone(f16(src[o + c]))));
            }
        }
    }
    if let Some(r) = &reference {
        // Mean red per region: lod 0 (faces), lod 1, and the 16-px levels.
        let region = |src: &[u16], x0: usize, y0: usize, ww: usize, hh: usize| {
            let mut s = 0.0f64;
            for y in y0..y0 + hh {
                for x in x0..x0 + ww {
                    s += f16(src[4 * (y * w as usize + x)]) as f64;
                }
            }
            s / (ww * hh) as f64
        };
        let c = size.cube as usize;
        let mut regions = vec![("lod0".to_string(), 0, 0, 3 * c, 2 * c), ("lod1".to_string(), 0, 2 * c, 3 * c / 2, c)];
        regions.extend((0..7).map(|k| (format!("lod4/extra{k}"), 48 * k, 4 * c - 64, 48, 32)));
        for (name, x0, y0, ww, hh) in regions {
            println!("{name:>9}: rust {:.4}  three {:.4}", region(halves, x0, y0, ww, hh), region(r, x0, y0, ww, hh));
        }
    }
    let cols = if reference.is_some() { 2 } else { 1 };
    let file = std::fs::File::create(out.join("env-atlas.png")).unwrap();
    let mut e = png::Encoder::new(std::io::BufWriter::new(file), w * cols, h);
    e.set_color(png::ColorType::Rgb);
    e.write_header().unwrap().write_image_data(&px).unwrap();
}
