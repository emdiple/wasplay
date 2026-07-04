<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/branding/dark-logo-github.png">
  <source media="(prefers-color-scheme: light)" srcset="public/branding/light-logo-github.png">
  <img alt="Wazplay" src="public/branding/light-logo-github.png" width="480">
</picture>

### A professional-grade video editor that runs entirely in your browser

**No installs. No plugins. No FFmpeg. No cloud, no accounts, no uploads.** Just
open a tab and edit — powered by Rust compiled to WebAssembly.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![Rust](https://img.shields.io/badge/rust-2024-CE422B?logo=rust&logoColor=white)](Cargo.toml)
[![WebAssembly](https://img.shields.io/badge/wasm-wasm--pack-654FF0?logo=webassembly&logoColor=white)](https://rustwasm.github.io/wasm-pack/)
[![TypeScript](https://img.shields.io/badge/typescript-5.7-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![React](https://img.shields.io/badge/react-19-61DAFB?logo=react&logoColor=black)](package.json)
[![Vite](https://img.shields.io/badge/vite-6-646CFF?logo=vite&logoColor=white)](vite.config.ts)
[![WebCodecs](https://img.shields.io/badge/render-WebCodecs-FF6F00)](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)

</div>

---

## Overview

**Wazplay** is a browser-based non-linear video editor built on a set of
focused Rust/WebAssembly media modules. **Files never leave the machine** —
probing, loudness analysis, waveform decoding, keyframe scanning, timeline
math, and the final render all run client-side, with **no server, no FFmpeg
binary, and no external services** in the loop. Import, arrange, cut, analyze,
and **export a real MP4/WebM file end-to-end — entirely in the browser, and
fully offline-capable** once loaded.

The heavy lifting is split into small, single-purpose Rust crates compiled to
WASM, each streaming source files byte-range by byte-range so **multi-gigabyte
media stays at flat memory** regardless of input size (see
[Streaming architecture](#streaming-architecture)). Rendering runs on the
[WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
for **hardware-accelerated export with no native dependencies**.

> **Project status — active development.** Editing, analysis, and export are
> functional end-to-end. Live preview during playback is a single-clip program
> monitor (it plays whichever clip sits under the playhead) rather than a fully
> composited multi-layer render — see the [Roadmap](#roadmap).

## Features

- **100% client-side, zero dependencies** — no uploads, no backend, no transcoding server, **no native install and no FFmpeg to set up**; works offline once loaded.
- **Handles huge files** — a streaming Rust/WASM core keeps **memory flat whether the source is 10 MB or 10 GB**, so multi-gigabyte clips import without exhausting the tab.
- **Multi-format import** — drag in multiple audio/video files at once; each source gets a colour shared by its linked video and audio clips.
- **Non-linear timeline** — single-layer (one video track, one audio track) editing: drag-to-arrange with snapping, marquee multi-select, a playhead-anchored razor that cuts linked A/V together, and zoom-to-fit on a timeline that scales to long media.
- **Broadcast-grade audio analysis** — per-source panel with container/codec info, **integrated loudness (EBU R128 / LUFS) with gain-to-target**, decoded waveforms, and keyframe thumbnails, all reusing the same decoded data as the timeline. Per-source and per-clip gain (dB) driven by real LUFS measurement.
- **Real export, in the browser, two ways:**
  - **Render** the timeline to a downloadable **MP4** (H.264 / AAC) or **WebM** (VP9 or VP8 / Opus) entirely in-browser via the **hardware-accelerated WebCodecs API**, muxed on the client, with a native save-location picker where supported.
  - **Frame-accurate EDL export** — a JSON edit list plus a best-effort FFmpeg `filter_complex` command, for finishing in external tools.
- **Session persistence** — projects survive reloads (IndexedDB + `localStorage`); resizable, responsive workspace panels.

## Quick start

**Prerequisites:** [Node.js](https://nodejs.org/) 20+, a
[Rust](https://www.rust-lang.org/tools/install) toolchain, and
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/).

```bash
npm install
npm run dev
```

Open the printed URL — normally **http://localhost:5173/**.

`npm run dev` compiles any missing WASM crate (via `wasm-pack`) before starting
the Vite dev server with hot reload, so there is no separate "build the Rust
part" step to remember.

### Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Build missing WASM crates, then start the Vite dev server |
| `npm run build` | Production build to `dist/` (typechecks first) |
| `npm run preview` | Serve the production build locally |
| `npm run wasm` | Force-rebuild every WASM crate |
| `npm run typecheck` | `tsc --noEmit` only |
| `cargo test --workspace` | Rust test suite for all crates |

## Architecture

### Why standalone WASM modules

Editing video in the browser demands a few hard things done fast and without
blocking the UI: parsing containers, measuring loudness, decoding waveforms,
locating keyframes, and keeping frame-accurate timeline math correct. Each is
implemented as its own small Rust crate compiled to WASM, so the frontend pulls
in only the pieces it needs. Every crate exposes both **whole-buffer**
functions (`&[u8]` in, for small files and tests) and **streaming** functions
(a `(offset, len) => Uint8Array` callback + file length) so huge sources are
never fully loaded into memory.

| Crate | Responsibility |
| --- | --- |
| [`waz-stinger-wasm`](crates/waz-stinger-wasm) | Media probe + loudness (EBU R128 / LUFS) |
| [`waz-wave-wasm`](crates/waz-wave-wasm) | Waveform peak extraction |
| [`waz-strip-wasm`](crates/waz-strip-wasm) | MP4 keyframe scanner (no video decode) |
| [`waz-edl-wasm`](crates/waz-edl-wasm) | Stateless EDL / timeline export engine |

<details>
<summary><strong>Module APIs</strong></summary>

#### waz-stinger-wasm

```rust
get_media_info(bytes) -> JSON string                  // container, codecs, channels, sample rate, bit depth
measure_lufs_from_bytes(bytes) -> f64                 // integrated LUFS from raw file bytes
measure_lufs(samples, sample_rate, channels) -> f64   // LUFS from pre-decoded interleaved f32 PCM
gain_to_target(measured_lufs, target_lufs) -> f64     // dB/LU needed to hit a loudness target

// streaming variants
get_media_info_streaming(read_fn, file_len) -> JSON string
measure_lufs_streaming(read_fn, file_len) -> f64
```

#### waz-wave-wasm

```rust
extract_peaks(audio_bytes, num_peaks) -> Vec<f32>     // peak amplitude per bucket, [0.0, 1.0]
extract_peaks_streaming(read_fn, file_len, num_peaks) -> Vec<f32>
```

#### waz-strip-wasm

```rust
scan_keyframes(mp4_bytes) -> JSON string              // codec config + keyframe { timestamp, byte_offset, byte_length }[]
get_keyframe_bytes(mp4_bytes, byte_offset, byte_length) -> Vec<u8>
select_thumbnail_keyframes(scan_result_json, count) -> JSON indices  // evenly spaced across duration

// streaming variants (reads only the `moov` box — the video payload is never touched)
scan_keyframes_streaming(read_fn, file_len) -> JSON string
get_keyframe_bytes_streaming(read_fn, byte_offset, byte_length) -> Vec<u8>
```

#### waz-edl-wasm

A **stateless** EDL exporter. The editor store (`src/store/editorStore.ts`) is
the single source of truth and does all interactive editing; this crate is a
pure transform that takes a project snapshot as JSON and produces a
frame-accurate EDL (events + a best-effort FFmpeg `filter_complex` and command)
for external use.

```rust
export_edl(project_json) -> JSON   // { sources, video_events, audio_events, total_*, ffmpeg }
validate(project_json) -> JSON     // { valid, errors[], warnings[] }

// frame-time helpers
snap_to_frame(time_s, fps_num, fps_den) -> f64
seconds_to_frames(time_s, fps_num, fps_den) -> i64
frames_to_seconds(frames, fps_num, fps_den) -> f64
```

The input `project_json` mirrors the store's shape: `{ fps, sources[],
video_clips[], audio_clips[] }`, where each clip is `{ id, source_id, link,
start_s, in_s, dur_s, z }`. The `ffmpeg` section composites video over a black
base with `overlay` (gaps → black, overlaps resolve by `z`) and places audio
with `adelay`/`amix`. The in-browser WebCodecs renderer consumes the same event
list.

</details>

### Streaming architecture

Reading a whole file into a JS `ArrayBuffer` and handing it to WASM works for
small clips but breaks down for real video: `file.arrayBuffer()` can reject or
exhaust memory on multi-gigabyte files, and copying the buffer across the
JS↔WASM boundary multiplies memory use. Instead:

- [`src/wasm/wazWorker.ts`](src/wasm/wazWorker.ts) is a module Web Worker that
  owns a `File` handle and reads arbitrary byte ranges from it synchronously
  with [`FileReaderSync`](https://developer.mozilla.org/en-US/docs/Web/API/FileReaderSync)
  (only available inside workers).
- Each crate's streaming export takes a `(offset, len) => Uint8Array` callback.
  On the Rust side, `JsReader` implements `Read + Seek` (a `symphonia`
  `MediaSource`) on top of that callback, so audio decodes packet-by-packet
  without ever holding the full file in memory.
- `waz-strip-wasm`'s streaming scan walks the top-level MP4 boxes and reads
  **only the `moov` box** — the (potentially huge) `mdat` payload is never
  touched.
- [`src/wasm/wazClient.ts`](src/wasm/wazClient.ts) is the main-thread RPC
  client: it posts the `File` (a cheap by-reference structured clone) to the
  worker and gets typed results back as promises.

**Net effect:** peak memory stays roughly flat whether the input is 10 MB or
10 GB.

### Project structure

```
crates/                 Rust workspace — one crate per WASM module
  waz-stinger-wasm/        media probe + loudness (EBU R128 / LUFS)
  waz-wave-wasm/           waveform peak extraction
  waz-strip-wasm/          MP4 keyframe scanner (no video decode)
  waz-edl-wasm/            EDL / timeline export engine

src/                    React + TypeScript app
  wasm/                   the WASM boundary: worker, typed client, thumbnails
    pkg/                    wasm-pack output (generated, gitignored)
  export/                 WebCodecs render + mux pipeline (MP4 / WebM)
  lib/                    pure helpers (timeline math, colour, formatting)
  store/                  Zustand editor store + persistence
  hooks/                  import, zoom, transport, marquee, shortcuts
  context/                shares viewport ref + zoom/transport controllers
  components/             TopBar, MediaBin, Preview, Timeline, Inspector, …
  styles/                 global stylesheet

public/sample-files/    small test clips used during development
scripts/build-wasm.mjs  Rust → WASM build step, run before dev/build
```

WASM output is generated into `src/wasm/pkg/` by
[`scripts/build-wasm.mjs`](scripts/build-wasm.mjs) (gitignored — rebuilt on
demand).

## Roadmap

- **Composited live preview** — a true program monitor that renders the mixed timeline in real time, rather than the current single-clip-under-playhead preview.
- **Multi-track timeline** — more than one video/audio layer.
- **Transitions & effects** — cross-dissolves, speed changes, filters.
- **Worker-based render** — move the export render loop fully off the main thread for a consistently responsive UI on long timelines.

## Contributing

Issues and pull requests are welcome. For local development, follow the
[Quick start](#quick-start); `cargo test --workspace` covers the Rust crates
and `npm run typecheck` the frontend.

## License

Wazplay is released under the [MIT License](LICENSE) — free to use, modify, and
distribute, with no restrictions. A commercial/hosted version of Wazplay may be
offered in the future as a separate product; that will not change the terms of
this open-source release.
