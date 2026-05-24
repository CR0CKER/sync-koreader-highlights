import '@logseq/libs'
import { SettingSchemaDesc } from '@logseq/libs/dist/LSPlugin'
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval'
import {
  DEFAULT_BOOK_HEADER_TEMPLATE,
  DEFAULT_HIGHLIGHT_BLOCK_TEMPLATE,
  DEFAULT_HIGHLIGHTS_HEADING_TEMPLATE,
  DEFAULT_TEMPLATES,
  Templates,
} from './render'
import { INDEX_PAGE_NAME, resetSyncState, runSync } from './sync'
import { getBookIdsMap } from './storage'
import { openPanel as openPanelUI, OpenPanelResult, PanelState, watchTheme } from './panel'
import pkg from '../package.json'

const PICKER_HANDLE_KEY = 'sync-koreader-highlights:directoryHandle'
const LAST_SYNC_KEY = 'lastSync'

const SETTINGS_SCHEMA: SettingSchemaDesc[] = [
  {
    key: 'rememberDirectory',
    title: 'Remember Koreader directory',
    description: 'Cache the directory handle so the picker is skipped on subsequent syncs. Only works on Logseq builds that load the plugin same-origin with the host window (typically dev-mode "load unpacked plugin"). On packaged/marketplace installs the plugin runs in a cross-origin iframe and the directory must be re-selected from the panel each session.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'autoSyncOnLaunch',
    title: 'Auto-sync on Logseq launch',
    description: 'Run a sync once shortly after Logseq starts. Requires a persisted directory handle (see above); a no-op on packaged installs.',
    type: 'boolean',
    default: false,
  },
  {
    key: 'autoSyncIntervalMinutes',
    title: 'Auto-sync interval (minutes)',
    description: 'Run a sync automatically every N minutes. Set to 0 to disable. Each automatic sync only runs if a persisted directory handle is available; a no-op on packaged installs.',
    type: 'number',
    default: 0,
  },
  {
    key: 'bookHeaderTemplate',
    title: 'Book page header template (Mustache)',
    description:
      'Mustache template defining the page-level properties on each book page. ' +
      'Default produces author / full-title / series / category (#Books) / summary / tags. ' +
      'Render output is parsed line-by-line as `key:: value` pairs and written via Logseq\'s structured `createPage` properties API for safe escaping (the same path is used whether you keep the default or customise). ' +
      'Lines that don\'t match `key:: value` are dropped — empty Mustache sections (e.g. `{{#series}}…{{/series}}`) collapse cleanly. ' +
      'Variables: {{title}}, {{authors}} (comma-joined plain text), {{authorsLinked}} (each as [[wikilink]]), ' +
      '{{series}}, {{seriesLinked}}, {{tags}}, {{tagsLinked}}, ' +
      '{{language}}, {{summary}} (alias {{description}}), {{koreaderId}}.',
    type: 'string',
    inputAs: 'textarea',
    default: DEFAULT_BOOK_HEADER_TEMPLATE,
  },
  {
    key: 'highlightsHeadingTemplate',
    title: 'Highlights section heading template (Mustache)',
    description:
      'Mustache template for the heading block above each book\'s highlights. ' +
      'Re-rendered on every sync so its date stays current. ' +
      'Variables: {{date}}, {{kind}} ("initial sync" or "sync").',
    type: 'string',
    inputAs: 'textarea',
    default: DEFAULT_HIGHLIGHTS_HEADING_TEMPLATE,
  },
  {
    key: 'highlightBlockTemplate',
    title: 'Highlight block template (Mustache)',
    description:
      'Mustache template for each highlight block on a book page. ' +
      'When left at the default, the plugin uses Logseq\'s structured-properties API for safer rendering. ' +
      'Modify to take full control of the block content (text + inline `key:: value` properties). ' +
      'Variables: {{text}}, {{date}}, {{dateUpdated}}, {{chapter}}, {{page}}, {{note}}.',
    type: 'string',
    inputAs: 'textarea',
    default: DEFAULT_HIGHLIGHT_BLOCK_TEMPLATE,
  },
]

