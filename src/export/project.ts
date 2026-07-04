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

/** Build a project snapshot from the current store state. */
export function serializeProject(fps = EXPORT_FPS): Project {
  const s = useEditorStore.getState()
  const clip = (c: (typeof s.videoClips)[number]): ProjectClip => ({
    id: c.id,
    source_id: c.sourceId,
    link: c.link,
    start_s: c.start,
    in_s: c.in,
    dur_s: c.dur,
    z: c.z,
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
    video_clips: s.videoClips.map(clip),
    audio_clips: s.audioClips.map(clip),
  }
}
