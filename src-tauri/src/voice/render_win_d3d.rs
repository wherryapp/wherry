// The D3D11 presenter for a Windows tile: stage W3.2 of
// docs/prompts/archive/w3-native-render-windows.md (§5), un-deferred when
// D-50 read 8.7x on 2026-09-11. The GDI path in `render_win.rs` converts
// NV12 to BGRA on the CPU with libyuv, then stretches it with
// `StretchDIBits` under `HALFTONE` on the main thread, every frame, for
// every tile. Here the frame task writes the NV12 planes into a staging
// texture and hands the colour conversion, the scaling and the letterbox
// to `ID3D11VideoProcessor`, then presents a flip-model swap chain bound
// to the tile's `HWND` from the frame task itself -- no `WM_PAINT`, no
// main-thread hop per frame. **No shader, no HLSL, no compile step**: the
// video processor is the Windows analogue of handing an
// `AVSampleBufferDisplayLayer` a pixel buffer, which is what macOS does at
// 1.17x.
//
// What this does not touch, and it may be the larger half of D-50's
// 42.7%: the decode. libwebrtc on Windows decodes H264 in software through
// FFmpeg (the fork's `VideoDecoderFactory` has a hardware path for NVIDIA
// on Linux only), and the frame arrives here as I420 already paid for. So
// what this stage can win back is the conversion, the stretch and the
// paint; D-50 records both halves so the next decision is made on the
// split rather than on the total.
//
// One device for the process, created on the first frame that wants it
// and kept in a `static`. Its immediate context is not thread-safe, so
// every use -- Map, copy, blt, Present -- is under one `Mutex`, and every
// use is on a frame task, which never calls into the main thread while
// holding it. The per-window state (swap chain, textures, processor)
// lives in `render_win.rs`'s `Shared`, so a rebind reuses the swap chain:
// DXGI allows one flip-model swap chain per `HWND`, and a second one made
// before an aborted task has dropped the first is refused.
//
// Hardware or nothing in the product: a device that fails to create (no
// GPU, a remote desktop session, a broken driver) or that has no video
// half means the GDI path with one warning line, which is why that path
// is kept. `WHERRY_TILE_PRESENTER` (debug builds) overrides: `gdi` forces
// the fallback for an A/B on one machine; `warp` asks for the software
// rasterizer. **The rig cannot run the presenter at all**, measured
// 2026-09-12: whichever driver type is asked for, the guest's only device
// is the Microsoft Basic Render Driver -- WARP under its adapter name --
// and it answers `E_NOINTERFACE` for `ID3D11VideoDevice`, because the
// video processor is a driver feature WARP does not implement. What the
// rig settles is the refusal and the fallback; the presenter's own
// picture is the physical box's to read (docs/windows-rig.md §8).

use std::ffi::c_void;
use std::mem::ManuallyDrop;
use std::sync::{Mutex, OnceLock};

use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_frame::BoxVideoBuffer;
use windows::Win32::Foundation::{HMODULE, HWND, RECT};
use windows::Win32::Graphics::Direct3D::{
  D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_11_0,
};
use windows::Win32::Graphics::Direct3D11::{
  D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, ID3D11VideoContext,
  ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorInputView,
  ID3D11VideoProcessorOutputView, D3D11_CPU_ACCESS_WRITE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
  D3D11_FORMAT_SUPPORT_VIDEO_PROCESSOR_INPUT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_WRITE,
  D3D11_SDK_VERSION, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC, D3D11_USAGE,
  D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11_VIDEO_COLOR, D3D11_VIDEO_COLOR_0,
  D3D11_VIDEO_COLOR_RGBA, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_COLOR_SPACE,
  D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM,
  D3D11_VIDEO_USAGE_PLAYBACK_NORMAL, D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
  DXGI_ALPHA_MODE_UNSPECIFIED, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_FORMAT_UNKNOWN,
  DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
  IDXGIDevice, IDXGIFactory2, IDXGISwapChain1, DXGI_PRESENT, DXGI_SCALING_STRETCH,
  DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_EFFECT_FLIP_DISCARD,
  DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
use windows_core::{Interface, BOOL};

// -- which device -------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Driver {
  Hardware,
  /// The software rasterizer. Never in the product -- it would do on the
  /// CPU what GDI already does, with a device in the way -- and allowed
  /// only by the knob, for the rig.
  Warp,
}

