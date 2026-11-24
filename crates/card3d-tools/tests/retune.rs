//! A stage's card retuned in place (`Stage::retune`: new foil values) draws exactly as a card built
//! from the new design does, and a change it can't take leaves the card as it was. Needs a GPU: skipped
//! without an adapter, except where `CARD3D_REQUIRE_GPU` is set (CI, on lavapipe).
#![allow(clippy::print_stderr, reason = "says why the test was skipped")]

use card3d_engine::card::BuildKey;
use card3d_engine::json;
use card3d_engine::stage::{Stage, StageOptions};
use card3d_engine::{CardDesign, CardRenderer};
use card3d_native::NativeHost;

const W: u32 = 320;
const H: u32 = 200;
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// Both sides foiled, each its own way; `edits` replace recipe values.
fn design(edits: &[(&str, &str)]) -> String {
    let mut recipe = vec![
        ("material", "\"silver\""),
        ("frontHolo", "true"),
        ("backHolo", "true"),
        ("matchHoloSides", "false"),
        ("holoStyle", "\"vmax\""),
        ("foilIntensity", "70"),
        ("holoGlare", "60"),
        ("backHoloStyle", "\"cosmos\""),
        ("backFoilIntensity", "50"),
    ];
    for (k, v) in edits {
        recipe.retain(|(key, _)| key != k);
        recipe.push((k, v));
    }
    let recipe: Vec<String> = recipe.iter().map(|(k, v)| format!("\"{k}\": {v}")).collect();
    format!(r#"{{ "recipe": {{ {} }}, "cardholderName": "Ada Lovelace", "decals": [] }}"#, recipe.join(", "))
}

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

impl Gpu {
    /// The stage's frame at a tilt that shows the front foil and the bevel, read back.
    fn draw(&self, stage: &mut Stage) -> Vec<u8> {
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

    /// A stage showing `text`, built with its key.
    fn stage(&self, text: &str) -> Stage {
        let mut stage = Stage::new(StageOptions { interactive: false, intro: false, quality: Default::default(), ..Default::default() });
        let options = stage.card_options(None);
        let design = CardDesign::from_json(text).unwrap();
        let card = pollster::block_on(CardRenderer::new(&self.device, &self.queue, FORMAT, &design, &NativeHost::default(), &options)).unwrap();
        stage.install_keyed(card, key(&stage, text));
        stage
    }
}

fn key(stage: &Stage, text: &str) -> BuildKey {
    BuildKey::new(json::parse(text).unwrap(), &stage.card_options(None), Vec::new()).unwrap()
}

/// `stage` takes `text` in place (true) or not.
fn retune(stage: &mut Stage, text: &str) -> bool {
    let k = key(stage, text);
    stage.retune(&k, &CardDesign::from_json(text).unwrap())
}

#[test]
fn a_retuned_card_draws_as_a_built_one() {
    let Some(gpu) = gpu() else { return };
    let a = design(&[]);
    let b = design(&[("holoStyle", "\"gold\""), ("foilIntensity", "95"), ("holoGlare", "20"), ("foilScale", "160"), ("backFoilIntensity", "90")]);
    let mut stage = gpu.stage(&a);
    let before = gpu.draw(&mut stage);
    assert!(retune(&mut stage, &b));
    let retuned = gpu.draw(&mut stage);
    let built = gpu.draw(&mut gpu.stage(&b));
    assert!(retuned != before, "the foil values changed nothing");
    assert!(retuned == built, "the retuned card draws unlike a built one");

    // A side losing its foil, or anything but the foil values, needs a build: the card stays as it was.
    for c in [design(&[("foilIntensity", "0")]), design(&[("backHolo", "false")]), design(&[("polish", "10")]), a.replace("Ada", "Grace")] {
        assert!(!retune(&mut stage, &c), "{c}");
        assert!(gpu.draw(&mut stage) == built);
    }
    // A card installed without its key isn't retuned.
    let card = pollster::block_on(CardRenderer::new(
        &gpu.device,
        &gpu.queue,
        FORMAT,
        &CardDesign::from_json(&b).unwrap(),
        &NativeHost::default(),
        &stage.card_options(None),
    ))
    .unwrap();
    stage.install(card);
    assert!(!retune(&mut stage, &a));
}

#[test]
fn a_card_that_animates_by_itself_is_built_again() {
    let Some(gpu) = gpu() else { return };
    // The shine add-on without a frozen time animates: a build starts its clock at zero, a retune wouldn't.
    let shine = |d: String| d.replace(r#""decals": []"#, r#""decals": [], "addons": { "shine": {} }"#);
    let mut stage = gpu.stage(&shine(design(&[])));
    assert!(!retune(&mut stage, &shine(design(&[("foilIntensity", "95")]))));
}
