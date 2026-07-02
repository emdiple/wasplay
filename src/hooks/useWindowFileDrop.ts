import { useEffect, useState } from 'react'

/**
 * Window-wide drag-and-drop file import. Tracks drag depth so the drop overlay
 * shows only while files are actually being dragged over the window.
 *
 * @returns `true` while a file drag is in progress (to reveal the overlay).
 */
export function useWindowFileDrop(onFiles: (files: FileList) => void): boolean {
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDragLeave = () => {
      if (--depth <= 0) {
        depth = 0
        setDragging(false)
      }
    }
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      onFiles(e.dataTransfer.files)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [onFiles])

  return dragging
}
