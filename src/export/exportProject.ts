/**
 * exportProject.ts — orchestrates the in-browser render: pick codecs, set up the
 * muxer + WebCodecs encoders, render the video and audio timelines, and finalize
 * into a downloadable file. See renderVideo/renderAudio for the two halves.
 */

import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer'
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer'
import { pickCodecs, even, type ExportCodecPlan } from './codecs'
import { renderVideo, type TransByClip } from './renderVideo'
import { renderAudio } from './renderAudio'
import { useEditorStore } from '../store/editorStore'
import { fromSpan, clipSpan } from '../lib/transition'
import type { EdlResult } from '../wasm/wazEdl'
import type { Clip, Source } from '../types'

const SAMPLE_RATE = 48000
const CHANNELS = 2

export type ExportStage = 'preparing' | 'video' | 'audio' | 'finalizing'

export interface ExportResult {
  blob: Blob
  ext: string
  container: 'mp4' | 'webm'
  videoCodec: string
  audioCodec: string | null
}

export interface ExportArgs {
  edl: EdlResult
  sources: Source[]
  onStage?: (stage: ExportStage) => void
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

interface AnyMuxer {
  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void
  addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void
  finalize(): void
}

function createMuxer(
  plan: ExportCodecPlan,
  width: number,
  height: number,
  fps: number,
): { muxer: AnyMuxer; target: { buffer: ArrayBuffer } } {
  if (plan.container === 'mp4') {
    const target = new Mp4Target()
    const muxer = new Mp4Muxer({
      target,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
      video: { codec: plan.video.muxerCodec as 'avc' | 'hevc' | 'av1', width, height },
      audio: plan.audio ? { codec: 'aac', numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE } : undefined,
    })
    return { muxer: muxer as unknown as AnyMuxer, target }
  }
  const target = new WebmTarget()
  const webmCodec = plan.video.muxerCodec === 'av1' ? 'V_AV1' : plan.video.muxerCodec === 'vp9' ? 'V_VP9' : 'V_VP8'
  const muxer = new WebmMuxer({
    target,
    firstTimestampBehavior: 'offset',
    video: { codec: webmCodec, width, height, frameRate: fps },
    audio: plan.audio ? { codec: 'A_OPUS', numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE } : undefined,
  })
  return { muxer: muxer as unknown as AnyMuxer, target }
}

/** Render the whole timeline to a single media file. */
export async function exportProject({ edl, sources, onStage, onProgress, signal }: ExportArgs): Promise<ExportResult> {
  onStage?.('preparing')

  const width = even(edl.ffmpeg.output.width)
  const height = even(edl.ffmpeg.output.height)
  const fps = edl.ffmpeg.output.fps || 30
  const total = edl.total_duration_s
  const hasAudio = edl.audio_events.length > 0

  if (total <= 0) throw new Error('Timeline is empty — add clips before exporting.')

  const plan = await pickCodecs(width, height, fps, hasAudio, SAMPLE_RATE, CHANNELS)
  const { muxer, target } = createMuxer(plan, width, height, fps)

  // Per-clip effects live on the store clips (both tracks); join by clip id, the
  // same side-map pattern as gainByClip — effects don't round-trip through the EDL.
  const st = useEditorStore.getState()

  // Plain fade envelopes (video renderer applies these outside dissolve windows).
  const fadesByClip = new Map(
    [...st.videoClips, ...st.audioClips]
      .filter((c) => c.fadeIn || c.fadeOut)
      .map((c) => [c.id, { fadeIn: c.fadeIn ?? 0, fadeOut: c.fadeOut ?? 0 }]),
  )
  // A dissolve is a same-layer construct: resolve each incoming clip's outgoing
  // partner within its own track only.
  const laneFrom = (clips: Clip[], b: Clip): Clip | null => {
    const lane = clips.filter((c) => c.trackId === b.trackId)
    const fs = fromSpan(lane.map(clipSpan), clipSpan(b))
    return (fs && lane.find((c) => c.id === fs.id)) || null
  }
  // Video dissolves, keyed by the incoming clip id (the video renderer blends).
  const transByClip: TransByClip = new Map()
  for (const b of st.videoClips) {
    const d = b.transitionIn?.dur
    if (!d) continue
    const from = laneFrom(st.videoClips, b)
    if (from) transByClip.set(b.id, { dur: d, fromClipId: from.id })
  }
  // Audio has no compositor, so a dissolve is expressed as effective fades: the
  // incoming clip fades in over the overlap and the outgoing clip fades out over
  // it — a linear crossfade the existing gain-ramp path renders unchanged.
  const audioFadesByClip = new Map(
    st.audioClips.map((c) => [c.id, { fadeIn: c.fadeIn ?? 0, fadeOut: c.fadeOut ?? 0 }]),
  )
  for (const b of st.audioClips) {
    const d = b.transitionIn?.dur
    if (!d) continue
    const to = audioFadesByClip.get(b.id)!
    to.fadeIn = Math.max(to.fadeIn, d)
    const from = laneFrom(st.audioClips, b)
    if (from) {
      const f = audioFadesByClip.get(from.id)!
      f.fadeOut = Math.max(f.fadeOut, d)
    }
  }

  let failure: Error | null = null
  const capture = (e: unknown) => {
    failure ??= e instanceof Error ? e : new Error(String(e))
  }

  // ── Video ──
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: capture,
  })
  const vcfg: VideoEncoderConfig = { codec: plan.video.codec, width, height, bitrate: plan.video.bitrate, framerate: fps }
  if (plan.video.codec.startsWith('avc')) vcfg.avc = { format: 'avc' }
  // `hevc` is in the WebCodecs spec but missing from @types/dom-webcodecs 0.1.x.
  if (plan.video.muxerCodec === 'hevc')
    (vcfg as VideoEncoderConfig & { hevc?: { format: 'hevc' | 'annexb' } }).hevc = { format: 'hevc' }
  // AV1/HEVC were only picked because a hardware encoder exists — hold it to that.
  if (plan.video.hardware) vcfg.hardwareAcceleration = 'prefer-hardware'
  videoEncoder.configure(vcfg)

  onStage?.('video')
  await renderVideo({
    events: edl.video_events,
    sources,
    width,
    height,
    fps,
    totalDuration: total,
    encoder: videoEncoder,
    fadesByClip,
    transByClip,
    onProgress: (done, all) => onProgress?.((done / all) * (hasAudio ? 0.9 : 0.97)),
    signal,
  })
  if (failure) throw failure

  // ── Audio ──
  if (plan.audio) {
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: capture,
    })
    audioEncoder.configure({
      codec: plan.audio.codec,
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: plan.audio.bitrate,
    })
    // Per-clip output levels live on the store's audio clips; join by clip id.
    const gainByClip = new Map(st.audioClips.map((c) => [c.id, c.gainDb]))

    onStage?.('audio')
    await renderAudio({
      events: edl.audio_events,
      sources,
      totalDuration: total,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      encoder: audioEncoder,
      gainByClip,
      fadesByClip: audioFadesByClip,
      signal,
    })
    if (failure) throw failure
    onProgress?.(0.98)
  }

  onStage?.('finalizing')
  muxer.finalize()
  onProgress?.(1)

  return {
    blob: new Blob([target.buffer], { type: plan.mime }),
    ext: plan.ext,
    container: plan.container,
    videoCodec: plan.video.codec,
    audioCodec: plan.audio?.codec ?? null,
  }
}
