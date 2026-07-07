/**
 * project.ts — serialize the editor store into the flat "project" snapshot the
 * waz-edl-wasm exporter and the render pipeline consume. The store stays the
 * single source of truth; this is just a field-name mapping to the WASM shape.
 */

import { useEditorStore } from '../store/editorStore'

/** Project frame rate used for EDL/render (the store tracks time in seconds only). */
export const EXPORT_FPS = 30

export interface ProjectSource {
  id: string
  name: string
  duration_s: number
  width: number
  height: number
  has_audio: boolean
  is_video: boolean
}

export interface ProjectClip {
  id: string
  source_id: string
  link: string
  start_s: number
  in_s: number
  dur_s: number
  z: number
}

export interface Project {
  fps: number
  sources: ProjectSource[]
  video_clips: ProjectClip[]
  audio_clips: ProjectClip[]
}

/**
 * Layer separation in the flattened z passed to the EDL/compositor. Track
 * priority dominates within-track stacking, so a clip on V2 always composites
 * above anything on V1 regardless of their per-clip z values.
 */
const Z_BAND = 1_000_000

/** Build a project snapshot from the current store state. */
export function serializeProject(fps = EXPORT_FPS): Project {
  const s = useEditorStore.getState()
  // The EDL shape has no track concept — layers are flattened into z bands:
  // effective z = videoTrackIndex * Z_BAND + clip z. Audio needs no banding
  // (every audio event mixes regardless of order).
  const videoOrder = s.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const clip = (c: (typeof s.videoClips)[number], band = 0): ProjectClip => ({
    id: c.id,
    source_id: c.sourceId,
    link: c.link,
    start_s: c.start,
    in_s: c.in,
    dur_s: c.dur,
    z: band * Z_BAND + c.z,
  })
  return {
    fps,
    sources: s.sources.map((src) => ({
      id: src.id,
      name: src.name,
      duration_s: src.duration,
      width: src.width,
      height: src.height,
      has_audio: src.hasAudio,
      is_video: src.isVideo,
    })),
    video_clips: s.videoClips.map((c) => clip(c, Math.max(0, videoOrder.indexOf(c.trackId)))),
    audio_clips: s.audioClips.map((c) => clip(c)),
  }
}
