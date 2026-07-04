<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/branding/dark-logo-github.png">
  <source media="(prefers-color-scheme: light)" srcset="public/branding/light-logo-github.png">
  <img alt="Wazplay logo" src="public/branding/light-logo-github.png">
</picture>

# Wazplay

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![Rust](https://img.shields.io/badge/rust-2024-CE422B?logo=rust&logoColor=white)](Cargo.toml)
[![WebAssembly](https://img.shields.io/badge/wasm-wasm--pack-654FF0?logo=webassembly&logoColor=white)](https://rustwasm.github.io/wasm-pack/)
[![TypeScript](https://img.shields.io/badge/typescript-5.7-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![React](https://img.shields.io/badge/react-19-61DAFB?logo=react&logoColor=black)](package.json)
[![Vite](https://img.shields.io/badge/vite-6-646CFF?logo=vite&logoColor=white)](vite.config.ts)

Wazplay is a browser-based **video editor** built on a set of Rust/WebAssembly
media modules — no server-side transcoding, no uploads. Each crate is a
focused, standalone WASM module (media probing, loudness, waveforms, keyframe
scanning, EDL/timeline math) that the React editor UI is built on top of.

> The editor still cannot preview or export composited video — there is no
> playback engine or encoder wired up yet. Import, arrange, cut, and analyze
> work end-to-end; render/export is the next milestone.

## Quick start

Requires Node 20+, Rust, and [`wasm-pack`](https://rustwasm.github.io/wasm-pack/).

```bash
npm install
npm run dev      # builds any missing WASM packages, then starts Vite
```

Open the printed URL — normally **http://localhost:5173/**.

That's it. `npm run dev` automatically compiles any missing WASM crate (via
`wasm-pack`) before starting the Vite dev server with hot reload, so there's
no separate "build the Rust part" step to remember.

Other useful scripts:

```bash
npm run build       # production build to dist/ (typechecks first)
npm run preview     # serve the production build locally
npm run wasm        # force-rebuild every WASM crate
npm run typecheck   # tsc --noEmit only
cargo test --workspace   # Rust test suite for all crates
```

## Why WASM modules instead of one big app

Video editing in the browser needs a few hard things done fast and without
blocking the UI: parsing containers, measuring loudness, decoding waveforms,
locating keyframes, and keeping frame-accurate timeline math correct. Each of
those is implemented as its own small Rust crate compiled to WASM, so the
frontend can pull in just the pieces it needs.

## Project layout

```
crates/               Rust workspace — one crate per WASM module
  waz-stinger-wasm/          media probe + loudness (EBU R128 / LUFS)
  waz-wave-wasm/    waveform peak extraction
  waz-strip-wasm/        MP4 keyframe scanner (no video decode)
  waz-edl-wasm/          EDL / timeline engine (not yet wired into the UI)

src/                   React + TypeScript app
  wasm/                  the WASM boundary: worker, typed client, thumbnails
    pkg/                   wasm-pack output (generated, gitignored)
  lib/                   pure helpers (timeline math, color, formatting)
  store/                 Zustand editor store
  hooks/                 import, zoom, transport, marquee, shortcuts
  context/               shares viewport ref + zoom/transport controllers
  components/            TopBar, MediaBin, Preview, Timeline, Clip, …
  styles/                global stylesheet

public/sample-files/  small test clips used during development
scripts/build-wasm.mjs Rust → WASM build step, run before dev/build
```

Every crate exposes both **whole-buffer** functions (`&[u8]` in, for small
files or tests) and **streaming** functions (a `(offset, len) => Uint8Array`
JS callback + file length) so multi-gigabyte source files never have to be
fully loaded into memory. See [Streaming architecture](#streaming-architecture-workerfs)
below.

### waz-stinger-wasm

```rust
get_media_info(bytes) -> JSON string             // container, codecs, channels, sample rate, bit depth
measure_lufs_from_bytes(bytes) -> f64             // integrated LUFS from raw file bytes
measure_lufs(samples, sample_rate, channels) -> f64  // LUFS from pre-decoded interleaved f32 PCM
gain_to_target(measured_lufs, target_lufs) -> f64 // dB/LU needed to hit a loudness target

// streaming variants
get_media_info_streaming(read_fn, file_len) -> JSON string
measure_lufs_streaming(read_fn, file_len) -> f64
```

### waz-wave-wasm

```rust
extract_peaks(audio_bytes, num_peaks) -> Vec<f32>            // peak amplitude per bucket, [0.0, 1.0]
extract_peaks_streaming(read_fn, file_len, num_peaks) -> Vec<f32>
```

### waz-strip-wasm

```rust
scan_keyframes(mp4_bytes) -> JSON string             // codec config + keyframe { timestamp, byte_offset, byte_length }[]
get_keyframe_bytes(mp4_bytes, byte_offset, byte_length) -> Vec<u8>
select_thumbnail_keyframes(scan_result_json, count) -> JSON indices  // evenly spaced across duration

// streaming variants (reads only the `moov` box — the video payload is never touched)
scan_keyframes_streaming(read_fn, file_len) -> JSON string
get_keyframe_bytes_streaming(read_fn, byte_offset, byte_length) -> Vec<u8>
```

### waz-edl-wasm

A **stateless** EDL exporter. The editor store (`src/store/editorStore.ts`) is
the single source of truth and does all interactive editing; this crate is a
pure transform that takes a project snapshot as JSON and produces an EDL
(frame-accurate events + a best-effort FFmpeg `filter_complex` and command) for
**external use** — real FFmpeg, other tools.

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
start_s, in_s, dur_s, z }`. The model matches the app's current capabilities
(cut, arrange, link/detach A/V) — no transitions or speed changes yet. The
`ffmpeg` section composites video clips over a black base with `overlay`
(gaps → black, overlaps resolve by `z`) and places audio with `adelay`/`amix`.

Not yet wired into the UI — this is the first half of the export pipeline; the
in-browser WebCodecs render step will consume the same event list.

## Streaming architecture (WorkerFS)

Reading a whole file into a JS `ArrayBuffer` and handing it to WASM works for
small clips, but breaks down for real video: `file.arrayBuffer()` can reject
or exhaust memory on multi-gigabyte files, and copying the buffer across the
JS↔WASM boundary multiplies memory use.

Instead:

- [`src/wasm/wazWorker.ts`](src/wasm/wazWorker.ts) is a module Web Worker
  that owns a `File` handle and reads arbitrary byte ranges from it
  synchronously with
  [`FileReaderSync`](https://developer.mozilla.org/en-US/docs/Web/API/FileReaderSync)
  (only available inside workers).
- Each crate's streaming export takes a `(offset, len) => Uint8Array`
  callback. On the Rust side, `JsReader` (`crates/waz-stinger-wasm/src/reader.rs`,
  `crates/waz-wave-wasm/src/reader.rs`) implements `Read + Seek` (a
  symphonia `MediaSource`) on top of that callback, so `symphonia` decodes
  audio packet-by-packet without ever holding the full file in memory.
- `waz-strip-wasm`'s streaming scan walks the top-level MP4 boxes and reads
  **only the `moov` box** — the (potentially huge) `mdat` payload is never
  read at all.
- [`src/wasm/wazClient.ts`](src/wasm/wazClient.ts) is the main-thread RPC
  client: it posts the `File` (a cheap by-reference structured clone) to the
  worker and gets back typed results as promises.

Net effect: peak memory stays roughly flat regardless of whether the input
is 10 MB or 10 GB.

## WASM build output

WASM output is generated into `src/wasm/pkg/` by
[`scripts/build-wasm.mjs`](scripts/build-wasm.mjs) (gitignored — rebuilt on
demand). `waz-edl-wasm` is part of the Cargo workspace and test suite but has
no JS bindings built yet, since it isn't wired into the UI.

## Editor UI

The editor is a single-layer (one video track, one audio track) timeline:
multi-file import, per-source colours shared between a file's linked
video/audio clips, drag-to-arrange with snapping, marquee multi-select, a
playhead-anchored razor that cuts linked audio/video together, zoom-to-fit on
a timeline that expands to cover long media, and an import lock that waits
for waveform/thumbnail decoding to finish before unlocking the UI.

A per-source **Analyze media** panel (folded into the editor as a modal —
see `src/components/AnalyzerPanel.tsx`) shows codec/container info,
integrated loudness (EBU R128 / LUFS) with gain-to-target, the decoded
waveform, and timeline thumbnails, reusing the same decoded data as the
timeline.

Clips cannot yet be previewed or played back as composited video, and there
is no export/render step — that's the next layer to build on top of the WASM
modules above.

## License

Wazplay is licensed under the [MIT License](LICENSE) — free to use, modify,
and distribute, with no restrictions. A commercial/hosted version of Wazplay
may be offered in the future as a separate product; it will not change the
terms of this open-source release.