/// Which device the frame task should try, or `None` for GDI outright.
/// Read once per binding; the knob is a debug-build instrument like every
/// other `WHERRY_*`.
pub fn driver() -> Option<Driver> {
  #[cfg(debug_assertions)]
  {
    match std::env::var("WHERRY_TILE_PRESENTER").ok().as_deref() {
      Some("gdi") => return None,
      Some("warp") => return Some(Driver::Warp),
      _ => {}
    }
  }
  Some(Driver::Hardware)
}

// -- the device, one per process -----------------------------------------------

struct Gpu {
  device: ID3D11Device,
  /// The immediate context. Not thread-safe, which is what the `Mutex`
  /// around this whole struct is for.
  context: ID3D11DeviceContext,
  video_device: ID3D11VideoDevice,
  video_context: ID3D11VideoContext,
  factory: IDXGIFactory2,
}

/// The first attempt's outcome, kept: a driver that cannot make a device
/// is asked once per process, not once per tile, and the answer is one
/// line in the log either way.
static GPU: OnceLock<Result<Mutex<Gpu>, String>> = OnceLock::new();

fn gpu(driver: Driver) -> Result<&'static Mutex<Gpu>, String> {
  GPU.get_or_init(|| Gpu::new(driver).map(Mutex::new)).as_ref().map_err(Clone::clone)
}

impl Gpu {
  fn new(driver: Driver) -> Result<Gpu, String> {
    let kind = match driver {
      Driver::Hardware => D3D_DRIVER_TYPE_HARDWARE,
      Driver::Warp => D3D_DRIVER_TYPE_WARP,
    };
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    // SAFETY: a plain creation call; every out-pointer is a local.
    unsafe {
      D3D11CreateDevice(
        None,
        kind,
        HMODULE::default(),
        // BGRA is the swap chain's format, and 10.0 is enough: the video
        // processor is a D3D11 feature of the runtime, not of the level.
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        Some(&[D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0]),
        D3D11_SDK_VERSION,
        Some(&mut device),
        None,
        Some(&mut context),
      )
      .map_err(|e| format!("D3D11CreateDevice ({driver:?}): {e}"))?;
    }
    let device = device.ok_or_else(|| "D3D11CreateDevice returned no device".to_string())?;
    let context = context.ok_or_else(|| "D3D11CreateDevice returned no context".to_string())?;
    // The adapter's name first, so every refusal below says *which* device
    // refused: a VM's "hardware" device is a real D3D11 device with no
    // video half, and the log has to be able to tell that from a GPU.
    // SAFETY: queries on live objects this function owns.
    let (factory, name) = unsafe {
      let dxgi: IDXGIDevice = device.cast().map_err(|e| format!("no IDXGIDevice: {e}"))?;
      let adapter = dxgi.GetAdapter().map_err(|e| format!("GetAdapter: {e}"))?;
      let name = adapter
        .GetDesc()
        .map(|d| String::from_utf16_lossy(&d.Description).trim_end_matches('\0').to_string())
        .unwrap_or_else(|_| "unnamed adapter".to_string());
      let factory: IDXGIFactory2 =
        adapter.GetParent().map_err(|e| format!("no IDXGIFactory2: {e}"))?;
      (factory, name)
    };
    let video_device: ID3D11VideoDevice =
      device.cast().map_err(|e| format!("{name}: no ID3D11VideoDevice: {e}"))?;
    let video_context: ID3D11VideoContext =
      context.cast().map_err(|e| format!("{name}: no ID3D11VideoContext: {e}"))?;
    // SAFETY: a query on a live device.
    let support = unsafe { device.CheckFormatSupport(DXGI_FORMAT_NV12) }
      .map_err(|e| format!("{name}: CheckFormatSupport(NV12): {e}"))?;
    // NV12 in is the whole contract; a device whose video processor cannot
    // take it is a GDI machine, and better said here than as a failed view.
    if support & D3D11_FORMAT_SUPPORT_VIDEO_PROCESSOR_INPUT.0 as u32 == 0 {
      return Err(format!("{name}: NV12 is not a video processor input on this device"));
    }
    log::info!("voice: tile presenter d3d11 on {name} ({driver:?})");
    Ok(Gpu { device, context, video_device, video_context, factory })
  }
}

