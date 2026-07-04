import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../store/editorStore'
import { serializeProject } from '../export/project'
import { exportEdl, type EdlResult } from '../wasm/foxEdl'
import { exportProject, type ExportStage } from '../export/exportProject'
import { pickCodecs, even, type ExportCodecPlan } from '../export/codecs'
import {
  downloadBlob,
  canPickSaveLocation,
  pickSaveFile,
  writeBlobToHandle,
  type FsFileHandle,
} from '../lib/download'

const DEFAULT_NAME = 'shadowfox-export'
/** Strip a trailing known media extension so we can re-append the real one. */
const baseName = (name: string): string => name.trim().replace(/\.(mp4|webm|m4v|mov)$/i, '') || DEFAULT_NAME

const STAGE_LABEL: Record<ExportStage, string> = {
  preparing: 'Preparing…',
  video: 'Rendering video…',
  audio: 'Rendering audio…',
  finalizing: 'Finalizing file…',
}

/** Export dialog: download the EDL (for external tools) or render the timeline
 * to a media file in-browser (WebCodecs). */
export function ExportDialog() {
  const open = useEditorStore((s) => s.exportOpen)
  const setExportOpen = useEditorStore((s) => s.setExportOpen)
  const hasContent = useEditorStore((s) => s.videoClips.length > 0 || s.audioClips.length > 0)

  const [edl, setEdl] = useState<EdlResult | null>(null)
  const [plan, setPlan] = useState<ExportCodecPlan | null>(null)
  const [filename, setFilename] = useState(DEFAULT_NAME)
  const [rendering, setRendering] = useState(false)
  const [stage, setStage] = useState<ExportStage>('preparing')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Compute the EDL whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setError(null)
    setEdl(null)
    setPlan(null)
    exportEdl(serializeProject())
      .then(setEdl)
      .catch((e) => setError(String(e?.message ?? e)))
  }, [open])

  // Predict the output container/codecs so the filename + save dialog show the
  // right extension before rendering (exportProject re-picks the same plan).
  useEffect(() => {
    if (!edl) return
    let live = true
    pickCodecs(even(edl.ffmpeg.output.width), even(edl.ffmpeg.output.height), edl.ffmpeg.output.fps || 30, edl.audio_events.length > 0, 48000, 2)
      .then((p) => live && setPlan(p))
      .catch(() => live && setPlan(null))
    return () => {
      live = false
    }
  }, [edl])

  if (!open) return null

  const close = () => {
    if (rendering) return // don't close mid-render; cancel first
    setExportOpen(false)
  }

  const downloadEdl = () => {
    if (!edl) return
    downloadBlob(JSON.stringify(edl, null, 2), 'shadowfox-timeline.edl.json', 'application/json')
  }

  const render = async () => {
    if (!edl) return
    const base = baseName(filename)
    const ext = plan?.ext ?? 'mp4'
    const mime = plan?.mime ?? 'video/mp4'

    // Ask WHERE to save first, while the click's user-activation is still valid
    // (a multi-second render would expire it). If the user cancels, do nothing.
    let handle: FsFileHandle | null = null
    if (canPickSaveLocation()) {
      try {
        handle = await pickSaveFile(`${base}.${ext}`, mime, ext, `${(plan?.container ?? 'mp4').toUpperCase()} video`)
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return // user dismissed the Save dialog
        handle = null // some other picker failure — fall back to a plain download
      }
    }

    setError(null)
    setRendering(true)
    setProgress(0)
    setStage('preparing')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await exportProject({
        edl,
        sources: useEditorStore.getState().sources,
        onStage: setStage,
        onProgress: setProgress,
        signal: controller.signal,
      })
      // Write to the chosen location if we have one, else download to the
      // browser's default folder under the requested name.
      if (handle) await writeBlobToHandle(handle, result.blob)
      else downloadBlob(result.blob, `${base}.${result.ext}`, result.blob.type)
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setError(String((e as Error)?.message ?? e))
    } finally {
      setRendering(false)
      abortRef.current = null
    }
  }

  const cancel = () => abortRef.current?.abort()

  return (
    <div className="analyzer-overlay" onClick={close}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="analyzer-head">
          <span className="analyzer-title">Export</span>
          <button className="btn icon" onClick={close} disabled={rendering} title="Close">
            ✕
          </button>
        </div>

        {!hasContent ? (
          <div className="export-empty">Add clips to the timeline before exporting.</div>
        ) : (
          <>
            <div className="export-summary">
              {edl ? (
                <>
                  {edl.ffmpeg.output.width}×{edl.ffmpeg.output.height} · {edl.ffmpeg.output.fps} fps ·{' '}
                  {edl.total_duration_s.toFixed(2)}s · {edl.video_events.length} video / {edl.audio_events.length} audio
                  clips
                </>
              ) : (
                'Computing timeline…'
              )}
            </div>

            <div className="export-row">
              <div>
                <div className="export-row-title">Edit Decision List</div>
                <div className="export-row-sub">Frame-accurate JSON + FFmpeg command, for external tools.</div>
              </div>
              <button className="btn" onClick={downloadEdl} disabled={!edl || rendering}>
                ⬇ Download EDL
              </button>
            </div>

            <div className="export-row">
              <div className="export-row-main">
                <div className="export-row-title">Media file</div>
                <div className="export-row-sub">
                  Render the timeline in-browser (WebCodecs)
                  {plan && ` · ${plan.container.toUpperCase()}`}.
                </div>
                <div className="export-filename">
                  <input
                    type="text"
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                    placeholder={DEFAULT_NAME}
                    disabled={rendering}
                    spellCheck={false}
                    aria-label="Output file name"
                  />
                  <span className="ext">.{plan?.ext ?? 'mp4'}</span>
                </div>
                <div className="export-hint">
                  {canPickSaveLocation()
                    ? 'You’ll choose the folder and confirm the name when you click.'
                    : 'Saves to your browser’s download folder.'}
                </div>
              </div>
              {rendering ? (
                <button className="btn" onClick={cancel}>
                  Cancel
                </button>
              ) : (
                <button className="btn primary" onClick={render} disabled={!edl}>
                  {canPickSaveLocation() ? '▶ Render & save…' : '▶ Render & download'}
                </button>
              )}
            </div>

            {rendering && (
              <div className="export-progress">
                <div className="export-progress-label">
                  <span>{STAGE_LABEL[stage]}</span>
                  <span>{Math.round(progress * 100)}%</span>
                </div>
                <div className="export-progress-bar">
                  <div className="export-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              </div>
            )}

            {error && <div className="export-error">{error}</div>}
          </>
        )}
      </div>
    </div>
  )
}
