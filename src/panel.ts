import '@logseq/libs'

/**
 * The panel renders inside the plugin's own iframe. That iframe does
 * NOT inherit Logseq's `--ls-*` theme variables, so the panel would
 * look nothing like the user's graph without help.
 *
 * Strategy (mirrors the logseq-reading-list plugin): try to read the
 * real Logseq theme variables from the parent document (accessible
 * on Logseq Desktop, where the plugin iframe is same-origin to the
 * host). If that's blocked, fall back to a polished light/dark
 * palette chosen from the user's preferred theme mode.
 */

const LS_VARS = [
  '--ls-primary-background-color',
  '--ls-secondary-background-color',
  '--ls-tertiary-background-color',
  '--ls-quaternary-background-color',
  '--ls-primary-text-color',
  '--ls-secondary-text-color',
  '--ls-border-color',
  '--ls-link-text-color',
  '--ls-active-primary-color',
  '--ls-selection-background-color',
] as const

type Palette = Record<string, string>

const LIGHT_FALLBACK: Palette = {
  '--ls-primary-background-color': '#ffffff',
  '--ls-secondary-background-color': '#f7f7f7',
  '--ls-tertiary-background-color': '#efefef',
  '--ls-quaternary-background-color': '#e4e4e4',
  '--ls-primary-text-color': '#1c1c1e',
  '--ls-secondary-text-color': '#6b6b6b',
  '--ls-border-color': '#d8d8d8',
  '--ls-link-text-color': '#2563eb',
  '--ls-active-primary-color': '#1f6feb',
  '--ls-selection-background-color': '#dbeafe',
}

const DARK_FALLBACK: Palette = {
  '--ls-primary-background-color': '#1e2022',
  '--ls-secondary-background-color': '#23272a',
  '--ls-tertiary-background-color': '#2b2f33',
  '--ls-quaternary-background-color': '#34393d',
  '--ls-primary-text-color': '#e6e6e6',
  '--ls-secondary-text-color': '#a0a0a0',
  '--ls-border-color': '#3a3f44',
  '--ls-link-text-color': '#6cb6ff',
  '--ls-active-primary-color': '#4493f8',
  '--ls-selection-background-color': '#2d4a73',
}

function readFromRealm(realm: Window | null): { palette: Palette; hits: number } | null {
  if (!realm) return null
  try {
    const doc = realm.document
    if (!doc) return null
    const cs = realm.getComputedStyle(doc.documentElement)
    const palette: Palette = {}
    let hits = 0
    for (const name of LS_VARS) {
      const v = cs.getPropertyValue(name).trim()
      if (v) {
        palette[name] = v
        hits++
      }
    }
    return { palette, hits }
  } catch {
    return null
  }
}

function readFromParent(): Palette | null {
  // Try window.parent first (the direct parent of this iframe), then
  // window.top (the topmost browsing context). Some Logseq builds
  // wrap plugin iframes one level deeper, in which case .parent is
  // an intermediate container without theme variables and .top is
  // the actual Logseq host. Combine results, preferring the realm
  // with more hits — when Awesome Styler is active it injects
  // --ls-* overrides on the host's <html data-theme="...">, so the
  // host realm has the richest palette.
  const fromParent = readFromRealm(window.parent ?? null)
  let fromTop: { palette: Palette; hits: number } | null = null
  try {
    if (window.top && window.top !== window.parent) {
      fromTop = readFromRealm(window.top)
    }
  } catch { /* cross-origin */ }
  const best = !fromParent ? fromTop
    : !fromTop ? fromParent
    : fromTop.hits > fromParent.hits ? fromTop : fromParent
  console.log('sync-koreader-highlights: theme read —',
    'parent hits:', fromParent?.hits ?? 'blocked',
    'top hits:', fromTop?.hits ?? 'same-as-parent-or-blocked',
    'best:', best ? best.hits : 'none')
  if (!best || best.hits === 0) return null
  return best.palette
}

function readFontFromRealm(realm: Window | null): string | null {
  if (!realm) return null
  try {
    const doc = realm.document
    if (!doc) return null
    const rootVar = realm.getComputedStyle(doc.documentElement)
      .getPropertyValue('--ls-font-family').trim()
    if (rootVar) return rootVar
    const bodyFont = realm.getComputedStyle(doc.body).fontFamily?.trim()
    return bodyFont || null
  } catch {
    return null
  }
}

