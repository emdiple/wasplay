/**
 * main.js — Shadowfox mock editor
 *
 * A single-layer video + single-layer audio timeline. Import multiple media
 * files; each file is assigned its own colour, shared between its video clip and
 * its audio clip. Arrange clips by dragging, split them with the cut tool.
 *
 * All heavy media work (waveform peaks, keyframe thumbnails) runs in fox-worker
 * via streaming reads — the files are never fully loaded on the main thread.
 * No WASM signatures are touched here; this is purely the UI/editor layer.
 */

import { fox } from './fox-worker-client.js';
import { generateThumbnails } from './fox-strip.js';

// ── DOM ─────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const fileInput   = $('fileInput');
const btnImport   = $('btnImport');
const toolSelect  = $('toolSelect');
const toolCut     = $('toolCut');
const btnDelete   = $('btnDelete');
const btnPlay     = $('btnPlay');
const btnClear    = $('btnClear');
const zoomIn      = $('zoomIn');
const zoomOut     = $('zoomOut');
const zoomLabel   = $('zoomLabel');
const statusEl    = $('status');

const binList     = $('binList');
const binCount    = $('binCount');
const loadingMsg  = $('loadingMsg');

const stageSwatch = $('stageSwatch');
const stageName   = $('stageName');
const stageHint   = $('stageHint');
const tcMain      = $('tcMain');
const tcTotal     = $('tcTotal');

const tlScroll    = $('tlScroll');
const tlContent   = $('tlContent');
const ruler       = $('rulerCanvas');
const videoTrack  = $('videoTrack');
const audioTrack  = $('audioTrack');
const playheadEl  = $('playhead');

// ── State ───────────────────────────────────────────────────────────────────
const sources    = new Map();   // id -> source
let videoClips   = [];          // { id, sourceId, start, in, dur }
let audioClips   = [];
let selection    = new Set();   // selected clip objects (marquee/multi-select)
let selectedSrc  = null;        // source shown in the preview stage

let tool         = 'select';    // 'select' | 'cut'
let pxPerSec     = 40;
let playheadTime = 0;

const DOMAIN_MIN_S = 60;        // timeline is at least 1 minute…
let totalSeconds   = DOMAIN_MIN_S;

// …but expands to cover the furthest clip end, so long media fits fully.
const domainSeconds = () => Math.max(DOMAIN_MIN_S, timelineEnd());

const VIDEO_RX = /\.(mp4|mov|mkv|webm|m4v|avi)$/i;
const MEDIA_RX = /\.(mp4|mov|mkv|webm|m4v|avi|mp3|wav|flac|ogg|oga|aac|m4a)$/i;

// ── Small utilities ──────────────────────────────────────────────────────────
let _idc = 0;
const uid = () => 'c' + (++_idc);
const pad = (n) => String(n).padStart(2, '0');

let _hue = Math.random() * 360;
function nextColor() {
  const h = _hue % 360;
  _hue += 137.508; // golden angle → well-spaced, distinct hues
  return { h: Math.round(h), s: 68, l: 56 };
}
const hsl = (c, a = 1, dl = 0) =>
  `hsla(${c.h}, ${c.s}%, ${Math.max(0, Math.min(100, c.l + dl))}%, ${a})`;