// -- one window's presenter ----------------------------------------------------

pub struct Presenter {
  driver: Driver,
  swap: IDXGISwapChain1,
  /// The swap chain's size, physical px: the window's, as `set_rect` last
  /// placed it. A frame that arrives between a placement and the resize
  /// here is stretched for one frame by `DXGI_SCALING_STRETCH`, not lost.
  size: (i32, i32),
  source: Option<Source>,
}

/// Everything that depends on the source size or the window size, rebuilt
/// when either changes. Dropped *before* `ResizeBuffers`, because `output`
/// is a reference to the back buffer and the resize refuses while one
/// exists.
struct Source {
  width: u32,
  height: u32,
  /// Where the CPU writes. Staging is the one usage a CPU may map with no
  /// bind flag; a dynamic NV12 texture would save the copy below and needs
  /// a bind flag not every driver grants to a video format.
  staging: ID3D11Texture2D,
  /// Its default-usage twin, which is what the processor reads.
  texture: ID3D11Texture2D,
  input: ID3D11VideoProcessorInputView,
  output: ID3D11VideoProcessorOutputView,
  processor: ID3D11VideoProcessor,
}

/// `D3D11_VIDEO_PROCESSOR_COLOR_SPACE` is a bitfield: Usage:1, RGB_Range:1,
/// YCbCr_Matrix:1, YCbCr_xvYCC:1, Nominal_Range:2. This is BT.601
/// (matrix 0) at studio range (`D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235`
/// = 1, in bits 4-5) -- what libyuv's `nv12_to_argb` assumed on the GDI
/// path, so a side-by-side differs in nothing but the presenter.
const INPUT_COLOR_SPACE: u32 = 1 << 4;
/// Full-range RGB out, playback usage: every field zero.
const OUTPUT_COLOR_SPACE: u32 = 0;

impl Presenter {
  /// A swap chain for `hwnd`, sized to the window. DXGI is free-threaded,
  /// so this runs on the frame task; the window only has to exist.
  pub fn new(hwnd: usize, size: (i32, i32), driver: Driver) -> Result<Presenter, String> {
    let size = (size.0.max(1), size.1.max(1));
    let gpu = gpu(driver)?.lock().unwrap();
    let desc = DXGI_SWAP_CHAIN_DESC1 {
      Width: size.0 as u32,
      Height: size.1 as u32,
      Format: DXGI_FORMAT_B8G8R8A8_UNORM,
      Stereo: BOOL(0),
      SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
      BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
      // Two buffers and flip-discard: the compositor reads the swap chain
      // directly, and a `Present(1, …)` at 30 fps never waits, since a
      // buffer is always free by the next frame.
      BufferCount: 2,
      Scaling: DXGI_SCALING_STRETCH,
      SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
      AlphaMode: DXGI_ALPHA_MODE_UNSPECIFIED,
      Flags: 0,
    };
    // SAFETY: the HWND is a live window this process owns.
    let swap = unsafe {
      gpu.factory.CreateSwapChainForHwnd(&gpu.device, HWND(hwnd as *mut c_void), &desc, None, None)
    }
    .map_err(|e| format!("CreateSwapChainForHwnd: {e}"))?;
    Ok(Presenter { driver, swap, size, source: None })
  }

