import { useEditorStore } from '../store/editorStore'
import { SourceSections } from './inspector/SourceSections'

/**
 * The media analyzer as a modal panel — used on mobile, where there's no room
 * for the persistent right Inspector. On desktop the same source sections live
 * in the Inspector instead. Both render the shared `SourceSections`.
 */
export function AnalyzerPanel() {
  const analyzerSrcId = useEditorStore((s) => s.analyzerSrcId)
  const src = useEditorStore((s) => s.sources.find((x) => x.id === s.analyzerSrcId) ?? null)
  const closeAnalyzer = useEditorStore((s) => s.closeAnalyzer)

  if (!analyzerSrcId || !src) return null

  return (
    <div className="analyzer-overlay" onClick={closeAnalyzer}>
      <div className="analyzer" onClick={(e) => e.stopPropagation()}>
        <div className="analyzer-head">
          <span className="analyzer-title">{src.name}</span>
          <button className="btn icon" onClick={closeAnalyzer} title="Close">
            ✕
          </button>
        </div>
        <SourceSections src={src} />
      </div>
    </div>
  )
}
