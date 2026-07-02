/**
 * renderAudio.ts — produce encoded audio chunks for the timeline.
 *
 * Uses an OfflineAudioContext to decode each source and mix the audio clips at
 * their timeline positions into one buffer (faster-than-real-time), then feeds
 * that buffer to a WebCodecs `AudioEncoder` in chunks.
 */

import type { EdlEvent } from '../wasm/foxEdl'
import type { Source } from '../types'

const ENCODE_CHUNK = 1024

export interface RenderAudioArgs {
  events: EdlEvent[]
  sources: Source[]
  totalDuration: number
  sampleRate: number
  channels: number
  encoder: AudioEncoder
  signal?: AbortSignal
}

/** Mix + encode the whole audio timeline into `encoder`, then flush it. */
export async function renderAudio({
  events,
  sources,
  totalDuration,
  sampleRate,
  channels,
  encoder,
  signal,
}: RenderAudioArgs): Promise<void> {
  if (!events.length || totalDuration <= 0) {
    await encoder.flush()
    return
  }

  const byId = new Map(sources.map((s) => [s.id, s]))
  const length = Math.max(1, Math.ceil(totalDuration * sampleRate))
  const ctx = new OfflineAudioContext(channels, length, sampleRate)

  // Decode each referenced source (resampled to the render sample rate).
  const buffers = new Map<string, AudioBuffer>()
  for (const id of new Set(events.map((e) => e.source_id))) {
    const src = byId.get(id)
    if (!src) continue
    try {
      buffers.set(id, await ctx.decodeAudioData(await src.file.arrayBuffer()))
    } catch {
      /* undecodable audio (e.g. silent video) — skip */
    }
  }

  // Schedule every audio clip at its timeline position.
  for (const ev of events) {
    const buf = buffers.get(ev.source_id)
    if (!buf) continue
    const node = ctx.createBufferSource()
    node.buffer = buf
    node.connect(ctx.destination)
    node.start(ev.timeline_in_s, ev.source_in_s, ev.source_out_s - ev.source_in_s)
  }

  const mixed = await ctx.startRendering()
  const chans = mixed.numberOfChannels
  const total = mixed.length

  for (let off = 0; off < total; off += ENCODE_CHUNK) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
    const len = Math.min(ENCODE_CHUNK, total - off)
    const planar = new Float32Array(len * chans)
    for (let c = 0; c < chans; c++) {
      planar.set(mixed.getChannelData(c).subarray(off, off + len), c * len)
    }
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: len,
      numberOfChannels: chans,
      timestamp: Math.round((off / sampleRate) * 1_000_000),
      data: planar,
    })
    encoder.encode(data)
    data.close()
  }

  await encoder.flush()
}
