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