function backfillTemplateDefaults(): void {
  const s = logseq.settings ?? {}
  const updates: Record<string, string> = {}
  if (!(s.bookHeaderTemplate as string | undefined)?.trim()) {
    updates.bookHeaderTemplate = DEFAULT_TEMPLATES.bookHeader
  }
  if (!(s.highlightsHeadingTemplate as string | undefined)?.trim()) {
    updates.highlightsHeadingTemplate = DEFAULT_TEMPLATES.highlightsHeading
  }
  if (!(s.highlightBlockTemplate as string | undefined)?.trim()) {
    updates.highlightBlockTemplate = DEFAULT_TEMPLATES.highlightBlock
  }
  if (Object.keys(updates).length > 0) {
    logseq.updateSettings(updates)
    console.log('sync-koreader-highlights: backfilled template defaults:', Object.keys(updates))
  }
}

function loadTemplates(): Templates {
  const s = logseq.settings ?? {}
  return {
    bookHeader: (s.bookHeaderTemplate as string) || DEFAULT_TEMPLATES.bookHeader,
    highlightsHeading: (s.highlightsHeadingTemplate as string) || DEFAULT_TEMPLATES.highlightsHeading,
    highlightBlock: (s.highlightBlockTemplate as string) || DEFAULT_TEMPLATES.highlightBlock,
  }
}

const pickerCache: { handle: any | null } = { handle: null }

async function loadCachedHandle(): Promise<void> {
  try {
    const handle = await idbGet(PICKER_HANDLE_KEY)
    if (handle) {
      pickerCache.handle = handle
      console.log('sync-koreader-highlights: restored cached directory handle:', handle.name)
    }
  } catch (e) {
    console.warn('sync-koreader-highlights: failed to read cached directory handle from IDB', e)
  }
}

async function persistHandle(handle: any): Promise<void> {
  try {
    await idbSet(PICKER_HANDLE_KEY, handle)
  } catch (e) {
    console.warn('sync-koreader-highlights: failed to persist directory handle to IDB', e)
  }
}

async function clearCachedHandle(): Promise<void> {
  pickerCache.handle = null
  try { await idbDel(PICKER_HANDLE_KEY) } catch {}
}

/**
 * Ensure read permission on a real FSA handle. Must be called from a
 * user-activation context (e.g. the Sync button's click handler) so
 * Chromium will show its permission prompt when permission has lapsed
 * across a Logseq restart. Returns true if granted, false otherwise.
 * Fake input-fallback handles always return true — they hold File
 * objects directly and need no permission.
 */
async function ensureReadPermission(handle: any): Promise<boolean> {
  if (!handle || handle.__fakeFsHandle) return true
  try {
    const current = await handle.queryPermission?.({ mode: 'read' })
    if (current === 'granted') return true
    const granted = await handle.requestPermission?.({ mode: 'read' })
    return granted === 'granted'
  } catch (e) {
    console.warn('sync-koreader-highlights: ensureReadPermission threw', e)
    return false
  }
}

/**
 * Detect whether this plugin runs in a cross-origin iframe. Logseq's
 * packaged/marketplace install runs plugins in a cross-origin iframe;
 * dev-mode "load unpacked plugin" usually shares origin with the host.
 * The File System Access API (`showDirectoryPicker`) is blocked from
 * cross-origin iframes by Chromium's Permissions Policy regardless of
 * which realm exposes the function, and `<input>.click()` requires
 * user activation that does not propagate through Logseq's command
 * bridge. Both work fine when invoked from inside the plugin's own
 * iframe in response to an in-iframe button click — which is what the
 * panel UI is for.
 */
function isCrossOriginIframe(): boolean {
  if (window.top === window.self) return false
  try {
    void window.top!.document
    return false
  } catch {
    return true
  }
}

function showDirectoryPickerAvailable(): boolean {
  return typeof (window as any).showDirectoryPicker === 'function'
}

/**
 * Wrap a flat `FileList` produced by `<input webkitdirectory>` in an
 * object that mimics enough of `FileSystemDirectoryHandle` for
 * `walkSidecars()` to iterate it. The directory tree is collapsed
 * into a single fake root yielding every file at top level — the
 * walker's filename regex handles selection, so depth is irrelevant
 * for sidecar discovery.
 */
function buildFakeDirectoryHandle(name: string, files: File[]): any {
  return {
    __fakeFsHandle: true,
    kind: 'directory',
    name,
    async *values() {
      for (const f of files) {
        yield {
          kind: 'file',
          name: f.name,
          getFile: async () => f,
        }
      }
    },
  }
}

/**
 * Open a `<input type="file" webkitdirectory>` picker. Must be invoked
 * synchronously (no awaits) from a real in-iframe user-click event
 * handler, otherwise Chromium drops the activation transient and the
 * dialog refuses to open.
 */