  /// One frame: the planes into the staging texture, a copy, the blt, a
  /// present. `size` is the window and `video` the picture's rect inside
  /// it (`Shared::video` in `render_win.rs`); the letterbox is the
  /// processor's destination rect and its background colour, which is how
  /// the bars come out black with no clear. `Ok(false)` is a frame with
  /// nowhere to go (a zero-sized picture), neither drawn nor dropped.
  pub fn present(
    &mut self,
    buffer: &BoxVideoBuffer,
    width: u32,
    height: u32,
    size: (i32, i32),
    video: (i32, i32, i32, i32),
  ) -> Result<bool, String> {
    if width < 2 || height < 2 || width % 2 != 0 || height % 2 != 0 {
      return Err(format!("{width}x{height} is not an NV12 size"));
    }
    let (vx, vy, vw, vh) = video;
    if vw <= 0 || vh <= 0 {
      return Ok(false);
    }
    let size = (size.0.max(1), size.1.max(1));
    let gpu = gpu(self.driver)?.lock().unwrap();
    // SAFETY: every call is on objects this presenter or the static owns,
    // under the context lock; the mapped pointer is used only between Map
    // and Unmap and never escapes.
    unsafe {
      if size != self.size {
        self.source = None;
        self
          .swap
          .ResizeBuffers(0, size.0 as u32, size.1 as u32, DXGI_FORMAT_UNKNOWN, DXGI_SWAP_CHAIN_FLAG(0))
          .map_err(|e| format!("ResizeBuffers to {}x{}: {e}", size.0, size.1))?;
        self.size = size;
      }
      if self.source.as_ref().map_or(true, |s| s.width != width || s.height != height) {
        self.source = Some(Source::new(&gpu, &self.swap, width, height, size)?);
      }
      let source = self.source.as_ref().unwrap();

      let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
      gpu
        .context
        .Map(&source.staging, 0, D3D11_MAP_WRITE, 0, Some(&mut mapped))
        .map_err(|e| format!("Map: {e}"))?;
      // An NV12 texture maps as one block: the Y plane, then the UV plane
      // starting at row `height`, both at `RowPitch`.
      let pitch = mapped.RowPitch as usize;
      let rows = height as usize;
      let chroma_rows = rows / 2;
      let base = mapped.pData as *mut u8;
      let y_out = std::slice::from_raw_parts_mut(base, pitch * rows);
      let uv_out = std::slice::from_raw_parts_mut(base.add(pitch * rows), pitch * chroma_rows);
      if let Some(nv12) = buffer.as_nv12() {
        // Already the texture's format: two plane copies, no conversion.
        let (src_y, src_uv) = nv12.data();
        let (sy, suv) = nv12.strides();
        let w = width as usize;
        for row in 0..rows {
          y_out[row * pitch..row * pitch + w]
            .copy_from_slice(&src_y[row * sy as usize..row * sy as usize + w]);
        }
        for row in 0..chroma_rows {
          uv_out[row * pitch..row * pitch + w]
            .copy_from_slice(&src_uv[row * suv as usize..row * suv as usize + w]);
        }
      } else {
        let i420 = buffer.to_i420();
        let (src_y, src_u, src_v) = i420.data();
        let (sy, su, sv) = i420.strides();
        yuv_helper::i420_to_nv12(
          src_y,
          sy,
          src_u,
          su,
          src_v,
          sv,
          y_out,
          pitch as u32,
          uv_out,
          pitch as u32,
          width as i32,
          height as i32,
        );
      }
      gpu.context.Unmap(&source.staging, 0);
      gpu.context.CopyResource(&source.texture, &source.staging);

      // Aspect fit, the same arithmetic as the GDI paint. A negative origin
      // (a tile poking out of its scroller) is fine: the processor clips
      // the destination to the target rect.
      let (dx, dy, dw, dh) = fit(width, height, vx, vy, vw, vh);
      let dest = RECT { left: dx, top: dy, right: dx + dw, bottom: dy + dh };
      let target = RECT { left: 0, top: 0, right: size.0, bottom: size.1 };
      gpu.video_context.VideoProcessorSetStreamDestRect(&source.processor, 0, true, Some(&dest));
      gpu.video_context.VideoProcessorSetOutputTargetRect(&source.processor, true, Some(&target));
      let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
        Enable: BOOL::from(true),
        pInputSurface: ManuallyDrop::new(Some(source.input.clone())),
        ..Default::default()
      };
      let blt = gpu.video_context.VideoProcessorBlt(
        &source.processor,
        &source.output,
        0,
        std::slice::from_ref(&stream),
      );
      ManuallyDrop::drop(&mut stream.pInputSurface);
      blt.map_err(|e| format!("VideoProcessorBlt: {e}"))?;
      self.swap.Present(1, DXGI_PRESENT(0)).ok().map_err(|e| format!("Present: {e}"))?;
    }
    Ok(true)
  }
}

