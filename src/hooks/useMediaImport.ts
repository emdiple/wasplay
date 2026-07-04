import { useCallback } from 'react'
import { fox } from '../wasm/foxClient'
import { useEditorStore } from '../store/editorStore'
import { createColorGenerator } from '../lib/color'
import { decorateSource, measureLoudness } from '../lib/decorate'
import { uid } from '../lib/id'
import type { MediaInfo, Source } from '../types'

const VIDEO_RX = /\.(mp4|mov|mkv|webm|m4v|avi)$/i
const MEDIA_RX = /\.(mp4|mov|mkv|webm|m4v|avi|mp3|wav|flac|ogg|oga|aac|m4a)$/i

// Persisted across imports so each source gets a distinct, well-spaced hue.
const nextColor = createColorGenerator()

/**
 * A track's audio is real if the probe reported channels/sample-rate, or a
 * recognised (non-"unknown") audio codec. `get_media_info` leaves these null
 * when the container has no audio track.
 */
function hasAudioTrack(info: MediaInfo): boolean {
  if (info.channels != null || info.sample_rate != null) return true
  const codec = (info.audio_codec || '').toLowerCase()
  return codec !== '' && !codec.startsWith('unknown')
}

/** Read duration + dimensions with a throwaway media element (no WASM needed). */
function probeMedia(file: File, isVideo: boolean): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(isVideo ? 'video' : 'audio') as HTMLVideoElement
    el.preload = 'metadata'
    const url = URL.createObjectURL(file)
    el.onloadedmetadata = () => {
      const d = el.duration
      resolve({ duration: isFinite(d) ? d : 0, width: el.videoWidth || 0, height: el.videoHeight || 0 })
      URL.revokeObjectURL(url)
    }
    el.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('probe failed'))
    }
    el.src = url
  })
}

/**
 * Returns an `importFiles(fileList)` callback. Locks the app until every file's
 * waveform + thumbnails are fully decoded (long files stream in the worker).
 */
export function useMediaImport(): (fileList: FileList | File[]) => Promise<void> {
  return useCallback(async (fileList: FileList | File[]) => {
    const store = useEditorStore.getState()
    if (store.busy) return // already importing — ignore re-entrant drops

    const files = [...fileList].filter(
      (f) => f.type.startsWith('video/') || f.type.startsWith('audio/') || MEDIA_RX.test(f.name),
    )
    if (!files.length) return

    store.lockUI('Reading media…')
    try {
      let i = 0
      for (const file of files) {
        i++
        const prefix = files.length > 1 ? `(${i}/${files.length}) ` : ''
        store.setStatus(`Reading ${file.name}…`)
        store.lockUI(`${prefix}Reading ${file.name}…`)
        const isVideo = file.type.startsWith('video/') || VIDEO_RX.test(file.name)

        // Probe duration/dimensions and codec info together. `info` tells us whether
        // an audio track actually exists — a silent video gets no audio clip.
        const [meta, info] = await Promise.all([
          probeMedia(file, isVideo).catch(() => ({ duration: 0, width: 0, height: 0 })),
          fox.mediaInfo(file).catch(() => null),
        ])
        const hasAudio = info ? hasAudioTrack(info) : true

        const src: Source = {
          id: uid(),
          file,
          name: file.name,
          color: nextColor(),
          isVideo,
          hasAudio,
          info,
          duration: meta.duration > 0 ? meta.duration : 5,
          width: meta.width || 0,
          height: meta.height || 0,
          thumbs: null,
          peaks: null,
          lufs: hasAudio ? undefined : null,
          gainDb: 0,
        }
        store.addSource(src)
        measureLoudness(src)

        // Block until decoded — long files can take a while (streamed in worker).
        store.lockUI(`${prefix}Decoding ${file.name} — waveform${isVideo ? ' & thumbnails' : ''}…`)
        await decorateSource(src)
      }
    } finally {
      store.unlockUI()
    }

    const count = useEditorStore.getState().sources.length
    store.setStatus(`${count} clip${count === 1 ? '' : 's'} in bin — double-click to add to timeline.`)
  }, [])
}