function pickDirectoryViaInput(): Promise<any | null> {
  return new Promise<any | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    ;(input as any).webkitdirectory = true
    ;(input as any).directory = true
    input.multiple = true
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.appendChild(input)

    let settled = false
    const finish = (val: any) => {
      if (settled) return
      settled = true
      try { input.remove() } catch {}
      resolve(val)
    }

    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [])
      if (files.length === 0) {
        finish(null)
        return
      }
      const rootName = (files[0] as any).webkitRelativePath?.split('/')[0] || 'KOReader'
      finish(buildFakeDirectoryHandle(rootName, files))
    })
    input.addEventListener('cancel', () => finish(null))
    const onFocusBackup = () => {
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) finish(null)
      }, 500)
      window.removeEventListener('focus', onFocusBackup)
    }
    window.addEventListener('focus', onFocusBackup)

    input.click()
  })
}

/**
 * Picker for the in-iframe panel button. Always shows the dialog (no
 * cached-handle short-circuit, no permission re-grant dance) so the
 * call reaches the picker on the same tick as the user click, which
 * is what iframe user activation needs.
 */
function pickDirectoryFromPanel(): Promise<any | null> {
  if (showDirectoryPickerAvailable() && !isCrossOriginIframe()) {
    return (window as any).showDirectoryPicker().then(
      (handle: any) => handle,
      (e: any) => {
        if (e?.name === 'AbortError') return null
        // Fall back to the input picker. Activation is already consumed
        // by the failed picker call, so this may not open until the
        // user clicks the button again — surface a hint.
        console.warn('sync-koreader-highlights: showDirectoryPicker rejected; falling back to <input>', e)
        return pickDirectoryViaInput()
      },
    )
  }
  return pickDirectoryViaInput()
}

let syncInFlight = false
let panel: OpenPanelResult | null = null
const panelState: PanelState = { directoryName: null, lastSync: null }

async function runSyncFromPanel(): Promise<void> {
  if (!panel) return
  if (syncInFlight) {
    panel.appendLog('A sync is already running.')
    return
  }
  const handle = pickerCache.handle
  if (!handle) {
    panel.appendLog('No directory selected — click "Choose KOReader directory…" first.')
    return
  }
  // First await — keep the click's user activation reachable so
  // Chromium will show the re-grant prompt if permission lapsed
  // across a Logseq restart.
  const granted = await ensureReadPermission(handle)
  if (!granted) {
    panel.appendLog(
      `Permission to read "${handle.name}" was not granted. ` +
      `Click "Choose KOReader directory…" to re-select the folder.`,
    )
    await logseq.UI.showMsg(
      'KOReader directory permission was denied. Re-select the folder from the panel.',
      'warning',
    )
    return
  }
  syncInFlight = true
  panel.setSyncing(true)
  panel.clearLog()
  panel.appendLog(`Starting sync against "${handle.name}"…`)
  try {
    const info = await logseq.App.getUserConfigs()
    const result = await runSync({
      directoryHandle: handle,
      preferredDateFormat: info.preferredDateFormat,
      templates: loadTemplates(),
      onProgress: (msg) => panel?.appendLog(msg),
    })
    const newHighlightCount = result.updatedBooks.reduce((a, b) => a + b.addedCount, 0)
    const summary =
      `Done — ${result.newBooks.length} new book(s), ` +
      `${newHighlightCount} new highlight(s), ` +
      `${result.skippedStubs} stub(s) skipped` +
      (result.errors.length > 0 ? `, ${result.errors.length} error(s) (see console)` : '.')
    panel.appendLog(summary)
    const nowIso = new Date().toISOString()
    panelState.lastSync = nowIso
    panel.setLastSync(nowIso)
    logseq.updateSettings({ [LAST_SYNC_KEY]: nowIso })
    await logseq.UI.showMsg(summary, result.errors.length > 0 ? 'warning' : 'success')
  } catch (e: any) {
    console.error('sync-koreader-highlights: sync failed', e)
    panel.appendLog(`Sync failed: ${e?.message ?? e}`)
    await logseq.UI.showMsg(`Sync failed: ${e?.message ?? e}`, 'error')
  } finally {
    syncInFlight = false
    panel.setSyncing(false)
  }
}

/**
 * Background sync entry point. Used by `applyAutoSyncInterval` and
 * `scheduleLaunchSync`. Only ever runs against a real FSA handle
 * (fake handles can't survive across plugin reloads anyway). Silent
 * on failure — there's no user-facing surface to update.
 */