function readFontFromParent(): string | null {
  return readFontFromRealm(window.parent ?? null) ?? readFontFromRealm(window.top ?? null)
}

async function resolvePalette(): Promise<Palette> {
  const fromParent = readFromParent()
  if (fromParent) return { ...DARK_FALLBACK, ...fromParent }
  let mode: string | undefined
  try {
    const cfg = (await logseq.App.getUserConfigs()) as { preferredThemeMode?: string }
    mode = cfg?.preferredThemeMode
  } catch { /* ignore */ }
  const dark = mode
    ? mode === 'dark'
    : window.matchMedia?.('(prefers-color-scheme: dark)').matches
  return dark ? DARK_FALLBACK : LIGHT_FALLBACK
}

export async function applyTheme(): Promise<void> {
  const palette = await resolvePalette()
  const font = readFontFromParent()
  if (font) palette['--ls-font-family'] = font
  const css = ':root{' + Object.entries(palette).map(([k, v]) => `${k}:${v};`).join('') + '}'
  let style = document.getElementById('skh-theme-vars') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'skh-theme-vars'
    document.head.appendChild(style)
  }
  style.textContent = css
}

export function watchTheme(): void {
  try {
    ;(logseq.App as any).onThemeModeChanged?.(() => { void applyTheme() })
  } catch (e) {
    console.warn('sync-koreader-highlights: onThemeModeChanged subscription failed', e)
  }
}

export interface PanelState {
  directoryName: string | null
  lastSync: string | null
  boundGraphName: string | null
  currentGraphName: string | null
}

export interface PanelHandlers {
  onPick: () => void | Promise<void>
  onSync: () => void | Promise<void>
  onRebind: () => void | Promise<void>
}

export interface OpenPanelArgs extends PanelHandlers {
  state: PanelState
  version: string
}

export interface OpenPanelResult {
  appendLog(line: string): void
  clearLog(): void
  setSyncing(syncing: boolean): void
  setDirectory(name: string | null): void
  setLastSync(iso: string | null): void
  setGraphInfo(boundName: string | null, currentName: string | null): void
  close(): void
}

/** True when the open graph is the bound graph (or nothing is bound yet, in
 *  which case the first sync will bind it). */