function formatTC(s) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(cs)}`;
}
function formatClock(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// ── App lock (block interaction while media decodes) ──────────────────────────
let busy = false;
function lockUI(msg) { busy = true; loadingMsg.textContent = msg || 'Loading media…'; document.body.classList.add('busy'); }
function unlockUI() { busy = false; document.body.classList.remove('busy'); }

const trackEnd  = (clips) => clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
const timelineEnd = () => Math.max(trackEnd(videoClips), trackEnd(audioClips));
const byStart   = (clips) => [...clips].sort((a, b) => a.start - b.start);

// ── Import ────────────────────────────────────────────────────────────────────
btnImport.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); fileInput.value = ''; });

async function handleFiles(fileList) {
  if (busy) return; // already importing — ignore re-entrant drops
  const files = [...fileList].filter(
    (f) => f.type.startsWith('video/') || f.type.startsWith('audio/') || MEDIA_RX.test(f.name)
  );
  if (!files.length) return;

  // Lock the app until every file's waveform + thumbnails are fully decoded.
  lockUI('Reading media…');
  try {
    let i = 0;
    for (const file of files) {
      i++;
      const prefix = files.length > 1 ? `(${i}/${files.length}) ` : '';
      statusEl.textContent = `Reading ${file.name}…`;
      lockUI(`${prefix}Reading ${file.name}…`);
      const isVideo = file.type.startsWith('video/') || VIDEO_RX.test(file.name);

      // Probe duration/dimensions and codec info together. `info` tells us whether
      // an audio track actually exists — a silent video gets no audio clip.
      const [meta, info] = await Promise.all([
        probeMedia(file, isVideo).catch(() => ({ duration: 0, width: 0, height: 0 })),
        fox.mediaInfo(file).catch(() => null),
      ]);
      const hasAudio = info ? hasAudioTrack(info) : true;

      const src = {
        id: uid(), file, name: file.name, color: nextColor(),
        isVideo, hasAudio, info,
        duration: meta.duration > 0 ? meta.duration : 5,
        width: meta.width || 0, height: meta.height || 0,
        thumbs: null, peaks: null,
      };
      sources.set(src.id, src);
      if (!selectedSrc) setStage(src);
      renderBin();

      // Block until decoded — long files can take a while (streamed in worker).
      lockUI(`${prefix}Decoding ${file.name} — waveform${isVideo ? ' & thumbnails' : ''}…`);
      await loadDecoration(src);
    }
  } finally {
    unlockUI();
  }
  statusEl.textContent = `${sources.size} clip${sources.size === 1 ? '' : 's'} in bin — double-click to add to timeline.`;
}

// A track's audio is real if the probe reported channels/sample-rate, or a
// recognised (non-"unknown") audio codec. `get_media_info` leaves these null
// when the container has no audio track.
function hasAudioTrack(info) {
  if (info.channels != null || info.sample_rate != null) return true;
  const codec = (info.audio_codec || '').toLowerCase();
  return codec !== '' && !codec.startsWith('unknown');
}

// Read duration + dimensions with a throwaway media element (no WASM needed).
function probeMedia(file, isVideo) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(isVideo ? 'video' : 'audio');
    el.preload = 'metadata';
    const url = URL.createObjectURL(file);
    el.onloadedmetadata = () => {
      const d = el.duration;
      resolve({
        duration: isFinite(d) ? d : 0,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
      });
      URL.revokeObjectURL(url);
    };
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('probe failed')); };
    el.src = url;
  });
}

// Decode the waveform peaks + keyframe thumbnails for a source. Resolves only
// when both are ready, so the importer can hold the app until it completes.
function loadDecoration(src) {
  const jobs = [];
  if (src.hasAudio) {
    jobs.push(fox.peaks(src.file, 1200).then((p) => { src.peaks = p; }).catch(() => {}));
  }
  if (src.isVideo) {
    jobs.push(
      generateThumbnails(src.file, { count: 16, width: 160, height: 90 })
        .then((ts) => { src.thumbs = ts; })
        .catch(() => {})
    );
  }
  return Promise.all(jobs).then(() => scheduleRender());
}

// ── Media bin ─────────────────────────────────────────────────────────────────
function renderBin() {
  binCount.textContent = sources.size;
  if (!sources.size) {
    binList.innerHTML =
      '<div class="bin-empty">No media yet.<br />Import files, then double-click to<br />add them to the timeline.</div>';
    return;
  }
  binList.innerHTML = '';
  for (const src of sources.values()) {
    const item = document.createElement('div');
    item.className = 'bin-item' + (src === selectedSrc ? ' sel' : '');
    item.draggable = true;

    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = hsl(src.color, 0.95);

    const meta = document.createElement('div');
    meta.className = 'bin-meta';
    const kind = src.isVideo ? (src.hasAudio ? 'video' : 'video · silent') : 'audio';
    const dims = src.isVideo && src.width ? ` · ${src.width}×${src.height}` : '';
    meta.innerHTML =
      `<div class="bin-name"></div>` +
      `<div class="bin-sub"><span class="kind">${kind}</span> · ${formatTC(src.duration)}${dims}</div>`;
    meta.querySelector('.bin-name').textContent = src.name;

    item.append(sw, meta);
    item.addEventListener('click', () => setStage(src));
    item.addEventListener('dblclick', () => { appendSource(src); fitTimeline(); });
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/fox-source', src.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    binList.appendChild(item);
  }
}

function setStage(src) {
  selectedSrc = src;
  stageSwatch.style.background = hsl(src.color, 0.9);
  stageSwatch.textContent = src.isVideo ? '▷' : '♪';
  stageName.textContent = src.name;
  const parts = [src.isVideo ? 'Video' : 'Audio', formatTC(src.duration)];
  if (src.isVideo && src.width) parts.push(`${src.width}×${src.height}`);
  if (src.isVideo && !src.hasAudio) parts.push('silent');
  if (src.info) {
    parts.push(src.info.container || '');
    if (src.info.video_codec) parts.push(src.info.video_codec);
    if (src.info.audio_codec) parts.push(src.info.audio_codec);
  }
  stageHint.textContent = parts.filter(Boolean).join(' · ');
  renderBin();
}

// ── Placing clips on the timeline ─────────────────────────────────────────────
function placeSource(src, at) {
  at = Math.max(0, at);
  // A file's video and audio clips share a `link` id so edits (cut) stay in sync.
  const link = uid();
  if (src.isVideo) {
    videoClips.push({ id: uid(), sourceId: src.id, link, start: at, in: 0, dur: src.duration });
  }
  if (src.hasAudio) {
    audioClips.push({ id: uid(), sourceId: src.id, link, start: at, in: 0, dur: src.duration });
  }
}
function appendSource(src) {
  placeSource(src, Math.max(trackEnd(videoClips), trackEnd(audioClips)));
  setStage(src);
}

// Drag a bin item onto the timeline to drop it at a specific time.
for (const zone of [videoTrack, audioTrack]) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData('text/fox-source');
    const src = sources.get(id);
    if (!src) return;
    e.preventDefault();
    const t = snapTime(offsetXInContent(e) / pxPerSec);
    placeSource(src, t);
    setStage(src);
    fitTimeline();
  });
}

// ── Timeline render ────────────────────────────────────────────────────────────
let _renderQueued = false;
function scheduleRender() {
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => { _renderQueued = false; render(); });
}

function render() {
  totalSeconds = domainSeconds();
  const w = totalSeconds * pxPerSec;
  tlContent.style.width = w + 'px';

  drawRuler(w);
  renderTrack(videoTrack, byStart(videoClips), true);
  renderTrack(audioTrack, byStart(audioClips), false);
  updatePlayhead();
  updateTotals();
}

function updateTotals() {
  tcTotal.textContent = '/ ' + formatTC(domainSeconds());
}
function updatePlayhead() {
  playheadEl.style.left = (playheadTime * pxPerSec) + 'px';
  tcMain.textContent = formatTC(playheadTime);
}

function drawRuler(cssW) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.min(cssW, 32000);
  ruler.width = Math.round(W * dpr);
  ruler.height = Math.round(26 * dpr);
  ruler.style.width = W + 'px';
  ruler.style.height = '26px';

  const ctx = ruler.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0f1015';
  ctx.fillRect(0, 0, W, 26);

  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const step = steps.find((s) => s * pxPerSec >= 64) || 3600;

  ctx.strokeStyle = '#2a2d38';
  ctx.fillStyle = '#6b7180';
  ctx.font = '10px "SF Mono", monospace';
  ctx.lineWidth = 1;

  for (let t = 0; t * pxPerSec <= W; t += step) {
    const x = Math.round(t * pxPerSec) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 13); ctx.lineTo(x, 26); ctx.stroke();
    ctx.fillText(formatClock(t), x + 4, 11);
    // half-step minor tick
    const hx = Math.round((t + step / 2) * pxPerSec) + 0.5;
    ctx.strokeStyle = '#1e2129';
    ctx.beginPath(); ctx.moveTo(hx, 19); ctx.lineTo(hx, 26); ctx.stroke();
    ctx.strokeStyle = '#2a2d38';
  }
}

function renderTrack(trackEl, clips, isVideo) {
  trackEl.classList.toggle('cut-mode', tool === 'cut');
  trackEl.innerHTML = '';
  for (const clip of clips) {
    const src = sources.get(clip.sourceId);
    if (!src) continue;

    const el = document.createElement('div');
    el.className = 'clip' + (selection.has(clip) ? ' sel' : '');
    el.style.left = (clip.start * pxPerSec) + 'px';
    el.style.width = Math.max(2, clip.dur * pxPerSec) + 'px';
    el.style.background = hsl(src.color, isVideo ? 0.30 : 0.22);
    el.style.borderColor = hsl(src.color, 0.85);

    const cv = document.createElement('canvas');
    cv.className = 'clip-canvas';
    el.appendChild(cv);

    const lab = document.createElement('div');
    lab.className = 'clip-label';
    lab.textContent = src.name;
    el.appendChild(lab);

    el._clip = clip; el._clips = isVideo ? videoClips : audioClips;
    el._isVideo = isVideo; el._canvas = cv;
    attachClipPointer(el);
    trackEl.appendChild(el);

    drawClipDecoration(el);
  }
}

function drawClipDecoration(el) {
  const cv = el._canvas, clip = el._clip, src = sources.get(clip.sourceId);
  const H = Math.max(1, Math.round(el.clientHeight));
  const dpr = window.devicePixelRatio || 1;

  // Cap the backing resolution: a clip wider than the browser's max canvas size
  // (~32k px) would fail to render entirely. The canvas is CSS-stretched to the
  // clip's real width, so a long clip just gets a slightly lower-res strip.
  const cssW = Math.max(1, Math.round(el.clientWidth));
  const W = Math.min(cssW, 4096);
  cv.width = Math.max(1, Math.round(W * dpr));
  cv.height = Math.max(1, Math.round(H * dpr));
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (el._isVideo && src.thumbs && src.thumbs.length) {
    drawFilmstrip(ctx, W, H, clip, src);
  } else if (!el._isVideo && src.peaks && src.peaks.length) {
    drawWaveform(ctx, W, H, clip, src);
  }
}

function drawFilmstrip(ctx, W, H, clip, src) {
  const aspect = (src.width && src.height) ? src.width / src.height : 16 / 9;
  const tileW = Math.max(24, H * aspect);
  const inP = clip.in, span = clip.dur || 1;
  for (let x = 0; x < W; x += tileW) {
    const t = inP + ((x + tileW / 2) / W) * span;
    const th = nearestThumb(src.thumbs, t);
    if (th) {
      try { ctx.drawImage(th.bitmap, x, 0, tileW, H); } catch { /* bitmap gone */ }
    }
  }
  // subtle separators between frames
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  for (let x = tileW; x < W; x += tileW) {
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H); ctx.stroke();
  }
}

function nearestThumb(thumbs, t) {
  let best = null, bd = Infinity;
  for (const th of thumbs) {
    const d = Math.abs(th.timestamp_s - t);
    if (d < bd) { bd = d; best = th; }
  }
  return best;
}

function drawWaveform(ctx, W, H, clip, src) {
  const peaks = src.peaks;
  const total = src.duration || 1;
  const inP = clip.in, span = clip.dur || 1;
  const mid = H / 2;
  ctx.fillStyle = hsl(src.color, 0.85, 14);
  for (let x = 0; x < W; x++) {
    const t = inP + (x / W) * span;
    const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor((t / total) * peaks.length)));
    const a = peaks[idx] || 0;
    const h = Math.max(0.75, a * mid * 0.9);
    ctx.fillRect(x, mid - h, 1, h * 2);
  }
}

// ── Selection helpers ──────────────────────────────────────────────────────────
const allClips = () => [...videoClips, ...audioClips];

function applySelectionClasses() {
  for (const el of document.querySelectorAll('.clip')) {
    el.classList.toggle('sel', selection.has(el._clip));
  }
}
function selectOnly(clip) {
  selection = new Set([clip]);
  const src = sources.get(clip.sourceId);
  if (src) setStage(src);
  applySelectionClasses();
}
function updateClipPositions() {
  for (const el of document.querySelectorAll('.clip')) {
    el.style.left = (el._clip.start * pxPerSec) + 'px';
  }
  updateTotals();
}

// ── Clip interaction (select / group drag-move / cut) ──────────────────────────
function attachClipPointer(el) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const clip = el._clip, clips = el._clips;

    // Decide selection at press time: shift toggles, plain click on an
    // unselected clip selects only it; clicking an already-selected clip keeps
    // the whole selection (so you can drag the group).
    if (tool === 'select') {
      if (e.shiftKey) {
        selection.has(clip) ? selection.delete(clip) : selection.add(clip);
        applySelectionClasses();
      } else if (!selection.has(clip)) {
        selectOnly(clip);
      }
      if (!selection.has(clip)) selection.add(clip);
      const src = sources.get(clip.sourceId);
      if (src) setStage(src);
    }

    const startX = e.clientX;
    const origins = new Map();
    for (const c of selection) origins.set(c, c.start);
    let moved = false;
    el.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      if (tool === 'select' && moved) {
        el.classList.add('dragging');
        // Snap using the grabbed clip, then apply the same delta to the group.
        const rawStart = Math.max(0, (origins.get(clip) ?? clip.start) + dx / pxPerSec);
        const snapped = snapEdges(rawStart, clip, selection);
        let delta = snapped - (origins.get(clip) ?? clip.start);
        // Clamp only at the left (0) — the domain expands to the right as needed.
        let lo = -Infinity;
        for (const base of origins.values()) lo = Math.max(lo, -base);
        delta = Math.max(delta, lo);
        for (const [c, base] of origins) c.start = base + delta;
        updateClipPositions();
      }
    };
    const onUp = (ev) => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.classList.remove('dragging');

      if (tool === 'cut' && !moved) {
        // Cut lands on the playhead (red line); the linked A/V partner is cut too.
        if (!cutClipLinked(clip, playheadTime)) {
          statusEl.textContent = 'Move the red playhead over the clip, then cut.';
        }
      }
      scheduleRender();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  });
}

// Split a single clip at time `t`; `clip` becomes the left half, the returned
// clip is the new right half (inherits the same link). null if `t` is outside.
function splitClip(clips, clip, t) {
  const eps = 0.02;
  if (t <= clip.start + eps || t >= clip.start + clip.dur - eps) return null;
  const offset = t - clip.start;
  const right = {
    id: uid(), sourceId: clip.sourceId, link: clip.link,
    start: t, in: clip.in + offset, dur: clip.dur - offset,
  };
  clip.dur = offset;
  clips.push(right);
  return right;
}

// Cut every clip in a link group at `t`. The left halves keep the old link; all
// right halves get a shared new link, so the A/V pair stays paired after the cut.
function splitLinkGroupAt(link, t) {
  const newLink = uid();
  const rights = [];
  for (const clips of [videoClips, audioClips]) {
    for (const c of [...clips]) {
      if (c.link === link) {
        const r = splitClip(clips, c, t);
        if (r) { r.link = newLink; rights.push(r); }
      }
    }
  }
  return rights;
}

// Razor a clip at the playhead — cuts its linked partner (audio↔video) too.
function cutClipLinked(clip, t) {
  const rights = splitLinkGroupAt(clip.link, t);
  if (rights.length) selection = new Set(rights); // select the new right segment(s)
  return rights.length > 0;
}

// Blade every clip (video + audio) the playhead crosses, one cut per linked pair.
function splitAtPlayhead() {
  const t = playheadTime;
  const links = new Set();
  for (const c of allClips()) {
    if (t > c.start + 0.02 && t < c.start + c.dur - 0.02) links.add(c.link);
  }
  let didCut = false;
  for (const link of links) if (splitLinkGroupAt(link, t).length) didCut = true;
  selection = new Set();
  if (didCut) statusEl.textContent = `Split at ${formatTC(t)}`;
  scheduleRender();
}

// Snap a clip's start so either edge lands on 0, the playhead, or another clip
// edge. Clips in `exclude` (the moving group) are ignored so it can't snap to
// itself or the other members being dragged with it.
function snapEdges(ns, clip, exclude = new Set([clip])) {
  const thr = 8 / pxPerSec;
  const anchors = [0, playheadTime];
  for (const c of allClips()) if (!exclude.has(c)) anchors.push(c.start, c.start + c.dur);

  let bestDelta = 0, bestDist = thr;
  for (const edge of [ns, ns + clip.dur]) {
    for (const a of anchors) {
      const d = Math.abs(edge - a);
      if (d < bestDist) { bestDist = d; bestDelta = a - edge; }
    }
  }
  return Math.max(0, ns + bestDelta);
}
const snapTime = (t) => {
  const thr = 8 / pxPerSec;
  const anchors = [0, playheadTime];
  for (const c of allClips()) anchors.push(c.start, c.start + c.dur);
  let best = t, bd = thr;
  for (const a of anchors) { const d = Math.abs(t - a); if (d < bd) { bd = d; best = a; } }
  return Math.max(0, best);
};

function deleteSelected() {
  if (!selection.size) return;
  videoClips = videoClips.filter((c) => !selection.has(c));
  audioClips = audioClips.filter((c) => !selection.has(c));
  selection = new Set();
  scheduleRender();
}

// ── Marquee (rubber-band) selection on empty timeline ──────────────────────────
function clipsInRect(l, t, r, b) {
  const t1 = l / pxPerSec, t2 = r / pxPerSec;
  const hit = new Set();
  const bands = [
    { clips: videoClips, top: videoTrack.offsetTop, bot: videoTrack.offsetTop + videoTrack.offsetHeight },
    { clips: audioClips, top: audioTrack.offsetTop, bot: audioTrack.offsetTop + audioTrack.offsetHeight },
  ];
  for (const band of bands) {
    if (b < band.top || t > band.bot) continue;          // no vertical overlap
    for (const c of band.clips) {
      if (c.start < t2 && c.start + c.dur > t1) hit.add(c); // horizontal overlap
    }
  }
  return hit;
}

function beginMarquee(e) {
  if (tool !== 'select' || e.button !== 0) return;
  const rect = tlContent.getBoundingClientRect();
  const x0 = e.clientX - rect.left, y0 = e.clientY - rect.top;
  const additive = e.shiftKey;
  const base = additive ? new Set(selection) : new Set();

  const box = document.createElement('div');
  box.className = 'marquee';
  tlContent.appendChild(box);
  let moved = false;

  const onMove = (ev) => {
    const x1 = ev.clientX - rect.left, y1 = ev.clientY - rect.top;
    if (Math.abs(x1 - x0) > 2 || Math.abs(y1 - y0) > 2) moved = true;
    const L = Math.min(x0, x1), T = Math.min(y0, y1);
    const W = Math.abs(x1 - x0), H = Math.abs(y1 - y0);
    box.style.left = L + 'px'; box.style.top = T + 'px';
    box.style.width = W + 'px'; box.style.height = H + 'px';
    selection = new Set([...base, ...clipsInRect(L, T, L + W, T + H)]);
    applySelectionClasses();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    box.remove();
    if (!moved && !additive) selection = new Set(); // bare click clears
    scheduleRender();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  e.preventDefault();
}

// Start a marquee when pressing empty track space (clips stop propagation).
for (const zone of [videoTrack, audioTrack]) {
  zone.addEventListener('pointerdown', (e) => { if (e.target === zone) beginMarquee(e); });
}

// ── Tools / toolbar ────────────────────────────────────────────────────────────
function setTool(t) {
  tool = t;
  toolSelect.classList.toggle('active', t === 'select');
  toolCut.classList.toggle('active', t === 'cut');
  videoTrack.classList.toggle('cut-mode', t === 'cut');
  audioTrack.classList.toggle('cut-mode', t === 'cut');
}
toolSelect.addEventListener('click', () => setTool('select'));
toolCut.addEventListener('click', () => setTool('cut'));
btnDelete.addEventListener('click', deleteSelected);

btnClear.addEventListener('click', () => {
  videoClips = []; audioClips = []; selection = new Set(); playheadTime = 0; pause();
  scheduleRender();
});

// Zoom is bounded below by "fit": the whole 1-minute domain filling the
// viewport. Zooming out can't shrink it further; zooming in expands it and the
// timeline scrolls horizontally.
function fitPxPerSec() {
  const w = tlScroll.clientWidth || 800;
  return Math.max(0.02, w / domainSeconds());
}
function setZoom(next) {
  pxPerSec = Math.max(fitPxPerSec(), Math.min(400, next));
  zoomLabel.textContent = (pxPerSec < 10 ? pxPerSec.toFixed(1) : Math.round(pxPerSec)) + ' px/s';
  scheduleRender();
}
// Fit the whole (possibly expanded) domain into the viewport.
function fitTimeline() { setZoom(fitPxPerSec()); }
zoomIn.addEventListener('click', () => setZoom(pxPerSec * 1.35));
zoomOut.addEventListener('click', () => setZoom(pxPerSec / 1.35));

// ── Playhead / transport ───────────────────────────────────────────────────────
let playing = false, rafId = null, lastTs = 0;

function play() {
  if (playing) return;
  if (playheadTime >= timelineEnd()) playheadTime = 0;
  playing = true; btnPlay.textContent = '❚❚';
  lastTs = performance.now();
  rafId = requestAnimationFrame(tick);
}
function pause() {
  playing = false; btnPlay.textContent = '▶';
  if (rafId) cancelAnimationFrame(rafId);
}
function tick(ts) {
  if (!playing) return;
  const dt = (ts - lastTs) / 1000; lastTs = ts;
  playheadTime += dt;
  const end = timelineEnd();
  if (playheadTime >= end) { playheadTime = end; pause(); }
  updatePlayhead();
  autoScroll();
  rafId = requestAnimationFrame(tick);
}
function autoScroll() {
  const x = playheadTime * pxPerSec;
  const left = tlScroll.scrollLeft, right = left + tlScroll.clientWidth;
  if (x < left + 40) tlScroll.scrollLeft = Math.max(0, x - 40);
  else if (x > right - 60) tlScroll.scrollLeft = x - tlScroll.clientWidth + 60;
}
btnPlay.addEventListener('click', () => (playing ? pause() : play()));

// ── Ruler scrubbing ────────────────────────────────────────────────────────────
function offsetXInContent(e) {
  const rect = tlContent.getBoundingClientRect();
  return Math.max(0, e.clientX - rect.left);
}
ruler.addEventListener('pointerdown', (e) => {
  ruler.setPointerCapture(e.pointerId);
  const scrub = (ev) => {
    playheadTime = Math.max(0, Math.min(totalSeconds, offsetXInContent(ev) / pxPerSec));
    updatePlayhead();
  };
  scrub(e);
  const onMove = (ev) => scrub(ev);
  const onUp = () => {
    ruler.releasePointerCapture(e.pointerId);
    ruler.removeEventListener('pointermove', onMove);
    ruler.removeEventListener('pointerup', onUp);
  };
  ruler.addEventListener('pointermove', onMove);
  ruler.addEventListener('pointerup', onUp);
});

// ── Keyboard ─────────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (busy) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  switch (e.key) {
    case 'v': case 'V': setTool('select'); break;
    case 'c': case 'C': setTool('cut'); break;
    case 's': case 'S': e.preventDefault(); splitAtPlayhead(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSelected(); break;
    case ' ': e.preventDefault(); playing ? pause() : play(); break;
  }
});

// ── Drag-and-drop import over the whole window ─────────────────────────────────
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++; document.body.classList.add('dragging-file');
});
window.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging-file'); } });
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  dragDepth = 0; document.body.classList.remove('dragging-file');
  handleFiles(e.dataTransfer.files);
});

// Re-apply the fit clamp on resize (viewport width changes the minimum zoom).
window.addEventListener('resize', () => setZoom(pxPerSec));

// ── Boot ───────────────────────────────────────────────────────────────────────
setTool('select');
setZoom(fitPxPerSec()); // start with the whole minute visible
render();