async function backgroundSync(): Promise<void> {
  if (syncInFlight) return
  const handle = pickerCache.handle
  if (!handle || handle.__fakeFsHandle) return
  // No user activation here — ensureReadPermission can only succeed
  // when Chromium silently re-grants (already 'granted').
  if (!(await ensureReadPermission(handle))) return
  syncInFlight = true
  try {
    const info = await logseq.App.getUserConfigs()
    const result = await runSync({
      directoryHandle: handle,
      preferredDateFormat: info.preferredDateFormat,
      templates: loadTemplates(),
      onProgress: (msg) => console.log('sync-koreader-highlights:', msg),
    })
    const nowIso = new Date().toISOString()
    panel?.setLastSync(nowIso)
    logseq.updateSettings({ [LAST_SYNC_KEY]: nowIso })
    const newHighlightCount = result.updatedBooks.reduce((a, b) => a + b.addedCount, 0)
    if (result.newBooks.length > 0 || newHighlightCount > 0) {
      await logseq.UI.showMsg(
        `Sync done — ${result.newBooks.length} new book(s), ${newHighlightCount} new highlight(s).`,
        'success',
      )
    }
  } catch (e: any) {
    console.error('sync-koreader-highlights: background sync failed', e)
  } finally {
    syncInFlight = false
  }
}

let intervalHandle: number | null = null

function applyAutoSyncInterval(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  const minutes = Number(logseq.settings?.autoSyncIntervalMinutes ?? 0)
  if (!Number.isFinite(minutes) || minutes <= 0) return
  const ms = Math.max(1, Math.floor(minutes)) * 60 * 1000
  intervalHandle = window.setInterval(() => {
    void backgroundSync()
  }, ms)
}

async function openPanel(): Promise<void> {
  try {
    panel = await openPanelUI({
      state: panelState,
      version: pkg.version,
      onPick: async () => {
        const handle = await pickDirectoryFromPanel()
        if (!handle) return
        pickerCache.handle = handle
        panelState.directoryName = handle.name
        panel?.setDirectory(handle.name)
        if (logseq.settings?.rememberDirectory && !handle.__fakeFsHandle) {
          await persistHandle(handle)
        }
      },
      onSync: () => runSyncFromPanel(),
    })
  } catch (e) {
    console.error('sync-koreader-highlights: openPanel failed', e)
  }
}

