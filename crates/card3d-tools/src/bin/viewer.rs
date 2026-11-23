//! Native window: the same card on the platform GPU API (Metal on macOS, DX12/Vulkan on Windows,
//! Vulkan on Linux). Drag to turn it. `viewer [design.json]`; `CARD_FRAMES=n` closes after n frames.
//! Animated GIF stickers play (`card3d_native::gif`, on the window's clock).
#![allow(clippy::print_stdout, reason = "a command-line tool: printing is its output")]

use std::sync::Arc;

use card3d_engine::{CardDesign, CardRenderer};
use card3d_native::NativeHost;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::window::{Window, WindowId};

struct Gpu {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    card: CardRenderer,
    gifs: card3d_native::gif::AnimatedStickers,
    start: std::time::Instant,
}

#[derive(Default)]
struct App {
    gpu: Option<Gpu>,
    rot: [f32; 3],
    drag: Option<((f64, f64), [f32; 3])>,
    cursor: (f64, f64),
    frames: u32,
}

impl ApplicationHandler for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.gpu.is_some() {
            return;
        }
        self.rot = [-0.22, 0.38, 0.04];
        let window = Arc::new(
            el.create_window(Window::default_attributes().with_title("Card (Rust + wgpu)").with_inner_size(winit::dpi::LogicalSize::new(960, 600))).unwrap(),
        );
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = instance.create_surface(window.clone()).unwrap();
        let adapter =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { compatible_surface: Some(&surface), ..Default::default() })).unwrap();
        let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap();
        let size = window.inner_size();
        let alpha_mode = caps.alpha_modes[0];
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode,
            view_formats: vec![],
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        surface.configure(&device, &config);
        println!("{} ({:?}), {format:?}", adapter.get_info().name, adapter.get_info().backend);
        let path = std::env::args().nth(1);
        let design = match &path {
            Some(path) => CardDesign::from_json(&std::fs::read_to_string(path).expect("read design")).expect("design"),
            None => CardDesign::from_json(include_str!("../../designs/brushed-silver.json")).unwrap(),
        };
        // Relative image `src`s are the design file's neighbours.
        let host = NativeHost { base: path.as_ref().and_then(|p| std::path::Path::new(p).parent().map(|d| d.to_path_buf())), ..Default::default() };
        let missing = design.unsupported();
        if !missing.is_empty() {
            println!("not drawn yet: {}", missing.join(", "));
        }
        let card = pollster::block_on(CardRenderer::new(&device, &queue, format, &design, &host, &Default::default())).expect("card");
        let gifs = card3d_native::gif::AnimatedStickers::load(&host, &design, &card.animated_stickers());
        window.request_redraw();
        self.gpu = Some(Gpu { window, surface, device, queue, config, card, gifs, start: std::time::Instant::now() });
    }

    fn window_event(&mut self, el: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        let Some(g) = self.gpu.as_mut() else { return };
        match event {
            WindowEvent::CloseRequested => el.exit(),
            WindowEvent::Resized(s) if s.width > 0 && s.height > 0 => {
                g.config.width = s.width;
                g.config.height = s.height;
                g.surface.configure(&g.device, &g.config);
                g.window.request_redraw();
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                self.drag = (state == ElementState::Pressed).then_some((self.cursor, self.rot));
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = (position.x, position.y);
                if let Some(((x0, y0), r)) = self.drag {
                    let k = 0.008 / g.window.scale_factor() as f32;
                    self.rot = [r[0] + (position.y - y0) as f32 * k, r[1] + (position.x - x0) as f32 * k, r[2]];
                    g.window.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => {
                let (card, device, queue) = (&mut g.card, &g.device, &g.queue);
                let next = g.gifs.update(g.start.elapsed().as_secs_f64(), |decal, w, h, rgba| {
                    card.show_sticker_frame(device, queue, decal, w, h, rgba);
                });
                if next.is_some() {
                    g.window.request_redraw();
                }
                if let wgpu::CurrentSurfaceTexture::Success(frame) | wgpu::CurrentSurfaceTexture::Suboptimal(frame) = g.surface.get_current_texture() {
                    let view = frame.texture.create_view(&Default::default());
                    g.card.render(&g.device, &g.queue, &view, g.config.width, g.config.height, self.rot);
                    g.queue.present(frame);
                }
                self.frames += 1;
                let limit = std::env::var("CARD_FRAMES").ok().and_then(|v| v.parse::<u32>().ok());
                if limit.is_some_and(|n| self.frames >= n) {
                    el.exit();
                } else if limit.is_some() {
                    g.window.request_redraw();
                }
            }
            _ => {}
        }
    }
}

fn main() {
    EventLoop::new().unwrap().run_app(&mut App::default()).unwrap();
}