impl Source {
  /// SAFETY: called under the context lock, on a live swap chain.
  unsafe fn new(
    gpu: &Gpu,
    swap: &IDXGISwapChain1,
    width: u32,
    height: u32,
    size: (i32, i32),
  ) -> Result<Source, String> {
    let texture = |usage: D3D11_USAGE, cpu: u32| -> Result<ID3D11Texture2D, String> {
      let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: usage,
        BindFlags: 0,
        CPUAccessFlags: cpu,
        MiscFlags: 0,
      };
      let mut out: Option<ID3D11Texture2D> = None;
      unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut out)) }
        .map_err(|e| format!("CreateTexture2D {width}x{height} NV12 ({usage:?}): {e}"))?;
      out.ok_or_else(|| "CreateTexture2D returned nothing".to_string())
    };
    let staging = texture(D3D11_USAGE_STAGING, D3D11_CPU_ACCESS_WRITE.0 as u32)?;
    let texture = texture(D3D11_USAGE_DEFAULT, 0)?;

    // The sizes are a hint to the driver's choice of processor, not a
    // contract; the rects set per frame are what it draws.
    let rate = DXGI_RATIONAL { Numerator: 30, Denominator: 1 };
    let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
      InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
      InputFrameRate: rate,
      InputWidth: width,
      InputHeight: height,
      OutputFrameRate: rate,
      OutputWidth: size.0 as u32,
      OutputHeight: size.1 as u32,
      Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    };
    let enumerator = gpu
      .video_device
      .CreateVideoProcessorEnumerator(&content)
      .map_err(|e| format!("CreateVideoProcessorEnumerator: {e}"))?;
    let processor = gpu
      .video_device
      .CreateVideoProcessor(&enumerator, 0)
      .map_err(|e| format!("CreateVideoProcessor: {e}"))?;

    let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
      FourCC: 0,
      ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
      Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
        Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 },
      },
    };
    let mut input: Option<ID3D11VideoProcessorInputView> = None;
    gpu
      .video_device
      .CreateVideoProcessorInputView(&texture, &enumerator, &input_desc, Some(&mut input))
      .map_err(|e| format!("CreateVideoProcessorInputView: {e}"))?;
    let input = input.ok_or_else(|| "CreateVideoProcessorInputView returned nothing".to_string())?;

    // Flip model: buffer 0 is always the one to draw on, so one view lasts
    // until the next resize.
    let back: ID3D11Texture2D = swap.GetBuffer(0).map_err(|e| format!("GetBuffer(0): {e}"))?;
    let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
      ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
      Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
        Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
      },
    };
    let mut output: Option<ID3D11VideoProcessorOutputView> = None;
    gpu
      .video_device
      .CreateVideoProcessorOutputView(&back, &enumerator, &output_desc, Some(&mut output))
      .map_err(|e| format!("CreateVideoProcessorOutputView: {e}"))?;
    let output = output.ok_or_else(|| "CreateVideoProcessorOutputView returned nothing".to_string())?;

    let input_space = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: INPUT_COLOR_SPACE };
    gpu.video_context.VideoProcessorSetStreamColorSpace(&processor, 0, &input_space);
    let output_space = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: OUTPUT_COLOR_SPACE };
    gpu.video_context.VideoProcessorSetOutputColorSpace(&processor, &output_space);
    let black = D3D11_VIDEO_COLOR {
      Anonymous: D3D11_VIDEO_COLOR_0 { RGBA: D3D11_VIDEO_COLOR_RGBA { R: 0.0, G: 0.0, B: 0.0, A: 1.0 } },
    };
    gpu.video_context.VideoProcessorSetOutputBackgroundColor(&processor, false, &black);

    Ok(Source { width, height, staging, texture, input, output, processor })
  }
}

/// Aspect fit of a `fw`x`fh` picture into the rect `(vx, vy, vw, vh)`,
/// centred: `(x, y, width, height)`. Kept identical to the GDI paint's so
/// the two presenters put the picture on the same pixels.
fn fit(fw: u32, fh: u32, vx: i32, vy: i32, vw: i32, vh: i32) -> (i32, i32, i32, i32) {
  let (fw, fh) = (fw as f64, fh as f64);
  let scale = (vw as f64 / fw).min(vh as f64 / fh);
  let dw = (fw * scale).round().max(1.0) as i32;
  let dh = (fh * scale).round().max(1.0) as i32;
  (vx + (vw - dw) / 2, vy + (vh - dh) / 2, dw, dh)
}
