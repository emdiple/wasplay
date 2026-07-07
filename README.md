<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/branding/icon-circle-light.png">
  <source media="(prefers-color-scheme: light)" srcset="public/branding/icon-circle-dark.png">
  <img alt="Wazplay" src="public/branding/icon-circle-dark.png" width="220">
</picture>

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/branding/wordmark-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="public/branding/wordmark-light.png">
  <img alt="Wazplay" src="public/branding/wordmark-light.png" width="220">
</picture>

### A high-performance, browser-native video editor powered by WebAssembly and Rust.

**Zero installation. Zero server-side dependencies. Zero data tracking.** Edit high-resolution video instantly in a single browser tab. By leveraging Rust compiled to WebAssembly, all rendering and processing happen entirely client-side—eliminating the need for cloud uploads, external plugins, or native FFmpeg binaries.

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

## Table of contents

- [Overview](#overview)
- [Features](#features)
- [Quick start](#quick-start)
- [Using the editor](#using-the-editor)
- [Browser support](#browser-support)
- [Architecture](#architecture)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

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
[Architecture](#architecture)). Rendering runs on the
[WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
for **hardware-accelerated export with no native dependencies**.

> **Project status — active development.** Editing, analysis, and export are
> functional end-to-end, including a live program monitor that follows the
> playhead and a hardware-accelerated render pipeline. Per-clip **fades and
> cross-dissolves** preview live and render on export, and the timeline is
> **multi-layer** (add/remove video and audio tracks; higher video layers
> composite on top). A broader effects set and a single unified WYSIWYG
> compositor are on the [Roadmap](#roadmap).

## Features

- **100% client-side, no native dependencies** — no uploads, no backend, no transcoding server, **no native install and no FFmpeg to set up**; works offline once loaded.
- **Handles huge files** — a streaming Rust/WASM core keeps **memory flat whether the source is 10 MB or 10 GB**, so multi-gigabyte clips import without exhausting the tab.
- **Multi-format import** — drag in multiple audio/video files at once; each source gets a colour shared by its linked video and audio clips.
- **Non-linear, multi-layer timeline** — add/remove video and audio tracks (V2 composites above V1; every audio layer mixes on export): drag-to-arrange with snapping and vertical moves between layers, marquee multi-select, a playhead-anchored razor that cuts linked A/V together, and zoom-to-fit on a timeline that scales to long media.
- **Fades & cross-dissolves** — per-clip fade-in/out (picture to black, sound to silence) and explicit cross-dissolves between adjacent clips, added from the clip menu or Inspector. Both **preview live** in the program monitor (layered video + audio ramps) and render identically on export.
- **Broadcast-grade audio analysis** — per-source panel with container/codec info, **integrated loudness (EBU R128 / LUFS) with gain-to-target**, decoded waveforms, and keyframe thumbnails, all reusing the same decoded data as the timeline. Per-source and per-clip gain (dB) driven by real LUFS measurement, with a **user-editable normalize target** stored as an app default.
- **Pro-style Inspector** — a context-aware properties panel with a clip identity header and collapsible groups (Info, Fades, Transition, Audio), mirroring the layout of desktop NLE inspectors.
- **Real export, in the browser, two ways:**
  - **Render** the timeline to a downloadable **MP4** (AV1 or HEVC where hardware-encoded, else H.264 / AAC) or **WebM** (AV1, VP9 or VP8 / Opus) entirely in-browser via the **hardware-accelerated WebCodecs API**, muxed on the client, with a native save-location picker where supported.
  - **Frame-accurate EDL export** — a JSON edit list plus a best-effort FFmpeg `filter_complex` command, for finishing in external tools.
- **Session persistence** — the whole project (media, layers, clips, effects, editing defaults) survives reloads via IndexedDB + `localStorage`; resizable, responsive workspace panels; 100-level undo/redo.

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

## Using the editor

**Workflow:** drag media into the bin → drop it on a timeline layer → arrange,
cut, and layer clips → add fades/dissolves from the clip's right-click menu or
the Inspector → adjust levels (or Normalize to a LUFS target) → Export.

- **Layers** — add tracks with the **＋V / ＋A** toolbar buttons; remove one via
  the **✕** on its gutter label (hover). Drag clips **vertically** to move them
  between layers of the same kind; higher video layers composite on top.
- **Fades** — select a clip and set Fade In / Fade Out (seconds) in the
  Inspector; picture fades from/to black, audio ramps from/to silence.
- **Cross-dissolve** — right-click the *second* of two adjacent clips → **Add
  dissolve** (or use the Inspector's Transition group). The incoming group
  ripple-slides onto the previous clip so real frames overlap; tune the length
  in the Inspector.
- **Loudness** — the Inspector's Audio group shows measured LUFS per source;
  **Normalize** sets each selected clip's gain to reach the target, and the
  target itself is editable (stored as an app default).

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> | Play / pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Step one frame |
| <kbd>Home</kbd> / <kbd>End</kbd> | Jump to start / end |
| <kbd>V</kbd> | Select tool |
| <kbd>C</kbd> | Razor (cut) tool |
| <kbd>S</kbd> | Split at playhead |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd> | Delete selection |
| <kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd> | Undo |
| <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Redo |
| <kbd>⇧</kbd>+click / marquee | Additive select |

## Browser support

Wazplay leans on modern web-platform APIs, so it runs best in **Chromium-based
browsers (Chrome, Edge, Brave, …)**, where every feature — including export —
is fully supported.

| Capability | Used for | Support |
| --- | --- | --- |
| [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) | Hardware decode/encode for the render pipeline | Full in Chromium; partial/limited elsewhere |
| [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) | Compositing render frames | Chromium, Firefox, Safari 16.4+ |
| [File System Access](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) | "Save to…" location picker on export | Chromium only — **falls back to a normal download elsewhere** |
| Web Workers + `FileReaderSync` | Streaming large-file reads | All modern browsers |

Import, editing, and analysis work across modern browsers; **in-browser
export currently requires WebCodecs encode support, so a Chromium browser is
recommended** for the full workflow. Feature detection is used where possible
(e.g. the save picker degrades to a plain download), but WebCodecs encode has
no pure-JS fallback.

## Architecture

> Looking for the deeper design rationale? [docs/DESIGN.md](docs/DESIGN.md)
> records how each subsystem is handled — strategy, file map, trade-offs, and
> future direction, one section per concern.

The heavy media work is split into small, single-purpose Rust crates compiled
to WASM, so the React frontend pulls in only what it needs. Each crate offers
both whole-buffer entry points (for small files and tests) and **streaming**
ones (a `(offset, len) => Uint8Array` callback), so huge sources are never
fully loaded into memory.

| Crate | Responsibility |
| --- | --- |
| [`waz-stinger-wasm`](crates/waz-stinger-wasm) | Media probe + loudness (EBU R128 / LUFS) |
| [`waz-wave-wasm`](crates/waz-wave-wasm) | Waveform peak extraction |
| [`waz-strip-wasm`](crates/waz-strip-wasm) | MP4/MOV keyframe scanner (no video decode) |
| [`waz-edl-wasm`](crates/waz-edl-wasm) | Stateless EDL / timeline export engine |

**Streaming core.** Rather than load a file into an `ArrayBuffer` (which can
exhaust memory on multi-gigabyte video), a Web Worker owns the `File` and reads
byte ranges on demand via `FileReaderSync`; on the Rust side a `JsReader`
implements `Read + Seek` so `symphonia` decodes packet-by-packet, and the MP4
keyframe scan reads only the `moov` box, never the payload. **Net effect: peak
memory stays flat whether the input is 10 MB or 10 GB.**

**Project layout.**

```
crates/       Rust workspace — one WASM crate per media concern
src/
  wasm/       WASM boundary: worker + typed client, thumbnails
  export/     WebCodecs render + mux pipeline (MP4 / WebM)
  store/      Zustand editor store + persistence
  components/ hooks/ lib/ context/ styles/   — React UI
scripts/build-wasm.mjs   Rust → WASM build step (output in src/wasm/pkg/, gitignored)
```

## Roadmap

- **Unified WYSIWYG compositor** — route the live preview through the same compositor as export (letterboxing, stacked layers, effects) instead of today's layered `<video>` approximation; includes mixing *every* audio layer in preview (export already mixes all; preview plays the topmost audible lane).
- **More transitions & effects** — building on the shipped fades and cross-dissolves: wipes, speed changes, colour/filters, and keyframable properties (likely on a shared GPU compositor as the effect set grows).
- **Text overlays / titles** — styled, animatable text as an overlay layer on the compositor above.
- **Worker-based render orchestration** — the decode/encode already run on hardware (WebCodecs) via a demux + `VideoDecoder` fast path; moving the render *loop* itself into a Worker would keep the UI fully responsive on long exports.

## Contributing

Issues and pull requests are welcome. For local development, follow the
[Quick start](#quick-start); `cargo test --workspace` covers the Rust crates
and `npm run typecheck` the frontend.

## License

Wazplay is released under the [MIT License](LICENSE) — free to use, modify, and
distribute, with no restrictions. A commercial/hosted version of Wazplay may be
offered in the future as a separate product; that will not change the terms of
this open-source release.
