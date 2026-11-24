//! A stage swapping designs (Card Studio's `setDesign`) draws each one exactly as a stage built for it
//! alone does: what a device keeps for its next card (`renderer::memo`: shader modules, pipelines,
//! liquid metal's masks, the vines' and shine's sprites) is only ever what that card would make. Needs a
//! GPU: skipped without an adapter, except where `CARD3D_REQUIRE_GPU` is set (CI, on lavapipe).
#![allow(clippy::print_stderr, reason = "says why the test was skipped")]

use card3d_engine::stage::{Stage, StageOptions};
use card3d_engine::CardDesign;
use card3d_native::NativeHost;
use std::path::Path;

const W: u32 = 320;
const H: u32 = 200;
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// Fixtures (designs/) whose builds make what the device keeps, in an order that revisits some.
const DESIGNS: &[&str] = &[
    "face-liquid-metal-mark",
    "face-liquid-metal-artwork",
    "addon-shine",
    "addon-shine-ice",
    "addon-vines",
    "face-halftone-overlay",
    "face-halftone-artwork",
    "glass-face-overlay",
    "scene-floor-mirror",
    "face-liquid-metal-shapes",
    "holo-styles",
    "face-liquid-metal-mark",
    "addon-shine",
    "face-liquid-metal-artwork",
];

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    target: wgpu::Texture,
}

fn gpu() -> Option<Gpu> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = match pollster::block_on(instance.request_adapter(&Default::default())) {
        Ok(a) => a,
        Err(e) if std::env::var_os("CARD3D_REQUIRE_GPU").is_some() => panic!("no GPU (CARD3D_REQUIRE_GPU): {e}"),
        Err(e) => {
            eprintln!("skipped: no GPU adapter ({e})");
            return None;
        }
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).expect("device");
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    Some(Gpu { device, queue, target })
}

fn host() -> NativeHost {
    let environments = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/assets/environments");
    NativeHost { base: None, environments: Some(environments), name_font: None }
}

fn design(name: &str) -> CardDesign {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("designs").join(format!("{name}.json"));
    CardDesign::from_json(&std::fs::read_to_string(path).unwrap()).unwrap()
}

impl Gpu {
    /// `stage` shows `name` (built while its last card is still shown), and its frame at a tilt, read back.
    fn show(&self, stage: &mut Stage, name: &str) -> Vec<u8> {
        pollster::block_on(stage.set_design(&self.device, &self.queue, FORMAT, &design(name), &host(), None)).unwrap();
        let view = self.target.create_view(&Default::default());
        stage.render_posed(&self.device, &self.queue, &view, W, H, [-0.22, 0.38, 0.04]);
        let row = (4 * W).div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (row * H) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            self.target.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(H) } },
            wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        );
        self.queue.submit([enc.finish()]);
        buffer.slice(..).map_async(wgpu::MapMode::Read, |r| r.unwrap());
        self.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let data = buffer.slice(..).get_mapped_range().unwrap();
        data.chunks(row as usize).flat_map(|r| &r[..(4 * W) as usize]).copied().collect()
    }
}

fn stage() -> Stage {
    Stage::new(StageOptions { interactive: false, intro: false, quality: Default::default(), ..Default::default() })
}

#[test]
fn a_swapped_design_draws_as_a_fresh_one() {
    let Some(gpu) = gpu() else { return };
    // Each design on a stage of its own first, one at a time: nothing kept from another card.
    let alone: Vec<Vec<u8>> = DESIGNS.iter().map(|name| gpu.show(&mut stage(), name)).collect();
    let mut swapping = stage();
    for (name, alone) in DESIGNS.iter().zip(&alone) {
        assert!(gpu.show(&mut swapping, name) == *alone, "{name} draws unlike a fresh build after a swap");
    }
}
