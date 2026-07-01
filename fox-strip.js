/**
 * fox-strip.js — Timeline thumbnail generator
 *
 * The MP4 keyframe scan runs in fox-worker.js, which reads only the `moov` box
 * from the File via FileReaderSync — the full video is never loaded into memory.
 *
 * Fast path (Chrome/Edge): worker returns keyframe byte offsets → main thread
 *   fetches each keyframe's bytes from the worker → WebCodecs hardware-decodes →
 *   OffscreenCanvas → ImageBitmap.
 *
 * Fallback (Safari / Firefox): a hidden <video> element seeks to each keyframe
 *   timestamp → canvas capture → ImageBitmap. Slower (~100–300 ms per frame) but
 *   works in any browser that can play the file, and still avoids reading the
 *   whole file into a buffer.
 */

import { fox } from './fox-worker-client.js';

// Kept for API compatibility with callers that used to pre-initialise WASM.
// Initialisation now happens lazily inside the worker, so this is a no-op.
export async function initStrip() {}

/**
 * Generate timeline thumbnails from a video file.
 *
 * @param {File}   file  — the video File (streamed in the worker; never fully read)
 * @param {object} opts
 * @param {number} opts.count  — number of thumbnails (default 10)
 * @param {number} opts.width  — thumb width in px (default 160)
 * @param {number} opts.height — thumb height in px (default 90)
 * @returns {Promise<Array<{ bitmap: ImageBitmap, timestamp_s: number }>>}
 */
export async function generateThumbnails(file, { count = 10, width = 160, height = 90 } = {}) {
  // 1. Scan container in the worker (reads only the moov box) + pick indices.
  const { scan, selected } = await fox.scan(file, count);

  if (!scan.keyframes.length) {
    throw new Error('No keyframes found — is this a valid MP4 with video?');
  }

  const selectedKfs = selected.map(i => scan.keyframes[i]);

  // 2a. WebCodecs fast path (Chrome 94+, Edge 94+)
  if ('VideoDecoder' in globalThis) {
    return decodeViaWebCodecs(file, scan, selectedKfs, width, height);
  }

  // 2b. Fallback: seek a hidden <video> element (Safari, Firefox, …)
  return decodeViaVideoSeek(file, selectedKfs, width, height);
}

// ── WebCodecs path ────────────────────────────────────────────────────────────

async function decodeViaWebCodecs(file, scan, keyframes, thumbW, thumbH) {
  const { config } = scan;

  const decoderConfig = {
    codec:       config.codec,
    codedWidth:  config.width  || thumbW,
    codedHeight: config.height || thumbH,
  };
  if (config.description_b64) {
    decoderConfig.description = base64ToBuffer(config.description_b64);
  }

  let support;
  try {
    support = await VideoDecoder.isConfigSupported(decoderConfig);
  } catch {
    support = { supported: false };
  }
  if (!support.supported) {
    // Codec not decodable by WebCodecs here (e.g. HEVC on some platforms).
    return decodeViaVideoSeek(file, keyframes, thumbW, thumbH);
  }

  const results = [];
  for (const kf of keyframes) {
    // Fetch just this keyframe's bytes from the worker (small range read).
    const data   = await fox.keyframeBytes(file, kf.byte_offset, kf.byte_length);
    const bitmap = await decodeOneFrame(data, kf, decoderConfig, thumbW, thumbH);
    results.push({ bitmap, timestamp_s: kf.timestamp_s });
  }
  return results;
}

function decodeOneFrame(data, kf, decoderConfig, thumbW, thumbH) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const decoder = new VideoDecoder({
      output(videoFrame) {
        if (settled) { videoFrame.close(); return; }
        settled = true;
        try {
          const canvas = new OffscreenCanvas(thumbW, thumbH);
          canvas.getContext('2d').drawImage(videoFrame, 0, 0, thumbW, thumbH);
          videoFrame.close();
          resolve(canvas.transferToImageBitmap());
        } catch (e) {
          videoFrame.close();
          reject(e);
        }
      },
      error(e) { if (!settled) { settled = true; reject(e); } },
    });

    decoder.configure(decoderConfig);
    decoder.decode(new EncodedVideoChunk({
      type:      'key',
      timestamp: Math.max(0, Math.round(kf.timestamp_s * 1_000_000)),
      data,
    }));
    decoder.flush().catch(e => { if (!settled) { settled = true; reject(e); } });
  });
}

// ── Video-seek fallback ───────────────────────────────────────────────────────

async function decodeViaVideoSeek(file, keyframes, thumbW, thumbH) {
  const url   = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted    = true;
  video.preload  = 'auto';
  video.src      = url;

  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Video load error')), { once: true });
  });

  const results = [];
  for (const kf of keyframes) {
    const bitmap = await seekAndCapture(video, kf.timestamp_s, thumbW, thumbH);
    results.push({ bitmap, timestamp_s: kf.timestamp_s });
  }

  URL.revokeObjectURL(url);
  video.src = '';
  return results;
}

function seekAndCapture(video, time, width, height) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(video, 0, 0, width, height);
        createImageBitmap(canvas).then(resolve, reject);
      } catch (e) { reject(e); }
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error',  reject,    { once: true });
    video.currentTime = time;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