function graphMatches(boundName: string | null, currentName: string | null): boolean {
  return !boundName || boundName === currentName
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function fmtLastSync(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

/**
 * Build the dialog HTML, await the live theme read, mount it into
 * #app, wire handlers, and call .showModal() + logseq.showMainUI().
 * Modeled exactly on logseq-reading-list's OpenToolbarGoogle flow.
 */
export async function openPanel(args: OpenPanelArgs): Promise<OpenPanelResult> {
  await applyTheme()

  const { state, version, onPick, onSync, onRebind } = args
  const dirText = state.directoryName ? esc(state.directoryName) : 'No directory selected'
  const dirClass = state.directoryName ? 'skh-dir' : 'skh-muted'
  const lastSyncText = fmtLastSync(state.lastSync)
  const lastSyncClass = state.lastSync ? '' : 'skh-muted'
  const graphText = state.boundGraphName ? esc(state.boundGraphName) : 'not bound (binds on first sync)'
  const graphClass = state.boundGraphName ? 'skh-dir' : 'skh-muted'
  const matches = graphMatches(state.boundGraphName, state.currentGraphName)
  const warnText = matches
    ? ''
    : `Open graph "${esc(state.currentGraphName ?? '?')}" is not the bound graph — sync is disabled here.`
  const rebindLabel = state.boundGraphName ? 'Re-bind to this graph' : 'Bind to this graph'
  const syncDisabled = !state.directoryName || !matches

  const appHtml = `
    <dialog id="skhDialog" class="skh-dialog">
      <div class="skh-head">
        <h1>Sync KOReader Highlights</h1>
        <button id="skhClose" class="skh-iconbtn" title="Close" type="button">✕</button>
      </div>
      <div class="skh-status">
        <div>Directory: <span id="skhDir" class="${dirClass}">${dirText}</span></div>
        <div>Graph: <span id="skhGraph" class="${graphClass}">${graphText}</span></div>
        <div>Last sync: <span id="skhLastSync" class="${lastSyncClass}">${lastSyncText}</span></div>
        <div id="skhGraphWarn" class="skh-warn"${matches ? ' hidden' : ''}>${warnText}</div>
      </div>
      <div class="skh-actions">
        <button id="skhPick" class="skh-btn" type="button">Choose KOReader directory…</button>
        <button id="skhRebind" class="skh-btn" type="button">${rebindLabel}</button>
        <button id="skhSync" class="skh-primary" type="button"${syncDisabled ? ' disabled' : ''}>Sync now</button>
      </div>
      <pre id="skhLog" class="skh-log" aria-live="polite"></pre>
      <div class="skh-foot">
        <button id="skhOpenSettings" class="skh-link" type="button">Open plugin settings…</button>
        <span class="skh-version">v${esc(version)}</span>
      </div>
    </dialog>
  `

  const appEl = document.getElementById('app') as HTMLDivElement
  appEl.innerHTML = appHtml

  const dialog = document.getElementById('skhDialog') as HTMLDialogElement
  const dirSpan = document.getElementById('skhDir') as HTMLSpanElement
  const graphSpan = document.getElementById('skhGraph') as HTMLSpanElement
  const graphWarn = document.getElementById('skhGraphWarn') as HTMLDivElement
  const lastSyncSpan = document.getElementById('skhLastSync') as HTMLSpanElement
  const pickBtn = document.getElementById('skhPick') as HTMLButtonElement
  const rebindBtn = document.getElementById('skhRebind') as HTMLButtonElement
  const syncBtn = document.getElementById('skhSync') as HTMLButtonElement
  const closeBtn = document.getElementById('skhClose') as HTMLButtonElement
  const logEl = document.getElementById('skhLog') as HTMLPreElement
  const openSettings = document.getElementById('skhOpenSettings') as HTMLButtonElement

  // CRITICAL: no awaits before invoking the handler — iframe user
  // activation must reach showDirectoryPicker / input.click() in the
  // same task as the user's click.
  pickBtn.addEventListener('click', () => { void onPick() })
  rebindBtn.addEventListener('click', () => { void onRebind() })
  syncBtn.addEventListener('click', () => { void onSync() })
  closeBtn.addEventListener('click', () => { if (dialog.open) dialog.close() })
  openSettings.addEventListener('click', () => {
    try { logseq.showSettingsUI() } catch (err) {
      console.warn('sync-koreader-highlights: showSettingsUI failed', err)
    }
  })
  dialog.addEventListener('close', () => {
    try { logseq.hideMainUI({ restoreEditingCursor: true }) } catch { /* not ready */ }
  }, { once: true })

  dialog.showModal()
  logseq.showMainUI({ autoFocus: true })

  let currentDir = state.directoryName
  let syncing = false
  let graphOk = matches

  return {
    appendLog(line) {
      logEl.textContent = (logEl.textContent ? logEl.textContent + '\n' : '') + line
      logEl.scrollTop = logEl.scrollHeight
    },
    clearLog() { logEl.textContent = '' },
    setSyncing(s) {
      syncing = s
      syncBtn.disabled = syncing || !currentDir || !graphOk
      pickBtn.disabled = syncing
      rebindBtn.disabled = syncing
      syncBtn.textContent = syncing ? 'Syncing…' : 'Sync now'
    },
    setDirectory(name) {
      currentDir = name
      if (name) {
        dirSpan.textContent = name
        dirSpan.className = 'skh-dir'
      } else {
        dirSpan.textContent = 'No directory selected'
        dirSpan.className = 'skh-muted'
      }
      syncBtn.disabled = syncing || !currentDir || !graphOk
    },
    setLastSync(iso) {
      lastSyncSpan.textContent = fmtLastSync(iso)
      lastSyncSpan.className = iso ? '' : 'skh-muted'
    },
    setGraphInfo(boundName, currentName) {
      graphOk = graphMatches(boundName, currentName)
      if (boundName) {
        graphSpan.textContent = boundName
        graphSpan.className = 'skh-dir'
      } else {
        graphSpan.textContent = 'not bound (binds on first sync)'
        graphSpan.className = 'skh-muted'
      }
      rebindBtn.textContent = boundName ? 'Re-bind to this graph' : 'Bind to this graph'
      if (graphOk) {
        graphWarn.hidden = true
        graphWarn.textContent = ''
      } else {
        graphWarn.hidden = false
        graphWarn.textContent =
          `Open graph "${currentName ?? '?'}" is not the bound graph — sync is disabled here.`
      }
      syncBtn.disabled = syncing || !currentDir || !graphOk
    },
    close() { if (dialog.open) dialog.close() },
  }
}
