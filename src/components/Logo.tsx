import { useState } from 'react'
import { useEditorStore } from '../store/editorStore'

/**
 * Project logo. Swaps between the dark-mode and light-mode variant to match the
 * app's active theme (the in-app toggle), not the OS setting.
 *
 * Falls back to the text wordmark if the image assets haven't been added yet
 * at `public/branding/logo-{dark,light}.png`, so a missing file never shows a
 * broken-image icon.
 */
export function Logo() {
  const [imageFailed, setImageFailed] = useState(false)
  const theme = useEditorStore((s) => s.theme)

  if (imageFailed) {
    return (
      <div className="logo">
        Shadow<b>fox</b> · Studio
      </div>
    )
  }

  return (
    <picture className="logo-pic">
      <img
        className="logo-img"
        src={theme === 'light' ? '/branding/logo-light.png' : '/branding/logo-dark.png'}
        alt="Shadowfox Studio"
        onError={() => setImageFailed(true)}
      />
    </picture>
  )
}
