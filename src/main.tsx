import '@logseq/libs'
import { SettingSchemaDesc } from '@logseq/libs/dist/LSPlugin'
import React, { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { DEFAULT_TEMPLATES, Templates } from './render'
import { INDEX_PAGE_NAME, resetSyncState, runSync } from './sync'
import { getBookIdsMap, getLastSync } from './storage'

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
    description: 'Run a sync once shortly after Logseq starts. Off by default.',
    type: 'boolean',
    default: false,
  },
  {
    key: 'bookHeaderTemplate',
    title: 'Book page header template (Mustache)',
    description: 'Override the default header rendered at the top of each book page. Leave blank to use the default.',
    type: 'string',
    inputAs: 'textarea',
    default: '',
  },
  {
    key: 'highlightsHeadingTemplate',
    title: 'Highlights section heading template (Mustache)',
    description: 'Override the default heading rendered above each batch of highlights. Leave blank to use the default.',
    type: 'string',
    inputAs: 'textarea',
    default: '',
  },
  {
    key: 'highlightBlockTemplate',
    title: 'Highlight block template (Mustache)',
    description: 'Override the default rendering of each highlight. Leave blank to use the default.',
    type: 'string',
    inputAs: 'textarea',
    default: '',
  },
]

function loadTemplates(): Templates {
  const s = logseq.settings ?? {}
  return {
    bookHeader: (s.bookHeaderTemplate as string) || DEFAULT_TEMPLATES.bookHeader,
    highlightsHeading: (s.highlightsHeadingTemplate as string) || DEFAULT_TEMPLATES.highlightsHeading,
    highlightBlock: (s.highlightBlockTemplate as string) || DEFAULT_TEMPLATES.highlightBlock,
  }
}

async function saveTemplates(t: Templates): Promise<void> {
  await logseq.updateSettings({
    bookHeaderTemplate: t.bookHeader === DEFAULT_TEMPLATES.bookHeader ? '' : t.bookHeader,
    highlightsHeadingTemplate: t.highlightsHeading === DEFAULT_TEMPLATES.highlightsHeading ? '' : t.highlightsHeading,
    highlightBlockTemplate: t.highlightBlock === DEFAULT_TEMPLATES.highlightBlock ? '' : t.highlightBlock,
  })
}

interface PickerCache {
  handle: any | null
}
const pickerCache: PickerCache = { handle: null }

async function pickDirectory(): Promise<any | null> {
  const remember = !!logseq.settings?.rememberDirectory
  if (remember && pickerCache.handle) {
    try {
      const perm = await pickerCache.handle.queryPermission?.({})
      if (perm === 'granted') return pickerCache.handle
    } catch {
      // fall through to picker
    }
  }
  try {
    const handle = await window.showDirectoryPicker()
    if (remember) pickerCache.handle = handle
    return handle
  } catch (e) {
    console.warn('sync-koreader-highlights: directory picker cancelled', e)
    return null
  }
}

function Root() {
  const [visible, setVisible] = useState(false)
  const [templates, setTemplates] = useState<Templates>(loadTemplates())
  const [lastSync, setLastSync] = useState<string | undefined>(getLastSync())

  useEffect(() => {
    const onShow = () => { setTemplates(loadTemplates()); setLastSync(getLastSync()); setVisible(true) }
    const onHide = () => setVisible(false)
    ;(window as any).__skh_show = onShow
    ;(window as any).__skh_hide = onHide
    return () => {
      delete (window as any).__skh_show
      delete (window as any).__skh_hide
    }
  }, [])

  const handleSync = useCallback(async (onProgress: (msg: string) => void) => {
    onProgress('Choose your KOReader directory…')
    const handle = await pickDirectory()
    if (!handle) { onProgress('Cancelled.'); return }

    const info = await logseq.App.getUserConfigs()
    const result = await runSync({
      directoryHandle: handle,
      preferredDateFormat: info.preferredDateFormat,
      templates: loadTemplates(),
      onProgress,
    })
    setLastSync(getLastSync())

    const summary =
      `Done — ${result.newBooks.length} new book(s), ` +
      `${result.updatedBooks.reduce((a, b) => a + b.addedCount, 0)} new highlight(s), ` +
      `${result.skippedStubs} stub(s) skipped` +
      (result.errors.length > 0 ? `, ${result.errors.length} error(s) (see console)` : '.')
    onProgress(summary)
    await logseq.UI.showMsg(summary, result.errors.length > 0 ? 'warning' : 'success')
  }, [])

  const handleReset = useCallback(async (alsoDeletePages: boolean) => {
    if (alsoDeletePages) {
      const ids = getBookIdsMap()
      for (const entry of Object.values(ids)) {
        try {
          await logseq.Editor.deletePage(entry.title)
        } catch (e) {
          console.warn('sync-koreader-highlights: deletePage failed for', entry.title, e)
        }
      }
      try {
        await logseq.Editor.deletePage(INDEX_PAGE_NAME)
      } catch (e) {
        console.warn('sync-koreader-highlights: deletePage failed for index', e)
      }
    }
    await resetSyncState()
    await logseq.UI.showMsg('Sync state reset.', 'success')
  }, [])

  const handleSaveTemplates = useCallback(async (t: Templates) => {
    await saveTemplates(t)
    setTemplates(t)
  }, [])

  return (
    <App
      visible={visible}
      onClose={() => { logseq.hideMainUI(); setVisible(false) }}
      onSync={handleSync}
      onReset={handleReset}
      templates={templates}
      onSaveTemplates={handleSaveTemplates}
      lastSync={lastSync}
    />
  )
}

function bootstrap() {
  console.log('sync-koreader-highlights: main loaded')
  logseq.useSettingsSchema(SETTINGS_SCHEMA)

  const container = document.getElementById('app')!
  ReactDOM.createRoot(container).render(<Root />)

  logseq.provideModel({
    showSyncKoreaderUI() {
      logseq.showMainUI()
      ;(window as any).__skh_show?.()
    },
  })

  logseq.setMainUIInlineStyle({ zIndex: 11 })

  logseq.App.registerUIItem('toolbar', {
    key: 'sync-koreader-highlights',
    template: `
      <a data-on-click="showSyncKoreaderUI" class="button" title="Sync Koreader Highlights">
        <i class="ti ti-book"></i>
      </a>
    `,
  })

  logseq.App.registerCommandPalette(
    { key: 'sync-koreader-highlights-open', label: 'Sync Koreader Highlights: open' },
    () => {
      logseq.showMainUI()
      ;(window as any).__skh_show?.()
    },
  )

  logseq.App.registerCommandPalette(
    { key: 'sync-koreader-highlights-reset', label: 'Sync Koreader Highlights: reset sync state' },
    async () => {
      await resetSyncState()
      await logseq.UI.showMsg('Sync state reset.', 'success')
    },
  )

  if (logseq.settings?.autoSyncOnLaunch) {
    setTimeout(() => {
      logseq.showMainUI()
      ;(window as any).__skh_show?.()
    }, 2000)
  }
}

logseq.ready(bootstrap).catch(console.error)
