import React, { useEffect, useRef, useState } from 'react'
import { DEFAULT_TEMPLATES, Templates } from './render'

declare global {
  interface Window {
    showDirectoryPicker: any
  }
}

interface AppProps {
  visible: boolean
  onClose: () => void
  onSync: (onProgress: (msg: string) => void) => Promise<void>
  onReset: (alsoDeletePages: boolean) => Promise<void>
  templates: Templates
  onSaveTemplates: (t: Templates) => Promise<void>
  lastSync?: string
}

export default function App(props: AppProps) {
  const { visible, onClose, onSync, onReset, templates, onSaveTemplates, lastSync } = props
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [view, setView] = useState<'main' | 'templates' | 'reset'>('main')
  const [draftTemplates, setDraftTemplates] = useState<Templates>(templates)
  const [alsoDeletePages, setAlsoDeletePages] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraftTemplates(templates)
  }, [templates, visible])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, onClose])

  if (!visible) return null

  const onClickBackdrop = (e: React.MouseEvent) => {
    if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose()
  }

  return (
    <div style={backdropStyle} onClick={onClickBackdrop}>
      <div ref={modalRef} style={modalStyle}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Sync Koreader Highlights</h2>
          <button style={closeBtnStyle} onClick={onClose} aria-label="Close">×</button>
        </div>

        {view === 'main' && (
          <div>
            <p style={{ marginTop: 0, color: '#666' }}>
              Pick the directory containing your KOReader sidecars (e.g. your Calibre library or
              the directory Syncthing pulls from your reader). One Logseq page is created per
              book; subsequent syncs append new highlights only.
            </p>
            {lastSync && (
              <p style={{ color: '#888', fontSize: 12 }}>
                Last sync: {new Date(lastSync).toLocaleString()}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                style={primaryBtnStyle}
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  setProgress('Starting…')
                  try {
                    await onSync((msg) => setProgress(msg))
                  } catch (e: any) {
                    setProgress(`Error: ${e?.message ?? e}`)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {busy ? 'Syncing…' : 'Sync now'}
              </button>
              <button style={secondaryBtnStyle} disabled={busy} onClick={() => setView('templates')}>
                Customize templates
              </button>
              <button style={dangerBtnStyle} disabled={busy} onClick={() => setView('reset')}>
                Reset
              </button>
            </div>
            {progress && (
              <pre style={progressStyle}>{progress}</pre>
            )}
          </div>
        )}

        {view === 'templates' && (
          <div>
            <p style={{ marginTop: 0, color: '#666' }}>
              Mustache templates. <code>{'{{var}}'}</code> for substitutions; <code>{'{{#var}}…{{/var}}'}</code>
              {' '}for sections that only render when a value is present. Reset to restore defaults.
            </p>
            <TemplateField
              label="Book page header"
              value={draftTemplates.bookHeader}
              onChange={(v) => setDraftTemplates({ ...draftTemplates, bookHeader: v })}
              vars={['title', 'authors', 'language', 'koreaderId', 'description']}
            />
            <TemplateField
              label="Highlights section heading"
              value={draftTemplates.highlightsHeading}
              onChange={(v) => setDraftTemplates({ ...draftTemplates, highlightsHeading: v })}
              vars={['kind', 'date']}
            />
            <TemplateField
              label="Highlight block"
              value={draftTemplates.highlightBlock}
              onChange={(v) => setDraftTemplates({ ...draftTemplates, highlightBlock: v })}
              vars={['text', 'page', 'chapter', 'datetime', 'journalDay', 'timeOfDay', 'datetimeUpdated', 'journalDayUpdated', 'timeOfDayUpdated', 'id']}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                style={primaryBtnStyle}
                onClick={async () => { await onSaveTemplates(draftTemplates); setView('main') }}
              >Save</button>
              <button
                style={secondaryBtnStyle}
                onClick={() => setDraftTemplates(DEFAULT_TEMPLATES)}
              >Reset to defaults</button>
              <button style={secondaryBtnStyle} onClick={() => setView('main')}>Cancel</button>
            </div>
          </div>
        )}

        {view === 'reset' && (
          <div>
            <p style={{ marginTop: 0 }}>
              This will clear the plugin's memory of which books and highlights it has already synced.
              The next sync will treat every book as new and recreate the <code>KOReader</code> index page.
            </p>
            <label style={{ display: 'block', margin: '12px 0' }}>
              <input
                type="checkbox"
                checked={alsoDeletePages}
                onChange={(e) => setAlsoDeletePages(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Also delete the book pages I created previously (irreversible).
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                style={dangerBtnStyle}
                onClick={async () => {
                  await onReset(alsoDeletePages)
                  setView('main')
                  setAlsoDeletePages(false)
                }}
              >Reset sync state</button>
              <button style={secondaryBtnStyle} onClick={() => setView('main')}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TemplateField({
  label,
  value,
  onChange,
  vars,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  vars: string[]
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        style={{
          width: '100%',
          fontFamily: 'monospace',
          fontSize: 12,
          padding: 8,
          background: '#f8f8f8',
          border: '1px solid #ccc',
          borderRadius: 4,
          color: '#222',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
        Variables: {vars.map((v) => <code key={v} style={{ marginRight: 6 }}>{`{{${v}}}`}</code>)}
      </div>
    </div>
  )
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  paddingTop: 40, zIndex: 9999,
}
const modalStyle: React.CSSProperties = {
  background: '#fff', color: '#222', borderRadius: 8, padding: 20,
  width: 'min(640px, 90vw)', maxHeight: '85vh', overflowY: 'auto',
  boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
}
const headerStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  marginBottom: 16,
}
const closeBtnStyle: React.CSSProperties = {
  border: 'none', background: 'transparent', fontSize: 24, cursor: 'pointer', lineHeight: 1,
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none',
  borderRadius: 4, cursor: 'pointer', fontWeight: 600,
}
const secondaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: '#e5e7eb', color: '#222', border: 'none',
  borderRadius: 4, cursor: 'pointer',
}
const dangerBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: '#dc2626', color: '#fff', border: 'none',
  borderRadius: 4, cursor: 'pointer', fontWeight: 600,
}
const progressStyle: React.CSSProperties = {
  marginTop: 12, padding: 8, background: '#f3f4f6', borderRadius: 4,
  fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap',
}
