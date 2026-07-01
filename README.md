# Shadowfox WASM Toolkit

Shadowfox is a set of Rust/WebAssembly tools for building a **web-based video
editor** that runs entirely in the browser — no server-side transcoding, no
uploads. Each crate is a focused, standalone WASM module (media probing,
loudness, waveforms, keyframe scanning, EDL/timeline math) that a real editor
UI can be built on top of.

> **The editor page in this repo (`index.html` / `main.js`) is a mock.** It
> exists to exercise the WASM modules end-to-end and demonstrate the intended
> UX (import, arrange, cut, mix), but it does not actually render or export
> video — there is no playback engine or encoder wired up. Treat it as a
> reference harness, not a product.

## Why WASM modules instead of one big app

Video editing in the browser needs a few hard things done fast and without
blocking the UI: parsing containers, measuring loudness, decoding waveforms,
locating keyframes, and keeping frame-accurate timeline math correct. Each of
those is implemented as its own small Rust crate compiled to WASM, so any
frontend (this mock, or a real one) can pull in just the pieces it needs.

## The crates

| Crate | Purpose |
|---|---|
| [`fox-ear-wasm`](fox-ear-wasm) | Probes container/codec info and measures integrated loudness (EBU R128 / LUFS) via [symphonia](https://github.com/pdeljanov/Symphonia) + [ebur128](https://crates.io/crates/ebur128). |
| [`fox-soundwave-wasm`](fox-soundwave-wasm) | Decodes audio and extracts peak-amplitude waveform data for rendering on a `<canvas>`. |
| [`fox-strip-wasm`](fox-strip-wasm) | A from-scratch ISOBMFF (MP4) box parser that locates keyframe byte offsets without decoding any video, so the browser's WebCodecs API can hardware-decode just the frames needed for timeline thumbnails. |
| [`fox-edl-wasm`](fox-edl-wasm) | An Edit Decision List engine: frame-accurate clip/transition state, timeline validation, and FFmpeg-compatible `filter_complex` export. Not yet wired into the mock UI. |

Every crate exposes both **whole-buffer** functions (`&[u8]` in, for small
files or tests) and **streaming** functions (a `(offset, len) => Uint8Array`
JS callback + file length) so multi-gigabyte source files never have to be
fully loaded into memory. See [Streaming architecture](#streaming-architecture-workerfs)
below.

### fox-ear-wasm

```rust
get_media_info(bytes) -> JSON string             // container, codecs, channels, sample rate, bit depth
measure_lufs_from_bytes(bytes) -> f64             // integrated LUFS from raw file bytes
measure_lufs(samples, sample_rate, channels) -> f64  // LUFS from pre-decoded interleaved f32 PCM
gain_to_target(measured_lufs, target_lufs) -> f64 // dB/LU needed to hit a loudness target

// streaming variants
get_media_info_streaming(read_fn, file_len) -> JSON string
measure_lufs_streaming(read_fn, file_len) -> f64
```

### fox-soundwave-wasm

```rust
extract_peaks(audio_bytes, num_peaks) -> Vec<f32>            // peak amplitude per bucket, [0.0, 1.0]
extract_peaks_streaming(read_fn, file_len, num_peaks) -> Vec<f32>
```

### fox-strip-wasm

```rust
scan_keyframes(mp4_bytes) -> JSON string             // codec config + keyframe { timestamp, byte_offset, byte_length }[]
get_keyframe_bytes(mp4_bytes, byte_offset, byte_length) -> Vec<u8>
select_thumbnail_keyframes(scan_result_json, count) -> JSON indices  // evenly spaced across duration

// streaming variants (reads only the `moov` box — the video payload is never touched)
scan_keyframes_streaming(read_fn, file_len) -> JSON string
get_keyframe_bytes_streaming(read_fn, byte_offset, byte_length) -> Vec<u8>
```

### fox-edl-wasm

A stateful `Timeline` object (frame-snapped to a given fps):

```rust
Timeline::new(fps_num, fps_den)
add_clip(source_id, source_in_s, source_out_s, timeline_in_s, video_track) -> clip_id
trim_clip(clip_id, new_source_in_s, new_source_out_s)
cut_clip(clip_id, cut_time_s) -> new_clip_id
move_clip(clip_id, new_timeline_in_s)
delete_clip(clip_id)
set_clip_speed(clip_id, speed)
set_clip_muted(clip_id, muted)
add_transition(from_clip_id, to_clip_id, kind, duration_s) -> transition_id  // fade | wipe | slide | zoom
delete_transition(transition_id)
validate() -> JSON { valid, errors[], warnings[] }
export_edl() -> JSON (includes an FFmpeg filter_complex string + suggested command)
to_json() / Timeline::from_json(json)                 // undo/redo, persistence
```

Plus free functions for frame math: `snap_to_frame`, `seconds_to_frames`,
`frames_to_seconds`.

## Streaming architecture (WorkerFS)

Reading a whole file into a JS `ArrayBuffer` and handing it to WASM works for
small clips, but breaks down for real video: `file.arrayBuffer()` can reject
or exhaust memory on multi-gigabyte files, and copying the buffer across the
JS↔WASM boundary multiplies memory use.

Instead:

- [`fox-worker.js`](fox-worker.js) is a module Web Worker that owns a `File`
  handle and reads arbitrary byte ranges from it synchronously with
  [`FileReaderSync`](https://developer.mozilla.org/en-US/docs/Web/API/FileReaderSync)
  (only available inside workers).
- Each crate's streaming export takes a `(offset, len) => Uint8Array`
  callback. On the Rust side, [`JsReader`](fox-ear-wasm/src/reader.rs)
  implements `Read + Seek` (a symphonia `MediaSource`) on top of that
  callback, so `symphonia` decodes audio packet-by-packet without ever
  holding the full file in memory.
- `fox-strip-wasm`'s streaming scan walks the top-level MP4 boxes and reads
  **only the `moov` box** — the (potentially huge) `mdat` payload is never
  read at all.
- [`fox-worker-client.js`](fox-worker-client.js) is the main-thread RPC
  client: it posts the `File` (a cheap by-reference structured clone) to the
  worker and gets back parsed results as promises.

Net effect: peak memory stays roughly flat regardless of whether the input
is 10 MB or 10 GB.

## Layout

```
fox-ear-wasm/        media probe + loudness (crate)
fox-soundwave-wasm/  waveform peaks (crate)
fox-strip-wasm/      MP4 keyframe scanner (crate)
fox-edl-wasm/        EDL / timeline engine (crate)

fox-worker.js         Web Worker hosting all four WASM modules
fox-worker-client.js  main-thread RPC client for the worker
fox-strip.js          keyframe thumbnail generation (WebCodecs fast path + <video>-seek fallback)

index.html, main.js   mock single-layer editor UI (see disclaimer above)
analyze.html          minimal single-file page: codec info, LUFS, waveform, timeline thumbnails
debug.html            manual pipeline debug page for fox-strip-wasm
sample-files/         small test clips used during development
```

## Building

Each crate is built independently with [`wasm-pack`](https://rustwasm.github.io/wasm-pack/):

```bash
wasm-pack build fox-ear-wasm       --target web
wasm-pack build fox-soundwave-wasm --target web
wasm-pack build fox-strip-wasm     --target web
wasm-pack build fox-edl-wasm       --target web
```

This generates a `pkg/` directory per crate (gitignored) containing the
`.wasm` binary and JS glue that `fox-worker.js` / `analyze.html` import
directly. **The pages will not load until these are built.**

Run the Rust test suite for all crates:

```bash
cargo test --workspace
```

## Running

Module workers require a real origin — `file://` won't work. Serve the repo
root over HTTP:

```bash
python3 -m http.server 8000
```

Then open:

- `http://localhost:8000/analyze.html` — minimal analyzer (single file →
  codec info, LUFS, waveform, timeline thumbnails)
- `http://localhost:8000/index.html` — the mock editor UI
- `http://localhost:8000/debug.html` — manual step-by-step debug page for
  `fox-strip-wasm`

## Mock editor UI

`index.html` / `main.js` demonstrate a single-layer (one video track, one
audio track) timeline: multi-file import, per-source colours shared between
a file's linked video/audio clips, drag-to-arrange with snapping, marquee
multi-select, a playhead-anchored razor that cuts linked audio/video
together, zoom-to-fit on a timeline that expands to cover long media, and an
import lock that waits for waveform/thumbnail decoding to finish before
unlocking the UI.

It is **not** a working editor: clips cannot be previewed or played back as
composited video, and there is no export/render step. It's a UI shell built
to prove out how the WASM modules above would be driven by a real editor.
