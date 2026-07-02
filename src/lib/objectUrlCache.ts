/** Caches one `blob:` object URL per source id, so preview media elements never re-create (and leak) URLs on every render. */

const cache = new Map<string, string>()

export function getObjectUrl(sourceId: string, file: File): string {
  let url = cache.get(sourceId)
  if (!url) {
    url = URL.createObjectURL(file)
    cache.set(sourceId, url)
  }
  return url
}
