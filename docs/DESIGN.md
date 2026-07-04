# Shadowfox Studio — Design & Architecture

## Purpose

This document records **how each part of the app is handled** — the strategy and
architecture behind every subsystem, kept separate per concern.

Its use case: a single place to see the *current position and design* of each
piece, so that when you want to change or improve one part, you know exactly
what it does today, where it lives, and why it was built that way — without
having to re-derive it from the code.

## How to use this document

- Each section below covers one part of the app (one concern).
- For each part, the goal is to capture: **what it does**, **where it lives**
  (files/crates), **how it's currently handled** (the strategy), and **known
  trade-offs / future directions**.
- When a part's design changes, update its section here first — this is the
  source of truth for intent, the code is the source of truth for detail.

---

<!--
Sections go here. Provide the titles you want and each will be filled in with
its current handling strategy and architecture.
-->

## Topics

- [Reading files (particularly large ones)](#reading-files-particularly-large-ones)
- [Downloading process (export to media file)](#downloading-process-export-to-media-file)
- [Caching and memory use](#caching-and-memory-use)
- [CPU overhead](#cpu-overhead)
- [Multi-threading (WASM worker pool)](#multi-threading-wasm-worker-pool)
- [Session persistence (save & restore across refreshes)](#session-persistence-save--restore-across-refreshes)

---

### Reading files (particularly large ones)

**What it does:** Probing metadata, measuring loudness, extracting waveform
peaks, and scanning MP4 keyframes never load a whole media file into memory —
files are read as arbitrary byte ranges on demand, so a 10 MB clip and a 10 GB
clip use roughly the same peak memory.

**Where it lives:**
- `src/wasm/foxWorker.ts` — a module Web Worker that owns the `File` and reads
  byte ranges synchronously via `FileReaderSync` (only available inside
  workers). Multiple instances of this module now run concurrently as a pool
  — see [Multi-threading](#multi-threading-wasm-worker-pool).
- `src/wasm/foxClient.ts` — main-thread RPC client; posts the `File` to a pool
  worker by reference (a cheap structured clone, not a copy).
- `crates/fox-ear-wasm/src/reader.rs`, `crates/fox-soundwave-wasm/src/reader.rs`
  — `JsReader`, a `Read + Seek` adapter over the worker's byte-range callback,
  so `symphonia` decodes audio packet-by-packet.
- `crates/fox-strip-wasm` — a from-scratch ISOBMFF (MP4) box parser whose
  streaming scan reads **only the `moov` box**; the (potentially huge) `mdat`
  video payload is never read for keyframe scanning.

**How it's handled:** The `File` is passed to the worker by reference. The
worker exposes a `(offset, len) => Uint8Array` reader; Rust's `JsReader` wraps
that as `Read + Seek` so existing decode libraries (`symphonia`) work
unmodified while only pulling the bytes they actually need, on demand.

**Trade-offs / known exception:** The **export render pipeline** does not
fully follow this discipline yet:
- `renderVideo.ts` decodes via hidden `<video>` elements (the browser's native
  media pipeline handles range-reading from the `File`/blob URL internally —
  fine).
- `renderAudio.ts` calls `file.arrayBuffer()` to decode each source fully into
  memory for `OfflineAudioContext` mixing — a deliberate simplification that
  breaks the "never fully load into memory" principle for very large audio
  sources. Acceptable today since audio files are typically much smaller than
  video, but worth revisiting if that stops being true.

---

### Downloading process (export to media file)

**What it does:** Two independent export paths, both entirely client-side (no
upload, no server transcoding):
1. **EDL export** — a frame-accurate JSON description of the edit (events +
   an FFmpeg `filter_complex`/command) for use in external tools.
2. **Media file export** — renders the timeline to a real MP4/WebM file
   in-browser via WebCodecs and triggers a download.

**Where it lives:**
- `crates/fox-edl-wasm` — stateless EDL exporter (project JSON in, EDL JSON
  out); no timeline state is duplicated here, the Zustand store stays the
  single source of truth.
- `src/wasm/foxEdl.ts` — main-thread client for the EDL exporter (runs on the
  main thread, not the worker, since it's a cheap pure JSON transform with no
  file reads).
- `src/export/project.ts` — maps the store's live state to the flat project
  snapshot the WASM exporter and the renderer both consume.
- `src/export/codecs.ts` — probes `VideoEncoder`/`AudioEncoder`
  `isConfigSupported` to pick a codec plan: **MP4/H.264+AAC** preferred,
  falling back to **WebM/VP9 (or VP8)+Opus** so export still works in
  browsers without H.264 hardware encode.
- `src/export/renderVideo.ts` — seeks a hidden `<video>` element per source to
  each output frame's timestamp, composites the topmost clip (by `z`-order)
  onto an `OffscreenCanvas` over a black base (gaps → black, overlaps resolve
  by stacking order), and feeds frames to `VideoEncoder`.
- `src/export/renderAudio.ts` — decodes and mixes every audio clip at its
  timeline position via `OfflineAudioContext` (faster than real time), then
  chunks the mixed buffer into `AudioEncoder`.
- `src/export/exportProject.ts` — orchestrates both encoders' output chunks
  into `mp4-muxer` or `webm-muxer`, finalizes an `ArrayBuffer`, wraps it in a
  `Blob`.
- `src/components/ExportDialog.tsx` + `src/lib/download.ts` — the UI (EDL
  download button, render-and-download button, progress bar, cancel) and the
  actual browser download trigger.

**How it's handled:** The render step never calls out to FFmpeg or any
server — `VideoEncoder`/`AudioEncoder` (WebCodecs) do the actual hardware
encoding, JS composites frames and mixes audio, and a small JS muxer
(`mp4-muxer`/`webm-muxer`, a few KB — not FFmpeg.wasm) writes the container.
This was chosen over FFmpeg.wasm specifically because FFmpeg.wasm requires the
whole working set to fit in WASM's ~2–4 GB address space and has no GPU
access — both of which conflict with this project's streaming, large-file
design goal.

**Trade-offs:**
- Runs on the **main thread** today — no Worker/OffscreenCanvas offload yet,
  so a long render will make the UI less responsive.
- Per-frame seek-and-draw video decode is simple and robust but not the
  fastest possible path; a true demux + `VideoDecoder` pipeline (feeding
  encoded chunks directly, no `<video>` seeking) would be faster.
- Output framerate is fixed at 30 fps (`EXPORT_FPS` in `project.ts`)
  regardless of source fps, since the store doesn't track per-source fps yet.
- See the audio memory trade-off under *Reading files*, above.

**Future direction:** move the render loop into a Worker with
`OffscreenCanvas`; add a real demuxer so untouched clip regions can be
stream-copied (no re-encode) instead of always re-encoding; track per-source
fps.

---

### Caching and memory use

**What it does:** A small number of caches avoid re-decoding or re-reading the
same bytes repeatedly across the app's different consumers of the same source
(timeline clip canvases, the live preview, the analyzer panel, and export).

**Where it lives:**
- `src/lib/objectUrlCache.ts` — one `blob:` object URL per source id, created
  lazily and reused by every `<video>`/`<audio>` element that needs it (the
  live preview's program monitor, and export's per-source `<video>` elements
  in `renderVideo.ts`).
- The `Source` object in the store itself (`thumbs`, `peaks` fields) — decoded
  once at import time (`src/hooks/useMediaImport.ts`, off the main thread in
  the media worker) and kept resident for the session, so the timeline clip
  canvases (`src/lib/clipCanvas.ts`) and the analyzer panel both read the same
  decoded waveform/thumbnail data instead of re-running WASM decode.

**How it's handled:** `getObjectUrl(sourceId, file)` checks a module-level
`Map` before calling `URL.createObjectURL`, so a given source's blob URL is
created exactly once no matter how many places reference it. Waveform peaks
and keyframe thumbnails are decoded once right after import and stored
directly on the `Source`, so later consumers are plain memory reads.

**Trade-offs:**
- Object URLs are **never explicitly revoked** (`URL.revokeObjectURL` is
  never called). Acceptable for a single editing session — the browser
  reclaims everything on reload/close — but would leak if a "remove source
  from bin" feature is ever added, since nothing currently drops these URLs.
- Decoded peaks/thumbnails stay resident in memory for the **whole session,
  for every imported source**, with no eviction. Fine for a handful of clips;
  would need an LRU/eviction strategy for a bin with many long sources.

**Future direction:** revoke object URLs and evict decoded artifacts when a
source is removed from the bin (once that feature exists); consider a memory
budget / eviction policy for large bins.

---

### CPU overhead

**What it does:** Keeps the UI thread free during normal editing (import,
scrub, drag, cut) by offloading decode-heavy work to a Worker and by redrawing
canvases only when something visually relevant actually changed — but the
**export render loop is the one place that doesn't yet follow this rule**, and
is the app's single biggest CPU/UI-blocking cost today.

**Where it lives:**
- `src/wasm/foxWorker.ts` — all WASM decode/analysis (loudness, waveform
  peaks, MP4 keyframe scanning) runs in a pool of Web Workers, off the main
  thread and now genuinely parallel across OS threads (see *Reading files*
  and [Multi-threading](#multi-threading-wasm-worker-pool)).
- `src/lib/clipCanvas.ts` — the filmstrip/waveform canvas for each clip
  redraws only when its `useEffect` dependencies change (zoom, trim, decoded
  data), not on every store update. Dragging a clip only changes its CSS
  `left`, a cheap layout change with no canvas re-render.
- `src/hooks/useTransport.ts` — the playhead's `requestAnimationFrame` loop
  during playback advances `playheadTime` in the store every frame.
- `src/components/Playhead.tsx`, `Preview.tsx` (`Timecode`, `ProgramMonitor`)
  — all subscribe to `playheadTime` directly, so they re-render at the
  playback frame rate (an established, intentional pattern in this codebase).
- `src/export/renderVideo.ts`, `renderAudio.ts`, `exportProject.ts` — the
  export render loop: a synchronous JS `for` loop that seeks a `<video>`,
  draws to an `OffscreenCanvas`, and calls `VideoEncoder.encode()` once per
  output frame, all on the **main thread**.

**How it's handled:** Decode-heavy work never touches the main thread — it's
in the worker via WASM. Encode work in export is hardware-accelerated where
supported (`VideoEncoder` taps the platform's H.264 encoder), so the actual
bit-level encoding isn't a JS CPU cost — but the canvas compositing, the
per-frame `<video>` seeking, and the JS glue driving all of it are, and they
run on the main thread today.

**Trade-offs:**
- The export loop is the app's biggest CPU sink and it competes directly with
  the React render thread — a multi-minute clip at 30 fps means thousands of
  sequential seek→draw→encode iterations, with only small cooperative yields
  (draining `encoder.encodeQueueSize`) keeping the tab from fully locking up.
  It is **not** in a Worker.
- Export's per-frame `<video>` seeking issues many discrete `currentTime`
  seeks rather than sequential decode; each seek can involve decoding forward
  from the nearest keyframe, so cost scales with a source's keyframe interval
  and codec complexity, not just the output frame count.
- Every playhead-driven component re-renders at the playback frame rate
  during playback, regardless of whether its visible output actually changed
  that frame — acceptable at today's scale, but a cost that grows with the
  number of playhead-subscribed components.

**Future direction:** move the export render loop into a Worker with
`OffscreenCanvas` so it stops competing with the UI thread (same fix noted
under *Downloading process*); replace per-frame `<video>` seeking with a true
demux + `VideoDecoder` pipeline for export (sequential decode, no repeated
seeks); revisit playhead-subscriber re-render cost if profiling ever shows it
mattering at larger timeline scales.

---

### Multi-threading (WASM worker pool)

**What it does:** The WASM media pipeline (`mediaInfo`, `lufs`, `peaks`,
`scan`, `keyframeBytes`) now runs on a **pool of Web Workers** instead of a
single shared worker, giving genuine OS-thread parallelism: independent jobs
(e.g. a source's waveform peaks and its keyframe thumbnail scan, or multiple
sources' jobs) can execute on separate CPU cores at the same time, rather than
queuing one after another on one thread.

**Where it lives:** `src/wasm/foxClient.ts` only — this is fully encapsulated
behind the existing `fox.*` API, so `foxWorker.ts`, `protocol.ts`,
`thumbnails.ts`, and every call site (`useMediaImport.ts`,
`AnalyzerPanel.tsx`) are unchanged.

**How it's handled:**
- **Pool size:** `clamp(navigator.hardwareConcurrency || 4, 2, 6)` — a floor
  of 2 guarantees real parallelism even where core count under-reports; a cap
  of 6 because each worker lazily instantiates its own WASM modules (its own
  linear memory), so growing the pool isn't free and returns diminish fast
  for this workload.
- **Creation:** lazy — workers are spun up one at a time, only when the
  dispatcher actually picks that slot for the first time, not all six upfront.
- **Dispatch:** least-busy. Each worker tracks an in-flight request count;
  a new call goes to whichever worker currently has the fewest, since job
  duration varies a lot (LUFS on a long file vs. a small keyframe fetch).
- **Statelessness is what makes this safe:** `foxWorker.ts` carries no state
  between calls (each op is fully self-contained given a `File` + args), so
  any worker can serve any request — no per-worker affinity or routing logic
  needed beyond least-busy.
- **Response routing:** a single global `pending: Map<id, {resolve, reject}>`
  keyed by the existing globally-unique request `id` — unchanged from before
  the pool existed, since the id already disambiguates responses regardless
  of which worker answers.
- **Error recovery:** if one worker's `onerror` fires, only *that worker's*
  in-flight requests are rejected and only that pool slot is torn down (it's
  lazily recreated on the next dispatch to it) — a crash on one core doesn't
  affect the others.

**Verified, not assumed:** confirmed with real timing instrumentation
(wrapping `Worker` from outside the app, no production code touched) that a
single file import now creates 2 distinct worker threads whose active
wall-clock ranges genuinely overlap — e.g. `peaks` running on worker 1 from
669.9–757.7 ms while `scan`+`keyframeBytes` ran concurrently on worker 2 from
710.9–738.6 ms, fully inside worker 1's window. That overlap was structurally
impossible before this change (everything serialized through one worker's
message queue).

**Deliberately not done:** shared-memory WASM threads (`wasm-bindgen-rayon` +
`SharedArrayBuffer`, letting a *single* WASM call split its own inner loop
across threads). Considered and rejected for now: it needs
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers on both
the dev server and whatever production host (real deployment/embedding
trade-offs) plus nightly Rust or special build flags — and the payoff would
be marginal for 3 of the 4 crates, since the actual bottleneck
(`symphonia` audio decode) is inherently sequential (entropy-coded bitstream)
and can't be split across threads this way. Left as a documented option, not
implemented.

**Note on multi-file import:** `useMediaImport.ts`'s top-level loop still
processes files one at a time (`for (const file of files) { ...; await
loadDecoration(src) }`), so importing several files doesn't yet parallelize
*across files* at the orchestration level — only the concurrent jobs *within*
a single file's decode (peaks + thumbnails) benefit today. Making the
per-file loop itself concurrent (e.g. `Promise.all` across files, bounded by
pool size) is a natural next step if multi-file import speed becomes a
priority.

---

### Session persistence (save & restore across refreshes)

**What it does:** The whole editing session survives a page reload — imported
media, both timeline tracks, per-clip audio levels, zoom/playhead, and theme.
Saving is automatic (debounced); restore runs once at startup. The user picks
files once and can refresh (or reopen the tab) without re-importing.

**Where it lives:**
- `src/lib/idb.ts` — a tiny IndexedDB wrapper for one object store of media
  blobs, keyed by source id (`idbPutFile`/`idbGetFile`/`idbDeleteFile`/
  `idbKeys`/`idbClear`). This is where the actual `File` bytes live.
- `src/store/persist.ts` — the orchestrator: serializes the persistable slice
  of the store to JSON, reconciles media blobs into IndexedDB, restores a saved
  session on startup, and arms the debounced autosave subscription.
- `src/lib/decorate.ts` — `decorateSource` (waveform peaks + keyframe
  thumbnails) and `measureLoudness` (integrated LUFS), extracted so both the
  importer (`useMediaImport.ts`) and the restore path re-derive decorations the
  same way. These are **never persisted** — they're recomputed from the
  restored bytes.
- `src/store/editorStore.ts` — a `hydrate()` action that replaces the document
  + view state from a restored session and resets transient/history state
  (selection, undo/redo, menus).
- `src/main.tsx` — calls `initPersistence()` once at module load, before render.
- `src/lib/theme.ts` — theme persistence (localStorage) predates this system
  and is independent; the project save doesn't touch it.

**How it's handled:** Two stores, split by data shape:
- **localStorage** holds the small JSON "project" — source *metadata* (id, name,
  colour, dimensions, codec info, measured loudness, gain), both clip tracks
  (clips are plain JSON already), and view state (`pxPerSec`, `playheadTime`,
  `selectedSrcId`). Synchronous, tiny, fast.
- **IndexedDB** holds the media file bytes — the one thing the browser will not
  let us reopen from disk after a refresh (a user-picked `File` can't be
  reconstructed from a path). `structuredClone` preserves the `File`'s name and
  type, so a stored value rehydrates as a usable `File`.

Autosave is a single `useEditorStore.subscribe` that debounces ~800 ms after
any change, then writes the JSON and **reconciles** blobs: it diffs the current
source ids against `idbKeys()`, `put`s files it doesn't have yet, and `delete`s
blobs no longer referenced — so large media bytes are written once on import,
not rewritten on every edit. Restore runs *before* autosave is armed, so a
fresh empty store can't clobber a saved project; it pairs each persisted source
with its stored blob, drops any source whose blob is missing (and clips that
referenced it), `hydrate()`s the store, then kicks off `decorateSource` for
every source in the background (and `measureLoudness` only when loudness wasn't
already persisted). Loudness *is* persisted (it's a slow full-decode
measurement); peaks and thumbnails are not (cheaper to recompute than to
serialize `Float32Array`/`ImageBitmap`).

**Trade-offs:**
- **Storage quota:** very large projects can exceed the browser's per-origin
  quota. Blob writes are wrapped in try/catch, so on failure the project JSON
  still saves but some media bytes may not — and there is **no visible warning
  or usage indicator** yet. Private-browsing / disabled-storage modes degrade
  silently to "no persistence."
- **No manual reset in the UI:** `clearPersisted()` (wipes the JSON + all
  blobs) exists but isn't wired to any button; there's no "clear saved session"
  control yet.
- **Single implicit project:** one autosaved session per origin — no named
  projects, no explicit save slots, no export/import of a project file.
- **Debounce window:** a reload within ~800 ms of the last edit (or a crash
  before the timer fires) can lose that last change. Acceptable for an
  autosave; a `beforeunload` flush would tighten it.
- **Restore re-decodes:** peaks/thumbnails are recomputed on every restore, so
  reopening a large bin spends CPU re-decorating (in the worker pool, in the
  background) rather than loading cached artifacts.

**Future direction:** surface a storage-usage indicator and a "clear saved
session" control; consider persisting peaks (and thumbnails as blobs) to skip
re-decoding large bins on restore; add named projects / explicit save slots and
a project-file export-import if multi-project workflows are wanted; flush on
`beforeunload` to close the debounce gap.

