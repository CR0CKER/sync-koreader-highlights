#!/usr/bin/env node
/**
 * Sync one plugin build in a throwaway Logseq OG instance, so two builds can be
 * compared file by file (see docs/live-testing.md).
 *
 *   node scripts/live-sync.mjs --dist <dist dir> --out <new run dir>
 *     [--graph <graph dir>] [--books <KOReader folder>] [--settings <plugin settings json>]
 *
 * By default the graph and books are the made-up ones in scripts/live-fixture/,
 * and the plugin starts with no saved state, as on a first install.
 *
 * Isolation: HOME and --user-data-dir both point into <out>, so no real
 * Logseq profile is opened. The graph is copied into <out>; the books folder
 * is only read.
 *
 * Every run needs a fresh <out>, so both builds start from identical state.
 * LIVE_DEBUG=1 prints graph-parsing progress; LIVE_KEEP=1 leaves Logseq
 * running afterwards for inspection over DevTools on --port.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const PLUGIN_ID = 'sync-koreader-highlights'
const BIN = process.env.LOGSEQ_OG_BIN || join(process.env.HOME, '.local/opt/logseq-og/Logseq-OG')
const REPO = resolve(new URL('..', import.meta.url).pathname)

const { values: args } = parseArgs({
  options: {
    dist: { type: 'string' },
    graph: { type: 'string' },
    books: { type: 'string' },
    out: { type: 'string' },
    settings: { type: 'string' },
    port: { type: 'string', default: '9711' },
  },
})
for (const k of ['dist', 'out']) {
  if (!args[k]) throw new Error(`--${k} is required`)
}
const FIXTURE = join(REPO, 'scripts/live-fixture')
args.graph ??= join(FIXTURE, 'graph')
args.books ??= join(FIXTURE, 'books')
const out = resolve(args.out)
if (existsSync(out)) throw new Error(`${out} exists; every run needs a fresh directory`)
const port = Number(args.port)
const inspectPort = port + 1000
const graph = join(out, 'graph')
const dot = join(out, 'home/.logseq-og')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- scratch profile -------------------------------------------------------
mkdirSync(join(dot, 'settings'), { recursive: true })
mkdirSync(join(dot, 'config'), { recursive: true })
mkdirSync(join(out, 'user-data'), { recursive: true })
cpSync(resolve(args.graph), graph, { recursive: true })
const pluginDir = join(dot, 'plugins', PLUGIN_ID)
for (const f of ['package.json', 'icon.svg']) cpSync(join(REPO, f), join(pluginDir, f))
cpSync(resolve(args.dist), join(pluginDir, 'dist'), { recursive: true })
// Optional starting state (default: none, as on a first install), bound to
// the copied graph and with auto-sync off.
const settings = args.settings ? JSON.parse(readFileSync(args.settings, 'utf8')) : {}
Object.assign(settings, {
  disabled: false,
  autoSyncOnLaunch: false,
  autoSyncIntervalMinutes: 0,
  boundGraph: { name: 'graph', url: `logseq_local_${graph}` },
})
writeFileSync(join(dot, `settings/${PLUGIN_ID}.json`), JSON.stringify(settings, null, 2))
writeFileSync(join(dot, 'preferences.json'), JSON.stringify({ theme: null, themes: { mode: 'light' }, externals: [] }))
writeFileSync(join(dot, 'config/plugins.edn'), '{}\n')

// --- minimal CDP client ----------------------------------------------------
async function socket(url) {
  const ws = new WebSocket(url)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`websocket failed: ${url}`)) })
  let id = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method) listeners.forEach((l) => l(m))
  }
  const call = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id
    const t = setTimeout(() => { pending.delete(i); rej(new Error(`${method} timed out`)) }, 60000)
    pending.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result) })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result?.value
  }
  return { call, evaluate, on: (l) => listeners.push(l), close: () => ws.close() }
}
const targets = async (p) => (await fetch(`http://127.0.0.1:${p}/json/list`)).json()
async function waitFor(cdp, expr, label, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    try { if (await cdp.evaluate(expr)) return } catch { /* still booting */ }
  }
  throw new Error(`timed out waiting for ${label}`)
}
// Input.dispatchMouseEvent carries user activation; element.click() does not.
async function realClick(cdp, elementExpr) {
  const p = await cdp.evaluate(`(()=>{const el=${elementExpr}; if(!el) return null
    const f=el.ownerDocument.defaultView.frameElement; const o=f?f.getBoundingClientRect():{x:0,y:0}
    const b=el.getBoundingClientRect(); return {x:o.x+b.x+b.width/2, y:o.y+b.y+b.height/2}})()`)
  if (!p) throw new Error(`not found: ${elementExpr}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await cdp.call('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 })
}

// --- run -------------------------------------------------------------------
const proc = spawn(BIN, [
  `--user-data-dir=${join(out, 'user-data')}`,
  `--remote-debugging-port=${port}`,
  `--inspect=127.0.0.1:${inspectPort}`,
  '--enable-features=WaylandWindowDecorations', '--gtk-version=4',
], { env: { ...process.env, HOME: join(out, 'home') }, stdio: 'ignore' })

let cdp
try {
  for (let i = 0; i < 60 && !cdp; i++) {
    try {
      const page = (await targets(port)).find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
      if (page) cdp = await socket(page.webSocketDebuggerUrl)
    } catch { /* not up yet */ }
    if (!cdp) await sleep(1000)
  }
  if (!cdp) throw new Error('no DevTools endpoint after 60s')
  await waitFor(cdp, 'Boolean(window.LSPluginCore)', 'Logseq to boot')

  // Logseq opens a folder only through the native dialog: answer it in the
  // main process, then press the onboarding card's "Choose a folder".
  const main = await socket((await targets(inspectPort))[0].webSocketDebuggerUrl)
  await main.evaluate(`(() => { const { dialog } = process.mainModule.require('electron')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(graph)}] }); return true })()`)
  main.close()
  await waitFor(cdp, `Boolean(document.querySelector('.cp__onboarding-setups label.action-input'))`, 'the onboarding card')
  await cdp.evaluate(`document.querySelector('.cp__onboarding-setups label.action-input').click()`)
  await waitFor(cdp, `(async () => (await logseq.api.get_current_graph())?.path === ${JSON.stringify(graph)})()`, 'the graph to open', 120000)
  await waitFor(cdp, `LSPluginCore.registeredPlugins.get('${PLUGIN_ID}')?.loaded`, 'the plugin to load')

  // A fresh profile parses the whole graph after opening it. Syncing before
  // that finishes loses writes: the receipt never reached KOReader.md, and one
  // run wrote nothing at all. Wait until parsing is done and the page count
  // has held still for 5s.
  const parsing = `JSON.stringify(logseq.api.get_state_from_store('graph/parsing-state')?.[${JSON.stringify(`logseq_local_${graph}`)}] ?? null)`
  for (let stable = 0, last = -1, end = Date.now() + 300000; stable < 5; await sleep(1000)) {
    if (Date.now() > end) throw new Error('graph still parsing after 5 min')
    const state = JSON.parse(await cdp.evaluate(parsing))
    const pages = await cdp.evaluate('(async () => (await logseq.api.get_all_pages()).length)()')
    const busy = state && state.total && state.finished < state.total
    stable = !busy && pages === last ? stable + 1 : 0
    if (process.env.LIVE_DEBUG) console.error('parsing', JSON.stringify(state), 'pages', pages)
    last = pages
  }

  const doc = `document.querySelector('#${PLUGIN_ID}_iframe').contentDocument`
  // By id: the Sync button's label changes to "Syncing…" while it runs.
  const button = (id) => `${doc}.getElementById(${JSON.stringify(id)})`
  await realClick(cdp, `document.querySelector('a[data-on-click=openPanel]')`)
  await waitFor(cdp, `${doc}?.querySelector('dialog.skh-dialog')?.open`, 'the panel')

  // showDirectoryPicker opens a native dialog CDP can't answer; hide it so the
  // plugin falls back to <input webkitdirectory>, whose chooser CDP can answer.
  await cdp.call('Page.enable')
  await cdp.call('Page.setInterceptFileChooserDialog', { enabled: true })
  const chooser = new Promise((res) => cdp.on((m) => m.method === 'Page.fileChooserOpened' && res(m.params)))
  await cdp.evaluate(`document.querySelector('#${PLUGIN_ID}_iframe').contentWindow.showDirectoryPicker = undefined`)
  await realClick(cdp, button('skhPick'))
  const { backendNodeId } = await chooser
  await cdp.call('DOM.setFileInputFiles', { files: [resolve(args.books)], backendNodeId })
  await waitFor(cdp, `!${button('skhSync')}.disabled`, 'Sync now to enable')

  await realClick(cdp, button('skhSync'))
  let log = ''
  for (let stable = 0, last = ''; stable < 3; await sleep(2000)) {
    const s = JSON.parse(await cdp.evaluate(`JSON.stringify({ busy: ${button('skhSync')}.disabled, log: ${doc}.querySelector('.skh-log')?.innerText || '' })`))
    stable = !s.busy && s.log && s.log === last ? stable + 1 : 0
    last = log = s.log
  }
  console.log(log)
  writeFileSync(join(out, 'sync.log'), log + '\n')
  // Logseq writes pages asynchronously, some (the KOReader index page) well
  // after the sync reports done. Stop only once the graph folder has been
  // quiet for 10s, or a comparison silently misses late writes.
  const newest = () => {
    let t = 0
    for (const f of readdirSync(graph, { recursive: true })) {
      try { t = Math.max(t, statSync(join(graph, f)).mtimeMs) } catch { /* removed */ }
    }
    return t
  }
  for (const end = Date.now() + 120000; Date.now() < end && Date.now() - newest() < 10000;) await sleep(1000)
} finally {
  cdp?.close()
  // LIVE_KEEP=1 leaves the instance running (DevTools on --port) to inspect.
  if (process.env.LIVE_KEEP) { proc.unref(); console.log(`kept running: pid ${proc.pid}, port ${port}`) }
  else proc.kill('SIGKILL')
}
console.log(`run in ${out}: graph/ and home/.logseq-og/settings/${PLUGIN_ID}.json`)
