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

const PICKER_HANDLE_KEY = 'sync-koreader-highlights:directoryHandle'

const SETTINGS_SCHEMA: SettingSchemaDesc[] = [
  {
    key: 'rememberDirectory',
    title: 'Remember Koreader directory',
    description: 'Cache the directory handle so the picker is skipped on subsequent syncs.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'autoSyncOnLaunch',
    title: 'Auto-sync on Logseq launch',
    description: 'Run a sync once shortly after Logseq starts.',
    type: 'boolean',
    default: false,
  },
  {
    key: 'autoSyncIntervalMinutes',
    title: 'Auto-sync interval (minutes)',
    description: 'Run a sync automatically every N minutes. Set to 0 to disable. Note: each automatic sync only runs if a directory was previously remembered (otherwise it would prompt for the picker, which is disruptive).',
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

/**
 * Logseq does not backfill schema defaults onto settings keys that have
 * already been written to the user's settings file (which happens on
 * first plugin load even if the user never opens the settings panel).
 * That leaves the textareas blank in the UI for users upgrading from a
 * prior version where the default was an empty string. On every load,
 * write the shipped default into any template field that's missing or
 * blank so the UI shows an editable starting point.
 */
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

// In-memory cache populated from IndexedDB on bootstrap and on every fresh
// pick. FileSystemDirectoryHandle is structured-cloneable, so it survives
// across plugin reloads (and Logseq restarts) when persisted to IDB.
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
 * Resolve a callable `showDirectoryPicker` across realms.
 *
 * Logseq plugins run inside an iframe. The File System Access API is
 * gated by Permissions Policy and is disabled by default in cross-origin
 * iframes — on macOS / Windows Logseq builds the call from inside the
 * iframe throws SecurityError or returns undefined, so the native dialog
 * never appears. Linux builds happen to expose it in the iframe realm,
 * which is why this code path appeared to work there.
 *
 * Walk up to the top window and pick the first realm that exposes the
 * function. The returned FileSystemDirectoryHandle is structured-cloneable
 * and works fine when used back in the iframe realm (its `.values()`,
 * `.getFile()`, etc. cross realms without issue).
 */
function resolveDirectoryPicker(): (() => Promise<any>) | null {
  const realms: Window[] = []
  let w: Window | null = window
  const seen = new Set<Window>()
  while (w && !seen.has(w)) {
    seen.add(w)
    realms.push(w)
    try {
      const next: Window | null = w.parent
      if (!next || next === w) break
      w = next
    } catch {
      // Cross-origin guard — can't walk further up.
      break
    }
  }
  for (const realm of realms) {
    try {
      const fn = (realm as any).showDirectoryPicker
      if (typeof fn === 'function') return fn.bind(realm)
    } catch {
      // Accessing the property may throw on locked-down realms; skip.
    }
  }
  return null
}

async function pickDirectory(allowPrompt: boolean): Promise<any | null> {
  const remember = !!logseq.settings?.rememberDirectory
  if (remember && pickerCache.handle) {
    try {
      const perm = await pickerCache.handle.queryPermission?.({ mode: 'read' })
      console.log('sync-koreader-highlights: cached handle permission =', perm, 'allowPrompt=', allowPrompt)
      if (perm === 'granted') return pickerCache.handle
      if (!allowPrompt) {
        // requestPermission requires user activation; calling it from a
        // background timer or launch hook throws "User activation is required".
        // Defer to the next time the user clicks the toolbar.
        return null
      }
      const granted = await pickerCache.handle.requestPermission?.({ mode: 'read' })
      console.log('sync-koreader-highlights: requestPermission =', granted)
      if (granted === 'granted') return pickerCache.handle
    } catch (e) {
      console.warn('sync-koreader-highlights: cached handle permission check failed', e)
    }
  }
  if (!allowPrompt) return null
  const picker = resolveDirectoryPicker()
  console.log(
    'sync-koreader-highlights: showDirectoryPicker availability —',
    'self:', typeof (window as any).showDirectoryPicker,
    'parent:', (() => { try { return typeof (window.parent as any)?.showDirectoryPicker } catch { return 'blocked' } })(),
    'top:', (() => { try { return typeof (window.top as any)?.showDirectoryPicker } catch { return 'blocked' } })(),
    'resolved:', picker ? 'yes' : 'no',
  )
  if (!picker) {
    await logseq.UI.showMsg(
      'Sync Koreader Highlights: this Logseq build does not expose the File System Access API to plugins (showDirectoryPicker is unavailable). Please report this with your OS and Logseq version.',
      'error',
    )
    return null
  }
  try {
    const handle = await picker()
    pickerCache.handle = handle
    if (remember) await persistHandle(handle)
    return handle
  } catch (e: any) {
    // AbortError = user cancelled the native dialog. Anything else is a real failure.
    if (e?.name === 'AbortError') {
      console.log('sync-koreader-highlights: directory picker cancelled by user')
      return null
    }
    console.warn('sync-koreader-highlights: directory picker failed', e)
    await logseq.UI.showMsg(
      `Sync Koreader Highlights: directory picker failed (${e?.name ?? 'Error'}: ${e?.message ?? e}).`,
      'error',
    )
    return null
  }
}

let syncInFlight = false

async function syncNow(allowPrompt: boolean): Promise<void> {
  if (syncInFlight) {
    await logseq.UI.showMsg('Sync Koreader Highlights: a sync is already running.', 'warning')
    return
  }
  syncInFlight = true
  try {
    const handle = await pickDirectory(allowPrompt)
    if (!handle) {
      // pickDirectory already surfaced any failure/unavailability toast.
      // Silent user cancellation needs no further message.
      return
    }
    await logseq.UI.showMsg('Sync Koreader Highlights: starting…', 'info')
    const info = await logseq.App.getUserConfigs()
    const result = await runSync({
      directoryHandle: handle,
      preferredDateFormat: info.preferredDateFormat,
      templates: loadTemplates(),
      onProgress: (msg) => console.log('sync-koreader-highlights:', msg),
    })
    const newHighlightCount = result.updatedBooks.reduce((a, b) => a + b.addedCount, 0)
    const summary =
      `Sync done — ${result.newBooks.length} new book(s), ` +
      `${newHighlightCount} new highlight(s), ` +
      `${result.skippedStubs} stub(s) skipped` +
      (result.errors.length > 0 ? `, ${result.errors.length} error(s) (see console)` : '.')
    await logseq.UI.showMsg(summary, result.errors.length > 0 ? 'warning' : 'success')
  } catch (e: any) {
    console.error('sync-koreader-highlights: sync failed', e)
    await logseq.UI.showMsg(`Sync failed: ${e?.message ?? e}`, 'error')
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
    // Background tick: never prompt for a directory, just no-op if none cached.
    void syncNow(false)
  }, ms)
}

async function bootstrap() {
  console.log('sync-koreader-highlights: main loaded')
  logseq.useSettingsSchema(SETTINGS_SCHEMA)
  backfillTemplateDefaults()

  await loadCachedHandle()

  logseq.onSettingsChanged((newSettings: any, oldSettings: any) => {
    applyAutoSyncInterval()
    // Clearing "Remember Koreader directory" flushes the cached handle.
    if (oldSettings?.rememberDirectory && !newSettings?.rememberDirectory) {
      void clearCachedHandle()
    }
  })

  logseq.provideModel({
    syncNow() { void syncNow(true) },
  })

  logseq.App.registerUIItem('toolbar', {
    // Logseq uses the toolbar key in CSS selectors for the plugin
    // dropdown's icon lookup; spaces break those selectors and the
    // entry then renders without an icon. Stick to the
    // lowercase-hyphen convention used by Readwise et al.
    key: 'sync-koreader-highlights',
    template: `
      <a data-on-click="syncNow" class="button" title="Sync KOReader Highlights">
        <i class="ti ti-book"></i>
      </a>
    `,
  })

  logseq.App.registerCommandPalette(
    { key: 'sync-koreader-highlights-sync-now', label: 'Sync Koreader Highlights: sync now' },
    () => { void syncNow(true) },
  )

  logseq.App.registerCommandPalette(
    { key: 'sync-koreader-highlights-reset', label: 'Sync Koreader Highlights: reset sync state' },
    async () => {
      await resetSyncState()
      await clearCachedHandle()
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
      await logseq.UI.showMsg('Sync Koreader Highlights: reset complete; book pages deleted.', 'success')
    },
  )

  logseq.App.registerCommandPalette(
    { key: 'sync-koreader-highlights-forget-directory', label: 'Sync Koreader Highlights: forget remembered directory' },
    async () => {
      await clearCachedHandle()
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
 * Run the launch sync as soon as it can. Three cases:
 *  1. No cached handle yet → silently no-op (the user hasn't picked a
 *     directory, can't auto-sync without one).
 *  2. Cached handle, permission already granted → sync immediately.
 *  3. Cached handle, permission lapsed (typical after a Logseq restart)
 *     → wait for the next user activation in the Logseq window, then
 *     call requestPermission inside that activation context. Chromium
 *     usually re-grants silently if the user previously approved the
 *     handle, no dialog. Sync fires the instant permission flips to
 *     "granted".
 */
async function scheduleLaunchSync(): Promise<void> {
  // Tiny delay so the rest of Logseq's UI has settled and toasts are visible.
  await new Promise((r) => setTimeout(r, 1500))
  const handle = pickerCache.handle
  if (!handle) {
    console.log('sync-koreader-highlights: launch sync skipped — no cached directory handle')
    return
  }
  try {
    const perm = await handle.queryPermission?.({ mode: 'read' })
    console.log('sync-koreader-highlights: launch handle permission =', perm)
    if (perm === 'granted') {
      void syncNow(false)
      return
    }
  } catch (e) {
    console.warn('sync-koreader-highlights: launch queryPermission threw', e)
    return
  }

  // Permission has lapsed. Defer the sync to the next user activation.
  console.log('sync-koreader-highlights: deferring launch sync to next user activation')
  let triggered = false
  const onActivation = async () => {
    if (triggered) return
    triggered = true
    try {
      const granted = await handle.requestPermission?.({ mode: 'read' })
      console.log('sync-koreader-highlights: deferred requestPermission =', granted)
      if (granted === 'granted') {
        void syncNow(false)
      }
    } catch (e) {
      console.warn('sync-koreader-highlights: deferred requestPermission threw', e)
    } finally {
      detach()
    }
  }
  const detach = () => {
    window.removeEventListener('pointerdown', onActivation, true)
    window.removeEventListener('keydown', onActivation, true)
    parent?.removeEventListener?.('pointerdown', onActivation, true)
    parent?.removeEventListener?.('keydown', onActivation, true)
  }
  // Listen on both this iframe's window (the plugin's own UI surface,
  // largely empty since we removed the modal) and the parent window
  // (the Logseq main UI, where actual user clicks happen).
  window.addEventListener('pointerdown', onActivation, true)
  window.addEventListener('keydown', onActivation, true)
  try {
    window.parent?.addEventListener('pointerdown', onActivation, true)
    window.parent?.addEventListener('keydown', onActivation, true)
  } catch {
    // Cross-origin guards may block this; the in-frame listener still works
    // because Logseq forwards toolbar/command events into our context.
  }
}

logseq.ready(bootstrap).catch(console.error)
