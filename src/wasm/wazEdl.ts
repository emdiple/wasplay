/**
 * wazEdl.ts — main-thread client for the stateless waz-edl-wasm exporter.
 *
 * EDL export is a pure JSON→JSON transform with no file reads, so it runs on the
 * main thread (lazily initialising the wasm module once) rather than going
 * through the media worker.
 */

import initEdl, { export_edl, validate } from './pkg/waz-edl-wasm/waz_edl_wasm.js'
import type { Project } from '../export/project'

let ready: Promise<unknown> | null = null
const ensure = () => (ready ??= initEdl())

/** One clip mapped onto the output timeline, frame-accurate. */
export interface EdlEvent {
  clip_id: string
  source_id: string
  link: string
  input_index: number
  z: number
  source_in_frame: number
  source_out_frame: number
  timeline_in_frame: number
  timeline_out_frame: number
  source_in_s: number
  source_out_s: number
  timeline_in_s: number
  timeline_out_s: number
}

export interface EdlResult {
  version: string
  framerate: { fps: number }
  total_frames: number
  total_duration_s: number
  sources: {
    source_id: string
    name: string
    input_index: number
    is_video: boolean
    has_audio: boolean
    width: number
    height: number
    duration_s: number
  }[]
  video_events: EdlEvent[]
  audio_events: EdlEvent[]
  ffmpeg: {
    output: { width: number; height: number; fps: number }
    filter_complex: string
    suggested_command: string
  }
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/** Produce the frame-accurate EDL (events + FFmpeg command) for a project. */
export async function exportEdl(project: Project): Promise<EdlResult> {
  await ensure()
  return JSON.parse(export_edl(JSON.stringify(project))) as EdlResult
}

/** Validate a project against its sources. */
export async function validateProject(project: Project): Promise<ValidationResult> {
  await ensure()
  return JSON.parse(validate(JSON.stringify(project))) as ValidationResult
}
