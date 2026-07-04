/** Trigger a browser download of a Blob (or string) under a given filename. */
export function downloadBlob(data: Blob | string, filename: string, mime = 'application/octet-stream'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// ── Choose-your-own save location (File System Access API) ────────────────────
// Only Chromium browsers expose showSaveFilePicker; the surface we use isn't in
// every TS DOM lib version, so declare the minimal shape we call.
interface FsWritable {
  write(data: Blob): Promise<void>
  close(): Promise<void>
}
export interface FsFileHandle {
  createWritable(): Promise<FsWritable>
}
interface SaveFilePickerOptions {
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}
declare global {
  interface Window {
    showSaveFilePicker?: (opts?: SaveFilePickerOptions) => Promise<FsFileHandle>
  }
}

/** True when the browser can prompt for a save folder + name (Chromium). */
export const canPickSaveLocation = (): boolean =>
  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'

/**
 * Open the native Save-As dialog (folder + filename). Returns the chosen file
 * handle, or `null` when the API is unavailable (caller should fall back to
 * {@link downloadBlob}). Must be called from a user gesture; throws `AbortError`
 * if the user cancels the dialog.
 */
export async function pickSaveFile(
  suggestedName: string,
  mime: string,
  ext: string,
  description: string,
): Promise<FsFileHandle | null> {
  if (!canPickSaveLocation()) return null
  return window.showSaveFilePicker!({
    suggestedName,
    types: [{ description, accept: { [mime]: [`.${ext}`] } }],
  })
}

/** Stream a blob into a file handle returned by {@link pickSaveFile}. */
export async function writeBlobToHandle(handle: FsFileHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
}
