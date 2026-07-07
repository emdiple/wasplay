import { useState, type ReactNode } from 'react'

/**
 * A collapsible Inspector group — the disclosure-triangle sections pro NLEs use
 * to organise a clip's properties (Premiere's Effect Controls, Resolve's
 * Inspector). Header is a full-width toggle; an optional `right` slot holds a
 * per-group action (e.g. reset) and swallows its own clicks so it doesn't toggle.
 * Open state is local, so it persists while the group stays mounted.
 */
export function InspGroup({
  title,
  hint,
  right,
  defaultOpen = true,
  children,
}: {
  title: string
  hint?: string
  right?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={'insp-group' + (open ? ' open' : '')}>
      <button className="insp-group-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <svg className="insp-chevron" viewBox="0 0 10 10" aria-hidden>
          <path d="M3 1.5 L6.5 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="insp-group-title">{title}</span>
        {hint && <span className="insp-group-hint">{hint}</span>}
        {right && (
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
          <span className="insp-group-right" onClick={(e) => e.stopPropagation()}>
            {right}
          </span>
        )}
      </button>
      {open && <div className="insp-group-body">{children}</div>}
    </section>
  )
}