async function bootstrap() {
  console.log('sync-koreader-highlights: main loaded (v' + pkg.version + ')')
  logseq.useSettingsSchema(SETTINGS_SCHEMA)
  backfillTemplateDefaults()

  await loadCachedHandle()

  if (pickerCache.handle) panelState.directoryName = pickerCache.handle.name
  const lastSync = logseq.settings?.[LAST_SYNC_KEY] as string | undefined
  if (lastSync) panelState.lastSync = lastSync

  watchTheme()

  logseq.onSettingsChanged((newSettings: any, oldSettings: any) => {
    applyAutoSyncInterval()
    if (oldSettings?.rememberDirectory && !newSettings?.rememberDirectory) {
      void clearCachedHandle()
      panelState.directoryName = null
      try { panel?.setDirectory(null) } catch { /* dialog rebuilt */ }
    }
  })

  logseq.provideModel({
    openPanel() { openPanel() },
  })

  logseq.App.registerUIItem('toolbar', {
    // Logseq uses the toolbar key in CSS selectors for the plugin
    // dropdown's icon lookup; spaces break those selectors and the
    // entry then renders without an icon.
    key: 'sync-koreader-highlights',
    template: `
      <a data-on-click="openPanel" class="button" title="Sync KOReader Highlights">
        <i class="ti ti-book"></i>
      </a>
    `,
  })

  logseq.App.registerCommandPalette(
    { key: 'sync-koreader-highlights-open-panel', label: 'Sync Koreader Highlights: open panel' },
    () => { openPanel() },
  )

  logseq.App.registerCommandPalette(
    { key: 'sync-koreader-highlights-reset', label: 'Sync Koreader Highlights: reset sync state' },
    async () => {
      await resetSyncState()
      await clearCachedHandle()
      panelState.directoryName = null
      panelState.lastSync = null
      try { panel?.setDirectory(null) } catch { /* dialog rebuilt */ }
      try { panel?.setLastSync(null) } catch { /* dialog rebuilt */ }
      await logseq.UI.showMsg('Sync Koreader Highlights: sync state reset.', 'success')
    },
  )

  logseq.App.registerCommandPalette(
    { key: 'sync-koreader-highlights-reset-and-delete', label: 'Sync Koreader Highlights: reset and delete all book pages' },
    async () => {
      const ids = getBookIdsMap()
      for (const entry of Object.values(ids)) {
        try { await logseq.Editor.deletePage(entry.title) } catch (e) {
          console.warn('sync-koreader-highlights: deletePage failed for', entry.title, e)
        }
      }
      try { await logseq.Editor.deletePage(INDEX_PAGE_NAME) } catch (e) {
        console.warn('sync-koreader-highlights: deletePage failed for index', e)
      }
      await resetSyncState()
      await clearCachedHandle()
      panelState.directoryName = null
      panelState.lastSync = null
      try { panel?.setDirectory(null) } catch { /* dialog rebuilt */ }
      try { panel?.setLastSync(null) } catch { /* dialog rebuilt */ }
      await logseq.UI.showMsg('Sync Koreader Highlights: reset complete; book pages deleted.', 'success')
    },
  )

  logseq.App.registerCommandPalette(
    { key: 'sync-koreader-highlights-forget-directory', label: 'Sync Koreader Highlights: forget remembered directory' },
    async () => {
      await clearCachedHandle()
      panelState.directoryName = null
      try { panel?.setDirectory(null) } catch { /* dialog rebuilt */ }
      await logseq.UI.showMsg('Sync Koreader Highlights: directory cache cleared.', 'success')
    },
  )

  logseq.App.registerCommandPalette(
    { key: 'sync-koreader-highlights-reset-templates', label: 'Sync Koreader Highlights: reset templates to defaults' },
    async () => {
      await logseq.updateSettings({
        bookHeaderTemplate: DEFAULT_TEMPLATES.bookHeader,
        highlightsHeadingTemplate: DEFAULT_TEMPLATES.highlightsHeading,
        highlightBlockTemplate: DEFAULT_TEMPLATES.highlightBlock,
      })
      await logseq.UI.showMsg('Sync Koreader Highlights: templates reset to defaults.', 'success')
    },
  )

  applyAutoSyncInterval()

  if (logseq.settings?.autoSyncOnLaunch) {
    console.log('sync-koreader-highlights: autoSyncOnLaunch on; scheduling launch sync')
    void scheduleLaunchSync()
  }
}

/**
 * Best-effort auto-sync on launch. Only fires when a real FSA handle
 * is cached AND its permission can be re-granted without user
 * activation (Chromium often re-grants silently after previous
 * approval). Fake handles from the <input> fallback are skipped
 * because they don't persist across plugin reloads anyway. This path
 * is effectively dev-mode-only / same-origin-only — packaged installs
 * never persist a real handle.
 */
async function scheduleLaunchSync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 1500))
  const handle = pickerCache.handle
  if (!handle || handle.__fakeFsHandle) {
    console.log('sync-koreader-highlights: launch sync skipped — no real cached handle')
    return
  }
  try {
    const perm = await handle.queryPermission?.({ mode: 'read' })
    console.log('sync-koreader-highlights: launch handle permission =', perm)
    if (perm === 'granted') {
      void backgroundSync()
      return
    }
  } catch (e) {
    console.warn('sync-koreader-highlights: launch queryPermission threw', e)
    return
  }

  console.log('sync-koreader-highlights: deferring launch sync to next user activation')
  let triggered = false
  const onActivation = async () => {
    if (triggered) return
    triggered = true
    try {
      const granted = await ensureReadPermission(handle)
      console.log('sync-koreader-highlights: deferred ensureReadPermission =', granted)
      if (granted) {
        void backgroundSync()
      }
    } finally {
      detach()
    }
  }
  const detach = () => {
    window.removeEventListener('pointerdown', onActivation, true)
    window.removeEventListener('keydown', onActivation, true)
    try {
      window.parent?.removeEventListener?.('pointerdown', onActivation, true)
      window.parent?.removeEventListener?.('keydown', onActivation, true)
    } catch { /* cross-origin */ }
  }
  window.addEventListener('pointerdown', onActivation, true)
  window.addEventListener('keydown', onActivation, true)
  try {
    window.parent?.addEventListener('pointerdown', onActivation, true)
    window.parent?.addEventListener('keydown', onActivation, true)
  } catch { /* cross-origin */ }
}

logseq.ready(bootstrap).catch(console.error)
