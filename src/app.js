import MarkdownIt from 'markdown-it'
import texmath from 'markdown-it-texmath'
import katex from 'katex'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import {toBlob, toJpeg} from 'html-to-image'
import Modal from 'bootstrap/js/dist/modal'
import Dropdown from 'bootstrap/js/dist/dropdown'
import Tooltip from 'bootstrap/js/dist/tooltip'
import {enableAdjacentStrongLabelCompatibility, enableBlankHeaderCardTableCompatibility, enableEscapedFileLinkCompatibility, enableExplicitAnchorCompatibility} from './markdown-compat.js'
import {cleanExtensionURL, stripExtensionQueryParams, SESSION_QUERY_KEY, TAB_QUERY_KEY} from './url-params.js'

const $ = selector => document.querySelector(selector)
const EXTENSION_VERSION_CHECK_INTERVAL = 5 * 60 * 1000
// Temporary validation switch: leave the update banner visible until the user confirms its layout.
const SHOW_EXTENSION_UPDATE_WARNING_FOR_TESTING = false
const ui = {
  tabs: $('#document-tabs'),
  preview: $('#preview'),
  contentRoot: $('#mdr-content-root'),
  empty: $('#empty-state'),
  sidebar: $('#sidebar'),
  sideResizer: $('#mdr-side-resizer'),
  outline: $('#outline-panel'),
  outlineTree: $('.mdr-outline-tree'),
  outlineExportBtn: $('#outline-export-btn'),
  files: $('#files-panel'),
  tasks: $('#tasks-panel'),
  taskList: $('#task-list'),
  taskCount: $('#task-count'),
  taskPanelCount: $('#task-panel-count'),
  taskClear: $('#task-clear'),
  search: $('#sidebar-search'),
  fileSearchTypes: $('#file-search-types'),
  toast: $('#toast'),
  directoryChangeNotice: $('#mdr-directory-change-notice'),
  settings: $('#settings-dialog'),
  globalSearch: $('#global-search-dialog'),
  globalSearchInput: $('#global-search-input'),
  globalSearchClear: $('#global-search-clear'),
  globalSearchResults: $('#global-search-results'),
  globalSearchStatus: $('#global-search-status'),
  dropOverlay: $('#drop-overlay'),
}

// ==========================================================================
// 侧边栏拖动调整宽度系统 (Sidebar Resizer - 100% 对齐 Lumina App)
// ==========================================================================
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 600
const DEFAULT_SIDEBAR_WIDTH = 280
const MIN_BODY_WIDTH = 320
const SIDEBAR_STORAGE_KEY = 'lumina_sidebar_width'
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'lumina_sidebar_collapsed'

function updateResizerTooltip(currentWidth) {
  const resizer = document.getElementById('mdr-side-resizer')
  if (!resizer) return
  const width = typeof currentWidth === 'number' ? currentWidth : (
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side-width')) || DEFAULT_SIDEBAR_WIDTH
  )
  const isNonDefault = Math.abs(width - DEFAULT_SIDEBAR_WIDTH) >= 2
  if (isNonDefault) {
    resizer.setAttribute('data-tooltip', '双击恢复默认')
    resizer.setAttribute('title', '双击恢复默认')
  } else {
    resizer.removeAttribute('data-tooltip')
    resizer.removeAttribute('title')
  }
}

function setSidebarWidth(width, persist = true) {
  const maxAvailable = Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - MIN_BODY_WIDTH)
  const upperLimit = Math.min(MAX_SIDEBAR_WIDTH, maxAvailable)
  const clamped = Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(width, upperLimit)))
  document.documentElement.style.setProperty('--side-width', `${clamped}px`)
  updateResizerTooltip(clamped)
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(clamped))
    } catch {}
  }
  return clamped
}

function restoreSidebarWidth() {
  try {
    const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY)
    if (saved) {
      const val = parseFloat(saved)
      if (!isNaN(val) && val >= MIN_SIDEBAR_WIDTH && val <= MAX_SIDEBAR_WIDTH) {
        setSidebarWidth(val, false)
        return val
      }
    }
  } catch {}
  setSidebarWidth(DEFAULT_SIDEBAR_WIDTH, false)
  return DEFAULT_SIDEBAR_WIDTH
}

function setSidebarCollapsed(collapsed, persist = true) {
  const isCollapsed = Boolean(collapsed)
  document.body.classList.toggle('is-sidebar-collapsed', isCollapsed)
  const button = document.getElementById('sidebar-collapse-toggle')
  if (button) {
    const label = isCollapsed ? '展开侧边栏' : '收缩侧边栏'
    button.setAttribute('aria-label', label)
    button.setAttribute('title', label)
    button.setAttribute('aria-expanded', String(!isCollapsed))
  }
  if (persist) {
    try {
      void chrome?.storage?.local?.set({[SIDEBAR_COLLAPSED_STORAGE_KEY]: isCollapsed}).catch(() => {})
    } catch {}
  }
}

function initSidebarCollapse() {
  const button = document.getElementById('sidebar-collapse-toggle')
  if (!button || button._collapseBound) return
  button._collapseBound = true
  setSidebarCollapsed(false, false)
  void chrome?.storage?.local?.get(SIDEBAR_COLLAPSED_STORAGE_KEY).then(result => {
    setSidebarCollapsed(result?.[SIDEBAR_COLLAPSED_STORAGE_KEY] === true, false)
  }).catch(() => {})
  chrome?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local' || !Object.hasOwn(changes, SIDEBAR_COLLAPSED_STORAGE_KEY)) return
    setSidebarCollapsed(changes[SIDEBAR_COLLAPSED_STORAGE_KEY].newValue === true, false)
  })
  button.addEventListener('click', () => {
    setSidebarCollapsed(!document.body.classList.contains('is-sidebar-collapsed'))
  })
}

async function syncSharedAppearancePreferences() {
  try {
    const stored = await chrome?.storage?.local?.get(['preferences', SIDEBAR_COLLAPSED_STORAGE_KEY])
    const storedTheme = stored?.preferences?.theme
    const themeChanged = ['system', 'light', 'dark'].includes(storedTheme) && storedTheme !== preferences.theme
    if (themeChanged) preferences.theme = storedTheme

    const isCollapsed = stored?.[SIDEBAR_COLLAPSED_STORAGE_KEY] === true
    const collapseChanged = isCollapsed !== document.body.classList.contains('is-sidebar-collapsed')
    if (collapseChanged) setSidebarCollapsed(isCollapsed, false)

    if (themeChanged) {
      applyPreferences()
      if (ui.settings?.classList.contains('show')) syncSettingsUI()
    }
  } catch {}
}

function initSidebarResize() {
  const resizer = document.getElementById('mdr-side-resizer')
  if (!resizer || resizer._resizeBound) return
  resizer._resizeBound = true

  restoreSidebarWidth()

  let isDragging = false
  let startX = 0
  let startWidth = 0

  const onMouseDown = e => {
    if (e.button !== 0) return
    isDragging = true
    startX = e.clientX
    startWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side-width')) || DEFAULT_SIDEBAR_WIDTH

    document.body.classList.add('is-resizing-sidebar')
    e.preventDefault()
    e.stopPropagation()

    const onMouseMove = moveEvent => {
      if (!isDragging) return
      moveEvent.preventDefault()
      const deltaX = moveEvent.clientX - startX
      setSidebarWidth(startWidth + deltaX, false)
    }

    const onMouseUp = upEvent => {
      if (!isDragging) return
      isDragging = false
      document.body.classList.remove('is-resizing-sidebar')
      window.removeEventListener('mousemove', onMouseMove, {capture: true})
      window.removeEventListener('mouseup', onMouseUp, {capture: true})

      const deltaX = upEvent.clientX - startX
      setSidebarWidth(startWidth + deltaX, true)
    }

    window.addEventListener('mousemove', onMouseMove, {capture: true, passive: false})
    window.addEventListener('mouseup', onMouseUp, {capture: true})
  }

  const onDblClick = e => {
    e.preventDefault()
    e.stopPropagation()
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH, true)
  }

  resizer.addEventListener('mouseenter', () => updateResizerTooltip())
  resizer.addEventListener('mousedown', onMouseDown)
  resizer.addEventListener('dblclick', onDblClick)

  window.addEventListener('resize', () => {
    const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side-width')) || DEFAULT_SIDEBAR_WIDTH
    const maxAvailable = window.innerWidth - MIN_BODY_WIDTH
    if (current > maxAvailable && maxAvailable >= MIN_SIDEBAR_WIDTH) {
      setSidebarWidth(maxAvailable, true)
    }
  })
}

const legacyExtensionDB = 'lumina-chrome-workspace-v1'
const docs = []
const documentFrames = new Map()
const pendingLocalTreeOpens = new Map()
const pendingDocumentLinkOpens = new Map()
let activeId = null
let rootHandle = null
let rootEntries = []
let fileIndex = []
let localTreeRoot = null
let additionalDirectoryRoots = []
let primaryRootTreeId = ''
let localTreeError = ''
let expandedDirectories = new Set()
let fileSearchType = 'all'
let fileSearchTimer = 0
let fileIndexGeneration = 0
let liveDirectoryScanRunning = false
let activeDocumentScanRunning = false
let activeDocumentScanTimer = 0
let activeDocumentScanGeneration = 0
let missingActiveDocumentScans = new Map()
let liveDirectoryTimer = 0
let liveDocumentTimer = 0
let globalSearchScope = 'directories'
let globalSearchResults = []
let globalSearchSelectedIndex = 0
let globalSearchTimer = 0
let globalSearchRequestId = 0
let globalSearchDocumentCount = 0
let globalSearchCompletedDocumentCount = 0
let globalSearchFailedDocumentCount = 0
let globalSearchLoading = false
let lastGlobalSearchShiftTime = 0
let globalSearchHighlightTimer = 0
let globalSearchFlashTimer = 0
let globalSearchHighlightGeneration = 0
let renderGeneration = 0
let installReportRequest = null
let installAlreadyReported = false
let mermaidRenderSeq = 0
let toastTimer = 0
let directoryChangeNoticeTimer = 0
let scrollSpyTicking = false
let draggedTabId = null
let suppressTabClick = false
const objectURLs = new Map()
const MIN_IMAGE_EXPORT_HEIGHT = 5000
const DEFAULT_IMAGE_EXPORT_HEIGHT = 50000
const MAX_IMAGE_EXPORT_HEIGHT = 100000
const MIN_IMAGE_EXPORT_PIXEL_RATIO = 1
const DEFAULT_IMAGE_EXPORT_PIXEL_RATIO = 1.5
const MAX_IMAGE_EXPORT_PIXEL_RATIO = 4
const preferences = {theme: 'system', width: 72, codeWrap: false, showReadingProgressBadge: true, imageExportMaximumHeight: DEFAULT_IMAGE_EXPORT_HEIGHT, imageExportPixelRatio: DEFAULT_IMAGE_EXPORT_PIXEL_RATIO, imageExportRetries: 3, imageExportTimeoutSeconds: 30, autoScrollInterval: 20, autoScrollAmount: 1, hideDropRefreshNotice: false}
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.preferences) return
  preferences.hideDropRefreshNotice = changes.preferences.newValue?.hideDropRefreshNotice === true
  const toggle = document.getElementById('pref-show-drop-refresh-notice')
  if (toggle) toggle.checked = !preferences.hideDropRefreshNotice
})
const autoScrollOverrides = new Map()
let runningAutoScrollDocumentId = null
let autoScrollTimer = 0

const SOURCE_TAB_PREFIX = 'lumina-source:'
const SESSION_ID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
let tabStateURLWriteTimer = 0
let lastTabStateLogAt = 0
let currentSessionId = ''
let sessionWriteQueue = Promise.resolve()

function tabBaseURL() {
  const base = new URL(location.href)
  base.search = ''
  base.hash = ''
  base.pathname = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1)
  return base
}

function remoteMarkdownURL(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && /\.md$/i.test(url.pathname)
      ? url
      : null
  } catch {
    return null
  }
}

function cleanRemoteMarkdownURL(value, {preserveHash = false} = {}) {
  const url = remoteMarkdownURL(value)
  if (!url) return null
  stripExtensionQueryParams(url)
  if (!preserveHash) url.hash = ''
  return url.href
}

function markdownDocumentLinkURL(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'file:' && /\.(?:md|markdown|mdown|mkd|mdx|mdc|txt)$/i.test(url.pathname)) {
      return localDocumentURL(url.href)
    }
    return cleanRemoteMarkdownURL(url.href, {preserveHash: true})
  } catch {
    return null
  }
}

function documentSourceURLKey(value) {
  return localFileURLKey(value) || cleanRemoteMarkdownURL(value)
}

function isAddressBarDocument(doc) {
  if (doc?.sourceView) return false
  const currentURLKey = documentSourceURLKey(location.href)
  return Boolean(currentURLKey && documentSourceURLKey(doc?.sourceURL) === currentURLKey)
}

function relativeTabPath(fileURL) {
  try {
    const target = new URL(fileURL)
    if (target.protocol !== 'file:') return cleanRemoteMarkdownURL(target.href, {preserveHash: true}) || ''
    target.search = ''
    const base = tabBaseURL()
    if (target.protocol !== base.protocol || target.host !== base.host) return target.href
    const fromParts = base.pathname.split('/').filter(Boolean)
    const toParts = target.pathname.split('/').filter(Boolean)
    let common = 0
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++
    const pathParts = [
      ...Array(fromParts.length - common).fill('..'),
      ...toParts.slice(common).map(part => {
        try { return encodeURIComponent(decodeURIComponent(part)) } catch { return encodeURIComponent(part) }
      }),
    ]
    return `${pathParts.join('/') || encodeURIComponent(decodeURIComponent(toParts.at(-1) || ''))}${target.hash}`
  } catch {
    return ''
  }
}

function documentTabPath(doc) {
  let path = ''
  if (doc.sourceURL) {
    path = relativeTabPath(doc.sourceURL)
  }
  if (!path) return ''
  return doc.sourceView ? `${SOURCE_TAB_PREFIX}${encodeURIComponent(path)}` : path
}

function decodeLegacyTabParameter(encoded) {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const value = JSON.parse(new TextDecoder().decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {entries: [], hasLegacyState: false}
    const entries = Object.entries(value).flatMap(([path, compactState]) => {
      if (!path) return []
      if (typeof compactState !== 'string') return []
      const match = /^(\d+):([01])$/.exec(compactState)
      if (!match) return []
      return [{path, tagNum: Number(match[1]), isCurrentTag: Number(match[2]), scrollTop: -1}]
    }).sort((a, b) => a.tagNum - b.tagNum)
    console.info('[LuminaChrome][tab-state] 读取并转换地址栏参数', {
      rawParameter: encoded,
      compactObject: value,
      readableObjects: entries.map(({path, ...state}) => ({path, ...state})),
      legacyFormat: 'tagNum:isCurrentTag',
    })
    return {entries}
  } catch (error) {
    console.warn('[LuminaChrome][tab-state] 地址栏参数解析失败', {
      rawParameter: encoded,
      error: error?.message || String(error),
    })
    return {entries: []}
  }
}

function parseSessionTabState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([path, state]) => {
    if (!path || !state || typeof state !== 'object' || Array.isArray(state)) return []
    const tagNum = Number(state.tagNum)
    const isCurrentTag = Number(state.isCurrentTag)
    const scrollTop = Number(state.scrollTop)
    if (!Number.isInteger(tagNum) || tagNum < 0 || ![0, 1].includes(isCurrentTag)) return []
    return [{path, tagNum, isCurrentTag, scrollTop: Number.isFinite(scrollTop) && scrollTop >= -1 ? scrollTop : -1}]
  }).sort((a, b) => a.tagNum - b.tagNum)
}

function captureDocumentScrollTop(doc) {
  if (doc?._scrollRestorePending) return doc._scrollRestorePending.top
  const frame = doc?.id ? documentFrames.get(doc.id) : null
  const frameWindow = frame?.contentWindow
  const frameDocument = frame?.contentDocument
  if (!frameWindow || !frameDocument || frame.classList.contains('is-inactive') || doc.loaded === false || doc.loading || frame._mdrRenderedSource == null) {
    return Number.isFinite(doc?.scrollTop) && doc.scrollTop > -1 ? Math.max(0, Math.round(doc.scrollTop)) : -1
  }
  const scrollingElement = frameDocument.scrollingElement || frameDocument.documentElement
  const liveScrollTop = Math.max(
    0,
    Number(frameWindow.scrollY) || 0,
    Number(scrollingElement?.scrollTop) || 0,
    Number(frameDocument.documentElement?.scrollTop) || 0,
    Number(frameDocument.body?.scrollTop) || 0,
  )
  doc.scrollTop = Math.round(liveScrollTop)
  return doc.scrollTop
}

function captureSavedDocumentScrollTop(doc) {
  return Number.isFinite(doc?.scrollTop) && doc.scrollTop > -1 ? Math.max(0, Math.round(doc.scrollTop)) : -1
}

function tabPayloadFromLegacyEntries(entries) {
  const tabs = Object.create(null)
  for (const entry of entries) {
    tabs[entry.path] = {
      tagNum: entry.tagNum,
      isCurrentTag: entry.isCurrentTag,
      scrollTop: entry.scrollTop,
    }
  }
  return tabs
}

function replaceAddressBarURL(url) {
  try {
    history.replaceState(history.state, '', url.href)
    return true
  } catch (error) {
    console.error('[LuminaChrome][session-cache] 更新地址栏失败', error)
    return false
  }
}

async function ensureSessionIdentity() {
  const url = new URL(location.href)
  const existingSessionId = url.searchParams.get(SESSION_QUERY_KEY) || ''
  const requestedSessionId = SESSION_ID_PATTERN.test(existingSessionId) ? existingSessionId : crypto.randomUUID()
  const result = await chrome.runtime.sendMessage({type: 'lumina:session-claim', sessionId: requestedSessionId})
  if (!result?.ok || typeof result.sessionId !== 'string' || !result.sessionId) {
    throw new Error(result?.error || '无法创建页面会话 ID')
  }
  currentSessionId = result.sessionId
  if (url.searchParams.get(SESSION_QUERY_KEY) !== currentSessionId) {
    url.searchParams.set(SESSION_QUERY_KEY, currentSessionId)
    replaceAddressBarURL(url)
  }
  console.info('[LuminaChrome][session-cache] 页面会话已就绪', {sessionId: currentSessionId})
  return currentSessionId
}

function removeLegacyTabParameter() {
  const url = new URL(location.href)
  if (!url.searchParams.has(TAB_QUERY_KEY)) return
  url.searchParams.delete(TAB_QUERY_KEY)
  replaceAddressBarURL(url)
  console.info('[LuminaChrome][session-cache] 已从地址栏移除旧标签参数', {sessionId: currentSessionId})
}

function tabStatePayload() {
  const payload = Object.create(null)
  const omittedTabs = []
  const paths = new Set()
  docs.forEach((doc, index) => {
    const path = documentTabPath(doc)
    if (!path) {
      omittedTabs.push({id: doc.id, title: doc.title, sourceURL: doc.sourceURL || ''})
      return
    }
    if (paths.has(path)) console.warn('[LuminaChrome][tab-state] 多个标签映射到相同路径，后一个状态会覆盖前一个', {path, id: doc.id, title: doc.title})
    paths.add(path)
    const isCurrentTab = doc.id === activeId
    const savedScrollTop = isCurrentTab ? captureDocumentScrollTop(doc) : captureSavedDocumentScrollTop(doc)
    payload[path] = {
      tagNum: index,
      isCurrentTag: isCurrentTab ? 1 : 0,
      scrollTop: savedScrollTop,
    }
  })
  if (Date.now() - lastTabStateLogAt >= 1000 || omittedTabs.length) {
    lastTabStateLogAt = Date.now()
    console.info('[LuminaChrome][tab-state] 生成地址栏标签状态', {
      openTabCount: docs.length,
      savedTabCount: Object.keys(payload).length,
      tabs: docs.map((doc, index) => ({
        id: doc.id,
        title: doc.title,
        path: documentTabPath(doc),
        tagNum: index,
        isCurrentTag: doc.id === activeId ? 1 : 0,
      scrollTop: payload[documentTabPath(doc)]?.scrollTop ?? -1,
      })),
      omittedTabs,
    })
  }
  return payload
}

function writeTabStateToURL(mode = 'push') {
  if (!currentSessionId) return
  const payload = tabStatePayload()
  const requestId = crypto.randomUUID()
  const save = async () => {
    const result = await chrome.runtime.sendMessage({
      type: 'lumina:session-save',
      requestId,
      sessionId: currentSessionId,
      tabs: payload,
    })
    if (!result?.ok) throw new Error(result?.error || 'IndexedDB 会话写入失败')
    removeLegacyTabParameter()
    console.info('[LuminaChrome][session-cache] 标签状态已写入扩展 IndexedDB', {
      requestId,
      sessionId: currentSessionId,
      tabCount: Object.keys(payload).length,
    })
  }
  sessionWriteQueue = sessionWriteQueue.catch(() => {}).then(save)
  sessionWriteQueue.catch(error => console.error('[LuminaChrome][session-cache] 保存标签状态失败', {
    requestId,
    sessionId: currentSessionId,
    error: error?.message || String(error),
  }))
}

function scheduleTabStateURLWrite() {
  if (tabStateURLWriteTimer) return
  tabStateURLWriteTimer = window.setTimeout(() => {
    tabStateURLWriteTimer = 0
    writeTabStateToURL('replace')
  }, 200)
}

function flushTabStateURLWrite() {
  if (!tabStateURLWriteTimer) return
  clearTimeout(tabStateURLWriteTimer)
  tabStateURLWriteTimer = 0
  writeTabStateToURL('replace')
}

function resolveTabPath(path) {
  try {
    const url = new URL(path, tabBaseURL())
    if (url.protocol !== 'file:') return cleanRemoteMarkdownURL(url.href, {preserveHash: true})
    url.search = ''
    return url.href
  } catch {
    return null
  }
}

function loadTabDocument(entry) {
  const sourceView = entry.path.startsWith(SOURCE_TAB_PREFIX)
  let sourcePath = entry.path
  if (sourceView) {
    try { sourcePath = decodeURIComponent(entry.path.slice(SOURCE_TAB_PREFIX.length)) } catch { return null }
  }
  const documentURL = resolveTabPath(sourcePath)
  if (!documentURL) return null
  let name = new URL(documentURL).pathname.split('/').pop() || 'Markdown 文档'
  try { name = decodeURIComponent(name) } catch {}
  return {
    id: crypto.randomUUID(),
    title: name,
    source: '',
    sourceURL: documentURL,
    sourceView,
    scrollTop: Number.isFinite(entry.scrollTop) && entry.scrollTop > -1 ? entry.scrollTop : -1,
    pendingFragment: sourceView ? '' : new URL(documentURL).hash,
    objectURLs: [],
    loaded: false,
    loading: false,
  }
}

function sendRuntimeMessageWithTimeout(message, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs)
  })
  return Promise.race([chrome.runtime.sendMessage(message), timeout]).finally(() => clearTimeout(timer))
}

function loadDocumentOnDemand(doc) {
  if (doc?.reloadPromise) return doc.reloadPromise.catch(() => null)
  if (!doc || doc.loaded !== false) return Promise.resolve(doc)
  if (doc.loadPromise) return doc.loadPromise

  doc.loading = true
  doc.loadError = ''
  renderTabs()
  updateControls()
  const opening = (async () => {
    if (doc.id === activeId) {
      await renderActive()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }

    const isLocal = Boolean(localFileURLKey(doc.sourceURL))
    const request = isLocal
      ? {type: 'lumina:read-local-markdown', fileURL: localFileURLKey(doc.sourceURL)}
      : {type: 'lumina:read-remote-markdown', url: cleanRemoteMarkdownURL(doc.sourceURL)}
    console.info('[LuminaChrome][document-load] 主页面发送消息', request)
    const result = await sendRuntimeMessageWithTimeout(request, 25_000, 'Markdown 读取')
    console.info('[LuminaChrome][document-load] Worker 返回结果', {type: request.type, ok: result?.ok, error: result?.error, sourceLength: result?.source?.length || 0})
    if (!result?.ok) throw new Error(result?.error || '读取 Markdown 文档失败')
    if (!docs.some(item => item.id === doc.id)) return null

    doc.source = result.source
    doc.loaded = true
    doc.loading = false
    doc.loadError = ''
    const frame = documentFrames.get(doc.id)
    if (frame) frame._mdrRenderedSource = null
    renderTabs()
    if (doc.id === activeId) await renderActive()
    updateControls()
    return doc
  })().catch(async error => {
    if (!docs.some(item => item.id === doc.id)) return null
    doc.loading = false
    doc.loadError = error?.message || String(error)
    renderTabs()
    if (doc.id === activeId) await renderActive()
    updateControls()
    return null
  }).finally(() => {
    doc.loadPromise = null
  })
  doc.loadPromise = opening
  return opening
}

async function restoreTabsFromEntries(entries) {
  if (!entries.length) {
    return false
  }

  const restored = []
  for (const entry of entries) {
    const doc = loadTabDocument(entry)
    if (doc && !restored.some(item => documentTabPath(item.doc) === entry.path)) restored.push({doc, current: entry.isCurrentTag === 1})
  }
  if (!restored.length) {
    return false
  }

  // The content script already captured the Markdown text from the page that
  // launched this reader. Reuse it for that URL's restored tab; other tabs
  // still load their source on demand.
  const pendingDocument = window.__LUMINA_PENDING_DOCUMENT__
  const currentURLKey = documentSourceURLKey(location.href)
  if (typeof pendingDocument?.source === 'string' && pendingDocument.source.trim()) {
    const currentDocument = restored.find(({doc}) => documentSourceURLKey(doc.sourceURL) === currentURLKey)?.doc
    if (currentDocument) {
      currentDocument.source = pendingDocument.source
      currentDocument.loaded = true
      currentDocument.loading = false
      currentDocument.loadError = ''
      currentDocument.sourceFromLoadedPage = location.protocol === 'file:'
    }
  }

  const restoredIds = new Set(restored.map(item => item.doc.id))
  documentFrames.forEach((frame, id) => {
    if (restoredIds.has(id)) return
    frame.remove()
    documentFrames.delete(id)
  })
  docs.splice(0, docs.length, ...restored.map(item => item.doc))
  activeId = (restored.find(item => item.current) || restored[0]).doc.id
  const active = activeDoc()
  if (active && location.hash && documentSourceURLKey(active.sourceURL) === documentSourceURLKey(location.href)) {
    const activeURL = new URL(active.sourceURL)
    activeURL.hash = location.hash
    active.sourceURL = activeURL.href
    active.pendingFragment = location.hash
  }
  renderTabs()
  updateControls()
  if (active) {
    if (active.loaded === false) void loadDocumentOnDemand(active)
    else await renderActive()
  }
  // The directory tree is rooted at the Markdown file that launched this page,
  // not at whichever document happens to be the active/restored tab.
  if (location.protocol === 'file:') await scanLocalDirectoryTree(location.href)
  if (rootHandle && await requestHandlePermission(rootHandle, 'read')) await refreshFileIndex()
  renderFiles()
  updateControls()
  updateFolderActive()
  writeTabStateToURL('replace')
  return true
}

// ==========================================================================
// MarkdownIt 解析器初始化与代码块高亮/复制按钮增强
// ==========================================================================
const markdown = new MarkdownIt({
  html: true,
  linkify: false,
  breaks: false,
})
enableBlankHeaderCardTableCompatibility(markdown)
enableEscapedFileLinkCompatibility(markdown)
enableExplicitAnchorCompatibility(markdown)
enableAdjacentStrongLabelCompatibility(markdown)
markdown.use(texmath, {engine: katex, delimiters: ['dollars', 'brackets'], katexOptions: {throwOnError: true}})

// Allow SVG data URIs for images while retaining markdown-it's other protocol restrictions.
const defaultValidateMarkdownLink = markdown.validateLink
const isSvgImageDataURI = url => /^data:image\/svg\+xml(?:;[a-z0-9=._+-]+)*,/i.test(url)
markdown.validateLink = url => /^file:\/\//i.test(url) || isSvgImageDataURI(url) || defaultValidateMarkdownLink(url)

const defaultLinkOpen = markdown.renderer.rules.link_open || ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options))
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index]
  // SVG data URIs are supported only as images, not navigable links.
  if (isSvgImageDataURI(token.attrGet('href') || '')) {
    const hrefIndex = token.attrIndex('href')
    if (hrefIndex >= 0) token.attrs.splice(hrefIndex, 1)
  }
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, index, options, env, renderer)
}

function mathFallback(token, displayMode) {
  const opening = token.tag || token.markup || (displayMode ? '$$' : '$')
  const closing = opening === '\\[' ? '\\]' : opening === '\\(' ? '\\)' : opening
  const source = displayMode
    ? `${opening}\n${token.content}\n${closing}`
    : `${opening}${token.content}${closing}`
  return `<span class="mdr-math-parse-failed${displayMode ? ' mdr-math-block-fallback' : ''}" role="note"><code>${markdown.utils.escapeHtml(source)}</code><small>解析失败</small></span>`
}

function renderMathToken(token, displayMode) {
  try {
    return katex.renderToString(token.content, {displayMode, throwOnError: true})
  } catch {
    return mathFallback(token, displayMode)
  }
}

markdown.renderer.rules.math_inline = (tokens, index) => `<eq>${renderMathToken(tokens[index], false)}</eq>`
markdown.renderer.rules.math_inline_double = (tokens, index) => `<section><eqn>${renderMathToken(tokens[index], true)}</eqn></section>`
markdown.renderer.rules.math_block = (tokens, index) => `<section><eqn>${renderMathToken(tokens[index], true)}</eqn></section>`
markdown.renderer.rules.math_block_eqno = (tokens, index) => {
  const token = tokens[index]
  return `<section class="eqno"><eqn>${renderMathToken(token, true)}</eqn><span>(${markdown.utils.escapeHtml(token.info || '')})</span></section>`
}

const defaultFence = markdown.renderer.rules.fence
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const token = tokens[index]
  const language = (token.info || '').trim().split(/\s+/)[0].toLowerCase()

  // Mermaid 流程图输出包含控制栏的专属区块
  if (language === 'mermaid') {
    const rawContent = markdown.utils.escapeHtml(token.content)
    return `
      <div class="mdr-mermaid-block">
        <div class="mdr-mermaid-controls" data-export-ignore>
          <button class="mdr-button" data-panzoom-action="zoom-in" data-tooltip="放大" title="放大" aria-label="放大">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
          </button>
          <button class="mdr-button" data-panzoom-action="zoom-out" data-tooltip="缩小" title="缩小" aria-label="缩小">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
          </button>
          <button class="mdr-button" data-panzoom-action="reset" data-tooltip="适应画布" title="适应画布" aria-label="适应画布">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          </button>
          <button class="mdr-button" data-panzoom-action="fullscreen" data-tooltip="全屏" title="全屏" aria-label="全屏">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
          </button>
          <button type="button" class="mdr-button" data-panzoom-action="export" data-tooltip="导出图片" title="导出图片" aria-label="导出流程图图片">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3M12 3v12m0 0 4-4m-4 4-4-4"/></svg>
          </button>
        </div>
        <div class="mermaid">${rawContent}</div>
      </div>
    `
  }

  const rawCode = token.content
  let highlighted = ''
  if (language && hljs.getLanguage(language)) {
    try {
      highlighted = hljs.highlight(rawCode, {language}).value
    } catch {
      highlighted = markdown.utils.escapeHtml(rawCode)
    }
  } else {
    try {
      highlighted = hljs.highlightAuto(rawCode).value
    } catch {
      highlighted = markdown.utils.escapeHtml(rawCode)
    }
  }

  const copyBtn = `<button class="mdr-button mdr-block__copy-btn" title="复制代码" aria-label="复制代码"><span class="btn-icon icon-copy"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></span><span class="btn-icon icon-success"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span></button>`

  const exportBtn = `<button type="button" class="mdr-button mdr-block__export-btn" title="导出代码图片" aria-label="导出代码图片" data-export-ignore><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5v2A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-2M8 2v8m0 0 3-3m-3 3L5 7"/></svg></button>`
  return `<pre class="hljs-pre mdr-code-block" data-language="${markdown.utils.escapeHtml(language)}"><code class="hljs ${language ? `language-${markdown.utils.escapeHtml(language)}` : ''}">${highlighted}</code>${copyBtn}${exportBtn}</pre>`
}

async function exportCodeBlockPNG(block, button, doc) {
  if (!block || button.disabled) return
  button.disabled = true
  let root
  let imageURL
  try {
    const ownerDocument = block.ownerDocument
    await ownerDocument.fonts?.ready
    const width = Math.ceil(Math.max(block.getBoundingClientRect().width, block.scrollWidth + 2))
    const padding = 5
    root = ownerDocument.createElement('div')
    root.className = 'mdr-content'
    const backgroundColor = document.documentElement.dataset.theme === 'dark' ? '#0d1117' : '#ffffff'
    Object.assign(root.style, {position: 'fixed', left: '0', top: '0', opacity: '0', pointerEvents: 'none', zIndex: '-1', boxSizing: 'border-box', width: `${width + padding * 2}px`, padding: `${padding}px`, margin: '0', backgroundColor})
    const clone = cloneForExport(block, new Map())
    clone.querySelectorAll('.mdr-block__copy-btn,.mdr-block__export-btn').forEach(item => item.remove())
    root.append(clone)
    ownerDocument.body.append(root)
    inlineComputedStyles(block, clone)
    clone.style.setProperty('margin', '0', 'important')
    clone.style.setProperty('width', `${width}px`, 'important')
    clone.style.setProperty('max-width', 'none', 'important')
    clone.style.setProperty('height', 'auto', 'important')
    clone.style.setProperty('overflow', 'visible', 'important')
    await waitForBrowserPaint()
    const height = Math.ceil(Math.max(clone.getBoundingClientRect().height, clone.scrollHeight)) + padding * 2
    const blob = await toBlob(root, {cacheBust: true, width: width + padding * 2, height, canvasWidth: width + padding * 2, canvasHeight: height, pixelRatio: preferences.imageExportPixelRatio, backgroundColor, style: {opacity: '1'}})
    if (!blob) throw new Error('代码图片生成失败')
    imageURL = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    const index = Array.from(ownerDocument.querySelectorAll('pre.mdr-code-block')).indexOf(block) + 1
    anchor.href = imageURL
    anchor.download = `${safeName(doc?.title?.replace(/\.[^.]+$/, '') || 'Markdown 文档')}_代码块${index > 1 ? `_${index}` : ''}.png`
    anchor.click()
  } catch (error) {
    console.error('[LuminaChrome] 代码图片导出失败', error)
    toast(`代码图片导出失败：${error?.message || error}`)
  } finally {
    root?.remove()
    if (imageURL) setTimeout(() => URL.revokeObjectURL(imageURL), 1000)
    button.disabled = false
  }
}

const slug = value => String(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'heading'
function getInlineMarkdownText(inline) {
  const text = inline?.children?.map(token => {
    if (token.type === 'text' || token.type === 'code_inline') return token.content
    if (token.type === 'image') return token.content || token.attrGet('alt') || ''
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' '
    return ''
  }).join('')
  return text || inline?.content || ''
}

let usedHeadingIDs = new Set()
markdown.renderer.rules.heading_open = (tokens, index, options, env, renderer) => {
  const inline = tokens[index + 1]
  const headingText = getInlineMarkdownText(inline) || `heading-${index}`
  const baseID = slug(headingText)
  let uniqueID = baseID
  let suffix = 1
  while (usedHeadingIDs.has(uniqueID)) uniqueID = `${baseID}-${suffix++}`
  usedHeadingIDs.add(uniqueID)
  tokens[index].attrSet('id', uniqueID)
  return renderer.renderToken(tokens, index, options)
}

// ==========================================================================
// GitHub Alert / Callout 与 表格自适应容器后处理
// ==========================================================================
function processAlerts(container) {
  const blockquotes = container.querySelectorAll('blockquote')
  for (const bq of blockquotes) {
    const firstP = bq.querySelector(':scope > p:first-child')
    if (!firstP) continue
    const text = firstP.textContent.trim()
    const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*(.*))?$/i.exec(text)
    if (!match) continue

    const type = match[1].toLowerCase()
    const remainder = match[2] || ''

    const alertDiv = document.createElement('div')
    alertDiv.className = `markdown-alert markdown-alert-${type}`

    const titleP = document.createElement('p')
    titleP.className = 'markdown-alert-title'
    titleP.textContent = type.toUpperCase()
    alertDiv.append(titleP)

    if (remainder.trim()) {
      firstP.textContent = remainder.trim()
      alertDiv.append(firstP)
    } else {
      firstP.remove()
    }

    while (bq.firstChild) {
      alertDiv.append(bq.firstChild)
    }

    bq.replaceWith(alertDiv)
  }
}

function processTables(container) {
  const tables = container.querySelectorAll('table')
  for (const table of tables) {
    table.classList.add('mdr-table')
    const firstRow = table.rows[0]
    if (firstRow && firstRow.cells.length >= 2 && firstRow.cells.length <= 4
      && [...table.rows].every(row => [...row.cells].every(cell => cell.colSpan === 1 && cell.rowSpan === 1))
      && [...table.querySelectorAll('code')].some(code => code.textContent.length > 60)) {
      table.dataset.mdrBalanced = 'true'
    }
    markTableLastColumn(table)
    if (table.parentElement?.classList.contains('mdr-table-wrapper')) continue
    const wrapper = document.createElement('div')
    wrapper.className = 'mdr-table-wrapper'
    table.replaceWith(wrapper)
    const exportButton = document.createElement('button')
    exportButton.type = 'button'
    exportButton.className = 'mdr-table-export-button'
    exportButton.setAttribute('data-export-ignore', '')
    exportButton.setAttribute('aria-label', '导出表格图片')
    exportButton.title = '导出表格图片'
    exportButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 10.5v2A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-2M8 2v8m0 0 3-3m-3 3L5 7"/></svg><span>导出图片</span>'
    exportButton.addEventListener('click', () => void exportTablePNG(table, exportButton))
    wrapper.append(exportButton)
    wrapper.append(table)
  }
}

function markTableLastColumn(table) {
  const occupied = []
  const positions = []
  let columnCount = 0
  for (const row of table.rows) {
    let column = 0
    for (const cell of row.cells) {
      const span = Math.max(1, cell.colSpan)
      while (Array.from({length: span}, (_, offset) => occupied[column + offset] > 0).some(Boolean)) column++
      const end = column + span
      positions.push({cell, end})
      for (let index = column; index < end; index++) occupied[index] = Math.max(1, cell.rowSpan || 1)
      column = end
      columnCount = Math.max(columnCount, end)
    }
    for (let index = 0; index < occupied.length; index++) occupied[index] = Math.max(0, (occupied[index] || 0) - 1)
  }
  for (const {cell, end} of positions) cell.toggleAttribute('data-mdr-last-column', end === columnCount)
}

async function exportTablePNG(table, button) {
  if (!table || button?.disabled) return
  const ownerDocument = table.ownerDocument || document
  const docEntry = Array.from(documentFrames.entries()).find(([, frame]) => frame.contentDocument === ownerDocument)
  const doc = docs.find(item => item.id === docEntry?.[0]) || activeDoc()
  if (button) {
    button.disabled = true
    button.classList.add('is-exporting')
    button.setAttribute('aria-busy', 'true')
  }

  let imageURL = ''
  let exportRoot = null
  try {
    await ownerDocument.fonts?.ready
    const rect = table.getBoundingClientRect()
    const width = Math.ceil(rect.width || table.scrollWidth)
    let height = Math.ceil(Math.max(rect.height, table.scrollHeight))
    if (width <= 0 || height <= 0) throw new Error('表格尺寸无效')

    const pixelRatio = Math.max(1, Number(preferences.imageExportPixelRatio) || 1.5)
    const backgroundColor = document.documentElement.dataset.theme === 'dark' ? '#0d1117' : '#ffffff'
    const imageData = await prepareExportImageData(Array.from(table.querySelectorAll('img')), doc)
    const exportTable = cloneForExport(table, imageData)
    exportRoot = ownerDocument.createElement('div')
    exportRoot.className = 'mdr-content'
    const padding = 5
    Object.assign(exportRoot.style, {position: 'fixed', left: '0', top: '0', opacity: '0', pointerEvents: 'none', zIndex: '-1', boxSizing: 'border-box', width: `${width + padding * 2}px`, height: `${height + padding * 2}px`, padding: `${padding}px`, margin: '0', overflow: 'hidden', backgroundColor})
    exportRoot.append(exportTable)
    ownerDocument.body.append(exportRoot)
    inlineComputedStyles(table, exportTable)
    Object.assign(exportTable.style, {margin: '0', width: `${width}px`, minWidth: '0', maxWidth: 'none', height: 'auto', overflow: 'visible'})
    exportTable.style.setProperty('margin', '0', 'important')
    await waitForBrowserPaint()
    height = Math.ceil(Math.max(exportTable.getBoundingClientRect().height, exportTable.scrollHeight))
    exportRoot.style.height = `${height + padding * 2}px`
    const blob = await toBlob(exportRoot, {
      cacheBust: true,
      width: width + padding * 2,
      height: height + padding * 2,
      canvasWidth: width + padding * 2,
      canvasHeight: height + padding * 2,
      pixelRatio,
      backgroundColor,
      style: {opacity: '1'},
    })
    if (!blob) throw new Error('表格图片生成失败')

    imageURL = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    const heading = table.closest('section')?.querySelector('h1,h2,h3,h4,h5,h6')?.textContent
    const baseName = safeName(heading || doc?.title?.replace(/\.[^.]+$/, '') || 'Markdown 文档')
    const index = Array.from(ownerDocument.querySelectorAll('table.mdr-table')).indexOf(table) + 1
    anchor.href = imageURL
    anchor.download = `${baseName}_表格${index > 1 ? `_${index}` : ''}.png`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(imageURL), 1000)
  } catch (error) {
    console.error('[LuminaChrome] 表格图片导出失败', error)
    toast(`表格图片导出失败：${error?.message || error}`)
  } finally {
    exportRoot?.remove()
    if (button) {
      button.disabled = false
      button.classList.remove('is-exporting')
      button.removeAttribute('aria-busy')
      button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 10.5v2A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-2M8 2v8m0 0 3-3m-3 3L5 7"/></svg><span>导出图片</span>'
    }
    if (imageURL) setTimeout(() => URL.revokeObjectURL(imageURL), 1000)
  }
}

function inlineComputedStyles(source, clone) {
  const sourceNodes = [source, ...source.querySelectorAll('*')]
  const cloneNodes = [clone, ...clone.querySelectorAll('*')]
  for (let index = 0; index < Math.min(sourceNodes.length, cloneNodes.length); index++) {
    const computed = sourceNodes[index].ownerDocument.defaultView.getComputedStyle(sourceNodes[index])
    const target = cloneNodes[index]
    for (const property of computed) {
      target.style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property))
    }
  }
}

// ==========================================================================
// 表格单元格尺寸拖动调整系统 (Table Column & Row Resizer - 100% 对齐 Lumina App)
// ==========================================================================
function initTableResize(rootContainer) {
  if (!rootContainer || rootContainer._tableResizeBound) return
  rootContainer._tableResizeBound = true

  const EDGE_THRESHOLD = 6 // 边缘触发阈值（像素）

  function getEdgeState(cell, e) {
    const rect = cell.getBoundingClientRect()
    const nearRight = e.clientX >= rect.right - EDGE_THRESHOLD && e.clientX <= rect.right + 2
    const nearBottom = e.clientY >= rect.bottom - EDGE_THRESHOLD && e.clientY <= rect.bottom + 2
    return { nearRight, nearBottom }
  }

  function ensureTableLayoutInitialized(table) {
    if (table.dataset.mdrResized === 'true') return

    const firstRow = table.rows[0]
    if (firstRow) {
      const measuredWidths = []
      for (let i = 0; i < firstRow.cells.length; i++) {
        measuredWidths.push(Math.round(firstRow.cells[i].getBoundingClientRect().width))
      }
      for (let i = 0; i < firstRow.cells.length; i++) {
        firstRow.cells[i].style.width = `${measuredWidths[i]}px`
      }
    }
    const initialTotalWidth = Math.round(table.getBoundingClientRect().width)
    table.style.width = `${initialTotalWidth}px`
    table.style.tableLayout = 'fixed'
    table.dataset.mdrResized = 'true'
  }

  function autoFitColumnWidth(table, colIndex) {
    ensureTableLayoutInitialized(table)

    const firstRow = table.rows[0]
    if (!firstRow || colIndex < 0 || colIndex >= firstRow.cells.length) return

    const headerCell = firstRow.cells[colIndex]
    const startColWidth = headerCell.getBoundingClientRect().width
    const startTableWidth = table.getBoundingClientRect().width
    const wrapper = table.closest('.mdr-table-wrapper') || table.parentElement || rootContainer

    const docOwner = table.ownerDocument || document
    const measurer = docOwner.createElement('div')
    measurer.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;width:max-content;max-width:none;pointer-events:none;z-index:-1;'
    measurer.innerHTML = `
      <style>
        .__ruler_table, .__ruler_table * {
          white-space: nowrap !important;
          word-break: normal !important;
          overflow-wrap: normal !important;
        }
      </style>
      <table class="mdr-table __ruler_table" style="table-layout:auto !important; width:auto !important; max-width:none !important; min-width:0 !important; border-collapse:separate !important;">
        <thead><tr><th id="__ruler_th" style="white-space:nowrap !important; width:auto !important; max-width:none !important; min-width:0 !important; box-sizing:border-box !important;"></th></tr></thead>
        <tbody><tr><td id="__ruler_td" style="white-space:nowrap !important; width:auto !important; max-width:none !important; min-width:0 !important; box-sizing:border-box !important;"></td></tr></tbody>
      </table>
    `
    wrapper.appendChild(measurer)

    const rulerTh = measurer.querySelector('#__ruler_th')
    const rulerTd = measurer.querySelector('#__ruler_td')

    let maxRequiredWidth = 0
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r]
      const c = row.cells && row.cells[colIndex]
      if (!c) continue

      const isTh = c.tagName === 'TH'
      const targetRuler = isTh ? rulerTh : rulerTd
      if (isTh) {
        rulerTd.innerHTML = ''
        rulerTh.innerHTML = c.innerHTML
      } else {
        rulerTh.innerHTML = ''
        rulerTd.innerHTML = c.innerHTML
      }

      const w = targetRuler.getBoundingClientRect().width
      if (w > maxRequiredWidth) maxRequiredWidth = w
    }

    measurer.remove()

    const newColWidth = Math.max(56, Math.ceil(maxRequiredWidth) + 10)
    const delta = newColWidth - startColWidth

    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r]
      const cellInCol = row.cells && row.cells[colIndex]
      if (cellInCol) cellInCol.style.width = `${newColWidth}px`
    }

    table.style.width = `${Math.max(100, Math.round(startTableWidth + delta))}px`
  }

  let hoverColLine = null
  let hoverRowLine = null
  let hoverLineWrapper = null

  const clearHoverResizerLines = () => {
    hoverColLine?.remove()
    hoverRowLine?.remove()
    hoverColLine = null
    hoverRowLine = null
    hoverLineWrapper = null
  }

  const updateHoverResizerLines = (table, cell, nearRight, nearBottom) => {
    const wrapper = table.closest('.mdr-table-wrapper') || table.parentElement
    if (!wrapper) return
    if (hoverLineWrapper !== wrapper) {
      clearHoverResizerLines()
      hoverLineWrapper = wrapper
    }
    const wr = wrapper.getBoundingClientRect()
    const tr = table.getBoundingClientRect()
    const cr = cell.getBoundingClientRect()
    const docOwner = table.ownerDocument || document

    if (nearRight) {
      if (!hoverColLine) {
        hoverColLine = docOwner.createElement('div')
        hoverColLine.className = 'mdr-table-resizer-line-col mdr-table-resizer-line-hover'
        wrapper.appendChild(hoverColLine)
      }
      hoverColLine.style.left = `${cr.right - wr.left + wrapper.scrollLeft - 1}px`
      hoverColLine.style.top = `${tr.top - wr.top + wrapper.scrollTop}px`
      hoverColLine.style.height = `${tr.height}px`
    } else {
      hoverColLine?.remove()
      hoverColLine = null
    }

    if (nearBottom) {
      if (!hoverRowLine) {
        hoverRowLine = docOwner.createElement('div')
        hoverRowLine.className = 'mdr-table-resizer-line-row mdr-table-resizer-line-hover'
        wrapper.appendChild(hoverRowLine)
      }
      hoverRowLine.style.top = `${cr.bottom - wr.top + wrapper.scrollTop - 1}px`
      hoverRowLine.style.left = `${tr.left - wr.left + wrapper.scrollLeft}px`
      hoverRowLine.style.width = `${tr.width}px`
    } else {
      hoverRowLine?.remove()
      hoverRowLine = null
    }
  }

  rootContainer.addEventListener('mousemove', e => {
    if (rootContainer._isTableResizing) return
    const cell = e.target.closest('th, td')
    if (!cell || !cell.closest('.mdr-table-wrapper table, table.mdr-table, table')) {
      clearHoverResizerLines()
      return
    }
    const { nearRight, nearBottom } = getEdgeState(cell, e)
    const table = cell.closest('table')
    updateHoverResizerLines(table, cell, nearRight, nearBottom)
    if (nearRight && nearBottom) cell.style.cursor = 'se-resize'
    else if (nearRight) cell.style.cursor = 'col-resize'
    else if (nearBottom) cell.style.cursor = 'row-resize'
    else cell.style.cursor = ''
  })

  rootContainer.addEventListener('mouseout', e => {
    if (rootContainer._isTableResizing) return
    const cell = e.target.closest('th, td')
    if (cell && cell.style.cursor) cell.style.cursor = ''
    if (!e.relatedTarget?.closest?.('th, td')) clearHoverResizerLines()
  })

  rootContainer.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    const cell = e.target.closest('th, td')
    if (!cell) return
    const table = cell.closest('table')
    if (!table) return

    const { nearRight, nearBottom } = getEdgeState(cell, e)
    if (!nearRight && !nearBottom) return

    e.preventDefault()
    e.stopPropagation()
    clearHoverResizerLines()

    rootContainer._isTableResizing = true
    const resizeMode = nearRight && nearBottom ? 'both' : (nearRight ? 'col' : 'row')
    const dragCursor = resizeMode === 'both' ? 'se-resize' : (resizeMode === 'col' ? 'col-resize' : 'row-resize')

    const docOwner = table.ownerDocument || document
    const bodyOwner = docOwner.body || document.body
    const winOwner = docOwner.defaultView || window

    bodyOwner.style.cursor = dragCursor
    bodyOwner.style.userSelect = 'none'
    bodyOwner.style.webkitUserSelect = 'none'

    const tr = cell.parentElement
    const colIndex = cell.cellIndex
    const wrapper = table.closest('.mdr-table-wrapper') || table.parentElement

    if (resizeMode === 'col' || resizeMode === 'both') ensureTableLayoutInitialized(table)

    const startX = e.clientX
    const startY = e.clientY
    const headerCell = (table.rows[0] && table.rows[0].cells[colIndex]) || cell
    const startColWidth = headerCell.getBoundingClientRect().width
    const startTableWidth = table.getBoundingClientRect().width
    const startRowHeight = tr.getBoundingClientRect().height

    let lineCol = null
    let lineRow = null

    if (resizeMode === 'col' || resizeMode === 'both') {
      lineCol = docOwner.createElement('div')
      lineCol.className = 'mdr-table-resizer-line-col'
      wrapper.appendChild(lineCol)
    }
    if (resizeMode === 'row' || resizeMode === 'both') {
      lineRow = docOwner.createElement('div')
      lineRow.className = 'mdr-table-resizer-line-row'
      wrapper.appendChild(lineRow)
    }

    function updateResizerLines() {
      const wrapperRect = wrapper.getBoundingClientRect()
      const tableRect = table.getBoundingClientRect()
      const currentCellRect = cell.getBoundingClientRect()

      if (lineCol) {
        lineCol.style.left = `${currentCellRect.right - wrapperRect.left + wrapper.scrollLeft - 1}px`
        lineCol.style.top = `${tableRect.top - wrapperRect.top + wrapper.scrollTop}px`
        lineCol.style.height = `${tableRect.height}px`
      }
      if (lineRow) {
        lineRow.style.top = `${currentCellRect.bottom - wrapperRect.top + wrapper.scrollTop - 1}px`
        lineRow.style.left = `${tableRect.left - wrapperRect.left + wrapper.scrollLeft}px`
        lineRow.style.width = `${tableRect.width}px`
      }
    }

    updateResizerLines()

    function onMouseMove(moveEvent) {
      if (resizeMode === 'col' || resizeMode === 'both') {
        const dx = moveEvent.clientX - startX
        const minColWidth = 40
        const newColWidth = Math.max(minColWidth, Math.round(startColWidth + dx))
        const actualDelta = newColWidth - startColWidth

        headerCell.style.width = `${newColWidth}px`
        if (cell !== headerCell) cell.style.width = `${newColWidth}px`
        table.style.width = `${Math.max(100, Math.round(startTableWidth + actualDelta))}px`
      }

      if (resizeMode === 'row' || resizeMode === 'both') {
        const dy = moveEvent.clientY - startY
        const minRowHeight = 28
        const newRowHeight = Math.max(minRowHeight, Math.round(startRowHeight + dy))
        tr.style.height = `${newRowHeight}px`
      }

      updateResizerLines()
    }

    function onMouseUp() {
      winOwner.removeEventListener('mousemove', onMouseMove)
      winOwner.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)

      lineCol?.remove()
      lineRow?.remove()

      if (resizeMode === 'col' || resizeMode === 'both') {
        const finalWidth = headerCell.style.width
        if (finalWidth) {
          for (let r = 0; r < table.rows.length; r++) {
            const cellInCol = table.rows[r].cells && table.rows[r].cells[colIndex]
            if (cellInCol) cellInCol.style.width = finalWidth
          }
        }
      }

      bodyOwner.style.cursor = ''
      bodyOwner.style.userSelect = ''
      bodyOwner.style.webkitUserSelect = ''
      cell.style.cursor = ''
      rootContainer._isTableResizing = false
    }

    winOwner.addEventListener('mousemove', onMouseMove)
    winOwner.addEventListener('mouseup', onMouseUp)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  })

  rootContainer.addEventListener('dblclick', e => {
    const cell = e.target.closest('th, td')
    if (!cell) return
    const table = cell.closest('table')
    if (!table) return

    const { nearRight, nearBottom } = getEdgeState(cell, e)
    if (nearRight) {
      e.preventDefault()
      e.stopPropagation()
      if (winOwnerSelection(table)) winOwnerSelection(table).removeAllRanges()
      autoFitColumnWidth(table, cell.cellIndex)
    } else if (nearBottom) {
      e.preventDefault()
      e.stopPropagation()
      const tr = cell.parentElement
      if (tr) tr.style.height = ''
    }
  })

  function winOwnerSelection(table) {
    const doc = table.ownerDocument || document
    return doc.defaultView ? doc.defaultView.getSelection() : window.getSelection()
  }
}

// ==========================================================================
// Mermaid 流程图拖拽平移、缩放、适应画布与全屏交互模块
// 彻底解决甘特图、时序图等变形挤压问题
// ==========================================================================
const documentFrameFullscreenStates = new WeakMap()

function restoreDocumentFrameStyles(frame) {
  const state = frame && documentFrameFullscreenStates.get(frame)
  if (!state) return
  if (state.originalStyle) frame.setAttribute('style', state.originalStyle)
  else frame.removeAttribute('style')
  documentFrameFullscreenStates.delete(frame)
}

function enterDocumentFrameFullscreen(frame) {
  if (!frame) return Promise.resolve()
  let state = documentFrameFullscreenStates.get(frame)
  if (!state) {
    state = {
      originalStyle: frame.getAttribute('style') || ''
    }
    documentFrameFullscreenStates.set(frame, state)
  }

  // Expand only within the current browser page; keep browser chrome visible.
  frame.style.setProperty('position', 'fixed', 'important')
  frame.style.setProperty('inset', '0', 'important')
  frame.style.setProperty('top', '0', 'important')
  frame.style.setProperty('left', '0', 'important')
  frame.style.setProperty('width', '100vw', 'important')
  frame.style.setProperty('height', '100vh', 'important')
  frame.style.setProperty('max-width', 'none', 'important')
  frame.style.setProperty('max-height', 'none', 'important')
  frame.style.setProperty('margin', '0', 'important')
  frame.style.setProperty('z-index', '2147483647', 'important')
  // Flush the expanded iframe geometry before Viewer.js measures its viewport.
  frame.getBoundingClientRect()

  return Promise.resolve()
}

function exitDocumentFrameFullscreen(frame) {
  if (!frame) return
  restoreDocumentFrameStyles(frame)
}

function initMermaidInteractions(container) {
  const interactionDocument = container.ownerDocument || document
  const interactionWindow = interactionDocument.defaultView || window
  const blocks = container.matches?.('.mdr-mermaid-block')
    ? [container]
    : [...container.querySelectorAll('.mdr-mermaid-block')]

  blocks.forEach(block => {
    const canvas = block.querySelector('.mermaid')
    if (!canvas || canvas.dataset.mdrInteractive || !canvas.querySelector('svg')) return
    canvas.dataset.mdrInteractive = '1'

    // 1. 精准提取 SVG 的固有几何尺寸
    const getSvgNaturalSize = targetSvg => {
      const el = targetSvg || canvas.querySelector('svg')
      if (!el) return {width: 600, height: 300}
      let w = el.viewBox?.baseVal?.width || 0
      let h = el.viewBox?.baseVal?.height || 0
      if (!w || !h) {
        const vb = el.getAttribute('viewBox')
        if (vb) {
          const parts = vb.trim().split(/[\s,]+/)
          if (parts.length >= 4) {
            w = parseFloat(parts[2]) || 0
            h = parseFloat(parts[3]) || 0
          }
        }
      }
      if (!w || !h) {
        try {
          const bbox = el.getBBox()
          if (bbox && bbox.width > 0 && bbox.height > 0) {
            w = bbox.width
            h = bbox.height
          }
        } catch {}
      }
      if (!w || !h) {
        const rawW = el.getAttribute('width') || ''
        const rawH = el.getAttribute('height') || ''
        if (rawW && !rawW.includes('%')) w = parseFloat(rawW) || 0
        if (rawH && !rawH.includes('%')) h = parseFloat(rawH) || 0
        w = w || el.clientWidth || 800
        h = h || el.clientHeight || 400
      }
      return {width: Math.max(20, Math.round(w)), height: Math.max(20, Math.round(h))}
    }

    let nat = getSvgNaturalSize()

    // 2. 锁定 SVG 几何尺寸，解除 max-width 导致的压扁挤叠
    const ensureSvgStyles = () => {
      const currentSvg = canvas.querySelector('svg')
      if (!currentSvg) return null
      nat = getSvgNaturalSize(currentSvg)
      currentSvg.style.width = `${nat.width}px`
      currentSvg.style.height = `${nat.height}px`
      currentSvg.style.maxWidth = 'none'
      currentSvg.style.maxHeight = 'none'
      currentSvg.style.position = 'absolute'
      currentSvg.style.left = '0'
      currentSvg.style.top = '0'
      currentSvg.style.transformOrigin = '0 0'
      return currentSvg
    }

    ensureSvgStyles()

    const maxBlockH = parseFloat(interactionWindow.getComputedStyle(block).maxHeight) || 1000
    const minBlockH = parseFloat(interactionWindow.getComputedStyle(block).minHeight) || 180
    const blockChromeH = 32
    const fitPadding = 32

    const computeBlockHeight = () => {
      const canvasW = block.clientWidth || canvas.clientWidth || 800
      const availW = Math.max(10, canvasW - fitPadding)
      const availH = Math.max(10, maxBlockH - blockChromeH - fitPadding)
      const nextFitScale = Math.min(1, availW / nat.width, availH / nat.height)
      return Math.round(Math.max(minBlockH, Math.min(maxBlockH, nat.height * nextFitScale + blockChromeH + fitPadding)))
    }

    let naturalBlockH = computeBlockHeight()
    block.style.height = `${naturalBlockH}px`

    let scale = 1, x = 0, y = 0
    let fitScale = 1, fitX = 0, fitY = 0
    let dragging = false, startX = 0, startY = 0
    let isUserManipulated = false

    const apply = () => {
      const currentSvg = ensureSvgStyles()
      if (currentSvg) {
        currentSvg.style.transform = `translate(${x}px,${y}px) scale(${scale})`
      }
    }

    const computeFit = () => {
      const isExpanded = block.classList.contains('mdr-mermaid-expanded')
      if (!isExpanded) {
        naturalBlockH = computeBlockHeight()
        block.style.height = `${naturalBlockH}px`
      }
      const canvasW = canvas.clientWidth || (isExpanded ? interactionWindow.innerWidth : 800)
      const canvasH = canvas.clientHeight || (isExpanded ? interactionWindow.innerHeight : naturalBlockH - 32)

      const availW = Math.max(10, canvasW - fitPadding)
      const availH = Math.max(10, canvasH - fitPadding)

      const scaleX = availW / nat.width
      const scaleY = availH / nat.height
      fitScale = Math.min(1.0, scaleX, scaleY)

      fitX = (canvasW - nat.width * fitScale) / 2
      fitY = (canvasH - nat.height * fitScale) / 2

      scale = fitScale
      x = fitX
      y = fitY
    }

    computeFit()
    apply()

    const zoomAt = (nextScale, clientX, clientY) => {
      const rect = canvas.getBoundingClientRect()
      const pointerX = clientX - rect.left
      const pointerY = clientY - rect.top
      const localX = (pointerX - x) / scale
      const localY = (pointerY - y) / scale
      x = pointerX - localX * nextScale
      y = pointerY - localY * nextScale
      scale = nextScale
      isUserManipulated = true
      apply()
    }

    // 全屏模式滚轮缩放与平移（非全屏阅读模式不拦截，保证正文顺畅滚动）
    const onWheel = event => {
      if (!block.classList.contains('mdr-mermaid-expanded')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.ctrlKey) {
        const factor = event.deltaY < 0 ? 1.1 : 0.9
        zoomAt(Math.max(fitScale * 0.15, Math.min(fitScale * 8, scale * factor)), event.clientX, event.clientY)
      } else {
        x -= event.deltaX
        y -= event.deltaY
        isUserManipulated = true
        apply()
      }
    }

    // 鼠标左键拖拽平移
    const onMouseDown = event => {
      if (event.button !== 0 || event.target.closest('.mdr-mermaid-controls')) return
      dragging = true
      startX = event.clientX - x
      startY = event.clientY - y
      canvas.classList.add('is-dragging')
    }

    const onMouseMove = event => {
      if (!dragging) return
      x = event.clientX - startX
      y = event.clientY - startY
      isUserManipulated = true
      apply()
    }

    const onMouseUp = () => {
      if (dragging) {
        dragging = false
        canvas.classList.remove('is-dragging')
      }
    }

    canvas.addEventListener('mousedown', onMouseDown)
    interactionWindow.addEventListener('mousemove', onMouseMove)
    interactionWindow.addEventListener('mouseup', onMouseUp)

    // 全屏切换
    const documentFrame = interactionWindow.frameElement
    const applyFullscreen = expanded => {
      if (expanded) {
        block.classList.add('mdr-mermaid-expanded')
        block.style.height = ''
        isUserManipulated = false
        canvas.addEventListener('wheel', onWheel, {passive: false})
        requestAnimationFrame(() => {
          computeFit()
          apply()
        })
      } else {
        block.classList.remove('mdr-mermaid-expanded')
        block.style.height = `${naturalBlockH}px`
        isUserManipulated = false
        canvas.removeEventListener('wheel', onWheel)
        requestAnimationFrame(() => {
          computeFit()
          apply()
        })
      }
    }

    const setFullscreen = (expanded, options = {}) => {
      if (!expanded) {
        applyFullscreen(false)
        if (!options.fromFrameExit) exitDocumentFrameFullscreen(documentFrame)
        return
      }

      const request = enterDocumentFrameFullscreen(documentFrame)
      applyFullscreen(true)
      request.catch(error => {
        applyFullscreen(false)
        exitDocumentFrameFullscreen(documentFrame)
        toast(`无法进入全屏：${error.message || error}`)
      })
    }

    block._mdrSetFullscreen = setFullscreen

    // 控制栏按钮点击处理
    block.querySelectorAll('[data-panzoom-action]').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation()
        const action = btn.dataset.panzoomAction
        const rect = canvas.getBoundingClientRect()
        if (action === 'export') {
          void exportMermaidPNG(block, btn, getSvgNaturalSize())
        } else if (action === 'fullscreen') {
          const isNowExpanded = !block.classList.contains('mdr-mermaid-expanded')
          setFullscreen(isNowExpanded)
        } else if (action === 'zoom-in') {
          zoomAt(Math.min(fitScale * 8, scale * 1.25), rect.left + rect.width / 2, rect.top + rect.height / 2)
        } else if (action === 'zoom-out') {
          zoomAt(Math.max(fitScale * 0.15, scale / 1.25), rect.left + rect.width / 2, rect.top + rect.height / 2)
        } else if (action === 'reset') {
          isUserManipulated = false
          computeFit()
          apply()
        }
      }
    })

    if (typeof interactionWindow.ResizeObserver !== 'undefined') {
      let lastObservedWidth = block.getBoundingClientRect().width
      let fitFrame = 0
      const ro = new interactionWindow.ResizeObserver(() => {
        const nextWidth = block.getBoundingClientRect().width
        // Height changes caused by computeFit must not feed back into the
        // observer. Only a real width change affects the fitted scale.
        if (Math.abs(nextWidth - lastObservedWidth) < 0.5) return
        lastObservedWidth = nextWidth
        if (fitFrame) cancelAnimationFrame(fitFrame)
        fitFrame = requestAnimationFrame(() => {
          fitFrame = 0
          if (isUserManipulated || block.classList.contains('mdr-mermaid-expanded')) return
          computeFit()
          apply()
        })
      })
      ro.observe(block)
    }
  })
}

async function exportMermaidPNG(block, button, size) {
  if (button.disabled) return
  const svg = block.querySelector('.mermaid svg')
  if (!svg) return
  button.disabled = true
  let root
  let imageURL
  try {
    const ownerDocument = block.ownerDocument
    await ownerDocument.fonts?.ready
    const padding = 12
    const width = Math.ceil(size.width) + padding * 2
    const height = Math.ceil(size.height) + padding * 2
    const backgroundColor = ownerDocument.documentElement.dataset.theme === 'dark' ? '#0d1117' : '#ffffff'
    root = ownerDocument.createElement('div')
    Object.assign(root.style, {position: 'fixed', left: '0', top: '0', zIndex: '-1', opacity: '0', pointerEvents: 'none', boxSizing: 'border-box', width: `${width}px`, height: `${height}px`, padding: `${padding}px`, backgroundColor})
    const clone = svg.cloneNode(true)
    root.append(clone)
    ownerDocument.body.append(root)
    inlineComputedStyles(svg, clone)
    for (const [property, value] of Object.entries({position: 'static', transform: 'none', width: `${size.width}px`, height: `${size.height}px`, 'max-width': 'none', 'max-height': 'none', margin: '0'})) clone.style.setProperty(property, value, 'important')
    await waitForBrowserPaint()
    const blob = await toBlob(root, {cacheBust: true, width, height, canvasWidth: width, canvasHeight: height, pixelRatio: preferences.imageExportPixelRatio, backgroundColor, style: {opacity: '1'}})
    if (!blob) throw new Error('流程图图片生成失败')
    imageURL = URL.createObjectURL(blob)
    const docEntry = Array.from(documentFrames.entries()).find(([, frame]) => frame.contentDocument === ownerDocument)
    const doc = docs.find(item => item.id === docEntry?.[0]) || activeDoc()
    const index = Array.from(ownerDocument.querySelectorAll('.mdr-mermaid-block')).indexOf(block) + 1
    const anchor = document.createElement('a')
    anchor.href = imageURL
    anchor.download = `${safeName(doc?.title?.replace(/\.[^.]+$/, '') || 'Markdown 文档')}_流程图${index > 1 ? `_${index}` : ''}.png`
    anchor.click()
  } catch (error) {
    console.error('[LuminaChrome] 流程图图片导出失败', error)
    toast(`流程图图片导出失败：${error?.message || error}`)
  } finally {
    root?.remove()
    if (imageURL) setTimeout(() => URL.revokeObjectURL(imageURL), 1000)
    button.disabled = false
  }
}

// ESC 键退出流程图全屏
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    document.querySelectorAll('.mdr-mermaid-block.mdr-mermaid-expanded').forEach(block => {
      if (typeof block._mdrSetFullscreen === 'function') {
        block._mdrSetFullscreen(false)
      } else {
        block.classList.remove('mdr-mermaid-expanded')
      }
    })
  }
})

// ==========================================================================
// Viewer.js 原生图片查看器高级适配模块 (100% 移植自 Lumina App)
// ==========================================================================
function fitViewerImageToViewport(viewerInstance) {
  if (!viewerInstance || !viewerInstance.imageData) return
  const view = viewerInstance.element?.ownerDocument?.defaultView || window
  const imgData = viewerInstance.imageData
  const nw = imgData.naturalWidth
  const nh = imgData.naturalHeight
  if (!nw || !nh || nw <= 0 || nh <= 0) return

  const viewerData = viewerInstance.viewerData || {}
  const containerWidth = viewerData.width || view.innerWidth
  const totalHeight = viewerData.height || view.innerHeight

  const footerHeight = (viewerInstance.footer && viewerInstance.footer.offsetHeight) || 60
  const topSafePadding = 56
  const bottomSafePadding = footerHeight + 20

  const safeAreaWidth = Math.max(containerWidth * 0.88, 200)
  const safeAreaHeight = Math.max(totalHeight - topSafePadding - bottomSafePadding, 200)

  let fitRatio = Math.min(safeAreaWidth / nw, safeAreaHeight / nh)
  if (nw < 64 || nh < 64) {
    fitRatio = Math.min(fitRatio, 3.5)
  } else if (nw < 128 || nh < 128) {
    fitRatio = Math.min(fitRatio, 5.0)
  }

  if (!fitRatio || fitRatio <= 0) return

  const targetWidth = nw * fitRatio
  const targetHeight = nh * fitRatio

  const targetX = (containerWidth - targetWidth) / 2
  const targetY = topSafePadding + (safeAreaHeight - targetHeight) / 2

  imgData.width = targetWidth
  imgData.height = targetHeight
  imgData.x = targetX
  imgData.y = targetY
  imgData.left = targetX
  imgData.top = targetY
  imgData.ratio = fitRatio
  imgData.oldRatio = fitRatio

  if (viewerInstance.initialImageData) {
    Object.assign(viewerInstance.initialImageData, {
      width: targetWidth,
      height: targetHeight,
      x: targetX,
      y: targetY,
      left: targetX,
      top: targetY,
      ratio: fitRatio,
    })
  }

  viewerInstance.renderImage()
}

function bindViewerCursorZoom(viewerInstance, doc) {
  const viewerContainer = viewerInstance.viewer
  if (!viewerContainer || viewerContainer._mdrWheelBound) return
  viewerContainer._mdrWheelBound = true

  viewerContainer.addEventListener('wheel', e => {
    if (!viewerInstance.isShown || !viewerInstance.viewed) return
    e.preventDefault()
    e.stopPropagation()

    const canvas = viewerInstance.canvas
    if (!canvas) return
    const imageEl = viewerInstance.image

    // 普通滚轮：平移图片
    if (!e.ctrlKey) {
      if (imageEl) imageEl.style.transition = 'none'
      viewerInstance.move(-e.deltaX, -e.deltaY)
      clearTimeout(viewerContainer._mdrTransitionTimer)
      viewerContainer._mdrTransitionTimer = setTimeout(() => {
        if (imageEl) imageEl.style.transition = ''
      }, 150)
      return
    }

    // Ctrl + 滚轮 / 触控板捏合：以鼠标为锚点丝滑缩放
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const factor = Math.exp(-e.deltaY * 0.012)

    const imageData = viewerInstance.imageData
    if (!imageData || !imageData.ratio) return

    const currentRatio = imageData.ratio
    const minRatio = viewerInstance.options.minZoomRatio || 0.01
    const maxRatio = viewerInstance.options.maxZoomRatio || 100
    const targetRatio = Math.max(minRatio, Math.min(maxRatio, currentRatio * factor))

    if (Math.abs(targetRatio - currentRatio) < 0.0001) return
    if (imageEl) imageEl.style.transition = 'none'

    viewerInstance.zoomTo(targetRatio, true, {x: px, y: py})
    clearTimeout(viewerContainer._mdrTransitionTimer)
    viewerContainer._mdrTransitionTimer = setTimeout(() => {
      if (imageEl) imageEl.style.transition = ''
    }, 150)
  }, {passive: false})
}

function bindViewerCloseEvents(viewerInstance, doc) {
  const viewerContainer = viewerInstance.viewer
  if (!viewerContainer || viewerContainer._mdrCloseBound) return
  viewerContainer._mdrCloseBound = true

  const closeViewerSafely = () => {
    viewerInstance.hide()
  }

  const handleEscKey = e => {
    if (e.key === 'Escape' && viewerInstance.isShown) {
      e.preventDefault()
      e.stopPropagation()
      closeViewerSafely()
    }
  }
  doc.addEventListener('keydown', handleEscKey, true)
  doc.defaultView.addEventListener('keydown', handleEscKey, true)
}

function bindViewerResizeAdaptive(viewerInstance) {
  const view = viewerInstance.element?.ownerDocument?.defaultView || window
  if (view._mdrViewerResizeBound) return
  view._mdrViewerResizeBound = true
  let timer = null
  view.addEventListener('resize', () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (viewerInstance && viewerInstance.isShown && viewerInstance.viewed) {
        fitViewerImageToViewport(viewerInstance)
      }
    }, 120)
  })
}

function layoutMarkdownImageGroups(containerEl) {
  if (!containerEl) return

  const containsOnlyImages = element => Array.from(element.childNodes).every(node => {
    if (node.nodeType === Node.TEXT_NODE) return !node.textContent.trim()
    if (node.nodeType !== Node.ELEMENT_NODE) return true
    if (node.matches('img, br')) return true
    return node.tagName === 'A' || node.children.length > 0
      ? containsOnlyImages(node)
      : false
  })

  const visit = parent => {
    Array.from(parent.children).forEach(child => {
      if (!child.matches('pre, code, table, .mdr-image-flex')) visit(child)
    })

    const children = Array.from(parent.children)
    for (let index = 0; index < children.length;) {
      if (children[index].tagName !== 'P' || !children[index].querySelector('img') || !containsOnlyImages(children[index])) {
        index += 1
        continue
      }

      const paragraphs = [children[index]]
      let nextIndex = index + 1
      while (nextIndex < children.length && children[nextIndex].tagName === 'P' && children[nextIndex].querySelector('img') && containsOnlyImages(children[nextIndex])) {
        paragraphs.push(children[nextIndex])
        nextIndex += 1
      }

      const imageGroup = containerEl.ownerDocument.createElement('div')
      imageGroup.className = 'mdr-image-flex'
      paragraphs[0].before(imageGroup)
      paragraphs.forEach(paragraph => {
        Array.from(paragraph.childNodes).forEach(node => {
          if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) return
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') return
          imageGroup.append(node)
        })
        paragraph.remove()
      })
      index = nextIndex
    }
  }

  visit(containerEl)
}

function setupArticleViewer(containerEl) {
  if (!containerEl) return
  const ViewerClass = containerEl.ownerDocument?.defaultView?.Viewer || window.Viewer
  const containerDocument = containerEl.ownerDocument || document
  const documentFrame = containerDocument.defaultView?.frameElement || null
  if (!ViewerClass) {
    console.warn('[LuminaChrome] Viewer.js class is not available')
    return
  }

  const imgs = containerEl.querySelectorAll('img')
  if (!imgs || imgs.length === 0) return

  imgs.forEach(img => {
    img.classList.add('mdr-viewable-img')

    // 若 SVG 图片（如 data URI）未显式声明 width/height，自动从 viewBox 提取固有尺寸，
    // 避免浏览器在无尺寸约束时将图片折叠或错误拉伸
    const src = img.getAttribute('src') || ''
    if (isSvgImageDataURI(src) && !img.getAttribute('width') && !img.getAttribute('height')) {
      try {
        const decoded = decodeURIComponent(src.split(',')[1] || '')
        const viewBoxMatch = decoded.match(/viewBox\s*=\s*["']?([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
        if (viewBoxMatch && Number(viewBoxMatch[3]) > 0 && Number(viewBoxMatch[4]) > 0) {
          img.setAttribute('width', viewBoxMatch[3])
          img.setAttribute('height', viewBoxMatch[4])
        }
      } catch {}
    }

    const imageLink = img.closest('a[href]')
    if (imageLink) {
      imageLink.classList.add('mdr-image-link')
      imageLink.setAttribute('data-bs-toggle', 'tooltip')
      imageLink.setAttribute('data-bs-title', isMac ? '按住 Command 点击预览' : '按住 Ctrl 点击预览')
      imageLink.removeAttribute('title')
      try {
        Tooltip.getOrCreateInstance(imageLink, {
          container: containerDocument.body,
          trigger: 'hover focus',
          placement: 'top',
        })
      } catch (error) {
        console.warn('[LuminaChrome] Image link tooltip setup failed:', error)
      }
    }
  })

  try {
    if (containerEl._mdrViewerClickGuard) {
      containerEl.removeEventListener('click', containerEl._mdrViewerClickGuard, true)
      containerEl._mdrViewerClickGuard = null
    }
    if (containerEl._mdrViewer) {
      containerEl._mdrViewer.destroy()
      containerEl._mdrViewer = null
    }

    const viewerInstance = new ViewerClass(containerEl, {
      backdrop: 'static',
      filter(image) {
        return image.tagName === 'IMG' && Boolean(image.src)
      },
      url(image) {
        return image.getAttribute('data-original') || image.src
      },
      title(image) {
        const alt = image.alt ? image.alt.trim() : ''
        if (/^(?:data|blob):/i.test(image.src)) return alt || '图片预览'
        const rawFilename = image.src.split('/').pop().split('?')[0].split('#')[0]
        let decodedFilename = rawFilename
        try { decodedFilename = decodeURIComponent(rawFilename) } catch {}
        if (alt && alt !== decodedFilename) return `${alt} (${decodedFilename})`
        return decodedFilename || '图片预览'
      },
      navbar: false,
      toolbar: {
        zoomIn: 1,
        zoomOut: 1,
        oneToOne: 1,
        reset: 1,
        prev: imgs.length > 1 ? 1 : 0,
        play: 0,
        next: imgs.length > 1 ? 1 : 0,
        rotateLeft: 1,
        rotateRight: 1,
        flipHorizontal: 1,
        flipVertical: 1,
      },
      tooltip: true,
      movable: true,
      zoomable: true,
      zoomOnWheel: false,
      rotatable: true,
      scalable: true,
      transition: false,
      focus: false,
      initialCoverage: 0.9,
      show() {
        if (viewerInstance._mdrFrameExpanded) return
        viewerInstance._mdrFrameExpanded = true
        containerDocument.documentElement.classList.add('mdr-viewer-showing')
        // Viewer.js fills its own document; expand the containing iframe too,
        // so the image viewer covers the page viewport while browser chrome stays visible.
        void enterDocumentFrameFullscreen(documentFrame).catch(error => {
          viewerInstance._mdrFrameExpanded = false
          exitDocumentFrameFullscreen(documentFrame)
          toast(`无法进入全屏：${error.message || error}`)
        })
      },
      view() {
        viewerInstance.viewer?.classList.add('mdr-viewer-positioning')
      },
      shown() {
        bindViewerCursorZoom(viewerInstance, containerDocument)
        bindViewerCloseEvents(viewerInstance, containerDocument)
        bindViewerResizeAdaptive(viewerInstance)
      },
      viewed() {
        fitViewerImageToViewport(viewerInstance)
        requestAnimationFrame(() => viewerInstance.viewer?.classList.remove('mdr-viewer-positioning'))
      },
      hide() {
        viewerInstance._mdrFrameExpanded = false
      },
      hidden() {
        viewerInstance._mdrFrameExpanded = false
        exitDocumentFrameFullscreen(documentFrame)
        containerDocument.documentElement.classList.remove('mdr-viewer-showing')
      },
    })

    // Keep Viewer.js as the only opener, but ignore another delivery for the
    // same image while its first open/load cycle is still active.
    const guardDuplicateImageClick = event => {
      const image = event.target.closest?.('img.mdr-viewable-img')
      if (!image || !containerEl.contains(image)) return

      const imageLink = image.closest('a[href]')
      if (imageLink) {
        const imageIndex = Array.from(imgs).indexOf(image)
        event.preventDefault()
        event.stopImmediatePropagation()
        if (event.metaKey || event.ctrlKey) {
          if (imageIndex >= 0) {
            if (viewerInstance.isShown) viewerInstance.view(imageIndex)
            else {
              viewerInstance.index = imageIndex
              viewerInstance.show()
            }
          }
          return
        }
        const documentDoc = docs.find(doc => documentFrames.get(doc.id)?.contentDocument === containerDocument) || activeDoc()
        void handlePreviewClick(event, documentDoc)
        return
      }

      // Viewer.js keeps `viewing` as an abort handle even after the image has
      // failed or the viewer has been hidden. Only block clicks while the
      // overlay itself is opening, visible, or closing.
      if (!viewerInstance.showing && !viewerInstance.isShown && !viewerInstance.hiding) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    containerEl.addEventListener('click', guardDuplicateImageClick, true)
    containerEl._mdrViewerClickGuard = guardDuplicateImageClick

    containerEl._mdrViewer = viewerInstance
  } catch (err) {
    console.warn('[LuminaChrome] Setup Viewer.js failed:', err)
  }
}

// Remove workspace records written by older releases. Document contents,
// handles, directory trees, and expansion state are intentionally not cached.
function clearLegacyWorkspaceDatabase() {
  return new Promise(resolve => {
    if (!globalThis.indexedDB) return resolve()
    const request = indexedDB.deleteDatabase(legacyExtensionDB)
    request.onsuccess = request.onerror = request.onblocked = () => resolve()
  })
}

function activeDoc() { return docs.find(doc => doc.id === activeId) || null }

function toast(message, {placement = 'default'} = {}) {
  ui.toast.textContent = message
  ui.toast.classList.toggle('toast-export', placement === 'export')
  ui.toast.classList.add('visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => ui.toast.classList.remove('visible'), 2600)
}

const directoryNoticeIcons = {
  add: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="7"/><path d="M8 5v6M5 8h6"/></svg>',
  delete: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M5.5 4.5V3A1.5 1.5 0 0 1 7 1.5h2A1.5 1.5 0 0 1 10.5 3v1.5M6.5 7.5v5M9.5 7.5v5M4.5 4.5l.8 9.2A1.5 1.5 0 0 0 6.8 15h2.4a1.5 1.5 0 0 0 1.5-1.3l.8-9.2"/></svg>',
  rename: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3-9 9H1.5v-3zM9 4l3 3M1.5 14.5h13"/></svg>',
  modify: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9L2 14"/><path d="M2 9.5V14h4.5"/></svg>',
  batch: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 6 3.5-6 3.5-6-3.5L8 2zM2 9l6 3.5L14 9M2 12.5 8 16l6-3.5"/></svg>',
}

function hideDirectoryChangeNotice(immediate = false) {
  const notice = ui.directoryChangeNotice
  if (!notice) return
  clearTimeout(directoryChangeNoticeTimer)
  directoryChangeNoticeTimer = 0
  if (immediate) {
    notice.hidden = true
    notice.classList.remove('is-hiding', 'is-add', 'is-delete', 'is-rename', 'is-modify', 'is-batch')
    notice.replaceChildren()
    return
  }
  if (notice.hidden || notice.classList.contains('is-hiding')) return
  notice.classList.add('is-hiding')
  directoryChangeNoticeTimer = setTimeout(() => hideDirectoryChangeNotice(true), 200)
}

function showDirectoryChangeNotice({typeKey = 'modify', changeType = '目录变更', fileName = '', detail = '', addedCount = 0, deletedCount = 0} = {}) {
  const notice = ui.directoryChangeNotice
  if (!notice) return
  clearTimeout(directoryChangeNoticeTimer)
  directoryChangeNoticeTimer = 0
  const type = ['add', 'delete', 'rename', 'modify', 'batch'].includes(typeKey) ? typeKey : 'modify'
  notice.classList.remove('is-visible', 'is-hiding', 'is-add', 'is-delete', 'is-rename', 'is-modify', 'is-batch')
  notice.classList.add(`is-${type}`)
  const badges = type === 'batch' ? `<div class="mdr-directory-change-notice__badges">${addedCount ? `<span class="mdr-change-pill is-add">+${addedCount} 新增</span>` : ''}${deletedCount ? `<span class="mdr-change-pill is-delete">-${deletedCount} 删除</span>` : ''}</div>` : ''
  notice.innerHTML = `
    <div class="mdr-directory-change-notice__indicator"></div>
    <div class="mdr-directory-change-notice__header">
      <div class="mdr-directory-change-notice__type-badge"><span class="mdr-directory-change-notice__icon">${directoryNoticeIcons[type]}</span><span class="mdr-directory-change-notice__type">${escapeHtml(changeType)}</span></div>
      <button type="button" class="mdr-directory-change-notice__close" title="关闭提示" aria-label="关闭提示"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m3 3 10 10M13 3 3 13"/></svg></button>
    </div>
    <div class="mdr-directory-change-notice__body"><div class="mdr-directory-change-notice__file" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>${badges}</div>
    ${detail ? `<div class="mdr-directory-change-notice__detail">${escapeHtml(detail)}</div>` : ''}
  `
  notice.hidden = false
  notice.querySelector('.mdr-directory-change-notice__close')?.addEventListener('click', event => {
    event.stopPropagation()
    hideDirectoryChangeNotice()
  }, {once: true})
  notice.onmouseenter = () => {
    clearTimeout(directoryChangeNoticeTimer)
    directoryChangeNoticeTimer = 0
  }
  notice.onmouseleave = () => {
    if (!notice.hidden && !notice.classList.contains('is-hiding')) directoryChangeNoticeTimer = setTimeout(() => hideDirectoryChangeNotice(), 3000)
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => notice.classList.add('is-visible'))
  })
  directoryChangeNoticeTimer = setTimeout(() => hideDirectoryChangeNotice(), 7000)
}

const exportTasks = []
let exportTaskTimer = null
let activeExportCount = 0
let exportPreviewWasHidden = true
const exportImageLoadingRefs = new WeakMap()

function acquireExportImages(images) {
  for (const image of images) {
    let state = exportImageLoadingRefs.get(image)
    if (!state) {
      state = {count: 0, loading: image.getAttribute('loading')}
      exportImageLoadingRefs.set(image, state)
    }
    state.count++
    image.loading = 'eager'
  }
}

function releaseExportImages(images) {
  for (const image of images) {
    const state = exportImageLoadingRefs.get(image)
    if (!state) continue
    state.count--
    if (state.count > 0) continue
    if (state.loading === null) image.removeAttribute('loading')
    else image.setAttribute('loading', state.loading)
    exportImageLoadingRefs.delete(image)
  }
}

async function prepareExportImageData(images, doc) {
  const entries = await Promise.all(images.map(async image => {
    const url = image.currentSrc || image.src
    if (!/^https?:|^file:/i.test(url)) return null
    const retries = Math.max(0, Math.min(10, Number(preferences.imageExportRetries) || 0))
    const timeoutMs = Math.max(1, Math.min(120, Number(preferences.imageExportTimeoutSeconds) || 30)) * 1000
    let lastError = ''
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const message = {
          type: 'lumina:read-export-image',
          url,
          documentURL: doc?.sourceURL || '',
          timeoutMs,
        }
        console.info('[LuminaChrome][image-export] 页面请求 background 下载图片', {url, documentURL: doc?.sourceURL || '', attempt: attempt + 1, retries, timeoutMs})
        const result = await sendRuntimeMessageWithTimeout(message, timeoutMs + 5000, '图片下载')
        console.info('[LuminaChrome][image-export] 页面收到 background 结果', {url, attempt: attempt + 1, ok: result?.ok, error: result?.error, dataURLLength: result?.dataURL?.length || 0})
        if (result?.ok && result.dataURL) return [image, {dataURL: result.dataURL}]
        lastError = result?.error || '图片下载失败'
      } catch (error) {
        lastError = String(error?.message || error)
      }
      if (attempt < retries) {
        console.warn(`[LuminaChrome][image-export] 图片下载失败，准备重试 (${attempt + 1}/${retries}):`, url, lastError)
        await new Promise(resolve => setTimeout(resolve, Math.min(1500, 300 * (attempt + 1))))
      }
    }
    console.warn('导出时无法下载图片，已替换为失败占位图:', url, lastError)
    return [image, {dataURL: createExportImageFailureDataURL(image)}]
  }))
  return new Map(entries.filter(Boolean))
}

function createExportImageFailureDataURL(image) {
  const width = Math.max(240, Math.round(image.naturalWidth || image.width || Number(image.getAttribute('width')) || 640))
  const height = Math.max(120, Math.round(image.naturalHeight || Number(image.getAttribute('height')) || width * 0.56))
  const labelSize = Math.max(18, Math.min(32, Math.round(width / 18)))
  const secondarySize = Math.max(12, Math.round(labelSize * 0.58))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f3f4f6"/><rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" fill="none" stroke="#cbd5e1" stroke-width="2"/><path d="M${width / 2} ${height * 0.24}v${height * 0.25}m0 ${height * 0.1}v2" stroke="#64748b" stroke-width="5" stroke-linecap="round"/><text x="50%" y="${height * 0.76}" text-anchor="middle" fill="#334155" font-family="sans-serif" font-size="${labelSize}">图片下载失败</text><text x="50%" y="${height * 0.88}" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="${secondarySize}">请检查网络或图片访问权限</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function cloneForExport(element, imageData) {
  const clone = element.cloneNode(true)
  clone.querySelectorAll('[data-export-ignore]').forEach(node => node.remove())
  if (clone.matches('[data-export-ignore]')) return clone.ownerDocument.createElement('div')
  const headings = [clone, ...clone.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .filter(node => /^H[1-6]$/.test(node.tagName))
  for (const heading of headings) {
    heading.style.position = 'static'
    heading.style.top = 'auto'
    heading.style.zIndex = 'auto'
    heading.style.backgroundColor = 'transparent'
  }
  const sourceImages = [element, ...element.querySelectorAll('img')].filter(node => node.tagName === 'IMG')
  const clonedImages = [clone, ...clone.querySelectorAll('img')].filter(node => node.tagName === 'IMG')
  sourceImages.forEach((image, index) => {
    const imageExport = imageData.get(image)
    if (imageExport && clonedImages[index]) {
      clonedImages[index].removeAttribute('srcset')
      clonedImages[index].src = imageExport.dataURL
    }
  })
  return clone
}

function getDocumentExportTarget(doc, contentRoot) {
  if (!doc?.sourceView) return contentRoot
  // Source-view exports contain only the Markdown code block, never its UI toolbar.
  return contentRoot?.querySelector('.mdr-source-view__code') || null
}

function formatExportDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function renderExportTasks() {
  const finishedCount = exportTasks.filter(task => task.status !== 'exporting').length
  const activeCount = exportTasks.length - finishedCount
  const countLabel = exportTasks.length ? `共 ${exportTasks.length} 项` : '还没有导出任务'
  ui.taskPanelCount.textContent = countLabel
  ui.taskCount.textContent = String(activeCount || exportTasks.length)
  ui.taskCount.hidden = exportTasks.length === 0
  ui.taskClear.disabled = finishedCount === 0
  ui.taskList.replaceChildren()
  if (!exportTasks.length) {
    const empty = document.createElement('div')
    empty.className = 'task-empty'
    empty.innerHTML = '<span class="task-empty-icon">⇧</span><strong>还没有导出任务</strong><span>导出 PDF 或 PNG 后，可在这里查看进度和结果</span>'
    ui.taskList.append(empty)
  } else {
    for (const task of [...exportTasks].reverse()) {
      const card = document.createElement('article')
      card.className = `task-card is-${task.status}`
      card.dataset.taskId = task.id
      const isPDF = task.type === 'PDF'
      const statusText = task.status === 'exporting' ? (task.cancelRequested ? '正在取消…' : `正在导出 ${task.type}…`) : task.status === 'completed' ? '导出成功' : task.status === 'cancelled' ? '已取消' : '导出失败'
      const elapsed = task.completedAt || Date.now()
      const duration = formatExportDuration(elapsed - task.createdAt)
      const safeError = task.error ? escapeHtml(task.error) : ''
      card.innerHTML = `
        <header class="task-card-heading">
          <span class="task-icon ${isPDF ? 'is-pdf' : 'is-image'}" aria-hidden="true">${isPDF ? 'PDF' : 'PNG'}</span>
          <span class="task-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span>
          ${task.status === 'exporting' ? `<button class="task-cancel-button" data-cancel-task="${task.id}" type="button" ${task.cancelRequested ? 'disabled' : ''}>${task.cancelRequested ? '取消中…' : '取消'}</button>` : `<button class="task-remove" data-remove-task="${task.id}" aria-label="移除任务" title="移除任务">×</button>`}
        </header>
        <div class="task-status is-${task.status}">${task.status === 'exporting' ? '<span class="task-spinner"></span>' : ''}<span>${statusText}</span><span class="task-duration">耗时 ${duration}</span></div>
        ${task.status === 'exporting' ? `<div class="task-progress-copy"><span>${escapeHtml(task.progressText || '准备中…')}</span><span>${Math.round((task.progress || 0) * 100)}%</span></div><div class="task-progress-track"><span style="width:${Math.max(0, Math.min(100, (task.progress || 0) * 100))}%"></span></div>${task.detail ? `<div class="task-detail">${escapeHtml(task.detail)}</div>` : ''}` : task.detail ? `<div class="task-detail">${escapeHtml(task.detail)}</div>` : ''}
        ${safeError ? `<p class="task-error">${safeError}</p>` : ''}
      `
      ui.taskList.append(card)
    }
  }
  if (activeCount && !exportTaskTimer) {
    exportTaskTimer = setInterval(() => {
      const now = Date.now()
      ui.taskList.querySelectorAll('.task-card.is-exporting').forEach(card => {
        const task = exportTasks.find(item => item.id === card.dataset.taskId)
        const duration = card.querySelector('.task-duration')
        if (task && duration) duration.textContent = `耗时 ${formatExportDuration(now - task.createdAt)}`
      })
    }, 1000)
  } else if (!activeCount && exportTaskTimer) {
    clearInterval(exportTaskTimer)
    exportTaskTimer = null
  }
}

function startExportTask(type, doc) {
  if (activeExportCount === 0) {
    exportPreviewWasHidden = ui.preview.hidden
    ui.preview.hidden = false
  }
  activeExportCount++
  const task = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    title: doc.title,
    status: 'exporting',
    createdAt: Date.now(),
    progress: 0,
    progressText: '准备导出…',
    detail: '',
  }
  exportTasks.push(task)
  setPanel('tasks')
  renderExportTasks()
  toast('导出已开始，可在左侧任务列表查看进度', {placement: 'export'})
  return task
}

function updateExportTask(task, updates) {
  if (!task || task.status !== 'exporting') return
  Object.assign(task, updates)
  renderExportTasks()
}

function assertExportNotCancelled(task) {
  if (task?.cancelRequested) throw new DOMException('导出已取消', 'AbortError')
}

function finishExportTask(task, status, error = '') {
  if (!task || task.status !== 'exporting') return
  task.status = status
  task.completedAt = Date.now()
  task.error = error
  if (status === 'completed') {
    task.progress = 1
    task.progressText = '导出完成'
  }
  activeExportCount = Math.max(0, activeExportCount - 1)
  if (activeExportCount === 0) ui.preview.hidden = exportPreviewWasHidden
  renderExportTasks()
}

function applyPreferences() {
  const theme = preferences.theme === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preferences.theme
  const isDark = theme === 'dark'

  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.mdrTheme = theme
  document.documentElement.dataset.mdrActualTheme = theme
  document.documentElement.dataset.mdrCodeBlockTheme = theme
  document.documentElement.setAttribute('theme-mode', theme)
  document.documentElement.classList.toggle('dark', isDark)

  document.documentElement.style.setProperty('--content-width', `${preferences.width}%`)
  document.body.classList.toggle('code-wrap', preferences.codeWrap)
  // Settings live in the host page, while rendered Markdown lives in one
  // iframe per open tab. Push every preference update to all existing frames,
  // including inactive tabs, rather than only the currently visible frame.
  for (const frame of documentFrames.values()) applyDocumentFramePreferences(frame)
}

function applyDocumentFramePreferences(frame) {
  const frameDocument = frame?.contentDocument
  if (!frameDocument) return
  const theme = document.documentElement.dataset.theme || 'light'
  frameDocument.documentElement.dataset.theme = theme
  frameDocument.documentElement.dataset.mdrTheme = theme
  frameDocument.documentElement.dataset.mdrActualTheme = theme
  frameDocument.documentElement.dataset.mdrCodeBlockTheme = theme
  frameDocument.documentElement.classList.toggle('dark', theme === 'dark')
  frameDocument.documentElement.style.setProperty('--content-width', `${preferences.width}%`)
  frameDocument.body.classList.toggle('code-wrap', preferences.codeWrap)
  frameDocument.querySelector('#mdr-reading-progress-badge')?.classList.toggle('is-preference-hidden', !preferences.showReadingProgressBadge)
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (preferences.theme === 'system') {
    applyPreferences()
    void renderActive()
  }
})

function safeName(value) { return String(value || 'Markdown 文档').replace(/[\\/:*?"<>|]/g, '_') }

async function downloadOriginalMarkdown(doc) {
  if (doc.loaded === false) {
    const loaded = doc.loadPromise ? await doc.loadPromise : await loadDocumentOnDemand(doc)
    if (!loaded || doc.loaded === false) throw new Error(doc.loadError || '原始内容尚未加载完成')
  }
  if (typeof doc.source !== 'string') throw new Error('原始内容不可用')

  let filename = doc.title || 'Markdown 文档'
  try {
    const pathFilename = new URL(doc.sourceURL).pathname.split('/').pop()
    if (pathFilename) filename = decodeURIComponent(pathFilename)
  } catch {}
  filename = safeName(filename)
  if (!/\.(?:md|markdown|mdown|mkd|mdx|mdc|txt)$/i.test(filename)) filename += '.md'

  const blobURL = URL.createObjectURL(new Blob([doc.source], {type: 'text/markdown;charset=utf-8'}))
  const anchor = document.createElement('a')
  anchor.href = blobURL
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(blobURL), 60_000)
  toast(`正在下载 ${filename}`)
}

function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function collectExportOutput(type, sessionId, response, mimeType) {
  if (!Number.isSafeInteger(response.size) || response.size < 1) throw new Error('导出文件大小无效')
  const chunks = []
  const chunkSize = 4 * 1024 * 1024
  for (let offset = 0; offset < response.size; offset += chunkSize) {
    const part = await chrome.runtime.sendMessage({
      type,
      action: 'read-output',
      payload: {sessionId, offset, length: Math.min(chunkSize, response.size - offset)},
    })
    if (!part?.ok || !part.base64) throw new Error(part?.error || '导出文件读取失败')
    chunks.push(base64ToBytes(part.base64))
  }
  const closed = await chrome.runtime.sendMessage({type, action: 'close', payload: {sessionId}})
  if (!closed?.ok) throw new Error(closed?.error || '导出后台清理失败')
  return {...response, blob: new Blob(chunks, {type: mimeType})}
}

function waitForBrowserPaint() {
  // Two animation frames let the loading state reach the screen before work
  // such as decoding a large local file starts.
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

async function readFileAsText(file) {
  if (!file.stream) return file.text()
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  let source = ''
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      source += decoder.decode(value, {stream: true})
    }
    return source + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function requestPDFWorker(action, sessionId, payload = {}) {
  const type = 'lumina:pdf-worker'
  const response = await chrome.runtime.sendMessage({type, action, payload: {...payload, sessionId}})
  if (!response?.ok) throw new Error(response?.error || 'PDF 后台处理失败')
  return action === 'finish' ? collectExportOutput(type, sessionId, response, 'application/pdf') : response
}

function createImageExportWorker() {
  const sessionId = crypto.randomUUID()
  let ended = false
  return {
    async request(action, payload = {}) {
      const requestPayload = {...payload, sessionId}
      if (requestPayload.blob) {
        const bytes = new Uint8Array(await requestPayload.blob.arrayBuffer())
        const filename = requestPayload.filename
        delete requestPayload.blob
        delete requestPayload.filename
        let response = await chrome.runtime.sendMessage({type: 'lumina:image-worker', action: 'add-page-start', payload: {...requestPayload, filename}})
        if (!response?.ok) throw new Error(response?.error || 'PNG 分片传输失败')
        const chunkSize = 4 * 1024 * 1024
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          response = await chrome.runtime.sendMessage({
            type: 'lumina:image-worker',
            action: 'add-page-chunk',
            payload: {...requestPayload, base64: bytesToBase64(bytes.subarray(offset, offset + chunkSize))},
          })
          if (!response?.ok) throw new Error(response?.error || 'PNG 分片传输失败')
        }
        response = await chrome.runtime.sendMessage({type: 'lumina:image-worker', action: 'add-page-end', payload: requestPayload})
        if (!response?.ok) throw new Error(response?.error || 'PNG 分片传输失败')
        return response
      }
      const response = await chrome.runtime.sendMessage({type: 'lumina:image-worker', action, payload: requestPayload})
      if (!response?.ok) throw new Error(response?.error || '图片导出后台处理失败')
      if (action === 'finish') {
        const output = await collectExportOutput('lumina:image-worker', sessionId, response, 'application/zip')
        ended = true
        return output
      }
      if (action === 'cancel' || action === 'close') ended = true
      return response
    },
    cancel() {
      if (ended) return
      ended = true
      void chrome.runtime.sendMessage({type: 'lumina:image-worker', action: 'cancel', payload: {sessionId}}).catch(() => {})
    },
  }
}

function updateControls() {
  const doc = activeDoc()
  const hasDoc = Boolean(doc)
  const canExport = hasDoc && !doc.loading && doc.loaded !== false
  const now = Date.now()
  $('#export-print').disabled = !canExport || Number($('#export-print').dataset.cooldownUntil || 0) > now
  $('#export-png').disabled = !canExport || Number($('#export-png').dataset.cooldownUntil || 0) > now
  if (ui.outlineExportBtn) {
    const hasOutline = Boolean(ui.outlineTree?.querySelector('.mdr-outline-item'))
    ui.outlineExportBtn.disabled = !hasOutline
    ui.outlineExportBtn.hidden = !hasOutline
  }
}

function startExportButtonCooldown(button, disableDuringCooldown = true) {
  const now = Date.now()
  const cooldownUntil = Number(button.dataset.cooldownUntil || 0)
  if (cooldownUntil > now) return false
  button.dataset.cooldownUntil = String(now + 2000)
  if (disableDuringCooldown) button.disabled = true
  window.setTimeout(() => {
    if (Number(button.dataset.cooldownUntil || 0) <= Date.now()) updateControls()
  }, 2000)
  return true
}

function closeDocumentFrameOverlays(frame) {
  const frameDocument = frame?.contentDocument
  if (!frameDocument) return
  const viewer = frameDocument.querySelector('#mdr-content-root')?._mdrViewer
  if (viewer?.isShown || viewer?.showing) viewer.hide()
  frameDocument.querySelectorAll('.mdr-mermaid-block.mdr-mermaid-expanded')
    .forEach(block => block._mdrSetFullscreen?.(false))
  exitDocumentFrameFullscreen(frame)
  frameDocument.documentElement.classList.remove('mdr-viewer-showing')
}

function persistState() {
  // Workspace documents remain in memory only; browser history stores paths,
  // never Markdown source, directory handles, or rendered content.
}

function normalizedDocumentPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function findOpenDocumentByAbsolutePath(absolutePath) {
  const expected = normalizedDocumentPath(absolutePath)
  if (!expected) return null

  // Prefer the encoded absolute path already attached to each tab element.
  for (const tab of ui.tabs.querySelectorAll('.doc-tab[data-absolute-path]')) {
    let tabPath = ''
    try { tabPath = decodeURIComponent(tab.dataset.absolutePath || '') } catch {}
    if (normalizedDocumentPath(tabPath) !== expected) continue
    const match = docs.find(doc => doc.id === tab.dataset.documentId)
    if (match && !match.sourceView) return match
  }

  return docs.find(doc => !doc.sourceView && normalizedDocumentPath(
    doc.absolutePath || fileURLToSystemPath(doc.sourceURL)
  ) === expected) || null
}

function findOpenDocument(candidate) {
  if (candidate.sourceView) {
    const sourceURLKey = documentSourceURLKey(candidate.sourceURL)
    return docs.find(doc => doc.sourceView && (
      (sourceURLKey && documentSourceURLKey(doc.sourceURL) === sourceURLKey)
      || (!sourceURLKey && doc.sourceOfDocumentId === candidate.sourceOfDocumentId)
    )) || null
  }

  const absolutePath = candidate.absolutePath || fileURLToSystemPath(candidate.sourceURL)
  const byAbsolutePath = findOpenDocumentByAbsolutePath(absolutePath)
  if (byAbsolutePath) return byAbsolutePath

  const sourceURLKey = documentSourceURLKey(candidate.sourceURL)
  if (sourceURLKey) {
    const bySourceURL = docs.find(doc => !doc.sourceView && documentSourceURLKey(doc.sourceURL) === sourceURLKey)
    if (bySourceURL) return bySourceURL
  }

  const relativePath = String(candidate.relativePath || '').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
  if (candidate.root && relativePath) {
    const byDirectoryPath = docs.find(doc => doc.root === candidate.root &&
      String(doc.relativePath || '').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '') === relativePath)
    if (byDirectoryPath) return byDirectoryPath
  }

  return candidate.handle ? docs.find(doc => doc.handle === candidate.handle) || null : null
}

function setDocument(doc, {persist = true, syncHistory = true} = {}) {
  doc = findOpenDocument(doc) || doc
  const wasOpen = docs.some(item => item.id === doc.id)
  const wasActive = activeId === doc.id
  if (activeId && activeId !== doc.id) {
    const previous = activeDoc()
    if (previous) {
      hideAutoScrollPanel(previous)
      stopAutoScroll(previous.id)
        const previousFrame = documentFrames.get(previous.id)
      captureDocumentReadingProgress(previous)
        captureDocumentScrollTop(previous)
      closeDocumentFrameOverlays(previousFrame)
    }
  }
  if (!docs.some(item => item.id === doc.id)) docs.push(doc)
  activeId = doc.id
  if (!wasOpen) setPanel('outline')
  const needsLoad = doc.loaded === false
  scheduleActiveDocumentScan()
  ui.preview.hidden = false
  documentFrames.forEach((frame, id) => setDocumentFrameActive(frame, id === doc.id))
  const frame = documentFrames.get(doc.id)
  // Switching tabs should only reveal the already-rendered iframe. Content
  // refresh paths explicitly invalidate this marker before rendering.
  if (needsLoad) {
    doc.loading = true
  } else if (!frame || frame._mdrRenderedSource == null) {
    void renderActive()
  } else {
    applyDocumentFramePreferences(frame)
    ui.empty.hidden = true
    ui.preview.hidden = false
    renderOutline()
    updateOutlineScrollSpy()
    updateControls()
  }
  renderTabs()
  syncDocumentReadingProgress(doc)
  updateFolderActive()
  if (persist) persistState()
  if (syncHistory) writeTabStateToURL(wasOpen && wasActive ? 'replace' : 'push')
  if (needsLoad) void loadDocumentOnDemand(doc)
}

// ==========================================================================
// 多文档标签栏与右键上下文菜单 (Context Menu)
// ==========================================================================
let tabContextMenu = null
function dismissContextMenus(event) {
  const target = event?.target
  if (event?.type === 'pointerdown' && !target?.closest?.('.topbar-actions-dropdown')) {
    Dropdown.getInstance(document.getElementById('top-actions-toggle'))?.hide()
  }
  if (target && (tabContextMenu?.contains(target) || folderContextMenu?.contains(target))) return
  hideTabContextMenu()
  hideFolderContextMenu()
}

// Capture before tree-row click handlers call stopPropagation().
document.addEventListener('pointerdown', dismissContextMenus, true)
document.addEventListener('click', dismissContextMenus, true)

function getOrCreateTabContextMenu() {
  if (tabContextMenu) return tabContextMenu
  tabContextMenu = document.createElement('div')
  tabContextMenu.className = 'mdr-context-menu'
  tabContextMenu.style.display = 'none'

  const icon = paths => `<svg class="mdr-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
  tabContextMenu.innerHTML = `
    <div class="mdr-context-menu-item" data-action="reload">${icon('<path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/>')}<span>重新加载</span></div>
    <div class="mdr-context-menu-item" data-action="open-new-page">${icon('<path d="M13 5h6v6M19 5l-9 9"/><path d="M19 14v5H5V5h5"/>')}<span>新页面打开</span></div>
    <div class="mdr-context-menu-separator" data-separator="source"></div>
    <div class="mdr-context-menu-item" data-action="view-source">${icon('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>')}<span>查看源码</span></div>
    <div class="mdr-context-menu-item" data-action="download-source">${icon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>')}<span>下载原始内容</span></div>
    <div class="mdr-context-menu-separator"></div>
    <div class="mdr-context-menu-item" data-action="export-pdf">${icon('<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>')}<span>导出 PDF</span></div>
    <div class="mdr-context-menu-item" data-action="export-png">${icon('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>')}<span>导出 PNG</span></div>
    <div class="mdr-context-menu-separator"></div>
    <div class="mdr-context-menu-item" data-action="copy-title">${icon('<path d="M5 5h14M12 5v14M8 19h8"/>')}<span>复制标题</span></div>
    <div class="mdr-context-menu-item" data-action="copy-path">${icon('<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M8 20h10a2 2 0 0 0 2-2V8"/>')}<span>复制路径</span></div>
    <div class="mdr-context-menu-item" data-action="show-in-folder">${icon('<path d="M3 6h6l2 2h10v10H3z"/><path d="M3 6V4h6l2 2"/>')}<span>在目录中显示</span></div>
    <div class="mdr-context-menu-separator"></div>
    <div class="mdr-context-menu-item" data-action="close-current">${icon('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>')}<span>关闭当前</span></div>
    <div class="mdr-context-menu-item" data-action="close-left">${icon('<path d="M5 4v16M19 7l-5 5 5 5M14 12H9"/>')}<span>关闭左侧</span></div>
    <div class="mdr-context-menu-item" data-action="close-right">${icon('<path d="M19 4v16M5 7l5 5-5 5m5-5h5"/>')}<span>关闭右侧</span></div>
    <div class="mdr-context-menu-item" data-action="close-other">${icon('<rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 5V3h12a2 2 0 0 1 2 2v12h-4M8 10l4 4m0-4-4 4"/>')}<span>关闭其它</span></div>
    <div class="mdr-context-menu-item" data-action="close-all">${icon('<rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 5V3h12a2 2 0 0 1 2 2v12h-4M8 10l4 4m0-4-4 4"/>')}<span>关闭所有</span></div>
  `

  tabContextMenu.addEventListener('click', event => {
    const item = event.target.closest('[data-action]')
    if (!item || item.classList.contains('is-disabled')) return
    event.stopPropagation()
    const action = item.dataset.action
    const targetId = tabContextMenu.dataset.tabId
    const targetIndex = docs.findIndex(d => d.id === targetId)

    if (action === 'reload') {
      const doc = docs.find(d => d.id === targetId)
      if (doc) void reloadDocumentContent(doc)
        .then(() => toast('已重新加载'))
        .catch(error => toast(`重新加载失败: ${error.message || error}`))
    } else if (action === 'open-new-page') {
      const doc = docs.find(d => d.id === targetId)
      const url = doc?.sourceURL ? cleanExtensionURL(doc.sourceURL) : ''
      if (url) void chrome.runtime.sendMessage({type: 'lumina:open-link', url})
        .then(result => { if (!result?.ok) throw new Error(result?.error || '打开失败') })
        .catch(error => toast(`新页面打开失败：${error.message || error}`))
    } else if (action === 'export-pdf' || action === 'export-png') {
      const doc = docs.find(d => d.id === targetId)
      if (doc && startContextExportCooldown(item)) {
        if (action === 'export-pdf') void exportPDF(doc)
        else void exportPNG(doc)
      }
    } else if (action === 'copy-title') {
      const doc = docs.find(d => d.id === targetId)
      if (doc) {
        void copyTextToClipboard(doc.title).then(() => toast('已复制标题')).catch(error => toast(`复制失败：${error.message || error}`))
      }
    } else if (action === 'view-source') {
      const doc = docs.find(d => d.id === targetId)
      hideTabContextMenu()
      if (doc && !doc.sourceView) {
        void openDocumentSourceView(doc).catch(error => toast(`打开源码失败：${error.message || error}`))
      }
      return
    } else if (action === 'download-source') {
      const doc = docs.find(d => d.id === targetId)
      hideTabContextMenu()
      if (doc) void downloadOriginalMarkdown(doc).catch(error => toast(`下载原始内容失败：${error.message || error}`))
      return
    } else if (action === 'copy-path') {
      const doc = docs.find(d => d.id === targetId)
      if (doc) {
        if (/^https?:/i.test(doc.sourceURL || '')) {
          void copyTextToClipboard(cleanExtensionURL(doc.sourceURL))
            .then(() => toast('已复制完整 URL'))
            .catch(error => toast(`复制失败：${error.message || error}`))
        } else {
          const tab = [...ui.tabs.querySelectorAll('.doc-tab')]
            .find(element => element.dataset.documentId === targetId)
          let absolutePath = ''
          try { absolutePath = decodeURIComponent(tab?.dataset.absolutePath || '') } catch {}
          if (!absolutePath) {
            toast('无法确认文件的绝对路径：请从该文件所在目录的 file:// 页面打开')
          } else {
            void copyTextToClipboard(absolutePath).then(() => toast('已复制绝对路径')).catch(error => toast(`复制失败：${error.message || error}`))
          }
        }
      }
    } else if (action === 'show-in-folder') {
      const doc = docs.find(d => d.id === targetId)
      if (doc) showDocumentInFolder(doc)
    } else if (action === 'close-current') {
      const targetDoc = docs.find(d => d.id === targetId)
      if (targetDoc && !isAddressBarDocument(targetDoc)) closeDocument(targetId)
    } else if (action === 'close-left' && targetIndex > 0) {
      const toRemove = docs.slice(0, targetIndex).filter(d => !isAddressBarDocument(d)).map(d => d.id)
      toRemove.forEach(id => closeDocument(id))
    } else if (action === 'close-right' && targetIndex >= 0) {
      const toRemove = docs.slice(targetIndex + 1).filter(d => !isAddressBarDocument(d)).map(d => d.id)
      toRemove.forEach(id => closeDocument(id))
    } else if (action === 'close-other' && targetIndex >= 0) {
      const toRemove = docs.filter(d => d.id !== targetId && !isAddressBarDocument(d)).map(d => d.id)
      toRemove.forEach(id => closeDocument(id))
    } else if (action === 'close-all') {
      const toRemove = docs.filter(d => !isAddressBarDocument(d)).map(d => d.id)
      toRemove.forEach(id => closeDocument(id))
    }
    hideTabContextMenu()
  })

  document.body.appendChild(tabContextMenu)
  window.addEventListener('scroll', hideTabContextMenu, {passive: true})
  return tabContextMenu
}

function hideTabContextMenu() {
  if (tabContextMenu) tabContextMenu.style.display = 'none'
}

async function openDocumentSourceView(doc) {
  const sourceURLKey = documentSourceURLKey(doc.sourceURL)
  const existing = docs.find(item => item.sourceView && (
    (sourceURLKey && documentSourceURLKey(item.sourceURL) === sourceURLKey)
    || (!sourceURLKey && item.sourceOfDocumentId === doc.id)
  ))
  if (existing) {
    setDocument(existing)
    return existing
  }

  if (doc.reloadPromise) await doc.reloadPromise
  else if (doc.loadPromise) await doc.loadPromise
  else if (doc.loaded === false) await loadDocumentOnDemand(doc)
  else if (doc.loading) {
    const deadline = Date.now() + 25_000
    while (doc.loading && Date.now() < deadline && docs.some(item => item.id === doc.id)) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  if (!docs.some(item => item.id === doc.id)) throw new Error('原文档标签已关闭')
  if (doc.loaded === false || doc.loading || doc.loadError || typeof doc.source !== 'string') {
    throw new Error(doc.loadError || '原始内容尚未加载完成')
  }

  const sourceView = {
    id: crypto.randomUUID(),
    title: doc.title,
    source: doc.source,
    sourceURL: doc.sourceURL,
    sourceView: true,
    sourceOfDocumentId: doc.id,
    handle: doc.handle,
    root: doc.root,
    relativePath: doc.relativePath,
    absolutePath: doc.absolutePath,
    objectURLs: [],
  }
  setDocument(sourceView)
  // Persist the source-view tab explicitly after it has been inserted. The
  // source tab shares its document URL with the rendered tab, so its distinct
  // lumina-source path must be present as a separate address-bar entry.
  console.info('[LuminaChrome][tab-state] 已打开源码标签，立即保存标签列表', {
    title: sourceView.title,
    sourceURL: sourceView.sourceURL,
    tabPath: documentTabPath(sourceView),
    openTabCount: docs.length,
  })
  writeTabStateToURL('replace')
  return sourceView
}

function startContextExportCooldown(item) {
  const cooldownUntil = Number(item.dataset.cooldownUntil || 0)
  if (cooldownUntil > Date.now()) return false
  item.dataset.cooldownUntil = String(Date.now() + 2000)
  item.classList.add('is-disabled')
  window.setTimeout(() => {
    if (Number(item.dataset.cooldownUntil || 0) <= Date.now()) item.classList.remove('is-disabled')
  }, 2000)
  return true
}

// ==========================================================================
// 目录树右键上下文菜单 (Folder & File Context Menu - 100% 对齐 Lumina App)
// ==========================================================================
let folderContextMenu = null
let folderContextMenuTarget = null

function getOrCreateFolderContextMenu() {
  if (folderContextMenu) return folderContextMenu
  folderContextMenu = document.createElement('div')
  folderContextMenu.id = 'mdr-folder-context-menu'
  folderContextMenu.className = 'mdr-context-menu'
  folderContextMenu.style.display = 'none'

  const icon = paths => `<svg class="mdr-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
  folderContextMenu.innerHTML = `
    <div class="mdr-context-menu-item" data-action="open-file">${icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>')}<span>打开文件</span></div>
    <div class="mdr-context-menu-item" data-action="toggle-folder">${icon('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>')}<span>展开/折叠</span></div>
    <div class="mdr-context-menu-separator"></div>
    <div class="mdr-context-menu-item" data-action="copy-name">${icon('<path d="M4 5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M14 3v6h6"/><path d="M8 15h8M8 18h5"/>')}<span>复制名称</span></div>
    <div class="mdr-context-menu-item" data-action="copy-path">${icon('<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M8 20h10a2 2 0 0 0 2-2V8"/><path d="m8 12 2-2 2 2"/>')}<span>复制路径</span></div>
    <div class="mdr-context-menu-separator" data-separator="remove"></div>
    <div class="mdr-context-menu-item remove-action" data-action="remove">${icon('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>')}<span>移除目录</span></div>
  `

  folderContextMenu.addEventListener('click', async event => {
    const item = event.target.closest('[data-action]')
    if (!item || item.classList.contains('is-disabled') || !folderContextMenuTarget) return
    event.stopPropagation()
    const action = item.dataset.action
    const target = folderContextMenuTarget
    hideFolderContextMenu()

    if (action === 'open-file') {
      if (target.kind === 'file') {
        try {
          if (target.handle) {
            await readFileHandle(target.handle, {root: target.rootHandle || rootHandle, relativePath: target.path})
          } else {
            await openLocalTreeFile(target)
          }
          updateFolderActive()
        } catch (error) {
          toast(error.message || '读取文件失败')
        }
      }
    } else if (action === 'toggle-folder') {
      if (target.element) {
        target.element.click()
      }
    } else if (action === 'copy-name') {
      const name = target.name || ''
      if (name) {
        void copyTextToClipboard(name).then(() => toast('已复制名称')).catch(e => toast(`复制失败：${e.message || e}`))
      }
    } else if (action === 'copy-path') {
      const path = getTreeItemPath(target)
      if (path) {
        void copyTextToClipboard(path).then(() => toast('已复制路径')).catch(e => toast(`复制失败：${e.message || e}`))
      }
    } else if (action === 'remove') {
      removeDirectoryRoot(target.rootRef)
      renderFiles()
      toast('已移除打开的目录')
    }
  })

  document.body.appendChild(folderContextMenu)
  window.addEventListener('scroll', hideFolderContextMenu, {passive: true})
  return folderContextMenu
}

function hideFolderContextMenu() {
  if (folderContextMenu) {
    folderContextMenu.style.display = 'none'
    folderContextMenuTarget = null
  }
}

function showFolderContextMenu(event, target) {
  event.preventDefault()
  event.stopPropagation()
  hideTabContextMenu()
  const menu = getOrCreateFolderContextMenu()
  folderContextMenuTarget = target

  const isFile = target.kind === 'file'
  const isRoot = target.kind === 'root'
  const isDir = target.kind === 'directory'

  const openFileBtn = menu.querySelector('[data-action="open-file"]')
  const toggleFolderBtn = menu.querySelector('[data-action="toggle-folder"]')
  const removeBtn = menu.querySelector('[data-action="remove"]')
  const removeSep = menu.querySelector('[data-separator="remove"]')

  if (openFileBtn) openFileBtn.style.display = isFile ? 'flex' : 'none'
  if (toggleFolderBtn) toggleFolderBtn.style.display = (isDir || isRoot) ? 'flex' : 'none'
  if (removeBtn) removeBtn.style.display = isRoot ? 'flex' : 'none'
  if (removeSep) removeSep.style.display = isRoot ? 'block' : 'none'

  menu.style.display = 'block'
  const rect = menu.getBoundingClientRect()
  const posX = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))
  const posY = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))
  menu.style.left = `${posX}px`
  menu.style.top = `${posY}px`
}

async function getDocumentAbsolutePath(doc) {
  // FileSystemHandle intentionally exposes only the selected handle and paths
  // relative to its granted directory. Resolve one only when a file:// URL can
  // be matched to the granted root and the file contents confirm the match.
  const directPath = fileURLToSystemPath(doc.sourceURL)
  if (directPath) return directPath
  if (!doc?.root?.name || !doc.relativePath || !doc.handle) return ''

  let baseURL
  try {
    const currentURL = new URL(location.href)
    if (currentURL.protocol !== 'file:') return ''
    const segments = currentURL.pathname.split('/').filter(Boolean)
    // file:// page pathname ends with the Markdown filename, so the granted
    // directory must be compared with its parent segment.
    const currentDirectoryName = decodeURIComponent(segments.at(-2) || '')
    if (currentDirectoryName !== doc.root.name) return ''
    baseURL = new URL('.', currentURL)
  } catch {
    return ''
  }

  const encodedRelativePath = doc.relativePath.split('/').map(encodeURIComponent).join('/')
  const candidateURL = new URL(encodedRelativePath, baseURL)
  const candidatePath = fileURLToSystemPath(candidateURL.href)
  if (!candidatePath) return ''

  try {
    const [handleFile, result] = await Promise.all([
      doc.handle.getFile(),
      chrome.runtime.sendMessage({type: 'lumina:read-local-markdown', fileURL: candidateURL.href}),
    ])
    if (result?.ok && result.source === await handleFile.text()) return candidatePath
  } catch {}
  return ''
}

function fileURLToSystemPath(value) {
  if (!value) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return ''
    const path = decodeURIComponent(url.pathname)
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path
  } catch {
    return ''
  }
}

function getTreeItemPath(target) {
  const storedPath = target.element?.dataset.absolutePath
  if (storedPath) {
    try { return decodeURIComponent(storedPath) } catch { return storedPath }
  }
  const filePath = fileURLToSystemPath(target.url)
  if (filePath) return filePath
  if (target.kind === 'root' && target.path) return fileURLToSystemPath(target.path) || target.path
  if (rootHandle?.name && target.path) return `${rootHandle.name}/${target.path}`
  return target.path || target.name || ''
}

async function copyTextToClipboard(value) {
  const text = String(value ?? '')
  if (!text) throw new Error('没有可复制的内容')

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {}
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('浏览器未能访问剪贴板')
}

function showTabContextMenu(event, doc, index, total) {
  event.preventDefault()
  event.stopPropagation()
  const menu = getOrCreateTabContextMenu()
  menu.dataset.tabId = doc.id
  const sourceAction = menu.querySelector('[data-action="view-source"]')
  const sourceSeparator = menu.querySelector('[data-separator="source"]')
  const downloadAction = menu.querySelector('[data-action="download-source"]')
  const showInFolderAction = menu.querySelector('[data-action="show-in-folder"]')
  const isRemoteDocument = /^https?:\/\//i.test(doc.sourceURL || '')
  if (sourceAction) sourceAction.hidden = Boolean(doc.sourceView)
  if (sourceSeparator) sourceSeparator.hidden = Boolean(doc.sourceView)
  if (downloadAction) downloadAction.hidden = !/^https?:\/\//i.test(doc.sourceURL || '')
  if (showInFolderAction) showInFolderAction.hidden = isRemoteDocument
  const canClose = documents => documents.some(item => !isAddressBarDocument(item))
  const setActionDisabled = (action, disabled) => {
    const item = menu.querySelector(`[data-action="${action}"]`)
    item?.classList.toggle('is-disabled', disabled)
    item?.setAttribute('aria-disabled', String(disabled))
  }
  const canOpenInNewPage = /^(?:https?:|file:)/i.test(doc.sourceURL || '')
  setActionDisabled('open-new-page', !canOpenInNewPage)
  menu.querySelector('[data-action="open-new-page"]').title = canOpenInNewPage ? '' : '当前文件没有可直接打开的地址'
  setActionDisabled('close-current', isAddressBarDocument(doc))
  setActionDisabled('close-left', !canClose(docs.slice(0, index)))
  setActionDisabled('close-right', !canClose(docs.slice(index + 1)))
  setActionDisabled('close-other', !canClose(docs.filter(item => item.id !== doc.id)))
  setActionDisabled('close-all', !canClose(docs))

  menu.style.display = 'block'
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`
}

function setTabAbsolutePath(tab, absolutePath) {
  if (!absolutePath) {
    delete tab.dataset.absolutePath
    return
  }
  tab.dataset.absolutePath = encodeURIComponent(absolutePath)
}

function getDocumentTabPath(doc) {
  const filePath = doc.absolutePath || fileURLToSystemPath(doc.sourceURL)
  if (filePath) return filePath
  if (doc.sourceURL && /^https?:\/\//i.test(doc.sourceURL)) return doc.sourceURL
  if (doc.root?.name && doc.relativePath) return `${doc.root.name}/${doc.relativePath}`
  return doc.sourceURL || ''
}

async function reloadDocumentContent(doc) {
  if (doc.reloadPromise) return doc.reloadPromise
  doc.loading = true
  doc.loaded = false
  doc.loadError = ''
  renderTabs()
  updateControls()

  const reload = (async () => {
    if (doc.id === activeId) {
      await renderActive()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }

    let source
    if (doc.handle) {
      const file = await doc.handle.getFile()
      source = await file.text()
      doc.lastModified = file.lastModified
    } else if (doc.sourceURL && localFileURLKey(doc.sourceURL)) {
      const result = await chrome.runtime.sendMessage({
        type: 'lumina:read-local-markdown',
        fileURL: localFileURLKey(doc.sourceURL),
      })
      if (!result?.ok) throw new Error(result?.error || '无法读取本地 Markdown 文件')
      source = result.source
    } else if (doc.sourceURL && cleanRemoteMarkdownURL(doc.sourceURL)) {
      const result = await chrome.runtime.sendMessage({
        type: 'lumina:read-remote-markdown',
        url: cleanRemoteMarkdownURL(doc.sourceURL),
      })
      if (!result?.ok) throw new Error(result?.error || '无法重新读取远程 Markdown 页面')
      source = result.source
    } else {
      throw new Error('该文档没有可重新读取的文件路径')
    }

    doc.source = source
    doc.loaded = true
    doc.loading = false
    doc.loadError = ''
    const frame = documentFrames.get(doc.id)
    if (frame) frame._mdrRenderedSource = null
    renderTabs()
    if (doc.id === activeId) await renderActive()
    updateControls()
    return doc
  })().catch(async error => {
    doc.loading = false
    doc.loaded = false
    doc.loadError = error?.message || String(error)
    renderTabs()
    if (doc.id === activeId) await renderActive()
    updateControls()
    throw error
  }).finally(() => {
    doc.reloadPromise = null
  })
  doc.reloadPromise = reload
  return reload
}

function disposeTabTooltip(tab) {
  const tooltip = Tooltip.getInstance(tab)
  if (!tooltip) return

  // Bootstrap clears the instance fields during dispose(), but a CSS transition
  // callback may still run afterward. Hide first and dispose from its terminal
  // event so the callback can finish while the instance is still intact.
  if (tab.hasAttribute('aria-describedby')) {
    tab.addEventListener('hidden.bs.tooltip', () => tooltip.dispose(), {once: true})
    tooltip.hide()
    return
  }

  tooltip.dispose()
}

function renderTabs() {
  const tabCount = document.getElementById('document-tab-count')
  if (tabCount) {
    const previousCount = tabCount.dataset.count
    const currentCount = String(docs.length)
    const label = `共 ${docs.length} 个文档`
    tabCount.textContent = currentCount
    tabCount.dataset.count = currentCount
    tabCount.setAttribute('aria-label', label)
    tabCount.title = label
    if (previousCount !== undefined && previousCount !== currentCount) {
      tabCount.classList.remove('is-bumped')
      void tabCount.offsetWidth
      tabCount.classList.add('is-bumped')
    }
  }
  const existingTabs = new Map([...ui.tabs.querySelectorAll('.doc-tab')]
    .map(tab => [tab.dataset.documentId, tab]))
  const documentIds = new Set(docs.map(doc => doc.id))
  for (const [id, tab] of existingTabs) {
    if (documentIds.has(id)) continue
    disposeTabTooltip(tab)
    tab.remove()
    existingTabs.delete(id)
  }

  docs.forEach((doc, index) => {
    const frame = documentFrames.get(doc.id) || createDocumentFrame(doc)
    setDocumentFrameActive(frame, doc.id === activeId)
    let tab = existingTabs.get(doc.id)
    if (!tab) {
      tab = createDocumentTab(doc)
      existingTabs.set(doc.id, tab)
    }
    tab.classList.toggle('active', doc.id === activeId)
    tab.classList.toggle('is-loading', Boolean(doc.loading))
    tab.setAttribute('aria-busy', doc.loading ? 'true' : 'false')
    tab.querySelector('.title').textContent = doc.title
    const closeButton = tab.querySelector('.close')
    closeButton.setAttribute('aria-label', `关闭 ${doc.title}`)
    closeButton.hidden = isAddressBarDocument(doc)
    setTabAbsolutePath(tab, getDocumentTabPath(doc))
    if (!doc.absolutePath && !fileURLToSystemPath(doc.sourceURL) && doc.root && doc.relativePath && doc.handle && !doc.absolutePathResolving) {
      doc.absolutePathResolving = true
      void getDocumentAbsolutePath(doc).then(absolutePath => {
        if (!absolutePath) return
        doc.absolutePath = absolutePath
        const currentTab = [...ui.tabs.querySelectorAll('.doc-tab')]
          .find(element => element.dataset.documentId === doc.id)
        if (currentTab) setTabAbsolutePath(currentTab, absolutePath)
      }).catch(() => {}).finally(() => { doc.absolutePathResolving = false })
    }
    if (ui.tabs.children[index] !== tab) {
      ui.tabs.insertBefore(tab, ui.tabs.children[index] || null)
    }
    syncTabReadingProgress(doc)
  })

  const activeTab = ui.tabs.querySelector('.doc-tab.active')
  if (activeTab) {
    requestAnimationFrame(() => {
      if (activeTab.isConnected) activeTab.scrollIntoView({behavior: 'instant', block: 'nearest', inline: 'nearest'})
    })
  }
}

function createDocumentTab(doc) {
  const tab = document.createElement('button')
  tab.className = 'doc-tab'
  tab.draggable = true
  tab.dataset.documentId = doc.id
  const progressFill = document.createElement('span')
  progressFill.className = 'doc-tab-reading-progress'
  progressFill.setAttribute('aria-hidden', 'true')
  const iconTemplate = document.createElement('template')
  iconTemplate.innerHTML = (doc.sourceView ? SVG_SOURCE_FILE_ICON : SVG_FILE_ICON).trim()
  const fileIcon = iconTemplate.content.firstElementChild
  fileIcon?.classList.add(doc.sourceView ? 'doc-tab-source-file-icon' : 'doc-tab-file-icon')
  fileIcon?.setAttribute('aria-hidden', 'true')
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = doc.title
  const close = document.createElement('span')
  close.className = 'close'
  close.textContent = '×'
  close.setAttribute('role', 'button')
  close.setAttribute('aria-label', `关闭 ${doc.title}`)
  close.addEventListener('click', event => {
    event.stopPropagation()
    if (!isAddressBarDocument(doc)) closeDocument(doc.id)
  })
  tab.append(progressFill, fileIcon, title, close)
  Tooltip.getOrCreateInstance(tab, {
    title() {
      try { return decodeURIComponent(tab.dataset.absolutePath || '') } catch { return '' }
    },
    placement: 'top',
    trigger: 'hover',
    delay: {show: 3000, hide: 0},
    container: 'body',
    boundary: 'viewport',
    customClass: 'mdr-path-tooltip',
  })
  tab.addEventListener('click', event => {
    if (suppressTabClick) {
      event.preventDefault()
      return
    }
    const targetDoc = docs.find(item => item.id === tab.dataset.documentId)
    if (targetDoc) setDocument(targetDoc)
  })
  tab.addEventListener('contextmenu', event => {
    const tabIndex = docs.findIndex(item => item.id === tab.dataset.documentId)
    const targetDoc = docs[tabIndex]
    if (targetDoc) showTabContextMenu(event, targetDoc, tabIndex, docs.length)
  })
  tab.addEventListener('dragstart', event => {
    draggedTabId = tab.dataset.documentId
    suppressTabClick = true
    tab.classList.add('dragging')
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', draggedTabId)
  })
  tab.addEventListener('dragover', event => {
    if (!draggedTabId || draggedTabId === tab.dataset.documentId) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    tab.classList.add('drag-over')
  })
  tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'))
  tab.addEventListener('drop', event => {
    event.preventDefault()
    event.stopPropagation()
    tab.classList.remove('drag-over')
    const targetId = tab.dataset.documentId
    const movingId = draggedTabId || event.dataTransfer.getData('text/plain')
    const from = docs.findIndex(item => item.id === movingId)
    const target = docs.findIndex(item => item.id === targetId)
    if (from < 0 || target < 0 || from === target) return
    const rect = tab.getBoundingClientRect()
    let insertionIndex = target + (event.clientX > rect.left + rect.width / 2 ? 1 : 0)
    const [moving] = docs.splice(from, 1)
    if (from < insertionIndex) insertionIndex--
    docs.splice(insertionIndex, 0, moving)
    renderTabs()
    writeTabStateToURL('replace')
    persistState()
  })
  tab.addEventListener('dragend', () => {
    draggedTabId = null
    ui.tabs.querySelectorAll('.doc-tab').forEach(item => item.classList.remove('dragging', 'drag-over'))
    setTimeout(() => { suppressTabClick = false }, 0)
  })
  return tab
}

function setDocumentFrameActive(frame, active) {
  frame.classList.toggle('is-inactive', !active)
  frame.inert = !active
  if (active) frame.removeAttribute('aria-hidden')
  else frame.setAttribute('aria-hidden', 'true')
}

function closeDocument(id) {
  const index = docs.findIndex(doc => doc.id === id)
  if (index < 0) return
  if (runningAutoScrollDocumentId === id) stopAutoScroll(id)
  autoScrollOverrides.delete(id)
  if (activeId === id) captureDocumentScrollTop(docs[index])
  const [removed] = docs.splice(index, 1)
  documentFrames.get(id)?.remove()
  documentFrames.delete(id)
  for (const url of removed.objectURLs || []) URL.revokeObjectURL(url)
  if (activeId === id) {
    activeId = docs[Math.min(index, docs.length - 1)]?.id || null
    if (activeId) {
      setDocument(activeDoc(), {syncHistory: false})
    } else {
      ui.preview.hidden = true
      ui.empty.hidden = false
    }
  }
  renderTabs()
  renderOutline()
  updateFolderActive()
  persistState()
  updateControls()
  writeTabStateToURL('push')
}

function createDocumentFrame(doc) {
  const frame = document.createElement('iframe')
  frame.className = 'mdr-document-frame is-inactive'
  frame.inert = true
  frame.setAttribute('aria-hidden', 'true')
  frame.title = `${doc.title} - Markdown 渲染`
  frame.dataset.documentId = doc.id
  const extensionURL = path => chrome.runtime.getURL(path)
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${extensionURL('katex.min.css')}"><link rel="stylesheet" href="${extensionURL('styles.css')}"><style>html{height:100%;overflow:auto!important}body{height:auto!important;min-height:100%;overflow:visible!important;display:block!important;background:var(--bg-body)}.mdr-content{padding:16px 48px 140px}</style></head><body><div id="mdr-content-root" class="mdr-content"></div>
    <div class="mdr-reading-progress-track" id="mdr-reading-progress-track" title="点击跳转至相应查阅进度"><div class="mdr-reading-progress-bar" id="mdr-reading-progress-bar"></div></div>
    <button class="mdr-reading-progress-badge is-pristine" id="mdr-reading-progress-badge" type="button" title="开始查阅文档 (0%)" aria-label="文档查阅进度 0%">
      <span class="mdr-reading-progress-icon-wrap"><svg class="mdr-reading-progress-ring" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" aria-hidden="true"><circle class="mdr-reading-progress-ring-bg" cx="8" cy="8" r="5.5" stroke-width="1.8"/><circle class="mdr-reading-progress-ring-fg" id="mdr-reading-progress-ring-fg" cx="8" cy="8" r="5.5" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="34.56" stroke-dashoffset="34.56" transform="rotate(-90 8 8)"/><polyline class="mdr-reading-progress-ring-check" id="mdr-reading-progress-ring-check" points="5.2 8.2 7.2 10.2 10.8 5.8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="mdr-reading-progress-text" id="mdr-reading-progress-text">0%</span>
    </button>
    <button class="mdr-auto-scroll-control is-hidden" id="mdr-auto-scroll-control" type="button" aria-label="自动滚动阅读" title="自动滚动阅读"><svg class="mdr-auto-scroll-control-icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="2.5" width="15" height="19" rx="2.5"/><path d="M8 7h8M8 10h8M9 14l3 3 3-3"/></svg></button>
    <button class="mdr-scroll-jump mdr-scroll-jump--top" id="mdr-back-to-top" type="button" aria-label="回到顶部" title="回到顶部">↑</button>
    <button class="mdr-scroll-jump mdr-scroll-jump--bottom" id="mdr-go-to-bottom" type="button" aria-label="去到底部" title="去到底部">↓</button>
    <div class="mdr-auto-scroll-backdrop" id="mdr-auto-scroll-backdrop" hidden></div>
    <section class="mdr-auto-scroll-panel" id="mdr-auto-scroll-panel" role="dialog" aria-label="自动滚动阅读设置" hidden>
      <header class="mdr-auto-scroll-panel__header">
        <span class="mdr-auto-scroll-panel__brand" aria-hidden="true">✦</span>
        <strong>自动滚动阅读</strong>
        <span class="mdr-auto-scroll-status"><i></i><span data-auto-status>已暂停</span></span>
        <button type="button" class="mdr-auto-scroll-close" data-auto-action="dismiss" aria-label="关闭" title="关闭">×</button>
      </header>
      <div class="mdr-auto-scroll-presets" role="group" aria-label="速度预设">
        <button type="button" data-auto-preset data-interval="40" data-amount="1">◴ 精读</button>
        <button type="button" data-auto-preset data-interval="25" data-amount="1">▤ 适中</button>
        <button type="button" data-auto-preset data-interval="12" data-amount="2">ϟ 速览</button>
      </div>
      <div class="mdr-auto-scroll-controls-card">
        <div class="mdr-auto-scroll-speed"><span>当前速度：约 <strong data-auto-speed>50</strong> 像素/秒</span><span class="mdr-auto-scroll-speed-tag" data-auto-speed-label>舒适匀速</span></div>
        <div class="mdr-auto-scroll-field"><label>◷ <span>时间间隔</span></label><div class="mdr-auto-scroll-stepper"><button type="button" data-auto-step="interval" data-step="-5" aria-label="减少时间间隔">−</button><input type="number" min="1" max="15000" step="1" data-auto-input="interval" aria-label="时间间隔"><button type="button" data-auto-step="interval" data-step="5" aria-label="增加时间间隔">+</button><small>毫秒</small></div></div>
        <div class="mdr-auto-scroll-field"><label>↕ <span>滚动幅度</span></label><div class="mdr-auto-scroll-stepper"><button type="button" data-auto-step="amount" data-step="-1" aria-label="减少滚动幅度">−</button><input type="number" min="1" max="800" step="1" data-auto-input="amount" aria-label="滚动幅度"><button type="button" data-auto-step="amount" data-step="1" aria-label="增加滚动幅度">+</button><small>点</small></div></div>
      </div>
      <footer class="mdr-auto-scroll-actions">
        <button type="button" class="mdr-auto-scroll-primary" data-auto-action="start">▶ <span>开始阅读</span></button>
        <button type="button" data-auto-action="top">↥ <span>回顶</span></button>
        <button type="button" data-auto-action="reset" disabled>↶ <span>默认</span></button>
      </footer>
      <div class="mdr-auto-scroll-footnote" data-auto-footnote>当前为全局默认配置，修改后仅在此文档生效。</div>
    </section>
    <script src="${extensionURL('viewer.min.js')}"></script></body></html>`
  ui.preview.append(frame)
  const ready = new Promise(resolve => frame.addEventListener('load', () => resolve(frame.contentDocument), {once: true}))
  frame._mdrReady = ready
  documentFrames.set(doc.id, frame)
  return frame
}

function normalizedAutoScrollConfiguration(configuration = {}) {
  return {
    interval: Math.round(Math.max(1, Math.min(15000, Number(configuration.interval) || preferences.autoScrollInterval || 20))),
    amount: Math.round(Math.max(1, Math.min(800, Number(configuration.amount) || preferences.autoScrollAmount || 1))),
  }
}

function getAutoScrollConfiguration(doc) {
  return normalizedAutoScrollConfiguration(autoScrollOverrides.get(doc.id) || {
    interval: preferences.autoScrollInterval,
    amount: preferences.autoScrollAmount,
  })
}

function updateAutoScrollPanel(doc) {
  const frameDocument = documentFrames.get(doc?.id)?.contentDocument
  const panel = frameDocument?.querySelector('#mdr-auto-scroll-panel')
  if (!panel) return
  const configuration = getAutoScrollConfiguration(doc)
  const speed = (1000 / configuration.interval) * configuration.amount
  const speedLabel = speed < 30 ? '细致精读' : (speed <= 75 ? '舒适匀速' : '快速速览')
  const isRunning = runningAutoScrollDocumentId === doc.id
  const hasTemporaryConfiguration = autoScrollOverrides.has(doc.id)
  panel.querySelector('[data-auto-input="interval"]').value = String(configuration.interval)
  panel.querySelector('[data-auto-input="amount"]').value = String(configuration.amount)
  panel.querySelector('[data-auto-speed]').textContent = String(Math.round(speed))
  panel.querySelector('[data-auto-speed-label]').textContent = speedLabel
  panel.querySelector('[data-auto-status]').textContent = isRunning ? '正在阅读' : '已暂停'
  panel.querySelector('.mdr-auto-scroll-status')?.classList.toggle('is-running', isRunning)
  const actionButton = panel.querySelector('[data-auto-action="start"]')
  actionButton.classList.toggle('is-running', isRunning)
  actionButton.innerHTML = isRunning ? 'Ⅱ <span>暂停阅读</span>' : '▶ <span>开始阅读</span>'
  panel.querySelector('[data-auto-action="reset"]').disabled = !hasTemporaryConfiguration
  panel.querySelector('[data-auto-footnote]').textContent = hasTemporaryConfiguration
    ? '当前为本篇文档临时设置，关闭标签页后自动失效。'
    : '当前为全局默认配置，修改后仅在此文档生效。'
  panel.querySelectorAll('[data-auto-preset]').forEach(button => {
    const selected = Number(button.dataset.interval) === configuration.interval && Number(button.dataset.amount) === configuration.amount
    button.classList.toggle('is-selected', selected)
  })
  const control = frameDocument.querySelector('#mdr-auto-scroll-control')
  if (control) {
    control.classList.toggle('is-running', isRunning)
    control.title = isRunning ? '自动阅读进行中' : '自动滚动阅读'
    control.setAttribute('aria-label', control.title)
  }
}

function setAutoScrollConfiguration(doc, configuration) {
  if (!doc) return
  autoScrollOverrides.set(doc.id, normalizedAutoScrollConfiguration(configuration))
  updateAutoScrollPanel(doc)
  if (runningAutoScrollDocumentId === doc.id) startAutoScroll(doc, false)
}

function resetAutoScrollConfiguration(doc) {
  if (!doc) return
  autoScrollOverrides.delete(doc.id)
  updateAutoScrollPanel(doc)
  if (runningAutoScrollDocumentId === doc.id) startAutoScroll(doc, false)
}

function hideAutoScrollPanel(doc) {
  const frameDocument = documentFrames.get(doc?.id)?.contentDocument
  if (!frameDocument) return
  const panel = frameDocument.querySelector('#mdr-auto-scroll-panel')
  const backdrop = frameDocument.querySelector('#mdr-auto-scroll-backdrop')
  if (panel) panel.hidden = true
  if (backdrop) backdrop.hidden = true
  frameDocument.documentElement.classList.remove('mdr-auto-scroll-active')
  frameDocument.body.classList.remove('mdr-auto-scroll-active')
}

function toggleAutoScrollPanel(doc) {
  const frameDocument = documentFrames.get(doc?.id)?.contentDocument
  if (!frameDocument || activeId !== doc.id) return
  const panel = frameDocument.querySelector('#mdr-auto-scroll-panel')
  const backdrop = frameDocument.querySelector('#mdr-auto-scroll-backdrop')
  if (!panel || !backdrop) return
  if (!panel.hidden) {
    hideAutoScrollPanel(doc)
    return
  }
  updateAutoScrollPanel(doc)
  panel.hidden = false
  backdrop.hidden = false
  frameDocument.documentElement.classList.add('mdr-auto-scroll-active')
  frameDocument.body.classList.add('mdr-auto-scroll-active')
}

function stopAutoScroll(docId = runningAutoScrollDocumentId) {
  if (!runningAutoScrollDocumentId || (docId && docId !== runningAutoScrollDocumentId)) return
  const previousId = runningAutoScrollDocumentId
  clearInterval(autoScrollTimer)
  autoScrollTimer = 0
  runningAutoScrollDocumentId = null
  const previousDoc = docs.find(doc => doc.id === previousId)
  if (previousDoc) updateAutoScrollPanel(previousDoc)
}

function startAutoScroll(doc, dismissPanel = true) {
  if (!doc || activeId !== doc.id) return
  stopAutoScroll()
  const frame = documentFrames.get(doc.id)
  const frameWindow = frame?.contentWindow
  const frameDocument = frame?.contentDocument
  if (!frameWindow || !frameDocument) return
  const configuration = getAutoScrollConfiguration(doc)
  runningAutoScrollDocumentId = doc.id
  autoScrollTimer = window.setInterval(() => {
    if (activeId !== doc.id || runningAutoScrollDocumentId !== doc.id) {
      stopAutoScroll(doc.id)
      return
    }
    const maxTop = Math.max(0, frameDocument.documentElement.scrollHeight - frameWindow.innerHeight)
    const nextTop = Math.min(maxTop, frameWindow.scrollY + configuration.amount)
    frameWindow.scrollTo(0, nextTop)
    if (nextTop >= maxTop) stopAutoScroll(doc.id)
  }, configuration.interval)
  if (dismissPanel) hideAutoScrollPanel(doc)
  updateAutoScrollPanel(doc)
}

function syncAutoScrollPanels() {
  for (const doc of docs) updateAutoScrollPanel(doc)
}

async function getDocumentFrame(doc) {
  const frame = documentFrames.get(doc.id) || createDocumentFrame(doc)
  const frameDocument = await frame._mdrReady
  const frameWindow = frame.contentWindow
  if (!frame.dataset.mdrEventsBound) {
    frameDocument.addEventListener('dragenter', event => {
      if (!isExternalFileDrag(event)) return
      event.preventDefault()
      showExternalDropOverlay()
    })
    frameDocument.addEventListener('dragstart', markInternalDragStart, true)
    frameDocument.addEventListener('dragend', clearInternalDragStart, true)
    frameDocument.addEventListener('dragover', event => {
      if (!isExternalFileDrag(event)) return
      event.preventDefault()
      showExternalDropOverlay()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    })
    frameDocument.addEventListener('dragleave', event => {
      if (!isExternalFileDrag(event) || event.relatedTarget) return
      hideExternalDropOverlay()
    })
    frameDocument.addEventListener('drop', event => {
      if (!isExternalFileDrag(event)) return
      event.preventDefault()
      event.stopPropagation()
      hideExternalDropOverlay()
      void processExternalDrop(event)
    })
    frameDocument.addEventListener('pointerdown', dismissContextMenus, true)
    frameDocument.addEventListener('click', dismissContextMenus, true)
    frameDocument.addEventListener('click', event => { void handlePreviewClick(event, doc) })
    frame.contentWindow.addEventListener('scroll', () => {
      captureDocumentScrollTop(doc)
      scheduleTabStateURLWrite()
      captureDocumentReadingProgress(doc)
      syncDocumentJumpButtons(doc)
      syncDocumentReadingProgress(doc)
      if (scrollSpyTicking) return
      scrollSpyTicking = true
      requestAnimationFrame(() => {
        updateOutlineScrollSpy()
        scrollSpyTicking = false
      })
    }, {passive: true})
    frameDocument.addEventListener('keydown', event => {
      handleGlobalSearchShortcut(event)
      if (event.code === 'Space' && !event.target.closest?.('input, textarea, select, button, [contenteditable="true"]') && runningAutoScrollDocumentId === doc.id) {
        event.preventDefault()
        stopAutoScroll(doc.id)
      }
      if (event.key === 'Escape') {
        frameDocument.querySelectorAll('.mdr-mermaid-block.mdr-mermaid-expanded').forEach(block => block._mdrSetFullscreen?.(false))
        hideAutoScrollPanel(doc)
      }
    })
    frameDocument.querySelector('#mdr-back-to-top')?.addEventListener('click', () => {
      frame.contentWindow.scrollTo({top: 0, behavior: 'instant'})
    })
    frameDocument.querySelector('#mdr-go-to-bottom')?.addEventListener('click', () => {
      const maxScroll = Math.max(0, frameDocument.documentElement.scrollHeight - frameWindow.innerHeight)
      frameWindow.scrollTo({top: maxScroll, behavior: 'instant'})
    })
    const progressTrack = frameDocument.querySelector('#mdr-reading-progress-track')
    progressTrack?.addEventListener('click', event => {
      event.stopPropagation()
      const rect = progressTrack.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      const maxScroll = frameDocument.documentElement.scrollHeight - frameWindow.innerHeight
      if (maxScroll > 0) frameWindow.scrollTo({top: ratio * maxScroll, behavior: 'instant'})
    })
    progressTrack?.addEventListener('mousemove', event => {
      const rect = progressTrack.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      progressTrack.title = `跳转至 ${Math.round(ratio * 100)}%`
    })
    frameDocument.querySelector('#mdr-reading-progress-badge')?.addEventListener('click', event => {
      event.stopPropagation()
      const maxScroll = frameDocument.documentElement.scrollHeight - frameWindow.innerHeight
      if (maxScroll <= 0) return
      frameWindow.scrollTo({top: frameWindow.scrollY > maxScroll * 0.4 ? 0 : maxScroll, behavior: 'instant'})
    })
    frameDocument.querySelector('#mdr-auto-scroll-control')?.addEventListener('click', () => toggleAutoScrollPanel(doc))
    frameDocument.querySelector('#mdr-auto-scroll-backdrop')?.addEventListener('click', () => hideAutoScrollPanel(doc))
    frameDocument.querySelector('#mdr-auto-scroll-panel')?.addEventListener('click', event => {
      const button = event.target.closest('button')
      if (!button) return
      const action = button.dataset.autoAction
      if (action === 'dismiss') hideAutoScrollPanel(doc)
      else if (action === 'start') {
        if (runningAutoScrollDocumentId === doc.id) stopAutoScroll(doc.id)
        else startAutoScroll(doc)
      } else if (action === 'top') {
        frame.contentWindow.scrollTo({top: 0, behavior: 'instant'})
      } else if (action === 'reset') {
        resetAutoScrollConfiguration(doc)
      } else if (button.hasAttribute('data-auto-preset')) {
        setAutoScrollConfiguration(doc, {interval: button.dataset.interval, amount: button.dataset.amount})
      } else if (button.hasAttribute('data-auto-step')) {
        const configuration = getAutoScrollConfiguration(doc)
        configuration[button.dataset.autoStep] += Number(button.dataset.step)
        setAutoScrollConfiguration(doc, configuration)
      }
    })
    frameDocument.querySelectorAll('[data-auto-input]').forEach(input => {
      input.addEventListener('change', () => {
        const configuration = getAutoScrollConfiguration(doc)
        configuration[input.dataset.autoInput] = input.value
        setAutoScrollConfiguration(doc, configuration)
      })
    })
    frame.dataset.mdrEventsBound = 'true'
  }
  if (!frame._mdrJumpResizeObserver && frameWindow.ResizeObserver) {
    const contentRoot = frameDocument.querySelector('#mdr-content-root')
    if (contentRoot) {
      frame._mdrJumpResizeObserver = new frameWindow.ResizeObserver(() => {
        syncDocumentJumpButtons(doc)
        syncDocumentReadingProgress(doc)
      })
      frame._mdrJumpResizeObserver.observe(contentRoot)
    }
  }
  initTableResize(frameDocument.body)
  applyDocumentFramePreferences(frame)
  return {frame, frameDocument, root: frameDocument.querySelector('#mdr-content-root')}
}

function syncDocumentReadingProgress(doc) {
  const frame = documentFrames.get(doc?.id)
  const frameDocument = frame?.contentDocument
  const frameWindow = frame?.contentWindow
  if (!frameDocument || !frameWindow || frame._mdrProgressFrame) return
  if (frame.classList.contains('is-inactive')) {
    syncTabReadingProgress(doc)
    return
  }
  // Schedule from the host page: Chrome may throttle requestAnimationFrame in
  // an iframe parked far off-screen while another tab is active.
  frame._mdrProgressFrame = window.requestAnimationFrame(() => {
    frame._mdrProgressFrame = 0
    if (frame.classList.contains('is-inactive')) {
      syncTabReadingProgress(doc)
      return
    }
    const progressTrack = frameDocument.querySelector('#mdr-reading-progress-track')
    const progressBar = frameDocument.querySelector('#mdr-reading-progress-bar')
    const progressBadge = frameDocument.querySelector('#mdr-reading-progress-badge')
    const progressText = frameDocument.querySelector('#mdr-reading-progress-text')
    const ringForeground = frameDocument.querySelector('#mdr-reading-progress-ring-fg')
    if (!progressBadge) return

    const percent = captureDocumentReadingProgress(doc)
    syncTabReadingProgress(doc, percent)
    const hue = Math.round(212 - (percent / 100) * 70)
    if (progressBar) {
      progressBar.style.width = `${percent}%`
      progressBar.style.setProperty('--progress-hue', hue)
    }
    progressTrack?.style.setProperty('--progress-hue', hue)
    progressText.textContent = `${percent}%`
    progressBadge.setAttribute('aria-label', `文档查阅进度 ${percent}%`)
    if (ringForeground) ringForeground.style.strokeDashoffset = String(Math.max(0, Math.min(34.56, 34.56 * (1 - percent / 100))))
    progressBadge.style.setProperty('--progress-hue', hue)
    const isPristine = percent === 0
    const isDone = percent >= 100
    progressBadge.classList.toggle('is-pristine', isPristine)
    progressBadge.classList.toggle('is-completed', isDone)
    progressBadge.title = isDone
      ? '文档已查阅完毕 (100%)，点击返回顶部'
      : (isPristine ? '开始查阅文档 (0%)' : `当前查阅进度：${percent}% (点击切换位置)`)
  })
}

function syncTabReadingProgress(doc, knownPercent) {
  if (!doc?.id) return
  const frame = documentFrames.get(doc.id)
  let percent = knownPercent
  if (percent === undefined) percent = captureDocumentReadingProgress(doc)
  const tab = [...ui.tabs.querySelectorAll('.doc-tab')].find(element => element.dataset.documentId === doc.id)
  const fill = tab?.querySelector('.doc-tab-reading-progress')
  if (!fill) return
  fill.style.width = `${percent}%`
}

function captureDocumentReadingProgress(doc) {
  const frame = documentFrames.get(doc?.id)
  if (!frame) return 0
  if (frame.classList.contains('is-inactive')) return frame._mdrReadingPercent ?? 0
  const frameDocument = frame.contentDocument
  const frameWindow = frame.contentWindow
  if (!frame._mdrRenderedSource || !frameDocument || !frameWindow) return frame._mdrReadingPercent ?? 0
  const scrollingElement = frameDocument.scrollingElement || frameDocument.documentElement
  const documentHeight = Math.max(
    scrollingElement.scrollHeight,
    frameDocument.documentElement.scrollHeight,
    frameDocument.body?.scrollHeight || 0,
  )
  const viewportHeight = frameWindow.innerHeight || frameDocument.documentElement.clientHeight
  const maxScroll = documentHeight - viewportHeight
  const scrollTop = Math.max(
    0,
    frameWindow.scrollY || 0,
    scrollingElement.scrollTop || 0,
    frameDocument.documentElement.scrollTop || 0,
    frameDocument.body?.scrollTop || 0,
  )
  const percent = maxScroll <= 0
    ? 100
    : Math.min(100, Math.max(0, Math.round((scrollTop / maxScroll) * 100)))
  frame._mdrReadingPercent = percent
  return percent
}

function syncDocumentJumpButtons(doc) {
  const frame = documentFrames.get(doc?.id)
  const frameDocument = frame?.contentDocument
  const frameWindow = frame?.contentWindow
  if (!frameDocument || !frameWindow) return
  const isActive = activeId === doc.id
  const scrollY = frameWindow.scrollY || 0
  const remaining = frameDocument.documentElement.scrollHeight - frameWindow.innerHeight - scrollY
  frameDocument.querySelector('#mdr-back-to-top')?.classList.toggle('is-visible', isActive && scrollY > 360)
  frameDocument.querySelector('#mdr-go-to-bottom')?.classList.toggle('is-visible', isActive && remaining > 80)
  frameDocument.querySelector('#mdr-auto-scroll-control')?.classList.toggle('is-hidden', !isActive)
  frameDocument.querySelector('#mdr-auto-scroll-control')?.classList.toggle('is-visible', isActive)
}

// ==========================================================================
// 大纲解析与树状时间轴节点渲染 (完全对齐图 1 原生 App 视觉)
// ==========================================================================
function parseHeadings(source) {
  let headingIndex = 0
  const tokens = markdown.parse(source, {})
  return tokens.flatMap((token, index) => {
    if (token.type !== 'heading_open') return []
    const inline = tokens[index + 1]
    return [{
      level: Number(token.tag.slice(1)),
      title: getInlineMarkdownText(inline),
      line: (token.map?.[0] ?? index) + 1,
      headingIndex: headingIndex++
    }]
  })
}

function renderOutline() {
  const doc = activeDoc()
  const treeContainer = ui.outlineTree || ui.outline
  treeContainer.replaceChildren()
  if (!doc) {
    const empty = document.createElement('div')
    empty.className = 'tree-empty mdr-outline-empty'
    empty.innerHTML = `
      <div class="tree-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
        </svg>
      </div>
      <div class="tree-empty-title">暂无文档大纲</div>
      <div class="tree-empty-desc">打开 Markdown 文档后即可查看大纲导航</div>
    `
    treeContainer.append(empty)
    updateControls()
    return
  }

  const query = ui.search.value.trim().toLocaleLowerCase()
  const headingIDs = new Set()
  const headings = parseHeadings(doc.source)
  const frame = documentFrames.get(doc.id)
  const renderedHeadings = frame?.contentDocument?.querySelectorAll('h1, h2, h3, h4, h5, h6') || []

  for (const heading of headings) {
    if (query && !heading.title.toLocaleLowerCase().includes(query)) continue

    // Use the renderer's real heading ID. Source titles may contain Markdown
    // links/code and punctuation that make independently generated slugs differ.
    const baseID = renderedHeadings[heading.headingIndex]?.id || slug(heading.title)
    let id = baseID
    let suffix = 1
    while (headingIDs.has(id)) id = `${baseID}-${suffix++}`
    headingIDs.add(id)

    const itemWrapper = document.createElement('div')
    itemWrapper.className = `mdr-outline-item level-${heading.level}`

    const nodeItem = document.createElement('div')
    nodeItem.className = 'tree-node-item'
    nodeItem.dataset.id = id

    const marker = document.createElement('span')
    marker.className = 'mdr-outline-marker'

    const titleSpan = document.createElement('span')
    titleSpan.className = 'mdr-outline-title'
    titleSpan.textContent = heading.title
    titleSpan.title = heading.title

    nodeItem.append(marker, titleSpan)
    itemWrapper.append(nodeItem)

    nodeItem.addEventListener('click', event => {
      event.preventDefault()
      const frame = documentFrames.get(activeId)
      const frameDocument = frame?.contentDocument
      const target = frameDocument?.querySelectorAll('h1, h2, h3, h4, h5, h6')?.[heading.headingIndex]
      if (target && frame?.contentWindow) {
        // A sticky heading's current rectangle is its pinned viewport position,
        // not its original document position. Temporarily unstick it to measure
        // its natural position before scrolling there.
        const previousPosition = target.style.position
        target.style.position = 'static'
        const targetTop = target.getBoundingClientRect().top + frame.contentWindow.scrollY
        target.style.position = previousPosition
        frame.contentWindow.scrollTo({top: Math.max(0, targetTop - 12), behavior: 'instant'})
        updateOutlineScrollSpy()
      }
    })

    treeContainer.append(itemWrapper)
  }

  if (!treeContainer.childElementCount) {
    const empty = document.createElement('div')
    empty.className = 'tree-empty mdr-outline-empty'
    if (query) {
      empty.innerHTML = `
        <div class="tree-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            <line x1="8" y1="11" x2="14" y2="11"></line>
          </svg>
        </div>
        <div class="tree-empty-title">没有匹配的标题</div>
        <div class="tree-empty-desc">未找到包含“<span class="tree-empty-query">${escapeHtml(ui.search.value.trim())}</span>”的大纲标题</div>
        <button type="button" class="tree-empty-action" id="outline-clear-search-btn">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          <span>清空搜索</span>
        </button>
      `
      empty.querySelector('#outline-clear-search-btn')?.addEventListener('click', () => {
        ui.search.value = ''
        renderOutline()
        ui.search.focus()
      })
    } else {
      empty.innerHTML = `
        <div class="tree-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="5" x2="5" y2="19" stroke-dasharray="2 2" opacity="0.6"></line>
            <circle cx="5" cy="6" r="2" fill="currentColor"></circle>
            <line x1="10" y1="6" x2="20" y2="6"></line>
            <circle cx="5" cy="12" r="2" fill="currentColor"></circle>
            <line x1="10" y1="12" x2="17" y2="12"></line>
            <circle cx="5" cy="18" r="2" fill="currentColor"></circle>
            <line x1="10" y1="18" x2="14" y2="18"></line>
          </svg>
        </div>
        <div class="tree-empty-title">当前文档没有标题</div>
        <div class="tree-empty-desc">文档中未包含 # 一级至六级标题，添加标题后可自动生成多级大纲目录</div>
        <div class="tree-empty-hint" title="在 Markdown 中使用 # 快速创建标题">
          <code># 一级标题</code>
          <code>## 二级标题</code>
        </div>
      `
    }
    treeContainer.append(empty)
  }
  updateControls()
}

function updateOutlineScrollSpy() {
  if (ui.preview.hidden) return
  const frame = documentFrames.get(activeId)
  const headings = frame?.contentDocument?.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')
  if (!headings?.length) return

  const containerRect = ui.preview.getBoundingClientRect()
  let currentActiveId = null

  for (const heading of headings) {
    const rect = heading.getBoundingClientRect()
    const top = frame.getBoundingClientRect().top + rect.top
    if (top <= containerRect.top + 100) {
      currentActiveId = heading.id
    } else {
      break
    }
  }

  if (!currentActiveId && headings.length > 0) {
    currentActiveId = headings[0].id
  }

  if (!currentActiveId) return

  const nodeItems = document.querySelectorAll('#panel-outline .tree-node-item')
  let activeNode = null
  for (const node of nodeItems) {
    if (node.dataset.id === currentActiveId) {
      node.classList.add('is-active')
      activeNode = node
    } else {
      node.classList.remove('is-active')
    }
  }

  if (activeNode) {
    activeNode.scrollIntoView({block: 'nearest', behavior: 'instant'})
  }
}

async function exportOutlinePNG() {
  const doc = activeDoc()
  const tree = ui.outlineTree
  if (!doc || !tree?.childElementCount) return

  await document.fonts?.ready
  await waitForBrowserPaint()
  const rect = tree.getBoundingClientRect()
  const width = Math.ceil(rect.width)
  const contentHeight = Math.ceil(tree.scrollHeight)
  const items = Array.from(tree.children, element => {
    const itemRect = element.getBoundingClientRect()
    return {
      element,
      left: itemRect.left - rect.left,
      top: itemRect.top - rect.top,
      width: itemRect.width,
      bottom: itemRect.bottom - rect.top,
    }
  })
  const task = startExportTask('PNG', {...doc, title: `${doc.title} · 大纲截图`})
  const pixelRatio = preferences.imageExportPixelRatio
  const maximumPixelHeight = Math.max(MIN_IMAGE_EXPORT_HEIGHT, Math.min(MAX_IMAGE_EXPORT_HEIGHT, Number(preferences.imageExportMaximumHeight) || DEFAULT_IMAGE_EXPORT_HEIGHT))
  const backgroundColor = document.documentElement.dataset.theme === 'dark' ? '#161b22' : '#ffffff'
  const baseName = safeName(doc.title.replace(/\.[^.]+$/, ''))
  const pageRoots = []
  let imageWorker
  let outputBlob = null
  let outputURL = ''

  try {
    assertExportNotCancelled(task)
    if (width <= 0 || contentHeight <= 0) throw new Error('大纲内容为空')
    const maximumSliceHeight = Math.max(1, Math.floor(maximumPixelHeight / pixelRatio))
    const imageCount = Math.ceil(contentHeight / maximumSliceHeight)
    updateExportTask(task, {progress: 0.05, progressText: '准备大纲 PNG 分片', detail: `0/${imageCount} 张`})
    if (imageCount > 1) {
      imageWorker = createImageExportWorker()
      await imageWorker.request('init', {zip: true})
    }

    for (let index = 0; index < imageCount; index++) {
      assertExportNotCancelled(task)
      const offsetY = index * maximumSliceHeight
      const sliceHeight = Math.min(maximumSliceHeight, contentHeight - offsetY)
      const sliceBottom = offsetY + sliceHeight
      updateExportTask(task, {progress: 0.05 + index / imageCount * 0.9, progressText: '生成大纲 PNG 分片', detail: `${index}/${imageCount} 张`})
      await waitForBrowserPaint()

      const pageRoot = document.createElement('div')
      pageRoot.id = 'panel-outline'
      const treeClone = tree.cloneNode(false)
      pageRoots.push(pageRoot)
      Object.assign(pageRoot.style, {
        position: 'fixed', left: '0', top: '0', zIndex: '2147483647',
        opacity: '0', pointerEvents: 'none', width: `${width}px`, height: `${sliceHeight}px`,
        minHeight: '0', maxHeight: 'none', boxSizing: 'border-box', margin: '0', padding: '0', overflow: 'hidden',
        backgroundColor,
      })
      Object.assign(treeClone.style, {position: 'relative', width: '100%', height: `${sliceHeight}px`, margin: '0', padding: '0'})
      pageRoot.append(treeClone)
      for (const item of items) {
        if (item.bottom <= offsetY || item.top >= sliceBottom) continue
        const clone = item.element.cloneNode(true)
        Object.assign(clone.style, {
          position: 'absolute', left: `${item.left}px`, top: `${item.top - offsetY}px`,
          width: `${item.width}px`, maxWidth: 'none', margin: '0', boxSizing: 'border-box',
        })
        treeClone.append(clone)
      }
      document.body.append(pageRoot)
      await waitForBrowserPaint()

      const blob = await toBlob(pageRoot, {
        cacheBust: true,
        width,
        height: sliceHeight,
        canvasWidth: width,
        canvasHeight: sliceHeight,
        pixelRatio,
        backgroundColor,
        style: {opacity: '1'},
      })
      assertExportNotCancelled(task)
      if (!blob) throw new Error(`第 ${index + 1} 张大纲图片生成失败`)
      if (imageWorker) {
        await imageWorker.request('add-page', {blob, filename: `${baseName}_大纲_${index + 1}.png`})
      } else {
        outputBlob = blob
      }
      updateExportTask(task, {progress: 0.05 + (index + 1) / imageCount * 0.9, progressText: '生成大纲 PNG 分片', detail: `${index + 1}/${imageCount} 张`})
      pageRoot.remove()
      pageRoots.pop()
      await waitForBrowserPaint()
    }

    if (imageWorker) {
      assertExportNotCancelled(task)
      updateExportTask(task, {progress: 0.97, progressText: '打包 ZIP', detail: `${imageCount} 张大纲截图`})
      const archiveResult = await imageWorker.request('finish')
      if (archiveResult.pageCount !== imageCount) throw new Error(`分片数量不一致：计划 ${imageCount} 张，实际打包 ${archiveResult.pageCount} 张`)
      outputBlob = archiveResult.blob
    }
    outputURL = URL.createObjectURL(outputBlob)
    const anchor = document.createElement('a')
    anchor.href = outputURL
    anchor.download = imageCount > 1 ? `${baseName}_大纲截图.zip` : `${baseName}_大纲截图.png`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(outputURL), 60_000)
    task.detail = imageCount > 1 ? `已打包 ${imageCount} 张大纲 PNG` : '大纲 PNG 图片已下载'
    finishExportTask(task, 'completed')
  } catch (error) {
    if (outputURL) URL.revokeObjectURL(outputURL)
    if (task.cancelRequested) finishExportTask(task, 'cancelled')
    else finishExportTask(task, 'failed', error.message || String(error))
  } finally {
    imageWorker?.cancel()
    pageRoots.forEach(pageRoot => pageRoot.remove())
  }
}

if (ui.outlineExportBtn) {
  ui.outlineExportBtn.addEventListener('click', event => {
    if (startExportButtonCooldown(event.currentTarget, false)) void exportOutlinePNG()
  })
}

// ==========================================================================
// 媒体与渲染管线
// ==========================================================================
async function resolveImage(doc, source) {
  if (/^(?:https?:|data:|blob:|chrome-extension:|file:)/i.test(source)) return source
  if (doc.sourceURL) {
    try { return new URL(source, doc.sourceURL).href } catch { return source }
  }
  if (!doc.root || !doc.relativePath) return source
  try {
    const clean = decodeURIComponent(source.split(/[?#]/, 1)[0]).replace(/\\/g, '/')
    const parts = doc.relativePath.split('/').slice(0, -1)
    for (const segment of clean.split('/')) {
      if (!segment || segment === '.') continue
      if (segment === '..') parts.pop()
      else parts.push(segment)
    }
    const cacheKey = `${doc.id}:${parts.join('/')}`
    if (objectURLs.has(cacheKey)) return objectURLs.get(cacheKey)
    let directory = doc.root
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
    const handle = await directory.getFileHandle(parts.at(-1))
    const file = await handle.getFile()
    const url = URL.createObjectURL(file)
    objectURLs.set(cacheKey, url)
    doc.objectURLs ||= []
    doc.objectURLs.push(url)
    return url
  } catch { return source }
}

/**
 * 修正 Mermaid 节点文字截断与度量微差：
 * 1. 解除 foreignObject 默认 overflow:hidden 造成的生硬截断
 * 2. 规范内部 div/span 行高与弹性垂直居中，杜绝中文字体基线偏下导致的挤迫
 * 3. 为外层容器 rect 补充充足的横向与纵向呼吸留白，保持严格中心对称
 */
function decorateMermaidNodeLabels(node) {
  node.querySelectorAll('svg foreignObject').forEach(fo => {
    fo.style.setProperty('overflow', 'visible', 'important')
    const div = fo.querySelector('div')
    if (div) {
      div.style.setProperty('line-height', '1.35', 'important')
      div.style.setProperty('display', 'flex', 'important')
      div.style.setProperty('flex-direction', 'column', 'important')
      div.style.setProperty('justify-content', 'center', 'important')
      div.style.setProperty('align-items', 'center', 'important')
      div.style.setProperty('box-sizing', 'border-box', 'important')
      div.style.setProperty('overflow', 'visible', 'important')
    }
    const span = fo.querySelector('.nodeLabel')
    if (span) {
      span.style.setProperty('line-height', '1.35', 'important')
      span.style.setProperty('text-align', 'center', 'important')
    }
  })

  node.querySelectorAll('svg g.node').forEach(nodeG => {
    const rect = nodeG.querySelector('rect.basic.label-container') || nodeG.querySelector('rect')
    const fo = nodeG.querySelector('g.label foreignObject') || nodeG.querySelector('foreignObject')
    if (!rect || !fo) return

    const foWidth = Number.parseFloat(fo.getAttribute('width')) || 0
    const rectWidth = Number.parseFloat(rect.getAttribute('width')) || 0
    const rectX = Number.parseFloat(rect.getAttribute('x')) || 0

    // 横向呼吸留白保障（左右各至少 12px）
    if (rectWidth > 0 && foWidth > 0 && rectWidth - foWidth < 24) {
      const extra = 24 - (rectWidth - foWidth)
      const newRectWidth = rectWidth + extra
      rect.setAttribute('width', String(newRectWidth))
      rect.setAttribute('x', String(rectX - extra / 2))
    }

    // 纵向呼吸留白保障：多行文本节点保障至少 28px 垂直留白，单行节点保障至少 20px
    const foHeight = Number.parseFloat(fo.getAttribute('height')) || 0
    const rectHeight = Number.parseFloat(rect.getAttribute('height')) || 0
    const rectY = Number.parseFloat(rect.getAttribute('y')) || 0

    const minVerticalPadding = foHeight > 24 ? 28 : 20
    if (rectHeight > 0 && foHeight > 0 && rectHeight - foHeight < minVerticalPadding) {
      const extraH = minVerticalPadding - (rectHeight - foHeight)
      const newRectHeight = rectHeight + extraH
      rect.setAttribute('height', String(newRectHeight))
      rect.setAttribute('y', String(rectY - extraH / 2))
    }

    // 补偿中文字体（如 PingFang SC）在 WebKit 渲染中字形偏下的度量偏差，向上微调 2px
    const labelG = nodeG.querySelector('g.label')
    if (labelG && !labelG.dataset.mdrYAdjusted) {
      labelG.dataset.mdrYAdjusted = 'true'
      const transform = labelG.getAttribute('transform') || ''
      const m = transform.match(/translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/)
      if (m) {
        const lx = Number.parseFloat(m[1])
        const ly = Number.parseFloat(m[2])
        labelG.setAttribute('transform', `translate(${lx}, ${ly - 2})`)
      }
    }
  })
}

/**
 * 修正连线文字边框，扩大标签圆角背景，防止遮挡线条或文字被压
 */
function decorateMermaidEdgeLabels(node) {
  const isDark = document.documentElement.dataset.theme === 'dark' || document.documentElement.classList.contains('dark')
  const background = isDark ? '#161b22' : '#f6f8fa'

  node.querySelectorAll('svg .edgeLabel').forEach(edgeLabel => {
    const visibleText = (edgeLabel.textContent || '').replace(/[\s\u200B-\u200D\uFEFF]/g, '')
    if (!visibleText) edgeLabel.setAttribute('display', 'none')
  })

  node.querySelectorAll('svg .edgeLabel rect').forEach(rect => {
    if (rect.dataset.mdrEdgeLabelDecorated === 'true') return
    const edgeLabel = rect.closest('.edgeLabel')
    if (!edgeLabel?.textContent?.trim()) {
      edgeLabel?.setAttribute('display', 'none')
      return
    }
    const x = Number.parseFloat(rect.getAttribute('x')) || 0
    const y = Number.parseFloat(rect.getAttribute('y')) || 0
    const width = Number.parseFloat(rect.getAttribute('width')) || 0
    const height = Number.parseFloat(rect.getAttribute('height')) || 0
    if (width <= 0 || height <= 0) return

    rect.dataset.mdrEdgeLabelDecorated = 'true'
    rect.setAttribute('x', String(x - 7))
    rect.setAttribute('y', String(y - 3))
    rect.setAttribute('width', String(width + 14))
    rect.setAttribute('height', String(height + 6))
    rect.setAttribute('rx', '6')
    rect.setAttribute('ry', '6')
    rect.style.setProperty('fill', background, 'important')
    rect.style.setProperty('stroke', 'none', 'important')
  })

  node.querySelectorAll('svg .edgeLabel foreignObject, svg foreignObject.edgeLabel').forEach(label => {
    const content = label.querySelector('div')
    if (!content) return

    const oldWidth = Number.parseFloat(label.getAttribute('width')) || 0
    const oldHeight = Number.parseFloat(label.getAttribute('height')) || 0
    const oldX = Number.parseFloat(label.getAttribute('x')) || 0
    const oldY = Number.parseFloat(label.getAttribute('y')) || 0

    label.style.setProperty('background', 'transparent', 'important')
    label.style.overflow = 'visible'
    content.querySelectorAll('*').forEach(child => {
      child.style.setProperty('background', 'transparent', 'important')
      child.style.setProperty('background-color', 'transparent', 'important')
    })
    content.style.cssText += `;display:inline-block;box-sizing:border-box;padding:3px 7px;border-radius:6px;background:${background};box-shadow:0 1px 2px rgba(15,23,42,.14);`

    const rect = content.getBoundingClientRect()
    const width = Math.ceil(rect.width)
    const height = Math.ceil(rect.height)
    if (width <= 0 || height <= 0) return

    label.setAttribute('width', String(width))
    label.setAttribute('height', String(height))
    label.setAttribute('x', String(oldX - (width - oldWidth) / 2))
    label.setAttribute('y', String(oldY - (height - oldHeight) / 2))
  })
}

function restoreScrollAfterImages(doc, frame, container, pending) {
  const frameDocument = frame.contentDocument
  const frameWindow = frame.contentWindow
  if (pending.top <= 50) {
    if (doc._scrollRestorePending === pending) delete doc._scrollRestorePending
    if (frame.isConnected) {
      frameWindow.scrollTo({top: pending.top, behavior: 'instant'})
      syncDocumentJumpButtons(doc)
      syncDocumentReadingProgress(doc)
    }
    return
  }
  const allImages = [...container.querySelectorAll('img')]
  const images = allImages.filter(image => !image.complete)
  const cleanups = []
  let notice = null
  let cancelButton = null
  let progressText = null
  let percentBadge = null
  let progressFill = null
  let remaining = images.length
  const updateProgress = () => {
    const total = allImages.length
    const completed = total - remaining
    const percent = Math.min(100, Math.max(0, Math.round((completed / total) * 100))) || 0
    if (progressText) {
      progressText.textContent = `${completed}/${total}`
    }
    if (percentBadge) {
      percentBadge.textContent = `${percent}%`
    }
    if (progressFill) {
      progressFill.style.width = `${percent}%`
    }
  }
  if (images.length) {
    notice = frameDocument.createElement('div')
    notice.className = 'mdr-scroll-restore-notice'
    const panel = frameDocument.createElement('div')
    panel.className = 'mdr-scroll-restore-notice__panel'

    const spinner = frameDocument.createElement('span')
    spinner.className = 'mdr-scroll-restore-notice__spinner'
    spinner.setAttribute('aria-hidden', 'true')

    const status = frameDocument.createElement('span')
    status.className = 'mdr-scroll-restore-notice__status'
    status.setAttribute('role', 'status')

    const label = frameDocument.createElement('span')
    label.className = 'mdr-scroll-restore-notice__label'
    label.textContent = '正在加载图片并恢复阅读位置…'

    const metrics = frameDocument.createElement('span')
    metrics.className = 'mdr-scroll-restore-notice__metrics'

    progressText = frameDocument.createElement('span')
    progressText.className = 'mdr-scroll-restore-notice__count'

    percentBadge = frameDocument.createElement('span')
    percentBadge.className = 'mdr-scroll-restore-notice__percent'

    metrics.append(progressText, percentBadge)
    status.append(label, metrics)

    cancelButton = frameDocument.createElement('button')
    cancelButton.type = 'button'
    cancelButton.textContent = '取消等待'

    const progressBar = frameDocument.createElement('div')
    progressBar.className = 'mdr-scroll-restore-notice__progress-bar'
    progressBar.setAttribute('aria-hidden', 'true')
    progressFill = frameDocument.createElement('div')
    progressFill.className = 'mdr-scroll-restore-notice__progress-fill'
    progressBar.append(progressFill)

    updateProgress()

    panel.append(spinner, status, cancelButton, progressBar)
    notice.append(panel)
    frameDocument.body.append(notice)
  }
  let cancelled = false
  let finishWaiting
  const wait = new Promise(resolve => { finishWaiting = resolve })
  const dismissNotice = () => {
    if (!notice) return
    notice.classList.add('is-hiding')
    const timer = setTimeout(() => {
      notice.remove()
    }, 200)
    cleanups.push(() => clearTimeout(timer))
  }
  const cancel = () => {
    cancelled = true
    finishWaiting()
  }
  pending.cancel = cancel
  if (notice) {
    cancelButton.addEventListener('click', cancel, {once: true})
    const preventScroll = event => event.preventDefault()
    for (const type of ['wheel', 'touchmove']) {
      notice.addEventListener(type, preventScroll, {passive: false})
      cleanups.push(() => notice.removeEventListener(type, preventScroll))
    }
  }
  for (const image of images) {
    let finished = false
    const finishImage = () => {
      if (finished) return
      finished = true
      image.removeEventListener('load', finishImage)
      image.removeEventListener('error', finishImage)
      remaining--
      updateProgress()
      if (remaining === 0) finishWaiting()
    }
    image.addEventListener('load', finishImage, {once: true})
    image.addEventListener('error', finishImage, {once: true})
    cleanups.push(() => {
      image.removeEventListener('load', finishImage)
      image.removeEventListener('error', finishImage)
    })
    if (image.loading === 'lazy') image.loading = 'eager'
    if (image.complete) finishImage()
  }
  if (!remaining) finishWaiting()
  void wait.then(() => {
    cleanups.forEach(cleanup => cleanup())
    if (doc._scrollRestorePending !== pending) {
      notice?.remove()
      return
    }
    delete doc._scrollRestorePending
    if (!cancelled && frame.isConnected) {
      frameWindow.scrollTo({top: pending.top, behavior: 'instant'})
      syncDocumentJumpButtons(doc)
      syncDocumentReadingProgress(doc)
    }
    dismissNotice()
  })
}

async function renderActive() {
  const doc = activeDoc()
  if (!doc) return
  if (runningAutoScrollDocumentId && runningAutoScrollDocumentId !== doc.id) stopAutoScroll()
  ui.preview.hidden = false
  const generation = ++renderGeneration
  doc._scrollRestorePending?.cancel?.()
  delete doc._scrollRestorePending
  usedHeadingIDs = new Set()
  try {
    const {frame, frameDocument, root: targetContainer} = await getDocumentFrame(doc)
    if (generation !== renderGeneration) return
    documentFrames.forEach((item, id) => setDocumentFrameActive(item, id === doc.id))
    if (doc.loading || doc.loaded === false) {
      const status = frameDocument.createElement('div')
      status.className = 'mdr-document-load-state'
      status.setAttribute('role', 'status')
      if (doc.loadError) {
        status.textContent = `加载失败：${doc.loadError}。点击当前标签重试。`
      } else {
        status.innerHTML = `
          <div class="mdr-loading-composition" aria-hidden="true">
            <div class="mdr-loading-orbit mdr-loading-orbit--outer"><i></i></div>
            <div class="mdr-loading-orbit mdr-loading-orbit--inner"><i></i></div>
            <div class="mdr-loading-core">
              <span class="mdr-loading-star"></span>
            </div>
          </div>
          <div class="mdr-document-load-label">
            <span class="mdr-document-load-text">正在加载 Markdown 文档</span>
            <span class="mdr-document-load-ellipsis" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
          </div>`
      }
      targetContainer.replaceChildren(status)
      frame._mdrRenderedSource = doc.source
      ui.empty.hidden = true
      renderOutline()
      updateOutlineScrollSpy()
      return
    }

    if (!installAlreadyReported && !installReportRequest && !__LUMINA_DEV__) {
      installReportRequest = chrome.runtime.sendMessage({type: 'lumina:report-install'})
        .then(result => {
          if (!result?.ok) {
            console.warn('[LuminaChrome] 安装上报未成功', result?.error || '未知错误')
            return
          }
          installAlreadyReported = Boolean(result.reported)
        })
        .catch(error => console.warn('[LuminaChrome] 安装上报请求失败', error))
        .finally(() => { installReportRequest = null })
    }

    if (doc.sourceView) {
      const scrollRestore = Number.isFinite(doc.scrollTop) && doc.scrollTop > -1 ? {top: doc.scrollTop} : null
      if (scrollRestore) doc._scrollRestorePending = scrollRestore
      renderRawSourceView(doc, frameDocument, targetContainer)
      frame._mdrRenderedSource = doc.source
      ui.empty.hidden = true
      renderOutline()
      updateOutlineScrollSpy()
      if (scrollRestore) restoreScrollAfterImages(doc, frame, targetContainer, scrollRestore)
      syncDocumentReadingProgress(doc)
      return
    }

    const tokens = markdown.parse(doc.source, {})
    for (const token of tokens) {
      if (token.children) {
        for (const child of token.children) {
          if (child.type === 'image') child.attrSet('src', await resolveImage(doc, child.attrGet('src') || ''))
        }
      }
    }
    if (generation !== renderGeneration) return
    const raw = markdown.renderer.render(tokens, markdown.options, {})
    const sanitizedHtml = DOMPurify.sanitize(raw, {
      USE_PROFILES: {html: true, svg: true, mathMl: true},
      ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|file|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      ADD_TAGS: ['button', 'use'],
      ADD_ATTR: ['aria-label', 'aria-pressed', 'data-language', 'data-panzoom-action', 'data-tooltip', 'target', 'rel'],
    })

    const savedScrollTop = Number.isFinite(doc.scrollTop) && doc.scrollTop > -1 ? doc.scrollTop : null
    const scrollRestore = savedScrollTop === null ? null : {top: savedScrollTop}
    if (scrollRestore) doc._scrollRestorePending = scrollRestore
    targetContainer.innerHTML = sanitizedHtml
    layoutMarkdownImageGroups(targetContainer)
    wrapMarkdownHeadingSections(targetContainer)
    renderDocumentPathBar(doc, frameDocument, targetContainer)

    // 处理 GitHub Alert 与表格包裹层
    processAlerts(targetContainer)
    processTables(targetContainer)
    initTableResize(frameDocument.body)

    // Mermaid 流程图精准初始化与渲染
    const isDark = document.documentElement.dataset.theme === 'dark' || document.documentElement.classList.contains('dark')
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      securityLevel: 'loose',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', sans-serif",
      flowchart: {htmlLabels: true, useMaxWidth: false, padding: 18},
      gantt: {
        useMaxWidth: false,
        useWidth: 1100,
        leftPadding: 180,
        topPadding: 50,
        rightPadding: 35,
        barHeight: 24,
        barGap: 6,
      },
      sequence: {useMaxWidth: false},
    })

    const mermaidNodes = targetContainer.querySelectorAll('.mermaid')
    for (const node of mermaidNodes) {
      const rawCode = node.textContent || ''
      if (!rawCode.trim()) continue
      const uniqueId = `mdr_mermaid_${++mermaidRenderSeq}_${Math.random().toString(36).slice(2, 7)}`
      try {
        const {svg} = await mermaid.render(uniqueId, rawCode)
        node.innerHTML = svg
        node.setAttribute('data-processed', 'true')
        decorateMermaidEdgeLabels(node)
        decorateMermaidNodeLabels(node)
      } catch (err) {
        console.warn('Mermaid 渲染失败:', err)
        const temp = document.getElementById(uniqueId) || document.getElementById('d' + uniqueId)
        temp?.remove()
        node.classList.add('mdr-mermaid-parse-failed')
        node.closest('.mdr-mermaid-block')?.classList.add('mdr-mermaid-parse-failed')
        node.innerHTML = `<div class="mdr-mermaid-parse-fallback"><pre><code>${markdown.utils.escapeHtml(rawCode)}</code></pre><span class="mdr-mermaid-parse-badge" role="note">解析失败</span></div>`
      }
    }

    // 绑定流程图的拖拽平移、缩放、适应画布与全屏交互
    initMermaidInteractions(targetContainer)

    if (generation !== renderGeneration) {
      if (doc._scrollRestorePending === scrollRestore) delete doc._scrollRestorePending
      return
    }

    ui.empty.hidden = true
    const hasSavedScrollPosition = scrollRestore !== null
    if (hasSavedScrollPosition) {
      doc.pendingFragment = ''
      restoreScrollAfterImages(doc, frame, targetContainer, scrollRestore)
    }
    syncDocumentJumpButtons(doc)
    syncDocumentReadingProgress(doc)

    // 初始化 Viewer.js 图片全屏查看器
    setupArticleViewer(targetContainer)
    frame._mdrRenderedSource = doc.source

    renderOutline()
    updateOutlineScrollSpy()
    if (!hasSavedScrollPosition && doc.pendingFragment) void navigateDocumentToFragment(doc)
  } catch (error) {
    if (generation === renderGeneration) toast(`渲染失败：${error?.message || error}`)
  }
}

function renderRawSourceView(doc, frameDocument, targetContainer) {
  const section = frameDocument.createElement('section')
  section.className = 'mdr-source-view'

  const toolbar = frameDocument.createElement('header')
  toolbar.className = 'mdr-source-view__toolbar'
  const pathGroup = frameDocument.createElement('div')
  pathGroup.className = 'mdr-source-view__path'
  const pathCopyButton = frameDocument.createElement('button')
  pathCopyButton.className = 'mdr-source-view__path-copy'
  pathCopyButton.type = 'button'
  pathCopyButton.setAttribute('aria-label', '复制文件路径')
  pathCopyButton.title = '复制文件路径'
  pathCopyButton.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>'
  const documentPath = getDocumentDisplayPath(doc)
  pathCopyButton.addEventListener('click', async () => {
    try {
      await copyTextToClipboard(documentPath)
      toast('已复制文件路径')
    } catch (error) {
      toast(`复制路径失败：${error.message || error}`)
    }
  })
  const label = frameDocument.createElement('span')
  label.className = 'mdr-source-view__label'
  label.textContent = formatSourceViewURL(documentPath) || doc.title
  pathGroup.append(pathCopyButton, label)

  const copyButton = frameDocument.createElement('button')
  copyButton.className = 'mdr-source-view__copy'
  copyButton.type = 'button'
  copyButton.textContent = '复制原始内容'
  copyButton.setAttribute('aria-label', '复制 Markdown 原始内容')
  copyButton.addEventListener('click', async () => {
    try {
      await copyTextToClipboard(doc.source)
      copyButton.textContent = '已复制'
      toast('已复制原始内容')
      window.setTimeout(() => {
        if (copyButton.isConnected) copyButton.textContent = '复制原始内容'
      }, 1600)
    } catch (error) {
      toast(`复制失败：${error.message || error}`)
    }
  })
  toolbar.append(pathGroup, copyButton)

  const pre = frameDocument.createElement('pre')
  pre.className = 'mdr-source-view__code'
  pre.tabIndex = 0
  const code = frameDocument.createElement('code')
  code.textContent = doc.source
  pre.append(code)
  toolbar.append(createDocumentStats(doc.source, frameDocument))
  section.append(toolbar, pre)
  targetContainer.replaceChildren(section)
}

function countDocumentWords(source) {
  const matches = source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu)
  return matches?.length || 0
}

function createDocumentStats(source, frameDocument) {
  const stats = frameDocument.createElement('div')
  stats.className = 'mdr-document-stats'
  stats.dataset.exportIgnore = 'true'
  stats.setAttribute('aria-label', '文档统计')

  const wordCount = countDocumentWords(source)
  const lineCount = source.length ? source.split(/\r\n|\r|\n/).length : 0
  const sizeBytes = new TextEncoder().encode(source).byteLength
  stats.textContent = `字数 ${wordCount.toLocaleString()} · 行数 ${lineCount.toLocaleString()} · 大小 ${formatDocumentSize(sizeBytes)}`
  return stats
}

function formatDocumentSize(sizeBytes) {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSourceViewURL(sourceURL) {
  if (!sourceURL) return ''
  try {
    const url = new URL(cleanExtensionURL(sourceURL))
    let pathname = url.pathname
    try { pathname = decodeURIComponent(pathname) } catch {}
    let search = url.search
    let hash = url.hash
    try { search = decodeURI(search) } catch {}
    try { hash = decodeURI(hash) } catch {}
    return `${url.protocol}//${url.host}${pathname}${search}${hash}`
  } catch {
    return sourceURL
  }
}

function renderDocumentPathBar(doc, frameDocument, targetContainer) {
  const path = getDocumentDisplayPath(doc)
  if (targetContainer.querySelector('.mdr-document-path-bar')) return
  const bar = frameDocument.createElement('div')
  bar.className = 'mdr-document-path-bar'
  bar.dataset.exportIgnore = 'true'
  if (path) {
    const copyButton = frameDocument.createElement('button')
    copyButton.className = 'mdr-source-view__path-copy'
    copyButton.type = 'button'
    copyButton.setAttribute('aria-label', '复制文件路径')
    copyButton.title = '复制文件路径'
    copyButton.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>'
    copyButton.addEventListener('click', async () => {
      try {
        await copyTextToClipboard(path)
        toast('已复制文件路径')
      } catch (error) {
        toast(`复制路径失败：${error.message || error}`)
      }
    })
    const label = frameDocument.createElement('span')
    label.className = 'mdr-document-path-bar__label'
    label.textContent = formatSourceViewURL(path)
    bar.append(copyButton, label)
  }
  bar.append(createDocumentStats(doc.source, frameDocument))
  targetContainer.prepend(bar)
}

function getDocumentDisplayPath(doc) {
  if (doc?.absolutePath) return doc.absolutePath
  if (doc?.sourceURL) return cleanExtensionURL(doc.sourceURL)
  const relativePath = String(doc?.relativePath || '').replace(/^\/+/, '')
  if (doc?.root?.name && relativePath) return `${doc.root.name}/${relativePath}`
  return doc?.title || ''
}

async function navigateDocumentToFragment(doc, fragment = doc?.pendingFragment) {
  if (!doc || !fragment) return false
  doc.pendingFragment = fragment
  if (doc.loaded === false || doc.loading) return false

  const frame = documentFrames.get(doc.id)
  const frameDocument = frame?.contentDocument
  if (!frameDocument) return false
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  let targetID = String(fragment).replace(/^#/, '')
  try { targetID = decodeURIComponent(targetID) } catch {}
  let target = frameDocument.getElementById(targetID)
  if (!target) target = frameDocument.getElementById(slug(targetID))
  if (!target) {
    const expectedSlug = slug(targetID)
    const compactExpectedSlug = expectedSlug.replace(/-/g, '')
    target = [...frameDocument.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .find(heading => {
        const headingSlug = slug(heading.textContent || '')
        return headingSlug === expectedSlug || headingSlug.replace(/-/g, '') === compactExpectedSlug
      })
  }
  if (!target) return false
  target.scrollIntoView({block: 'start', behavior: 'instant'})
  if (doc.pendingFragment === fragment) doc.pendingFragment = ''
  return true
}

function wrapMarkdownHeadingSections(container) {
  const nodes = [...container.childNodes]
  let currentSection = null
  container.replaceChildren()

  for (const node of nodes) {
    const startsHeadingSection = node.nodeType === Node.ELEMENT_NODE && /^H[1-6]$/.test(node.tagName)
    if (startsHeadingSection) {
      if (currentSection) {
        const level = Number(node.tagName.slice(1))
        currentSection.style.paddingBottom = level === 1 ? '0.6em' : '1.6em'
      }
      currentSection = container.ownerDocument.createElement('section')
      currentSection.className = 'mdr-heading-section'
      container.append(currentSection)
    }
    const parent = currentSection || container
    parent.append(node)
  }
}

// ==========================================================================
// 文件系统读写逻辑
// ==========================================================================
async function loadFileIntoDocument(doc, readSource) {
  doc.loading = true
  doc.loadError = ''
  setDocument(doc)
  updateControls()
  // setDocument starts rendering asynchronously. Wait for the iframe's loading
  // state to be installed as well as painted before beginning file I/O.
  await renderActive()
  await waitForBrowserPaint()

  try {
    const loaded = await readSource()
    if (!docs.some(item => item.id === doc.id)) return null
    doc.source = loaded.source
    if (loaded.lastModified != null) doc.lastModified = loaded.lastModified
    doc.loading = false
    doc.loaded = true
    doc.loadError = ''
    const frame = documentFrames.get(doc.id)
    if (frame) frame._mdrRenderedSource = null
    renderTabs()
    updateControls()
    if (doc.id === activeId) await renderActive()
    if (!doc.root && /!\[[^\]]*\]\((?!https?:|data:|blob:)[^)]+\)/i.test(doc.source)) {
      toast('若文档引用同目录图片，请使用“打开目录”以授权读取图片文件。')
    }
    return doc
  } catch (error) {
    if (docs.some(item => item.id === doc.id)) closeDocument(doc.id)
    throw error
  }
}

async function readFileHandle(handle, metadata = {}) {
  const id = metadata.id || crypto.randomUUID()
  const doc = {
    id,
    title: metadata.title || handle.name,
    source: '',
    handle,
    root: metadata.root || null,
    relativePath: metadata.relativePath || '',
    loading: true,
    objectURLs: [],
  }
  return loadFileIntoDocument(doc, async () => {
    const file = await handle.getFile()
    return {source: await readFileAsText(file), lastModified: file.lastModified}
  })
}

async function requestHandlePermission(handle) {
  if (!handle) return true
  let permission = await handle.queryPermission({mode: 'read'})
  if (permission !== 'granted') permission = await handle.requestPermission({mode: 'read'})
  return permission === 'granted'
}

async function openFilePicker() {
  try {
    if (!window.showOpenFilePicker) throw new Error('当前 Chrome 不支持文件系统访问 API')
    const [handle] = await showOpenFilePicker({
      multiple: false,
      types: [{description: 'Markdown', accept: {'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mdx', '.mdc', '.txt']}}],
    })
    await readFileHandle(handle)
    persistState()
    showDropRefreshNotice()
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message || '无法打开文件')
  }
}

async function openDirectoryPicker() {
  try {
    if (!window.showDirectoryPicker) throw new Error('当前 Chrome 不支持目录访问 API')
    const handle = await showDirectoryPicker({mode: 'read'})
    if (!await requestHandlePermission(handle, 'read')) throw new Error('未获准访问此目录')
    await appendDirectoryHandle(handle)
    renderFiles()
    document.querySelector('[data-panel="files"]').click()
    toast(`已添加目录：${handle.name}`)
    persistState()
    showDropRefreshNotice()
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message || '无法打开目录')
  }
}

async function appendDirectoryHandle(handle) {
  const existingRoots = [
    ...(rootHandle ? [{handle: rootHandle, entries: rootEntries, fileIndex}] : []),
    ...additionalDirectoryRoots,
  ]
  let existing = existingRoots.find(root => root.handle === handle)
  if (!existing && typeof handle.isSameEntry === 'function') {
    for (const root of existingRoots) {
      try {
        if (root.handle && await handle.isSameEntry(root.handle)) { existing = root; break }
      } catch {}
    }
  }
  if (existing) return existing

  const entries = []
  const files = []
  const rootKey = crypto.randomUUID()
  const scan = async (directory, relative = '') => {
    const children = []
    for await (const [name, childHandle] of directory.entries()) {
      if (name.startsWith('.')) continue
      const path = relative ? `${relative}/${name}` : name
      if (childHandle.kind === 'directory') {
        children.push({kind: 'directory', name, path, handle: childHandle, rootHandle: handle, rootKey, children: await scan(childHandle, path)})
      } else if (/\.(md|markdown|mdown|mkd|mdx|mdc|txt)$/i.test(name)) {
        const item = {kind: 'file', name, path, handle: childHandle, rootHandle: handle, rootKey}
        children.push(item)
        files.push(item)
      }
    }
    return children.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', {numeric: true}) : a.kind === 'directory' ? -1 : 1)
  }
  entries.push(...await scan(handle))

  if (!rootHandle && !localTreeRoot && !additionalDirectoryRoots.length) {
    rootHandle = handle
    primaryRootTreeId = rootKey
    rootEntries = entries
    fileIndex = files
  } else {
    additionalDirectoryRoots.push({handle, entries, fileIndex: files, rootKey})
  }
  localTreeError = ''
  return {handle, entries, fileIndex: files}
}

async function refreshFileIndex() {
  const generation = ++fileIndexGeneration
  const previousTreeSignature = directoryTreeSignature(rootEntries)
  const nextFileIndex = []
  if (!rootHandle) return false
  const scan = async (directory, relative = '') => {
    const entries = []
    for await (const [name, handle] of directory.entries()) {
      if (name.startsWith('.')) continue
      const path = relative ? `${relative}/${name}` : name
      if (handle.kind === 'directory') {
        const children = await scan(handle, path)
        entries.push({kind: 'directory', name, path, handle, rootHandle, rootKey: primaryRootTreeId, children})
      } else if (/\.(md|markdown|mdown|mkd|mdx|mdc|txt)$/i.test(name)) {
        const item = {kind: 'file', name, path, handle, rootHandle, rootKey: primaryRootTreeId}
        entries.push(item)
        nextFileIndex.push(item)
      }
    }
    return entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', {numeric: true}) : a.kind === 'directory' ? -1 : 1)
  }
  const entries = await scan(rootHandle)
  if (generation !== fileIndexGeneration) return false
  fileIndex = nextFileIndex
  rootEntries = entries
  return directoryTreeSignature(entries) !== previousTreeSignature
}

function directoryTreeSignature(entries) {
  return JSON.stringify((entries || []).map(item => [
    item.kind,
    item.name,
    item.path,
    item.kind === 'directory' ? directoryTreeSignature(item.children) : '',
  ]))
}

function getDirectoryRootDescriptors() {
  return [
    ...(rootHandle || localTreeRoot ? [{handle: rootHandle, localRoot: localTreeRoot, entries: rootEntries, fileIndex, rootKey: primaryRootTreeId}] : []),
    ...additionalDirectoryRoots,
  ]
}

async function scanLocalDirectoryTree(fileURL) {
  localTreeError = ''
  try {
    const result = await readLocalDirectoryTree(fileURL)
    if (!rootHandle && !localTreeRoot && !additionalDirectoryRoots.length) {
      localTreeRoot = result.root
      primaryRootTreeId = result.root?.url || crypto.randomUUID()
      rootEntries = result.entries
    }
    else {
      const existing = additionalDirectoryRoots.find(root => root.localRoot?.url === result.root?.url)
      if (existing) {
        existing.localRoot = result.root
        existing.entries = result.entries
      } else additionalDirectoryRoots.push({localRoot: result.root, entries: result.entries, fileIndex: [], rootKey: result.root?.url || crypto.randomUUID()})
    }
    await restoreExpandedDirectories()
  } catch (error) {
    if (!rootHandle && !additionalDirectoryRoots.length) {
      localTreeRoot = null
      rootEntries = []
    }
    localTreeError = error.message || '无法读取本地目录'
  }
}

async function readLocalDirectoryTree(fileURL) {
  const result = await chrome.runtime.sendMessage({type: 'lumina:scan-local-tree', fileURL})
  if (!result?.ok) throw new Error(result?.error || '无法读取本地目录')
  return result
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, match => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[match]))
}

// 高颜值现代目录树 SVG 图标系统 (完全对齐 App 原生视觉)
const FOLDER_PATH = `<path d="M561.632 164.574h335.018c27.298 0 49.632 22.335 49.632 49.632v62.04c0 27.298-22.334 49.632-49.632 49.632H561.632c-27.298 0-49.632-22.334-49.632-49.632v-62.04c0-27.297 22.334-49.632 49.632-49.632z" fill="currentColor" opacity=".55"/><path d="M983.507 933.875H189.39c-54.596 0-99.265-44.669-99.265-99.265V189.39c0-54.596 44.669-99.265 99.265-99.265h285.386c68.244 18.612 54.596 53.355 99.265 99.265l31.02 49.632h378.447c54.596 0 99.265 44.669 99.265 99.265v496.323c0 54.596-44.669 99.265-99.265 99.265z" fill="currentColor"/>`
const SVG_FOLDER_CLOSED = `<svg class="folder-icon-closed" viewBox="0 0 1204 1024" width="16" height="16">${FOLDER_PATH}</svg>`
const SVG_FOLDER_OPEN = `<svg class="folder-icon-open" viewBox="0 0 1024 1024" width="16" height="16"><path d="M908.203 944.981c0 40.107-30.464 73.472-67.072 73.472H85.333l118.869-607.915c13.653-52.053 30.464-73.472 67.072-73.472h685.653c36.608 0 67.072 33.451 67.072 73.472L908.203 944.981zM946.091 254.123H200.96c-40.192 0-50.517 35.072-64 80.384L0 1024V72.533C0 32.939 33.451 0 73.643 0h283.05c40.107 0 73.643 32.939 73.643 72.533v65.878h442.027c40.192 0 73.728 33.024 73.728 72.533v43.179z" fill="currentColor"/></svg>`
const SVG_FOLDER_ICON = `<span class="folder-icon">${SVG_FOLDER_CLOSED}${SVG_FOLDER_OPEN}</span>`
const SVG_FILE_ICON = `<span class="file-icon"><svg class="file-icon-svg" viewBox="0 0 1024 1024" width="16" height="16" aria-hidden="true"><path d="M815.36 322.56c21.12 0 37.76 17.28 37.76 37.76 0 21.12-17.28 37.76-37.76 37.76H625.92c-21.12 0-37.76-17.28-37.76-37.76 0-21.12 17.28-37.76 37.76-37.76h189.44z m0 151.68c21.12 0 37.76 17.28 37.76 37.76s-17.28 37.76-37.76 37.76H625.92c-21.12 0-37.76-17.28-37.76-37.76s17.28-37.76 37.76-37.76h189.44zM364.8 378.88c-12.16-1.28-23.68 5.12-28.8 16L264.32 537.6l-29.44-87.68c-3.84-11.52-14.72-19.84-27.52-19.84-12.16 0-23.68 7.68-27.52 19.84l-51.2 153.6c-5.12 14.72 3.2 31.36 18.56 36.48 3.2 1.28 6.4 1.28 8.96 1.28 12.16 0 23.04-7.68 27.52-19.84L208 550.4l23.68 71.68c3.84 10.88 13.44 18.56 24.96 19.84 11.52 0.64 22.4-5.76 28.16-16l67.84-135.04 32 129.28c3.84 15.36 19.2 24.96 35.2 21.12 15.36-3.84 24.96-19.2 21.12-35.2l-51.2-204.8c-3.2-12.16-12.8-21.12-24.96-22.4z m450.56 247.04c21.12 0 37.76 17.28 37.76 37.76 0 21.12-17.28 37.76-37.76 37.76H625.92c-21.12 0-37.76-17.28-37.76-37.76 0-21.12 17.28-37.76 37.76-37.76h189.44z m37.76-493.44h-531.2c-19.2 0-35.2 14.08-37.76 33.28v118.4h151.68c41.6 0 76.16 33.92 76.16 76.16v303.36c0 41.6-33.92 76.16-76.16 76.16H284.16v113.92c0 19.2 14.08 35.2 33.28 37.76h535.68c19.2 0 35.2-14.08 37.76-33.28V170.88c0-19.2-14.08-35.2-33.28-37.76l-4.48-0.64z m0-75.52c60.16 0 110.08 46.72 113.28 106.88v689.28c0 60.16-46.72 110.08-106.88 113.28h-537.6c-60.16 0-110.08-46.72-113.28-106.88v-120.32H132.48c-41.6 0-76.16-33.92-76.16-76.16V360.32c0-41.6 33.92-76.16 76.16-76.16h76.16V170.88c0-60.16 46.72-110.08 106.88-113.28h537.6z" fill="currentColor"/></svg></span>`

const SVG_SOURCE_FILE_ICON = `<span class="file-icon"><svg class="file-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/></svg></span>`

function renderHighlightedText(text, query) {
  if (!query || !query.trim()) return escapeHtml(text)
  const q = query.trim()
  const lowerText = text.toLowerCase()
  const lowerQ = q.toLowerCase()
  const index = lowerText.indexOf(lowerQ)
  if (index === -1) return escapeHtml(text)
  const before = text.slice(0, index)
  const matched = text.slice(index, index + q.length)
  const after = text.slice(index + q.length)
  return `${escapeHtml(before)}<mark class="mdr-search-highlight">${escapeHtml(matched)}</mark>${renderHighlightedText(after, query)}`
}

function updateFolderActive() {
  const doc = activeDoc()
  if (!doc) return
  const currentPath = doc.relativePath || ''
  const currentURL = doc.sourceURL || ''
  const currentTitle = doc.title || ''

  ui.files.querySelectorAll('.file-node-li, .tree-node-item.is-file').forEach(el => {
    el.classList.remove('active', 'is-active')
  })

  const fileLinks = Array.from(ui.files.querySelectorAll('.tree-node-item.is-file'))
  let matched = fileLinks.find(a => {
    const p = a.dataset.path
    const u = a.dataset.url
    return (p && p === currentPath) || (u && u === currentURL)
  })
  if (!matched && currentTitle) {
    matched = fileLinks.find(a => a.querySelector('.file-name')?.textContent === currentTitle)
  }
  if (matched) {
    matched.classList.add('is-active')
    matched.closest('.file-node-li')?.classList.add('active')

    // 自动展开激活文件所属的所有祖先级目录
    let parent = matched.parentElement?.closest('.folder-node-li')
    let stateChanged = false
    while (parent) {
      if (!parent.classList.contains('is-open')) {
        parent.classList.add('is-open')
        const link = parent.querySelector(':scope > .tree-node-item.is-folder')
        link?.classList.add('is-open')
        const sub = parent.querySelector(':scope > .sub-folder-container')
        if (sub) sub.style.display = 'block'
        if (parent.dataset.path) {
          expandedDirectories.add(parent.dataset.path)
          stateChanged = true
        }
      }
      parent = parent.parentElement?.closest('.folder-node-li')
    }
    if (stateChanged) persistExpandedDirectories()
  }
}

function showDocumentInFolder(doc) {
  setDocument(doc)
  ui.search.value = ''
  fileSearchType = 'all'
  setPanel('files')

  if (!rootHandle && !localTreeRoot) {
    toast('请先打开包含此文档的目录')
    return
  }

  requestAnimationFrame(() => {
    const fileLinks = [...ui.files.querySelectorAll('.tree-node-item.is-file')]
    const sourceKey = localFileURLKey(doc.sourceURL)
    const relativePath = String(doc.relativePath || '').replace(/^\.\//, '')
    let matched = relativePath
      ? fileLinks.find(link => link.dataset.path === relativePath)
      : null
    if (!matched && sourceKey) {
      matched = fileLinks.find(link => localFileURLKey(link.dataset.url) === sourceKey)
    }
    if (!matched && doc.title) {
      const titleMatches = fileLinks.filter(link => link.querySelector('.file-name')?.textContent === doc.title)
      if (titleMatches.length === 1) matched = titleMatches[0]
    }
    if (!matched) {
      toast('当前文档不在已打开的目录中')
      return
    }

    let parent = matched.closest('.file-node-li')?.parentElement?.closest('.folder-node-li')
    let expanded = false
    while (parent) {
      parent.classList.add('is-open')
      const folder = parent.querySelector(':scope > .tree-node-item.is-folder')
      folder?.classList.add('is-open')
      const children = parent.querySelector(':scope > .sub-folder-container')
      if (children) children.style.display = 'block'
      if (parent.dataset.path) {
        expandedDirectories.add(parent.dataset.path)
        expanded = true
      }
      parent = parent.parentElement?.closest('.folder-node-li')
    }
    if (expanded) persistExpandedDirectories()

    matched.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'})
    matched.classList.remove('is-locate-highlight')
    void matched.offsetWidth
    matched.classList.add('is-locate-highlight')
    setTimeout(() => matched.classList.remove('is-locate-highlight'), 1600)
  })
}

async function openLocalTreeFile(item) {
  const key = localFileURLKey(item.url)
  const existing = docs.find(doc => key && localFileURLKey(doc.sourceURL) === key)
  if (existing) {
    setDocument(existing)
    updateControls()
    return
  }

  if (key && pendingLocalTreeOpens.has(key)) {
    const opened = await pendingLocalTreeOpens.get(key)
    if (opened) {
      setDocument(opened)
      updateControls()
    }
    return
  }

  const opening = (async () => {
    const doc = {
      id: crypto.randomUUID(),
      title: item.name,
      source: '',
      sourceURL: item.url,
      loading: true,
      objectURLs: [],
    }
    return loadFileIntoDocument(doc, async () => {
      const result = await chrome.runtime.sendMessage({type: 'lumina:read-local-markdown', fileURL: item.url})
      if (!result?.ok) throw new Error(result?.error || '读取 Markdown 文件失败')
      return {source: result.source}
    })
  })()

  if (key) pendingLocalTreeOpens.set(key, opening)
  try {
    await opening
  } catch (error) {
    toast(error.message || '读取 Markdown 文件失败')
  } finally {
    if (key && pendingLocalTreeOpens.get(key) === opening) pendingLocalTreeOpens.delete(key)
  }
}

async function openMarkdownDocumentLink(value) {
  const sourceURL = markdownDocumentLinkURL(value)
  if (!sourceURL) return false

  const existing = findOpenDocument({sourceURL})
  if (existing) {
    existing.pendingFragment = new URL(sourceURL).hash
    setDocument(existing)
    if (existing.pendingFragment) void navigateDocumentToFragment(existing)
    updateControls()
    return true
  }

  if (pendingDocumentLinkOpens.has(sourceURL)) {
    const pending = await pendingDocumentLinkOpens.get(sourceURL)
    if (pending) {
      setDocument(pending)
      updateControls()
      return true
    }
    return false
  }

  const opening = (async () => {
    let title = new URL(sourceURL).pathname.split('/').pop() || 'Markdown 文档'
    try { title = decodeURIComponent(title) } catch {}
    if (!/^https?:/i.test(sourceURL)) {
      const result = await chrome.runtime.sendMessage({type: 'lumina:read-local-markdown', fileURL: sourceURL})
      if (!result?.ok) throw new Error(result?.error || '读取 Markdown 文档失败')
      const doc = {id: crypto.randomUUID(), title, source: result.source, sourceURL, pendingFragment: new URL(sourceURL).hash, objectURLs: []}
      setDocument(doc)
      updateControls()
      return doc
    }

    const doc = {id: crypto.randomUUID(), title, source: '', sourceURL, pendingFragment: new URL(sourceURL).hash, objectURLs: [], loading: true}
    setDocument(doc)
    renderTabs()
    updateControls()

    // Activate and paint the destination tab before requesting its Markdown.
    await renderActive()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    try {
      const result = await chrome.runtime.sendMessage({type: 'lumina:read-remote-markdown', url: cleanRemoteMarkdownURL(sourceURL)})
      if (!result?.ok) throw new Error(result?.error || '读取 Markdown 文档失败')
      doc.source = result.source
      doc.loading = false
      const frame = documentFrames.get(doc.id)
      if (frame) frame._mdrRenderedSource = null
      renderTabs()
      await renderActive()
      updateControls()
    } catch (error) {
      closeDocument(doc.id)
      throw error
    }
    return doc
  })()

  pendingDocumentLinkOpens.set(sourceURL, opening)
  try {
    await opening
    return true
  } catch (error) {
    console.warn('无法在当前窗口打开 Markdown 文档', error)
    return false
  } finally {
    if (pendingDocumentLinkOpens.get(sourceURL) === opening) pendingDocumentLinkOpens.delete(sourceURL)
  }
}

function localFileURLKey(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function localDocumentURL(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    url.search = ''
    return url.href
  } catch {
    return null
  }
}

async function restoreExpandedDirectories() {
  expandedDirectories = new Set()
}

function persistExpandedDirectories() {
  // Expansion state is intentionally session-only and starts collapsed after reload.
}

function treeEntryKey(item) {
  return `${item.rootKey || ''}:${item.kind}:${item.path || item.url || item.name}`
}

function tagRootEntries(entries, rootKey, handle) {
  for (const item of entries || []) {
    item.rootKey = rootKey
    if (handle) item.rootHandle = handle
    if (item.kind === 'directory') tagRootEntries(item.children, rootKey, handle)
  }
}

function updateTreeEntryNode(node, item) {
  node._mdrTreeItem = item
  node.dataset.treeKey = treeEntryKey(item)
  node.dataset.path = item.path || ''
  const link = node.querySelector(':scope > .tree-node-item')
  if (!link) return
  link.dataset.tooltip = item.name || ''

  if (item.kind === 'directory') {
    const name = link.querySelector('.folder-name')
    if (name) {
      name.textContent = item.name
      name.dataset.originalName = item.name
    }
    if (item.url) link.dataset.absolutePath = encodeURIComponent(fileURLToSystemPath(item.url) || '')
    else delete link.dataset.absolutePath
    const children = node.querySelector(':scope > .sub-folder-container')
    if (children) syncTreeContainer(children, item.children || [])
    return
  }

  link.dataset.path = item.path || ''
  if (item.url) link.dataset.url = item.url
  else delete link.dataset.url
  const absolutePath = fileURLToSystemPath(item.url) || findOpenDocument({root: item.rootHandle || rootHandle, relativePath: item.path})?.absolutePath
  if (absolutePath) link.dataset.absolutePath = encodeURIComponent(absolutePath)
  else delete link.dataset.absolutePath
  const name = link.querySelector('.file-name')
  if (name) {
    name.textContent = item.name
    name.dataset.originalName = item.name
  }
}

function createTreeEntryNode(item) {
  const node = document.createElement('li')
  if (item.kind === 'directory') {
    const isOpen = expandedDirectories.has(item.path)
    node.className = `folder-node-li${isOpen ? ' is-open' : ''}`
    const link = document.createElement('a')
    link.href = '#'
    link.className = `tree-node-item is-folder${isOpen ? ' is-open' : ''}`
    link.innerHTML = `<span class="tree-node-content">${SVG_FOLDER_ICON}<span class="folder-name"></span></span>`
    const children = document.createElement('ul')
    children.className = 'sub-folder-container'
    children.style.display = isOpen ? 'block' : 'none'
    node.append(link, children)
    link.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      const itemNow = node._mdrTreeItem
      const shouldOpen = !node.classList.contains('is-open')
      children.style.display = shouldOpen ? 'block' : 'none'
      node.classList.toggle('is-open', shouldOpen)
      link.classList.toggle('is-open', shouldOpen)
      if (shouldOpen) expandedDirectories.add(itemNow.path)
      else expandedDirectories.delete(itemNow.path)
      persistExpandedDirectories()
    })
    link.addEventListener('contextmenu', event => {
      const itemNow = node._mdrTreeItem
      showFolderContextMenu(event, {kind: 'directory', name: itemNow.name, path: itemNow.path, url: itemNow.url || '', element: link})
    })
  } else {
    node.className = 'file-node-li'
    const link = document.createElement('a')
    link.href = '#'
    link.className = 'tree-node-item is-file'
    link.innerHTML = `<span class="tree-node-content">${SVG_FILE_ICON}<span class="file-name"></span></span>`
    node.append(link)
    link.addEventListener('click', async event => {
      event.preventDefault()
      event.stopPropagation()
      const itemNow = node._mdrTreeItem
      try {
        if (itemNow.handle) await readFileHandle(itemNow.handle, {root: itemNow.rootHandle || rootHandle, relativePath: itemNow.path})
        else await openLocalTreeFile(itemNow)
        updateFolderActive()
        link.classList.remove('is-locate-highlight')
        void link.offsetWidth
        link.classList.add('is-locate-highlight')
        setTimeout(() => link.classList.remove('is-locate-highlight'), 1600)
      } catch (error) {
        toast(error.message || '读取文件失败')
      }
    })
    link.addEventListener('contextmenu', event => {
      const itemNow = node._mdrTreeItem
      showFolderContextMenu(event, {kind: 'file', name: itemNow.name, path: itemNow.path, url: itemNow.url || '', handle: itemNow.handle, rootHandle: itemNow.rootHandle, element: link})
    })
  }
  updateTreeEntryNode(node, item)
  return node
}

function syncTreeContainer(container, items) {
  const oldNodes = new Map([...container.children]
    .filter(node => node.dataset.treeKey)
    .map(node => [node.dataset.treeKey, node]))
  const desiredKeys = new Set(items.map(treeEntryKey))

  if (items.length) container.querySelectorAll(':scope > .mdr-folder-empty-li').forEach(node => node.remove())
  items.forEach((item, index) => {
    const key = treeEntryKey(item)
    const node = oldNodes.get(key) || createTreeEntryNode(item)
    updateTreeEntryNode(node, item)
    const currentAtIndex = container.children[index]
    if (currentAtIndex !== node) container.insertBefore(node, currentAtIndex || null)
    oldNodes.delete(key)
  })
  for (const node of oldNodes.values()) node.remove()

  if (!items.length && !container.querySelector(':scope > .mdr-folder-empty-li')) {
    const emptyLi = document.createElement('li')
    emptyLi.className = 'mdr-folder-empty-li'
    emptyLi.title = '该目录下暂无可预览的 Markdown 文件'
    emptyLi.dataset.tooltip = '暂无 Markdown 文件'
    emptyLi.innerHTML = '<div class="tree-node-item is-folder-status is-folder-empty"><span class="tree-node-content"><span class="folder-status-text">(暂无 Markdown)</span></span></div>'
    container.append(emptyLi)
  }
}

function flattenTreeEntries(entries, result = new Map()) {
  for (const item of entries || []) {
    result.set(treeEntryKey(item), item)
    if (item.kind === 'directory') flattenTreeEntries(item.children, result)
  }
  return result
}

function reconcileDirectoryTree(entries) {
  const container = ui.files.querySelector('.is-root-folder > .sub-folder-container')
  if (!container) {
    renderFiles()
    return
  }
  syncTreeContainer(container, entries)
  filterFiles(ui.search.value)
  updateFolderActive()
}

function tabMatchesDeletedEntry(doc, entry) {
  if (entry.rootHandle && doc.root === entry.rootHandle && doc.relativePath) {
    if (entry.kind === 'file') return doc.relativePath === entry.path
    return doc.relativePath === entry.path || doc.relativePath.startsWith(`${entry.path}/`)
  }
  const documentURL = localFileURLKey(doc.sourceURL)
  if (!documentURL || !entry.url) return false
  if (entry.kind === 'file') return documentURL === localFileURLKey(entry.url)
  try {
    const directoryPath = new URL(entry.url).pathname.replace(/\/?$/, '/')
    return new URL(documentURL).pathname.startsWith(directoryPath)
  } catch { return false }
}

function presentTreeChanges(added, removed) {
  const collapseDescendants = items => items.filter(item => !items.some(parent => parent.kind === 'directory' && parent.path !== item.path && item.path.startsWith(`${parent.path}/`)))
  const visibleAdded = collapseDescendants(added)
  const visibleRemoved = collapseDescendants(removed)
  const total = visibleAdded.length + visibleRemoved.length
  const formatEntry = item => `${item.kind === 'directory' ? '目录' : '文件'} ${item.path || item.name}`

  if (visibleAdded.length && !visibleRemoved.length) {
    const first = visibleAdded[0]
    showDirectoryChangeNotice({
      typeKey: visibleAdded.length > 1 ? 'batch' : 'add',
      changeType: visibleAdded.length > 1 ? '批量新增' : `新增${first.kind === 'directory' ? '目录' : '文件'}`,
      fileName: visibleAdded.length > 1 ? `${formatEntry(first)} 等 ${visibleAdded.length} 项` : formatEntry(first),
      detail: '目录树已更新',
      addedCount: visibleAdded.length,
    })
    return
  }
  if (visibleRemoved.length && !visibleAdded.length) {
    const first = visibleRemoved[0]
    showDirectoryChangeNotice({
      typeKey: visibleRemoved.length > 1 ? 'batch' : 'delete',
      changeType: visibleRemoved.length > 1 ? '批量删除' : `删除${first.kind === 'directory' ? '目录' : '文件'}`,
      fileName: visibleRemoved.length > 1 ? `${formatEntry(first)} 等 ${visibleRemoved.length} 项` : formatEntry(first),
      detail: '目录树已更新',
      deletedCount: visibleRemoved.length,
    })
    return
  }
  if (total) {
    showDirectoryChangeNotice({
      typeKey: 'batch',
      changeType: '目录变更',
      fileName: `共 ${total} 项变动`,
      detail: '目录树已更新',
      addedCount: visibleAdded.length,
      deletedCount: visibleRemoved.length,
    })
  }
}

function renderFiles() {
  ui.files.replaceChildren()
  const roots = getDirectoryRootDescriptors()
  if (!roots.length) {
    const emptyWrap = document.createElement('div')
    emptyWrap.className = 'mdr-folder-empty-state'
    emptyWrap.innerHTML = `
      <div class="mdr-folder-empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          <line x1="12" y1="11" x2="12" y2="17"/>
          <line x1="9" y1="14" x2="15" y2="14"/>
        </svg>
      </div>
      <div class="mdr-folder-empty-title">暂无打开的目录</div>
      <div class="mdr-folder-empty-desc">${escapeHtml(localTreeError || '点击上方“打开目录”或拖拽文件夹至窗口浏览')}</div>
    `
    ui.files.append(emptyWrap)
    return
  }

  const panelDiv = document.createElement('div')
  panelDiv.id = 'panel-folder'

  const rootUl = document.createElement('ul')
  rootUl.className = 'mdr-folder-tree mdr-multi-root-tree'

  for (const root of roots) {
    const rootName = root.handle?.name || root.localRoot?.name || '文档目录'
    const rootKey = root.rootKey || (root.handle === rootHandle ? primaryRootTreeId : root.localRoot?.url || primaryRootTreeId || crypto.randomUUID())
    tagRootEntries(root.entries, rootKey, root.handle)
    const rootLi = document.createElement('li')
    rootLi.className = 'folder-node-li is-root-folder is-open'
    rootLi.innerHTML = `
      <a href="#" class="tree-node-item is-folder is-root-item is-open" data-tooltip="${escapeHtml(rootName)}">
        <span class="tree-node-content">${SVG_FOLDER_ICON}<span class="folder-name">${escapeHtml(rootName)}</span></span>
        <button class="root-folder-remove-btn" title="移除目录" aria-label="移除目录">×</button>
      </a>
      <ul class="sub-folder-container" style="display:block"></ul>
    `
    const subContainer = rootLi.querySelector('.sub-folder-container')
    const rootItem = rootLi.querySelector('.tree-node-item.is-root-item')
    const rootURL = root.localRoot?.url || ''
    const absoluteRootPath = fileURLToSystemPath(rootURL)
    if (absoluteRootPath) rootItem.dataset.absolutePath = encodeURIComponent(absoluteRootPath)
    rootItem.addEventListener('click', event => {
      if (event.target.closest('.root-folder-remove-btn')) return
      event.preventDefault()
      event.stopPropagation()
      const nextOpen = !rootLi.classList.contains('is-open')
      subContainer.style.display = nextOpen ? 'block' : 'none'
      rootLi.classList.toggle('is-open', nextOpen)
      rootItem.classList.toggle('is-open', nextOpen)
    })
    rootItem.addEventListener('contextmenu', event => showFolderContextMenu(event, {
      kind: 'root', name: rootName, path: rootURL || rootName, url: rootURL, element: rootItem, rootRef: root,
    }))
    rootLi.querySelector('.root-folder-remove-btn').addEventListener('click', event => {
      event.stopPropagation()
      removeDirectoryRoot(root)
      renderFiles()
      toast('已移除打开的目录')
    })
    if (root.entries?.length) syncTreeContainer(subContainer, root.entries)
    else {
      const emptyLi = document.createElement('li')
      emptyLi.className = 'mdr-folder-empty-li'
      emptyLi.title = '该目录下暂无可预览的 Markdown 文件'
      emptyLi.dataset.tooltip = '暂无 Markdown 文件'
      emptyLi.innerHTML = '<div class="tree-node-item is-folder-status is-folder-empty"><span class="tree-node-content"><span class="folder-status-text">(暂无 Markdown 文件)</span></span></div>'
      subContainer.append(emptyLi)
    }
    rootUl.append(rootLi)
  }
  panelDiv.append(rootUl)
  ui.files.append(panelDiv)

  filterFiles(ui.search.value)
  updateFolderActive()
}

function removeDirectoryRoot(root) {
  if (!root) return
  if (root.handle && root.handle === rootHandle) {
    rootHandle = null
    primaryRootTreeId = ''
    rootEntries = []
    fileIndex = []
  } else if (root.localRoot && root.localRoot === localTreeRoot) {
    localTreeRoot = null
    primaryRootTreeId = ''
    rootEntries = []
  } else {
    additionalDirectoryRoots = additionalDirectoryRoots.filter(item => item !== root)
  }
  expandedDirectories.clear()
}

function renderFileSearchTypes(counts, visible) {
  ui.fileSearchTypes.replaceChildren()
  ui.fileSearchTypes.hidden = !visible
  if (!visible) return

  const pillsWrap = document.createElement('div')
  pillsWrap.className = 'mdr-scope-pills'

  const types = [
    ['all', '全部', counts.all],
    ['directory', '目录', counts.directory],
    ['file', '文件', counts.file],
  ]

  for (const [type, label, count] of types) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `mdr-scope-pill${fileSearchType === type ? ' is-active' : ''}`
    button.dataset.type = type
    button.setAttribute('aria-pressed', String(fileSearchType === type))
    button.innerHTML = `<span>${label}</span><span class="mdr-scope-count">${count}</span>`
    button.addEventListener('click', () => {
      fileSearchType = type
      filterFiles(ui.search.value)
    })
    pillsWrap.append(button)
  }

  const activeCount = fileSearchType === 'all' ? counts.all : (fileSearchType === 'directory' ? counts.directory : counts.file)
  const badge = document.createElement('div')
  badge.className = 'mdr-search-count-badge'
  badge.textContent = `${activeCount} 项匹配`

  ui.fileSearchTypes.append(pillsWrap, badge)
}

function filterFiles(query) {
  ui.fileSearchTypes.classList.remove('is-loading')
  const needle = query.trim().toLocaleLowerCase()
  const counts = {directory: 0, file: 0, all: 0}

  const rootFolderUl = ui.files.querySelector('.mdr-multi-root-tree')
  if (!rootFolderUl) return

  // 移除旧搜索空状态
  ui.files.querySelector('.mdr-folder-search-empty')?.remove()

  if (!needle) {
    renderFileSearchTypes(counts, false)
    rootFolderUl.style.display = ''
    rootFolderUl.querySelectorAll('.folder-node-li, .file-node-li').forEach(el => {
      el.style.display = ''
    })
    rootFolderUl.querySelectorAll('.folder-name, .file-name').forEach(el => {
      const orig = el.dataset.originalName
      if (orig) el.textContent = orig
    })
    rootFolderUl.querySelectorAll('.mdr-search-result-kind').forEach(el => el.remove())
    rootFolderUl.querySelectorAll('.folder-node-li:not(.is-root-folder)').forEach(li => {
      const path = li.dataset.path
      const sub = li.querySelector(':scope > .sub-folder-container')
      const dirItem = li.querySelector(':scope > .tree-node-item.is-folder')
      const isOpen = expandedDirectories.has(path)
      if (sub) sub.style.display = isOpen ? 'block' : 'none'
      li.classList.toggle('is-open', isOpen)
      dirItem?.classList.toggle('is-open', isOpen)
    })
    const rootLi = rootFolderUl.querySelector('.is-root-folder')
    if (rootLi) {
      const sub = rootLi.querySelector(':scope > .sub-folder-container')
      const rootItem = rootLi.querySelector(':scope > .tree-node-item.is-folder')
      const isRootOpen = rootLi.classList.contains('is-open')
      if (sub) sub.style.display = isRootOpen ? 'block' : 'none'
      rootItem?.classList.toggle('is-open', isRootOpen)
    }
    return
  }

  const visitContainer = (ul) => {
    let hasVisibleChild = false
    const lis = Array.from(ul.children).filter(c => c.tagName === 'LI')
    for (const li of lis) {
      if (li.classList.contains('is-root-folder')) {
        const sub = li.querySelector(':scope > .sub-folder-container')
        const subHasVisible = sub ? visitContainer(sub) : false
        li.style.display = subHasVisible ? '' : 'none'
        if (subHasVisible) hasVisibleChild = true
        continue
      }

      if (li.classList.contains('folder-node-li')) {
        const dirItem = li.querySelector(':scope > .tree-node-item.is-folder')
        const nameEl = dirItem?.querySelector('.folder-name')
        if (nameEl && !nameEl.dataset.originalName) nameEl.dataset.originalName = nameEl.textContent
        const origName = nameEl?.dataset.originalName || ''
        const ownMatch = origName.toLocaleLowerCase().includes(needle)
        if (ownMatch) counts.directory++

        const sub = li.querySelector(':scope > .sub-folder-container')
        const subHasVisible = sub ? visitContainer(sub) : false

        const matchScope = fileSearchType === 'all' || fileSearchType === 'directory'
        const isSelfVisible = ownMatch && matchScope
        const isVisible = isSelfVisible || subHasVisible

        li.style.display = isVisible ? '' : 'none'
        if (isVisible) {
          hasVisibleChild = true
          if (sub) sub.style.display = 'block'
          li.classList.add('is-open')
          dirItem?.classList.add('is-open')
        }

        dirItem?.querySelector('.mdr-search-result-kind')?.remove()
        if (ownMatch && nameEl) {
          nameEl.innerHTML = renderHighlightedText(origName, needle)
          dirItem?.querySelector('.tree-node-content')?.insertAdjacentHTML('beforeend', '<span class="mdr-search-result-kind">目录</span>')
        } else if (nameEl) {
          nameEl.textContent = origName
        }
      } else if (li.classList.contains('file-node-li')) {
        const fileItem = li.querySelector(':scope > .tree-node-item.is-file')
        const nameEl = fileItem?.querySelector('.file-name')
        if (nameEl && !nameEl.dataset.originalName) nameEl.dataset.originalName = nameEl.textContent
        const origName = nameEl?.dataset.originalName || ''
        const ownMatch = origName.toLocaleLowerCase().includes(needle)
        if (ownMatch) counts.file++

        const matchScope = fileSearchType === 'all' || fileSearchType === 'file'
        const isVisible = ownMatch && matchScope

        li.style.display = isVisible ? '' : 'none'
        if (isVisible) hasVisibleChild = true

        fileItem?.querySelector('.mdr-search-result-kind')?.remove()
        if (ownMatch && nameEl) {
          nameEl.innerHTML = renderHighlightedText(origName, needle)
          fileItem?.querySelector('.tree-node-content')?.insertAdjacentHTML('beforeend', '<span class="mdr-search-result-kind">文件</span>')
        } else if (nameEl) {
          nameEl.textContent = origName
        }
      }
    }
    return hasVisibleChild
  }

  const hasVisible = visitContainer(rootFolderUl)
  counts.all = counts.directory + counts.file
  renderFileSearchTypes(counts, true)

  const activeCount = fileSearchType === 'all' ? counts.all : (fileSearchType === 'directory' ? counts.directory : counts.file)

  if (activeCount === 0 || !hasVisible) {
    rootFolderUl.style.display = 'none'
    const empty = document.createElement('div')
    empty.className = 'mdr-search-empty mdr-folder-search-empty'
    empty.innerHTML = `
      <div class="empty-icon-wrap">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="3"/>
          <path d="m14.5 15.5 2 2"/>
        </svg>
      </div>
      <div class="empty-main-text">未找到匹配的目录或文件</div>
      <div class="empty-sub-text">尝试使用更简短的名称，或检查拼写是否有误</div>
    `
    ui.files.append(empty)
  } else {
    rootFolderUl.style.display = ''
  }
}

function reportDirectoryChanges(added, removed) {
  if (!added.length && !removed.length) return
  for (const doc of [...docs]) {
    if (removed.some(entry => tabMatchesDeletedEntry(doc, entry))) closeDocument(doc.id)
  }
  reconcileDirectoryTree(rootEntries)
  presentTreeChanges(added, removed)
}

async function pollDirectoryTree() {
  if (liveDirectoryScanRunning) return
  if (!getDirectoryRootDescriptors().length) return
  liveDirectoryScanRunning = true
  try {
    const previousMap = new Map()
    for (const root of getDirectoryRootDescriptors()) {
      for (const [key, item] of flattenTreeEntries(root.entries)) previousMap.set(key, item)
    }

    if (rootHandle) await refreshFileIndex()
    else if (localTreeRoot) {
      const result = await readLocalDirectoryTree(location.href)
      localTreeRoot = result.root
      primaryRootTreeId = result.root?.url || primaryRootTreeId
      tagRootEntries(result.entries, primaryRootTreeId)
      rootEntries = result.entries
    }

    for (const root of additionalDirectoryRoots) {
      if (!root.handle) continue
      const nextFileIndex = []
      const scan = async (directory, relative = '') => {
        const entries = []
        for await (const [name, handle] of directory.entries()) {
          if (name.startsWith('.')) continue
          const path = relative ? `${relative}/${name}` : name
          if (handle.kind === 'directory') {
            entries.push({kind: 'directory', name, path, handle, rootHandle: root.handle, rootKey: root.rootKey, children: await scan(handle, path)})
          } else if (/\.(md|markdown|mdown|mkd|mdx|mdc|txt)$/i.test(name)) {
            const item = {kind: 'file', name, path, handle, rootHandle: root.handle, rootKey: root.rootKey}
            entries.push(item)
            nextFileIndex.push(item)
          }
        }
        return entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', {numeric: true}) : a.kind === 'directory' ? -1 : 1)
      }
      root.entries = await scan(root.handle)
      root.fileIndex = nextFileIndex
    }

    const nextMap = new Map()
    for (const root of getDirectoryRootDescriptors()) {
      for (const [key, item] of flattenTreeEntries(root.entries)) nextMap.set(key, item)
    }
    const removed = [...previousMap].filter(([key]) => !nextMap.has(key)).map(([, item]) => item)
    const added = [...nextMap].filter(([key]) => !previousMap.has(key)).map(([, item]) => item)
    if (added.length || removed.length) {
      renderFiles()
      for (const doc of [...docs]) {
        if (removed.some(entry => tabMatchesDeletedEntry(doc, entry))) closeDocument(doc.id)
      }
      presentTreeChanges(added, removed)
    }
  } catch {
    // Preserve the last successfully scanned tree during transient read errors.
  } finally {
    liveDirectoryScanRunning = false
  }
}

function isDocumentListedInTree(doc) {
  const entries = getDirectoryRootDescriptors().flatMap(root => [...flattenTreeEntries(root.entries).values()])
  const key = localFileURLKey(doc.sourceURL)
  if (key) return entries.some(item => item.kind === 'file' && localFileURLKey(item.url) === key)
  if (doc.root && doc.relativePath) {
    return entries.some(item => item.kind === 'file' && item.rootHandle === doc.root && item.path === doc.relativePath)
  }
  return true
}

function scheduleActiveDocumentScan() {
  activeDocumentScanGeneration++
  clearTimeout(activeDocumentScanTimer)
  activeDocumentScanTimer = setTimeout(() => void pollActiveDocument(), 100)
}

async function pollActiveDocument() {
  const doc = activeDoc()
  // Opening a document marks it active before its first source read finishes.
  // Do not compare that source against the temporary empty string: the poll
  // could otherwise mistake the initial load for an external file edit.
  if (!doc || doc.loading || doc.loaded === false || typeof doc.source !== 'string' || activeDocumentScanRunning) return
  activeDocumentScanRunning = true
  const generation = activeDocumentScanGeneration
  try {
    let source
    if (doc.handle) {
      if (await doc.handle.queryPermission({mode: 'read'}) !== 'granted') return
      const file = await doc.handle.getFile()
      source = await file.text()
      doc.lastModified = file.lastModified
    } else if (doc.sourceURL && localFileURLKey(doc.sourceURL)) {
      const result = await chrome.runtime.sendMessage({type: 'lumina:read-local-markdown', fileURL: localFileURLKey(doc.sourceURL)})
      if (!result?.ok) {
        await pollDirectoryTree()
        if (activeId === doc.id && !isDocumentListedInTree(doc)) {
          const missingCount = (missingActiveDocumentScans.get(doc.id) || 0) + 1
          missingActiveDocumentScans.set(doc.id, missingCount)
          if (missingCount >= 2) {
            closeDocument(doc.id)
            showDirectoryChangeNotice({typeKey: 'delete', changeType: '删除文件', fileName: `文件 ${doc.title}`, detail: '已从打开的标签中移除'})
          }
        }
        return
      }
      source = result.source
    } else {
      return
    }

    if (generation !== activeDocumentScanGeneration || activeId !== doc.id) return
    missingActiveDocumentScans.delete(doc.id)
    if (doc.sourceFromLoadedPage) {
      doc.sourceFromLoadedPage = false
      if (source !== doc.source) {
        doc.source = source
        const frame = documentFrames.get(doc.id)
        if (frame) frame._mdrRenderedSource = source
      }
      return
    }
    if (source !== doc.source) {
      doc.source = source
      await renderActive()
      showDirectoryChangeNotice({typeKey: 'modify', changeType: '文件已更新', fileName: `文件 ${doc.title}`, detail: '已同步外部变更并重新渲染'})
    }
  } catch (error) {
    if (error?.name === 'NotFoundError' && activeId === doc.id) {
      closeDocument(doc.id)
      showDirectoryChangeNotice({typeKey: 'delete', changeType: '删除文件', fileName: `文件 ${doc.title}`, detail: '已从打开的标签中移除'})
    }
  } finally {
    activeDocumentScanRunning = false
    if (generation !== activeDocumentScanGeneration && activeDoc()) void pollActiveDocument()
  }
}

function startLiveWatchers() {
  clearInterval(liveDirectoryTimer)
  clearInterval(liveDocumentTimer)
  liveDirectoryTimer = setInterval(() => void pollDirectoryTree(), 2500)
  liveDocumentTimer = setInterval(() => void pollActiveDocument(), 2000)
  void pollDirectoryTree()
  void pollActiveDocument()
}

async function exportPNG(doc = activeDoc()) {
  if (!doc) return
  const task = startExportTask('PNG', doc)
  const contentRoot = documentFrames.get(doc.id)?.contentDocument?.querySelector('#mdr-content-root')
  const target = getDocumentExportTarget(doc, contentRoot)
  if (!target) {
    finishExportTask(task, 'failed', '文档渲染尚未完成')
    return
  }

  const pixelRatio = preferences.imageExportPixelRatio
  const maximumPixelHeight = Math.max(MIN_IMAGE_EXPORT_HEIGHT, Math.min(MAX_IMAGE_EXPORT_HEIGHT, Number(preferences.imageExportMaximumHeight) || DEFAULT_IMAGE_EXPORT_HEIGHT))
  let outputBlob = null
  let outputURL = ''
  let imageWorker
  const pageRoots = []
  const sourceImages = Array.from(target.querySelectorAll('img'))
  acquireExportImages(sourceImages)
  try {
    if (sourceImages.length) {
      await waitForBrowserPaint()
      let loadedImageCount = 0
      updateExportTask(task, {progressText: '加载图片', detail: `0/${sourceImages.length}`})
      await Promise.all(sourceImages.map(image => new Promise(resolve => {
        if (image.complete) {
          loadedImageCount++
          updateExportTask(task, {progress: loadedImageCount / sourceImages.length * 0.15, progressText: '加载图片', detail: `${loadedImageCount}/${sourceImages.length}`})
          return resolve()
        }
        const finish = () => {
          clearTimeout(timeout)
          image.removeEventListener('load', finish)
          image.removeEventListener('error', finish)
          loadedImageCount++
          updateExportTask(task, {progress: loadedImageCount / sourceImages.length * 0.15, progressText: '加载图片', detail: `${loadedImageCount}/${sourceImages.length}`})
          resolve()
        }
        const timeout = setTimeout(finish, 8000)
        image.addEventListener('load', finish, {once: true})
        image.addEventListener('error', finish, {once: true})
      })))
    }

    await documentFrames.get(doc.id)?.contentDocument?.fonts?.ready
    const frameDocument = documentFrames.get(doc.id)?.contentDocument
    const exportImageData = await prepareExportImageData(sourceImages, doc)
    const rect = target.getBoundingClientRect()
    const width = Math.ceil(rect.width)
    if (!frameDocument || width <= 0) throw new Error('文档内容为空')
    const measureClone = cloneForExport(target, exportImageData)
    Object.assign(measureClone.style, {
      position: 'fixed', left: '0', top: '0', opacity: '0', pointerEvents: 'none',
      width: `${width}px`, maxWidth: 'none', height: 'auto', maxHeight: 'none',
      minHeight: '0', margin: '0', boxSizing: 'border-box', overflow: 'visible',
    })
    frameDocument.body.append(measureClone)
    let contentHeight
    try {
      await waitForBrowserPaint()
      contentHeight = Math.ceil(Math.max(measureClone.scrollHeight, measureClone.getBoundingClientRect().height))
    } finally {
      measureClone.remove()
    }
    if (contentHeight <= 0) throw new Error('文档内容为空')

    const maximumSliceHeight = Math.max(1, Math.floor(maximumPixelHeight / pixelRatio))
    const imageCount = Math.ceil(contentHeight / maximumSliceHeight)
    const backgroundColor = document.documentElement.dataset.theme === 'dark' ? '#0d1117' : '#ffffff'
    const baseName = safeName(doc.title.replace(/\.[^.]+$/, ''))
    updateExportTask(task, {progress: 0.15, progressText: '准备 PNG 分片', detail: `0/${imageCount} 张`})
    if (imageCount > 1) {
      imageWorker = createImageExportWorker()
      await imageWorker.request('init', {zip: true})
    }
    for (let index = 0; index < imageCount; index++) {
      assertExportNotCancelled(task)
      const offsetY = index * maximumSliceHeight
      const sliceHeight = Math.min(maximumSliceHeight, contentHeight - offsetY)
      updateExportTask(task, {progress: 0.15 + index / imageCount * 0.8, progressText: '生成 PNG 分片', detail: `${index}/${imageCount} 张`})
      await waitForBrowserPaint()

      const pageRoot = frameDocument.createElement('div')
      pageRoot.className = 'mdr-export-image-slice'
      pageRoots.push(pageRoot)
      Object.assign(pageRoot.style, {
        position: 'fixed', left: '0', top: '0', zIndex: '2147483647',
        opacity: '0', pointerEvents: 'none', width: `${width}px`, height: `${sliceHeight}px`,
        minHeight: '0', maxHeight: 'none', boxSizing: 'border-box', margin: '0', padding: '0', overflow: 'hidden',
        backgroundColor,
      })
      const contentClone = cloneForExport(target, exportImageData)
      Object.assign(contentClone.style, {
        position: 'absolute', left: '0', top: `${-offsetY}px`,
        width: `${width}px`, maxWidth: 'none', height: 'auto', maxHeight: 'none',
        minHeight: '0', margin: '0', boxSizing: 'border-box', overflow: 'visible',
      })
      pageRoot.append(contentClone)
      frameDocument.body.append(pageRoot)
      await waitForBrowserPaint()

      const blob = await toBlob(pageRoot, {
        cacheBust: true,
        width,
        height: sliceHeight,
        canvasWidth: width,
        canvasHeight: sliceHeight,
        pixelRatio,
        backgroundColor,
        style: {opacity: '1'},
      })
      assertExportNotCancelled(task)
      if (!blob) throw new Error(`第 ${index + 1} 张图片生成失败`)
      if (imageWorker) {
        await imageWorker.request('add-page', {
          blob,
          filename: `${baseName}_${index + 1}.png`,
        })
      } else {
        outputBlob = blob
      }
      updateExportTask(task, {progress: 0.15 + (index + 1) / imageCount * 0.8, progressText: '生成 PNG 分片', detail: `${index + 1}/${imageCount} 张`})
      pageRoot.remove()
      pageRoots.pop()
      await waitForBrowserPaint()
    }

    if (imageWorker) {
      assertExportNotCancelled(task)
      updateExportTask(task, {progress: 0.97, progressText: '打包 ZIP', detail: `${imageCount} 张`})
      const archiveResult = await imageWorker.request('finish')
      if (archiveResult.pageCount !== imageCount) {
        throw new Error(`分片数量不一致：计划 ${imageCount} 张，实际打包 ${archiveResult.pageCount} 张`)
      }
      outputBlob = archiveResult.blob
    }
    outputURL = URL.createObjectURL(outputBlob)
    const anchor = document.createElement('a')
    anchor.href = outputURL
    anchor.download = imageCount > 1 ? `${baseName}.zip` : `${baseName}.png`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(outputURL), 60_000)
    task.detail = imageCount > 1 ? `已打包 ${imageCount} 张 PNG` : 'PNG 图片已下载'
    finishExportTask(task, 'completed')
  } catch (error) {
    if (outputURL) URL.revokeObjectURL(outputURL)
    if (task.cancelRequested) {
      finishExportTask(task, 'cancelled')
    } else {
      finishExportTask(task, 'failed', error.message || String(error))
    }
  } finally {
    imageWorker?.cancel()
    pageRoots.forEach(pageRoot => pageRoot.remove())
    releaseExportImages(sourceImages)
  }
}

async function exportPDF(doc = activeDoc()) {
  if (!doc) return
  const task = startExportTask('PDF', doc)
  let currentPage = 0
  let pdfInitialized = false
  const pdfSessionId = crypto.randomUUID()
  let sourceImages = []

  try {
    const frame = documentFrames.get(doc.id)
    const frameDocument = frame?.contentDocument
    const contentRoot = frameDocument?.querySelector('#mdr-content-root')
    const target = getDocumentExportTarget(doc, contentRoot)
    if (!frameDocument || !target || !target.children.length) throw new Error('文档渲染尚未完成')

    await frameDocument.fonts?.ready
    sourceImages = Array.from(target.querySelectorAll('img'))
    acquireExportImages(sourceImages)
    if (sourceImages.length) {
      updateExportTask(task, {progressText: '加载图片', detail: `0/${sourceImages.length}`})
      await waitForBrowserPaint()
      let settledImages = 0
      await Promise.all(sourceImages.map(image => new Promise(resolve => {
        if (image.complete) {
          settledImages++
          return resolve()
        }
        const finish = () => {
          clearTimeout(timeout)
          image.removeEventListener('load', finish)
          image.removeEventListener('error', finish)
          settledImages++
          updateExportTask(task, {progress: settledImages / sourceImages.length * 0.1, progressText: '加载图片', detail: `${settledImages}/${sourceImages.length}`})
          resolve()
        }
        const timeout = setTimeout(finish, 8000)
        image.addEventListener('load', finish, {once: true})
        image.addEventListener('error', finish, {once: true})
      })))
      await waitForBrowserPaint()
    }

    const exportImageData = await prepareExportImageData(sourceImages, doc)

    const sourceRect = target.getBoundingClientRect()
    const sourceWidth = Math.ceil(sourceRect.width)
    if (!sourceWidth || !target.scrollHeight) throw new Error('文档内容为空')

    const pdfPageWidth = 595.28
    const pdfPageHeight = 841.89
    const margin = 36
    const printableWidth = pdfPageWidth - margin * 2
    const printableHeight = pdfPageHeight - margin * 2
    const scale = printableWidth / sourceWidth
    const maxSliceHeight = Math.max(1, Math.floor(printableHeight / scale))
    const pagePadding = 80
    const pageContentLimit = Math.max(1, maxSliceHeight - pagePadding)
    const blockElements = doc.sourceView ? [target] : Array.from(target.children).filter(element => !element.hasAttribute('data-export-ignore'))
    const blocks = []
    for (let index = 0; index < blockElements.length; index++) {
      const element = blockElements[index]
      const style = frame.contentWindow.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const marginTop = parseFloat(style.marginTop) || 0
      const marginBottom = parseFloat(style.marginBottom) || 0
      blocks.push({element, height: Math.ceil(rect.height + marginTop + marginBottom)})
      if ((index + 1) % 150 === 0) {
        updateExportTask(task, {progress: 0.1 + (index + 1) / blockElements.length * 0.1, progressText: '分析文档版面', detail: `${index + 1}/${blockElements.length} 个内容块`})
        await waitForBrowserPaint()
      }
    }
    const pages = []
    let pageBlocks = []
    let pageContentHeight = 0
    const flushPage = () => {
      if (!pageBlocks.length) return
      pages.push({blocks: pageBlocks, contentHeight: pageContentHeight, scale: 1})
      pageBlocks = []
      pageContentHeight = 0
    }
    for (const block of blocks) {
      if (block.height > pageContentLimit) {
        flushPage()
        pages.push({blocks: [block], contentHeight: pageContentLimit, scale: pageContentLimit / block.height})
        continue
      }
      if (pageBlocks.length && pageContentHeight + block.height > pageContentLimit) flushPage()
      pageBlocks.push(block)
      pageContentHeight += block.height
    }
    flushPage()
    if (!pages.length) throw new Error('文档中没有可导出的内容')
    updateExportTask(task, {progress: 0.2, progressText: '生成 PDF 页面', detail: `0/${pages.length} 页`})

    const backgroundColor = getComputedStyle(target).backgroundColor || (document.documentElement.dataset.theme === 'dark' ? '#0d1117' : '#ffffff')
    let omittedImages = 0
    await requestPDFWorker('init', pdfSessionId)
    pdfInitialized = true
    for (let index = 0; index < pages.length; index++) {
      assertExportNotCancelled(task)
      const page = pages[index]
      currentPage = index + 1
      updateExportTask(task, {progress: 0.2 + index / pages.length * 0.75, progressText: '渲染 PDF 页面', detail: `${index + 1}/${pages.length} 页`})
      await waitForBrowserPaint()
      const pageRoot = frameDocument.createElement('div')
      pageRoot.className = 'mdr-content'
      const pageHeight = Math.max(pagePadding, Math.min(maxSliceHeight, Math.ceil(pagePadding + page.contentHeight * page.scale)))
      Object.assign(pageRoot.style, {
        position: 'fixed', left: '0', top: '0', zIndex: '2147483647', opacity: '0',
        pointerEvents: 'none', width: `${sourceWidth}px`, height: `${pageHeight}px`,
        minHeight: '0', boxSizing: 'border-box', padding: '40px 48px', margin: '0',
        overflow: 'hidden', backgroundColor,
      })
      for (const block of page.blocks) {
        const clone = cloneForExport(block.element, exportImageData)
        if (page.scale < 1) {
          clone.style.transform = `scale(${page.scale})`
          clone.style.transformOrigin = 'top left'
        }
        pageRoot.append(clone)
      }
      frameDocument.body.append(pageRoot)
      const actualHeight = Math.max(pagePadding, Math.min(maxSliceHeight, Math.ceil(pageRoot.scrollHeight)))
      pageRoot.style.height = `${actualHeight}px`
      let image
      try {
        image = await toJpeg(pageRoot, {
          cacheBust: true,
          width: sourceWidth,
          height: actualHeight,
          canvasWidth: sourceWidth,
          canvasHeight: actualHeight,
          pixelRatio: 1.2,
          backgroundColor,
          quality: 0.88,
          style: {position: 'fixed', left: '0px', top: '0px', opacity: '1'},
          filter: node => !(node.nodeType === 1 && node.matches('.mdr-mermaid-controls,.mdr-block__copy-btn')),
          onImageErrorHandler: event => {
            omittedImages++
            const imageElement = event?.target
            if (imageElement?.style) imageElement.style.visibility = 'hidden'
            console.warn('PDF 导出时跳过无法捕获的图片:', imageElement?.currentSrc || imageElement?.src || '未知图片')
          },
        })
      } finally {
      pageRoot.remove()
    }
      assertExportNotCancelled(task)
      await requestPDFWorker('add-page', pdfSessionId, {pageIndex: index, image, x: margin, y: margin, width: printableWidth, height: actualHeight * scale})
      assertExportNotCancelled(task)
      updateExportTask(task, {progress: 0.2 + (index + 1) / pages.length * 0.75, progressText: '写入 PDF 页面', detail: `${index + 1}/${pages.length} 页`})
      await waitForBrowserPaint()
    }
    assertExportNotCancelled(task)
    updateExportTask(task, {progress: 0.98, progressText: '生成 PDF 文件', detail: `${pages.length} 页`})
    await waitForBrowserPaint()
    const response = await requestPDFWorker('finish', pdfSessionId)
    pdfInitialized = false
    const blobURL = URL.createObjectURL(response.blob)
    const anchor = document.createElement('a')
    anchor.href = blobURL
    anchor.download = `${safeName(doc.title.replace(/\.[^.]+$/, ''))}.pdf`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(blobURL), 60_000)
    task.detail = omittedImages ? `PDF 已下载；${omittedImages} 张图片无法捕获` : 'PDF 文件已下载'
    finishExportTask(task, 'completed')
  } catch (error) {
    if (task.cancelRequested) {
      finishExportTask(task, 'cancelled')
      return
    }
    console.error(`PDF 导出失败（第 ${currentPage || 1} 页）:`, error)
    const reason = error && typeof error === 'object' && 'type' in error && 'target' in error
      ? `${error.type || '资源'}加载事件失败${error.target?.currentSrc || error.target?.src ? `：${error.target.currentSrc || error.target.src}` : ''}`
      : (error?.message || String(error))
    finishExportTask(task, 'failed', reason)
  } finally {
    if (pdfInitialized) void requestPDFWorker('cancel', pdfSessionId).catch(() => {})
    releaseExportImages(sourceImages)
  }
}

function setPanel(name) {
  document.querySelectorAll('.sidebar-tabs button').forEach(button => {
    const isActive = button.dataset.panel === name
    button.classList.toggle('active', isActive)
    button.setAttribute('aria-selected', String(isActive))
  })
  ui.outline.hidden = name !== 'outline'
  ui.files.hidden = name !== 'files'
  ui.tasks.hidden = name !== 'tasks'
  ui.search.hidden = name === 'tasks'
  if (name !== 'files') ui.fileSearchTypes.hidden = true
  ui.search.placeholder = name === 'outline' ? '搜索大纲标题…' : '搜索目录和文件名…'
  if (name === 'files') {
    filterFiles(ui.search.value)
    updateFolderActive()
  }
}

// ==========================================================================
// 全屏文件与目录拖放 (Drag & Drop)
// ==========================================================================
function foldGlobalSearchText(value) {
  return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

function highlightGlobalSearchText(value, query) {
  const text = String(value || '')
  const needle = foldGlobalSearchText(query).trim()
  if (!needle) return escapeHtml(text)
  let folded = ''
  const starts = []
  const ends = []
  for (let offset = 0; offset < text.length;) {
    const point = String.fromCodePoint(text.codePointAt(offset))
    const nextOffset = offset + point.length
    const normalized = foldGlobalSearchText(point)
    for (let index = 0; index < normalized.length; index++) {
      folded += normalized[index]
      starts.push(offset)
      ends.push(nextOffset)
    }
    offset = nextOffset
  }
  let html = ''
  let sourceOffset = 0
  let foldedOffset = 0
  let matchIndex = folded.indexOf(needle)
  while (matchIndex >= 0) {
    const start = starts[matchIndex]
    const end = ends[matchIndex + needle.length - 1]
    html += `${escapeHtml(text.slice(sourceOffset, start))}<mark class="mdr-global-search-highlight">${escapeHtml(text.slice(start, end))}</mark>`
    sourceOffset = end
    foldedOffset = matchIndex + needle.length
    matchIndex = folded.indexOf(needle, foldedOffset)
  }
  return html + escapeHtml(text.slice(sourceOffset))
}

function globalSearchContext(content, query) {
  const text = String(content || '')
  const needle = foldGlobalSearchText(query).trim()
  let folded = ''
  const offsets = []
  for (let offset = 0; offset < text.length;) {
    const point = String.fromCodePoint(text.codePointAt(offset))
    const normalized = foldGlobalSearchText(point)
    for (let index = 0; index < normalized.length; index++) offsets.push(offset)
    folded += normalized
    offset += point.length
  }
  const match = folded.indexOf(needle)
  if (match < 0) return text.slice(0, 300)
  const start = Math.max(0, offsets[match] - 30)
  const end = Math.min(text.length, (offsets[match + needle.length - 1] ?? offsets[match]) + 120)
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function flattenGlobalSearchFiles(entries, files = []) {
  for (const entry of entries || []) {
    if (entry.kind === 'file') files.push(entry)
    else if (entry.kind === 'directory') flattenGlobalSearchFiles(entry.children, files)
  }
  return files
}

function renderedSearchBlocks(source, query) {
  const needle = foldGlobalSearchText(query).trim()
  if (!needle) return []
  const lines = String(source || '').split(/\r?\n/)
  const tokens = markdown.parse(String(source || ''), {})
  const blocks = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.level !== 0 || !Array.isArray(token.map) || token.nesting < 0) continue
    let endIndex = index
    if (token.nesting > 0) {
      let depth = 1
      for (let candidate = index + 1; candidate < tokens.length; candidate++) {
        depth += tokens[candidate].nesting
        if (depth === 0) { endIndex = candidate; break }
      }
    }
    const template = document.createElement('template')
    template.innerHTML = markdown.renderer.render(tokens.slice(index, endIndex + 1), markdown.options, {})
    template.content.querySelectorAll('.mdr-anchor, button, script, style, .mdr-mermaid-block').forEach(element => element.remove())
    const content = String(template.content.textContent || '').replace(/\s+/g, ' ').trim()
    if (content && foldGlobalSearchText(content).includes(needle)) {
      const start = Math.max(0, token.map[0])
      const end = Math.min(lines.length, token.map[1])
      let lineNumber = start + 1
      for (let line = start; line < end; line++) {
        if (foldGlobalSearchText(lines[line]).includes(needle)) { lineNumber = line + 1; break }
      }
      blocks.push({content: globalSearchContext(content, query), lineNumber, blockIndex: blocks.length})
    }
    index = endIndex
  }
  return blocks
}

function renderGlobalSearchPlaceholder(icon, title, detail) {
  ui.globalSearchResults.innerHTML = `<div class="mdr-global-search-placeholder"><span class="mdr-global-search-placeholder-icon" aria-hidden="true">${icon}</span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`
}

function updateGlobalSearchStatus() {
  if (globalSearchLoading) {
    ui.globalSearchStatus.innerHTML = `<span class="mdr-global-search-spinner" aria-hidden="true"></span>已搜索 ${globalSearchCompletedDocumentCount} / ${globalSearchDocumentCount} 个文档 · ${globalSearchResults.length} 个结果`
  } else if (ui.globalSearchInput.value.trim()) {
    ui.globalSearchStatus.textContent = `${globalSearchResults.length} 个结果${globalSearchFailedDocumentCount ? ` · ${globalSearchFailedDocumentCount} 个文档未能读取` : ''}`
  } else if (globalSearchScope === 'directories') {
    ui.globalSearchStatus.textContent = `${getDirectoryRootDescriptors().length} 个目录`
  } else {
    ui.globalSearchStatus.textContent = `${docs.length} 个已打开文档`
  }
}

function renderGlobalSearchResults() {
  const query = ui.globalSearchInput.value.trim()
  const directoryCount = getDirectoryRootDescriptors().length
  const openDocumentCount = docs.length
  const directoryScope = ui.globalSearch.querySelector('[data-search-scope="directories"]')
  const openScope = ui.globalSearch.querySelector('[data-search-scope="open"]')
  if (directoryScope) {
    directoryScope.textContent = `已选目录 (${directoryCount} 个)`
    directoryScope.setAttribute('aria-label', `搜索已选目录，共 ${directoryCount} 个目录`)
  }
  if (openScope) {
    openScope.textContent = `打开的文档 (${openDocumentCount} 个)`
    openScope.setAttribute('aria-label', `搜索打开的文档，共 ${openDocumentCount} 个`)
  }
  ui.globalSearchClear.hidden = !query
  ui.globalSearchInput.placeholder = globalSearchScope === 'directories' ? '搜索已选目录中的 Markdown 文档' : '搜索所有已打开的 Markdown 文档'
  if (!query) {
    renderGlobalSearchPlaceholder('⌕', globalSearchScope === 'directories' ? '搜索已选目录中的文档' : '搜索已打开的文档', '输入文字后，将按文档列出匹配内容')
  } else if (globalSearchLoading && !globalSearchResults.length) {
    ui.globalSearchResults.innerHTML = '<div class="mdr-global-search-loading"><span class="mdr-global-search-spinner"></span><span>正在搜索…</span></div>'
  } else if (!globalSearchResults.length) {
    const scope = globalSearchScope === 'directories' ? `已选目录（${directoryCount} 个）` : `打开的文档（${openDocumentCount} 个）`
    const failures = globalSearchFailedDocumentCount ? `；${globalSearchFailedDocumentCount} 个文档未能读取` : ''
    renderGlobalSearchPlaceholder('⌕', `没有找到“${query}”`, `搜索范围：${scope}${failures}。试试更短的关键词或切换范围。`)
  } else {
    const list = document.createElement('div')
    list.className = 'mdr-global-search-list'
    globalSearchResults.forEach((result, index) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `mdr-global-search-row${index === globalSearchSelectedIndex ? ' is-selected' : ''}`
      row.setAttribute('aria-selected', String(index === globalSearchSelectedIndex))
      row.innerHTML = `<span class="mdr-global-search-document-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></svg></span><span class="mdr-global-search-snippet">${highlightGlobalSearchText(result.content || '（空行）', query)}</span><span class="mdr-global-search-result-meta"><strong>${escapeHtml(result.title)}</strong><span title="${escapeHtml(result.path || '')}">${escapeHtml(result.path || '')}</span><small>第 ${result.lineNumber} 行 · 第 ${result.matchIndex} 处</small></span>`
      row.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        selectGlobalSearchResult(index, false)
        void openGlobalSearchResult(result)
      })
      row.addEventListener('click', event => {
        selectGlobalSearchResult(index, false)
        if (event.detail > 1) void openGlobalSearchResult(result)
      })
      list.append(row)
    })
    ui.globalSearchResults.replaceChildren(list)
  }
  updateGlobalSearchStatus()
}

function selectGlobalSearchResult(index, scroll = true) {
  if (!globalSearchResults.length) return
  globalSearchSelectedIndex = (index + globalSearchResults.length) % globalSearchResults.length
  ui.globalSearchResults.querySelectorAll('.mdr-global-search-row').forEach((row, rowIndex) => {
    const selected = rowIndex === globalSearchSelectedIndex
    row.classList.toggle('is-selected', selected)
    row.setAttribute('aria-selected', String(selected))
  })
  if (scroll) ui.globalSearchResults.querySelector('.mdr-global-search-row.is-selected')?.scrollIntoView({block: 'nearest'})
}

function getGlobalSearchSources(scope) {
  if (scope === 'open') {
    return docs.filter(doc => !doc.sourceView).map(doc => ({
      title: doc.title,
      path: getDocumentDisplayPath(doc),
      documentId: doc.id,
      doc,
      fileItem: null,
    }))
  }
  const files = getDirectoryRootDescriptors().flatMap(root => {
    const entries = root.handle === rootHandle && root.fileIndex?.length ? root.fileIndex : flattenGlobalSearchFiles(root.entries)
    return entries.map(item => {
      if (root.handle && !item.rootHandle) item.rootHandle = root.handle
      return item
    })
  })
  const openedByURL = new Map()
  const openedByPath = new Map()
  for (const doc of docs) {
    if (doc.sourceView) continue
    const key = localFileURLKey(doc.sourceURL)
    if (key) openedByURL.set(key, doc)
    if (doc.relativePath) openedByPath.set(doc.relativePath, doc)
  }
  return files.map(fileItem => ({
    title: fileItem.name,
    path: (fileItem.url && (fileURLToSystemPath(fileItem.url) || cleanExtensionURL(fileItem.url))) || fileItem.path || fileItem.name,
    documentId: null,
    fileItem,
    openedByURL,
    openedByPath,
  }))
}

async function loadGlobalSearchSource(item) {
  if (item.doc) {
    const doc = item.doc.loaded === false ? await loadDocumentOnDemand(item.doc) : item.doc
    return typeof doc?.source === 'string' ? {...item, title: doc.title, source: doc.source} : null
  }

  const {fileItem} = item
  let opened = (fileItem.url && item.openedByURL.get(localFileURLKey(fileItem.url))) || item.openedByPath.get(fileItem.path)
  if (!opened && fileItem.handle) {
    for (const doc of docs) {
      if (!doc.handle) continue
      try {
        if (fileItem.handle === doc.handle || await fileItem.handle.isSameEntry(doc.handle)) {
          opened = doc
          break
        }
      } catch {}
    }
  }

  let source = opened?.source
  if (source == null && fileItem.handle) source = await (await fileItem.handle.getFile()).text()
  else if (source == null && fileItem.url) {
    const response = await chrome.runtime.sendMessage({type: 'lumina:read-local-markdown', fileURL: fileItem.url})
    if (!response?.ok) return null
    source = response.source
  }
  if (typeof source !== 'string') return null
  return {...item, title: opened?.title || fileItem.name, documentId: opened?.id || null, source}
}

async function executeGlobalSearch(query, scope, requestId) {
  globalSearchLoading = true
  globalSearchResults = []
  globalSearchSelectedIndex = 0
  globalSearchCompletedDocumentCount = 0
  globalSearchFailedDocumentCount = 0
  const sources = getGlobalSearchSources(scope)
  globalSearchDocumentCount = sources.length
  renderGlobalSearchResults()

  let nextSourceIndex = 0
  const worker = async () => {
    while (requestId === globalSearchRequestId) {
      const sourceIndex = nextSourceIndex++
      if (sourceIndex >= sources.length) return
      const sourceItem = sources[sourceIndex]
      try {
        const source = await loadGlobalSearchSource(sourceItem)
        if (!source && requestId === globalSearchRequestId) globalSearchFailedDocumentCount++
        if (source && requestId === globalSearchRequestId) {
          let matchIndex = 0
          const matches = renderedSearchBlocks(source.source, query).map(block => ({
            ...block,
            title: source.title,
            path: source.path,
            documentId: source.documentId,
            fileItem: source.fileItem,
            matchIndex: ++matchIndex,
          }))
          globalSearchResults.push(...matches)
        }
      } catch (error) {
        if (requestId === globalSearchRequestId) globalSearchFailedDocumentCount++
        console.warn('[LuminaChrome][global-search] 文档搜索失败', {title: sourceItem.title, error: error?.message || String(error)})
      } finally {
        if (requestId === globalSearchRequestId) {
          globalSearchCompletedDocumentCount++
          renderGlobalSearchResults()
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }
    }
  }

  const concurrency = Math.min(8, sources.length)
  await Promise.all(Array.from({length: concurrency}, () => worker()))
  if (requestId !== globalSearchRequestId) return
  globalSearchSelectedIndex = 0
  globalSearchLoading = false
  renderGlobalSearchResults()
}

function scheduleGlobalSearch() {
  clearTimeout(globalSearchTimer)
  const requestId = ++globalSearchRequestId
  globalSearchResults = []
  globalSearchSelectedIndex = 0
  globalSearchFailedDocumentCount = 0
  const query = ui.globalSearchInput.value.trim()
  globalSearchLoading = Boolean(query)
  if (!query) { renderGlobalSearchResults(); return }
  globalSearchTimer = window.setTimeout(() => {
    void executeGlobalSearch(query, globalSearchScope, requestId).catch(error => {
      if (requestId !== globalSearchRequestId) return
      globalSearchLoading = false
      renderGlobalSearchPlaceholder('!', '搜索失败', error.message || '读取文档时发生错误')
      updateGlobalSearchStatus()
    })
  }, 250)
  renderGlobalSearchResults()
}

async function openGlobalSearchResult(result) {
  try {
    const query = ui.globalSearchInput.value.trim()
    let doc = result.documentId ? docs.find(item => item.id === result.documentId) : null
    if (!doc && result.fileItem?.handle) {
      await readFileHandle(result.fileItem.handle, {root: result.fileItem.rootHandle || rootHandle, relativePath: result.fileItem.path})
      doc = docs.find(item => item.root === (result.fileItem.rootHandle || rootHandle) && item.relativePath === result.fileItem.path) || null
    } else if (!doc && result.fileItem?.url) {
      await openLocalTreeFile(result.fileItem)
      const key = localFileURLKey(result.fileItem.url)
      doc = docs.find(item => key && localFileURLKey(item.sourceURL) === key) || null
    }
    if (!doc) return
    setDocument(doc)
    if (doc.loaded === false) await loadDocumentOnDemand(doc)
    if (doc.loaded === false || doc.loadError) throw new Error(doc.loadError || '文档加载失败')
    await renderActive()
    closeGlobalSearch()
    requestAnimationFrame(() => {
      const frameDocument = documentFrames.get(doc.id)?.contentDocument
      const root = frameDocument?.querySelector('#mdr-content-root')
      if (!root) return
      const needle = foldGlobalSearchText(query)
      doc._scrollRestorePending?.cancel?.()
      const blocks = [...root.children].flatMap(element => element.classList.contains('mdr-heading-section') ? [...element.children] : [element])
        .filter(element => !element.hasAttribute('data-export-ignore'))
      const matchingBlocks = blocks.filter(block => foldGlobalSearchText(block.innerText || block.textContent).includes(needle))
      const block = matchingBlocks[Math.max(0, result.matchIndex - 1)]
      if (!block) { toast('未能定位匹配内容'); return }
      const target = [...block.querySelectorAll('p, li, td, th, h1, h2, h3, h4, h5, h6, pre')]
        .find(element => foldGlobalSearchText(element.textContent || '').includes(needle)) || block
      target.scrollIntoView({behavior: 'instant', block: 'center'})
      clearGlobalSearchHighlights()
      highlightGlobalSearchMatches(target, query)
    })
  } catch (error) { toast(`打开搜索结果失败：${error.message || error}`) }
}

const GLOBAL_SEARCH_HIGHLIGHT_NAME = 'lumina-global-search-match'

function clearGlobalSearchHighlights() {
  globalSearchHighlightGeneration++
  clearTimeout(globalSearchHighlightTimer)
  clearInterval(globalSearchFlashTimer)
  globalSearchHighlightTimer = 0
  globalSearchFlashTimer = 0
  for (const doc of docs) {
    documentFrames.get(doc.id)?.contentWindow?.CSS?.highlights?.delete(GLOBAL_SEARCH_HIGHLIGHT_NAME)
  }
}

function highlightGlobalSearchMatches(container, query) {
  const needle = foldGlobalSearchText(query).trim()
  if (!needle) return
  const ownerDocument = container.ownerDocument
  const frameWindow = ownerDocument.defaultView
  if (!frameWindow?.CSS?.highlights || !frameWindow.Highlight) return
  const walker = ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
      if (node.parentElement?.closest('script, style, button, [aria-hidden="true"], .mdr-anchor, .mdr-mermaid-block')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const textNodes = []
  while (walker.nextNode()) textNodes.push(walker.currentNode)

  const foldedCharacters = []
  const positions = []
  let previousBlock = null
  for (const textNode of textNodes) {
    const block = textNode.parentElement?.closest('p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote, figure, div') || container
    if (previousBlock && block !== previousBlock) {
      foldedCharacters.push('\0')
      positions.push(null)
    }
    previousBlock = block
    const source = textNode.nodeValue
    for (let offset = 0; offset < source.length;) {
      const point = String.fromCodePoint(source.codePointAt(offset))
      const nextOffset = offset + point.length
      const normalized = foldGlobalSearchText(point)
      for (let index = 0; index < normalized.length; index++) {
        foldedCharacters.push(normalized[index])
        positions.push({node: textNode, start: offset, end: nextOffset})
      }
      offset = nextOffset
    }
  }

  const folded = foldedCharacters.join('')
  const highlight = new frameWindow.Highlight()
  let matchIndex = folded.indexOf(needle)
  while (matchIndex >= 0) {
    const start = positions[matchIndex]
    const end = positions[matchIndex + needle.length - 1]
    if (start && end) {
      const range = ownerDocument.createRange()
      range.setStart(start.node, start.start)
      range.setEnd(end.node, end.end)
      highlight.add(range)
    }
    matchIndex = folded.indexOf(needle, matchIndex + needle.length)
  }
  if (!highlight.size) return

  const generation = globalSearchHighlightGeneration
  const setVisible = visible => {
    if (generation !== globalSearchHighlightGeneration) return
    if (visible) frameWindow.CSS.highlights.set(GLOBAL_SEARCH_HIGHLIGHT_NAME, highlight)
    else frameWindow.CSS.highlights.delete(GLOBAL_SEARCH_HIGHLIGHT_NAME)
  }
  setVisible(true)

  const flashStartedAt = performance.now()
  globalSearchFlashTimer = window.setInterval(() => {
    if (generation !== globalSearchHighlightGeneration) return
    if (performance.now() - flashStartedAt >= 3000) {
      clearInterval(globalSearchFlashTimer)
      globalSearchFlashTimer = 0
      setVisible(true)
      return
    }
    setVisible(!frameWindow.CSS.highlights.has(GLOBAL_SEARCH_HIGHLIGHT_NAME))
  }, 300)
  globalSearchHighlightTimer = window.setTimeout(() => {
    if (generation !== globalSearchHighlightGeneration) return
    clearInterval(globalSearchFlashTimer)
    globalSearchFlashTimer = 0
    frameWindow.CSS.highlights.delete(GLOBAL_SEARCH_HIGHLIGHT_NAME)
    globalSearchHighlightTimer = 0
  }, 6000)
}

function openGlobalSearch() {
  if (ui.settings.classList.contains('show')) return
  globalSearchScope = 'directories'
  ui.globalSearch.querySelectorAll('[data-search-scope]').forEach(button => {
    const isActive = button.dataset.searchScope === globalSearchScope
    button.classList.toggle('active', isActive)
    button.setAttribute('aria-pressed', String(isActive))
  })
  ui.globalSearchInput.value = ''
  scheduleGlobalSearch()
  Modal.getOrCreateInstance(ui.globalSearch, {backdrop: 'static', keyboard: true, focus: true}).show()
}

function closeGlobalSearch() {
  clearTimeout(globalSearchTimer)
  globalSearchRequestId++
  globalSearchLoading = false
  Modal.getInstance(ui.globalSearch)?.hide()
}

function handleGlobalSearchShortcut(event) {
  if (event.key !== 'Shift' || event.repeat || ui.globalSearch.classList.contains('show')) return
  if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
  const now = performance.now()
  if (now - lastGlobalSearchShiftTime <= 450) {
    lastGlobalSearchShiftTime = 0
    event.preventDefault()
    openGlobalSearch()
  } else lastGlobalSearchShiftTime = now
}

function initGlobalSearch() {
  document.getElementById('global-search')?.addEventListener('click', openGlobalSearch)
  document.getElementById('global-search-close')?.addEventListener('click', closeGlobalSearch)
  ui.globalSearchInput.addEventListener('input', scheduleGlobalSearch)
  ui.globalSearchClear.addEventListener('click', () => {
    ui.globalSearchInput.value = ''
    scheduleGlobalSearch()
    ui.globalSearchInput.focus()
  })
  ui.globalSearch.querySelectorAll('[data-search-scope]').forEach(button => button.addEventListener('click', () => {
    if (globalSearchScope === button.dataset.searchScope) return
    globalSearchScope = button.dataset.searchScope
    ui.globalSearch.querySelectorAll('[data-search-scope]').forEach(item => {
      const isActive = item === button
      item.classList.toggle('active', isActive)
      item.setAttribute('aria-pressed', String(isActive))
    })
    scheduleGlobalSearch()
  }))
  ui.globalSearchInput.addEventListener('keydown', event => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && globalSearchResults.length) {
      event.preventDefault()
      selectGlobalSearchResult(globalSearchSelectedIndex + (event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Enter' && globalSearchResults[globalSearchSelectedIndex]) {
      event.preventDefault()
      void openGlobalSearchResult(globalSearchResults[globalSearchSelectedIndex])
    }
  })
  ui.globalSearch.addEventListener('shown.bs.modal', () => requestAnimationFrame(() => ui.globalSearchInput.focus()))
  ui.globalSearch.addEventListener('hidePrevented.bs.modal', () => {
    const card = ui.globalSearch.querySelector('.mdr-global-search-card')
    card?.classList.remove('is-shaking')
    void card?.offsetWidth
    card?.classList.add('is-shaking')
    setTimeout(() => card?.classList.remove('is-shaking'), 520)
  })
  ui.globalSearch.addEventListener('hidden.bs.modal', () => {
    clearTimeout(globalSearchTimer)
    globalSearchRequestId++
    globalSearchLoading = false
    lastGlobalSearchShiftTime = 0
  })
  document.addEventListener('keydown', handleGlobalSearchShortcut)
}

let dragCounter = 0
let internalDragResetTimer = 0
let internalDragActive = false

function markInternalDragStart() {
  internalDragActive = true
  window.clearTimeout(internalDragResetTimer)
  // Dragend normally clears this. Avoid leaving file drops disabled if the
  // browser cancels an internal drag without dispatching dragend.
  internalDragResetTimer = window.setTimeout(clearInternalDragStart, 30000)
}

function clearInternalDragStart() {
  internalDragActive = false
  window.clearTimeout(internalDragResetTimer)
  internalDragResetTimer = 0
}

function isExternalFileDrag(event) {
  return !draggedTabId && !internalDragActive && Array.from(event.dataTransfer?.types || []).includes('Files')
}

document.addEventListener('dragstart', markInternalDragStart, true)
document.addEventListener('dragend', clearInternalDragStart, true)

function showExternalDropOverlay() {
  if (ui.dropOverlay) {
    ui.dropOverlay.hidden = false
    ui.dropOverlay.classList.add('active')
  }
}

function hideExternalDropOverlay() {
  dragCounter = 0
  if (ui.dropOverlay) {
    ui.dropOverlay.classList.remove('active')
    ui.dropOverlay.hidden = true
  }
}

function showDropRefreshNotice() {
  if (preferences.hideDropRefreshNotice) return
  const dialog = document.getElementById('drop-refresh-notice')
  if (dialog && !dialog.open) {
    const checkbox = document.getElementById('drop-refresh-dont-show')
    if (checkbox) checkbox.checked = preferences.hideDropRefreshNotice
    dialog.showModal()
    if (!dialog.dataset.boundEvents) {
      dialog.dataset.boundEvents = 'true'
      document.getElementById('drop-refresh-dont-show')?.addEventListener('change', event => {
        void setDropRefreshNoticeHidden(event.target.checked)
      })
      const permLink = document.getElementById('drop-notice-permission-link')
      permLink?.addEventListener('click', () => {
        void chrome.runtime.sendMessage({type: 'lumina:open-file-url-access-settings'}).catch(() => {})
      })
    }
  }
}

async function setDropRefreshNoticeHidden(hidden) {
  preferences.hideDropRefreshNotice = hidden
  const toggle = document.getElementById('pref-show-drop-refresh-notice')
  if (toggle) toggle.checked = !hidden
  try { await chrome.storage.local.set({preferences}) } catch (error) {
    console.warn('[LuminaChrome] 保存拖入刷新提醒设置失败', error)
  }
}

async function processExternalDrop(event) {
  const items = event.dataTransfer?.items
  if (!items || items.length === 0) return

  try {
    const handles = []
    for (const item of items) {
      if (typeof item.getAsFileSystemHandle === 'function') {
        const handle = await item.getAsFileSystemHandle()
        if (handle) handles.push(handle)
      }
    }

    const directories = handles.filter(handle => handle.kind === 'directory')
    for (const directory of directories) await appendDirectoryHandle(directory)
    if (directories.length) {
      renderFiles()
      document.querySelector('[data-panel="files"]')?.click()
      toast(`已追加 ${directories.length} 个目录`)
      persistState()
    }

    let openedCount = 0
    for (const handle of handles) {
      if (handle.kind === 'file' && /\.(md|markdown|mdown|mkd|mdx|mdc|txt)$/i.test(handle.name)) {
        await readFileHandle(handle)
        openedCount++
      }
    }
    if (openedCount) {
      toast(`已打开 ${openedCount} 个 Markdown 文档`)
      persistState()
      showDropRefreshNotice()
      return
    }
    if (directories.length) {
      showDropRefreshNotice()
      return
    }
  } catch (err) {
    console.warn('获取 FileSystemHandle 失败，尝试降级读取:', err)
  }

  const files = Array.from(event.dataTransfer?.files || [])
  let openedCount = 0
  for (const file of files) {
    if (!/\.(md|markdown|mdown|mkd|mdx|mdc|txt)$/i.test(file.name)) continue
    const doc = {
      id: crypto.randomUUID(), title: file.name, source: '', handle: null,
      root: null, relativePath: '', lastModified: file.lastModified || Date.now(), loading: true, objectURLs: [],
    }
    await loadFileIntoDocument(doc, async () => ({source: await readFileAsText(file), lastModified: file.lastModified || Date.now()}))
    openedCount++
  }
  if (openedCount) {
    toast(`已打开 ${openedCount} 个 Markdown 文档`)
    persistState()
    showDropRefreshNotice()
  } else {
    toast('拖入的文件非 Markdown 格式（.md、.markdown）')
  }
}

window.addEventListener('dragenter', e => {
  if (!isExternalFileDrag(e)) return
  e.preventDefault()
  dragCounter++
  showExternalDropOverlay()
})

window.addEventListener('dragover', e => {
  if (!isExternalFileDrag(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
})

window.addEventListener('dragleave', e => {
  if (!isExternalFileDrag(e)) return
  e.preventDefault()
  dragCounter--
  if (dragCounter <= 0) {
    dragCounter = 0
    hideExternalDropOverlay()
  }
})

window.addEventListener('drop', async e => {
  if (!isExternalFileDrag(e)) return
  e.preventDefault()
  hideExternalDropOverlay()
  await processExternalDrop(e)
})

// ==========================================================================
// 交互事件监听与代码块复制
// ==========================================================================
$('#open-file').addEventListener('click', openFilePicker)
$('#empty-open-file').addEventListener('click', openFilePicker)
$('#open-folder').addEventListener('click', openDirectoryPicker)
$('#empty-open-folder').addEventListener('click', openDirectoryPicker)
document.getElementById('document-tab-count')?.addEventListener('click', () => {
  const activeTab = ui.tabs.querySelector('.doc-tab.active')
  if (activeTab?.isConnected) {
    activeTab.scrollIntoView({behavior: 'instant', block: 'nearest', inline: 'center'})
  }
})
Dropdown.getOrCreateInstance(document.getElementById('top-actions-toggle'))
$('#export-print').addEventListener('click', event => {
  if (startExportButtonCooldown(event.currentTarget)) void exportPDF()
})
$('#export-png').addEventListener('click', event => {
  if (startExportButtonCooldown(event.currentTarget)) void exportPNG()
})
// ==========================================================================
// 偏好设置模态弹窗交互与事件处理
// ==========================================================================
const SETTINGS_TAB_META = {
  appearance: {
    title: '外观与主题',
    subtitle: '选择适合您阅读环境的色彩风格，偏好设置将自动保存并记录。'
  },
  typography: {
    title: '排版与阅读',
    subtitle: '自适应正文视口黄金比例与长行折行排版规则。'
  },
  export: {
    title: '导出设置',
    subtitle: '配置文件转图片分页切片与高质量 PDF 导出。'
  },
  data: {
    title: '数据与隐私',
    subtitle: '管理保存在 Chrome 本地存储、缓存以及 IndexedDB 数据库中的工作区数据。'
  },
  about: {
    title: '关于软件',
    subtitle: ''
  }
}

function readRuntimeExtensionVersion() {
  try {
    const version = chrome.runtime.getManifest()?.version
    return version ? String(version) : null
  } catch {
    return null
  }
}

function setExtensionUpdateWarningVisible(visible) {
  const warning = $('#extension-update-warning')
  if (!warning) return
  warning.hidden = !visible
  document.body.classList.toggle('extension-update-visible', visible)
}

function startExtensionVersionMonitor() {
  const initialVersion = readRuntimeExtensionVersion()
  const versionLabel = document.querySelector('#settings .settings-version')
  if (versionLabel) versionLabel.textContent = initialVersion ? `v${initialVersion}` : ''

  // Keep the banner visible temporarily so the user can validate its position and appearance.
  setExtensionUpdateWarningVisible(SHOW_EXTENSION_UPDATE_WARNING_FOR_TESTING || !initialVersion)
  $('#extension-update-refresh')?.addEventListener('click', () => location.reload())

  window.setInterval(() => {
    try {
      const latestVersion = chrome.runtime.getManifest()?.version
      if (!latestVersion || String(latestVersion) !== initialVersion) {
        setExtensionUpdateWarningVisible(true)
      }
    } catch {
      // An extension update can invalidate the current page's runtime context.
      setExtensionUpdateWarningVisible(true)
    }
  }, EXTENSION_VERSION_CHECK_INTERVAL)
}

function setFileURLPermissionWarningVisible(visible) {
  const warning = $('#file-url-permission-warning')
  if (warning) warning.hidden = !visible
  document.body.classList.toggle('file-url-permission-visible', visible)

  const pendingBadge = document.querySelector('.mdr-permission-badge-pending')
  const grantedBadge = document.querySelector('.mdr-permission-badge-granted')
  if (pendingBadge && grantedBadge) {
    pendingBadge.hidden = !visible
    grantedBadge.hidden = visible
  }

  const dropNoticePermission = document.querySelector('.mdr-tip-permission-callout')
  if (dropNoticePermission) dropNoticePermission.hidden = !visible
}

async function refreshFileURLPermissionWarning() {
  try {
    const result = await chrome.runtime.sendMessage({type: 'lumina:get-file-url-access'})
    if (result?.ok !== true || typeof result.allowed !== 'boolean') throw new Error(result?.error || '无法获取文件网址访问权限')
    setFileURLPermissionWarningVisible(!result.allowed)
  } catch {
    setFileURLPermissionWarningVisible(false)
    const grantedBadge = document.querySelector('.mdr-permission-badge-granted')
    if (grantedBadge) grantedBadge.hidden = true
    setExtensionUpdateWarningVisible(true)
  }
}

function startFileURLPermissionMonitor() {
  for (const settingsLink of [$('#file-url-permission-link'), $('#empty-file-permission-link')]) {
    settingsLink?.addEventListener('click', () => {
      void chrome.runtime.sendMessage({type: 'lumina:open-file-url-access-settings'}).catch(() => {})
    })
  }

  void refreshFileURLPermissionWarning()
  window.addEventListener('focus', () => { void refreshFileURLPermissionWarning() })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshFileURLPermissionWarning()
  })
}

function syncSettingsUI() {
  const extensionVersion = readRuntimeExtensionVersion()
  const settingsButton = document.querySelector('#settings')
  if (settingsButton) {
    let versionLabel = settingsButton.querySelector('.settings-version')
    if (!versionLabel) {
      versionLabel = document.createElement('span')
      versionLabel.className = 'settings-version'
      settingsButton.append(versionLabel)
    }
    versionLabel.textContent = extensionVersion ? `v${extensionVersion}` : ''
  }

  const aboutVersion = document.querySelector('.mdr-about-version')
  if (aboutVersion) {
    aboutVersion.textContent = extensionVersion ? `版本 ${extensionVersion} (Chrome MV3)` : 'Chrome MV3'
  }

  // 1. 同步主题卡片与单选
  document.querySelectorAll('.mdr-theme-card').forEach(card => {
    const isSelected = card.dataset.themeValue === preferences.theme
    card.classList.toggle('active', isSelected)
    const radio = card.querySelector('input[type="radio"]')
    if (radio) radio.checked = isSelected
  })
  const prefThemeSelect = document.getElementById('pref-theme')
  if (prefThemeSelect) prefThemeSelect.value = preferences.theme

  // 2. 同步正文宽度滑块与预设胶囊
  const widthSlider = document.getElementById('pref-width')
  if (widthSlider) widthSlider.value = preferences.width
  const widthOutput = document.getElementById('width-output')
  if (widthOutput) widthOutput.value = `${preferences.width}%`
  document.querySelectorAll('.mdr-pill-btn[data-width]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.width) === preferences.width)
  })

  // 3. 同步导出图片最大高度滑块与预设胶囊
  const heightSlider = document.getElementById('pref-image-height')
  if (heightSlider) {
    heightSlider.min = String(MIN_IMAGE_EXPORT_HEIGHT)
    heightSlider.max = String(MAX_IMAGE_EXPORT_HEIGHT)
    heightSlider.value = preferences.imageExportMaximumHeight
  }
  const heightOutput = document.getElementById('image-height-output')
  if (heightOutput) heightOutput.value = `${preferences.imageExportMaximumHeight.toLocaleString()} px`
  const heightResetButton = document.getElementById('pref-height-reset')
  if (heightResetButton) {
    heightResetButton.textContent = '重置默认'
    heightResetButton.title = `恢复默认限制 (${DEFAULT_IMAGE_EXPORT_HEIGHT.toLocaleString()} px)`
    heightResetButton.disabled = preferences.imageExportMaximumHeight === DEFAULT_IMAGE_EXPORT_HEIGHT
  }
  const boundHeightPresets = [
    ['[data-height-min]', MIN_IMAGE_EXPORT_HEIGHT, '最小值'],
    ['[data-height-default]', DEFAULT_IMAGE_EXPORT_HEIGHT, '默认'],
    ['[data-height-max]', MAX_IMAGE_EXPORT_HEIGHT, '最大值'],
  ]
  for (const [selector, value, label] of boundHeightPresets) {
    const button = document.querySelector(selector)
    if (!button) continue
    button.dataset.height = String(value)
    button.textContent = `${value.toLocaleString()} px (${label})`
  }
  document.querySelectorAll('.mdr-pill-btn[data-height]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.height) === preferences.imageExportMaximumHeight)
  })
  const pixelRatioSlider = document.getElementById('pref-image-pixel-ratio')
  if (pixelRatioSlider) {
    pixelRatioSlider.min = String(MIN_IMAGE_EXPORT_PIXEL_RATIO)
    pixelRatioSlider.max = String(MAX_IMAGE_EXPORT_PIXEL_RATIO)
    pixelRatioSlider.step = '0.1'
    pixelRatioSlider.value = preferences.imageExportPixelRatio
  }
  const pixelRatioOutput = document.getElementById('image-pixel-ratio-output')
  if (pixelRatioOutput) pixelRatioOutput.value = `${preferences.imageExportPixelRatio.toFixed(1)}×`
  const imageRetriesInput = document.getElementById('pref-image-export-retries')
  const imageTimeoutInput = document.getElementById('pref-image-export-timeout')
  if (imageRetriesInput) imageRetriesInput.value = preferences.imageExportRetries
  if (imageTimeoutInput) imageTimeoutInput.value = preferences.imageExportTimeoutSeconds

  const retryDecrBtn = document.querySelector('[data-step-target="retries"][data-step="-1"]')
  const retryIncrBtn = document.querySelector('[data-step-target="retries"][data-step="1"]')
  if (retryDecrBtn) retryDecrBtn.disabled = preferences.imageExportRetries <= 0
  if (retryIncrBtn) retryIncrBtn.disabled = preferences.imageExportRetries >= 10

  const timeoutDecrBtn = document.querySelector('[data-step-target="timeout"][data-step="-5"]')
  const timeoutIncrBtn = document.querySelector('[data-step-target="timeout"][data-step="5"]')
  if (timeoutDecrBtn) timeoutDecrBtn.disabled = preferences.imageExportTimeoutSeconds <= 5
  if (timeoutIncrBtn) timeoutIncrBtn.disabled = preferences.imageExportTimeoutSeconds >= 120

  // 4. 同步换行开关
  const codeWrapCheck = document.getElementById('pref-code-wrap')
  if (codeWrapCheck) codeWrapCheck.checked = !!preferences.codeWrap
  const readingProgressBadgeCheck = document.getElementById('pref-show-reading-progress')
  if (readingProgressBadgeCheck) readingProgressBadgeCheck.checked = !!preferences.showReadingProgressBadge
  const dropRefreshNoticeCheck = document.getElementById('pref-show-drop-refresh-notice')
  if (dropRefreshNoticeCheck) dropRefreshNoticeCheck.checked = !preferences.hideDropRefreshNotice

  const autoIntervalInput = document.getElementById('pref-auto-interval')
  const autoAmountInput = document.getElementById('pref-auto-amount')
  if (autoIntervalInput) autoIntervalInput.value = preferences.autoScrollInterval
  if (autoAmountInput) autoAmountInput.value = preferences.autoScrollAmount
  const autoSpeed = (1000 / preferences.autoScrollInterval) * preferences.autoScrollAmount
  const autoSpeedOutput = document.getElementById('auto-default-speed')
  const autoSpeedLabel = document.getElementById('auto-default-speed-label')
  if (autoSpeedOutput) autoSpeedOutput.textContent = String(Math.round(autoSpeed))
  if (autoSpeedLabel) autoSpeedLabel.textContent = autoSpeed < 30 ? '细致精读' : (autoSpeed <= 75 ? '舒适匀速' : '快速速览')
  document.querySelectorAll('[data-auto-default-preset]').forEach(button => {
    const selected = Number(button.dataset.interval) === preferences.autoScrollInterval && Number(button.dataset.amount) === preferences.autoScrollAmount
    button.classList.toggle('active', selected)
  })
}

function openSettingsModal() {
  syncSettingsUI()
  Modal.getOrCreateInstance(ui.settings, {backdrop: 'static', keyboard: true}).show()
}

function closeSettingsModal() {
  if (ui.settings.classList.contains('show')) {
    Modal.getInstance(ui.settings)?.hide()
  }
}

async function selectTheme(themeValue) {
  if (!['system', 'light', 'dark'].includes(themeValue)) return
  preferences.theme = themeValue
  const prefThemeSelect = document.getElementById('pref-theme')
  if (prefThemeSelect) prefThemeSelect.value = themeValue

  document.querySelectorAll('.mdr-theme-card').forEach(card => {
    const isSelected = card.dataset.themeValue === themeValue
    card.classList.toggle('active', isSelected)
    const radio = card.querySelector('input[type="radio"]')
    if (radio) radio.checked = isSelected
  })

  applyPreferences()
  try { await chrome?.storage?.local?.set({preferences}) } catch {}
  await renderActive()
}

async function updateContentWidth(newWidth) {
  const width = Math.max(45, Math.min(100, Number(newWidth) || 72))
  preferences.width = width
  const slider = document.getElementById('pref-width')
  if (slider) slider.value = width
  const output = document.getElementById('width-output')
  if (output) output.value = `${width}%`

  document.querySelectorAll('.mdr-pill-btn[data-width]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.width) === width)
  })

  applyPreferences()
  try { await chrome?.storage?.local?.set({preferences}) } catch {}
}

async function updateImageExportHeight(newHeight) {
  const height = Math.max(MIN_IMAGE_EXPORT_HEIGHT, Math.min(MAX_IMAGE_EXPORT_HEIGHT, Number(newHeight) || DEFAULT_IMAGE_EXPORT_HEIGHT))
  preferences.imageExportMaximumHeight = height
  const slider = document.getElementById('pref-image-height')
  if (slider) slider.value = height
  const output = document.getElementById('image-height-output')
  if (output) output.value = `${height.toLocaleString()} px`

  const heightResetButton = document.getElementById('pref-height-reset')
  if (heightResetButton) {
    heightResetButton.disabled = height === DEFAULT_IMAGE_EXPORT_HEIGHT
  }

  document.querySelectorAll('.mdr-pill-btn[data-height]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.height) === height)
  })

  try { await chrome?.storage?.local?.set({preferences}) } catch {}
}

async function updateImageExportPixelRatio(newRatio) {
  const ratio = Math.round(Math.max(MIN_IMAGE_EXPORT_PIXEL_RATIO, Math.min(MAX_IMAGE_EXPORT_PIXEL_RATIO, Number(newRatio) || DEFAULT_IMAGE_EXPORT_PIXEL_RATIO)) * 10) / 10
  preferences.imageExportPixelRatio = ratio
  const slider = document.getElementById('pref-image-pixel-ratio')
  if (slider) slider.value = String(ratio)
  const output = document.getElementById('image-pixel-ratio-output')
  if (output) output.value = `${ratio.toFixed(1)}×`
  try { await chrome?.storage?.local?.set({preferences}) } catch {}
}

async function updateImageExportNetworkSettings(changes) {
  if ('imageExportRetries' in changes) {
    preferences.imageExportRetries = Math.round(Math.max(0, Math.min(10, Number(changes.imageExportRetries) || 0)))
  }
  if ('imageExportTimeoutSeconds' in changes) {
    preferences.imageExportTimeoutSeconds = Math.round(Math.max(5, Math.min(120, Number(changes.imageExportTimeoutSeconds) || 30)))
  }
  const retriesInput = document.getElementById('pref-image-export-retries')
  const timeoutInput = document.getElementById('pref-image-export-timeout')
  if (retriesInput) retriesInput.value = preferences.imageExportRetries
  if (timeoutInput) timeoutInput.value = preferences.imageExportTimeoutSeconds

  const retryDecrBtn = document.querySelector('[data-step-target="retries"][data-step="-1"]')
  const retryIncrBtn = document.querySelector('[data-step-target="retries"][data-step="1"]')
  if (retryDecrBtn) retryDecrBtn.disabled = preferences.imageExportRetries <= 0
  if (retryIncrBtn) retryIncrBtn.disabled = preferences.imageExportRetries >= 10

  const timeoutDecrBtn = document.querySelector('[data-step-target="timeout"][data-step="-5"]')
  const timeoutIncrBtn = document.querySelector('[data-step-target="timeout"][data-step="5"]')
  if (timeoutDecrBtn) timeoutDecrBtn.disabled = preferences.imageExportTimeoutSeconds <= 5
  if (timeoutIncrBtn) timeoutIncrBtn.disabled = preferences.imageExportTimeoutSeconds >= 120

  try { await chrome?.storage?.local?.set({preferences}) } catch {}
}

function initSettingsModal() {
  // 唤起与关闭
  $('#settings').addEventListener('click', openSettingsModal)
  const closeBtn = document.getElementById('settings-close-btn')
  if (closeBtn) closeBtn.addEventListener('click', closeSettingsModal)

  // 左侧导航 Tab 切换
  document.querySelectorAll('.mdr-settings-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabKey = btn.dataset.tab
      if (!tabKey) return
      const meta = SETTINGS_TAB_META[tabKey] || SETTINGS_TAB_META.appearance
      const titleEl = document.getElementById('settings-tab-title')
      const subtitleEl = document.getElementById('settings-tab-subtitle')
      if (titleEl) titleEl.textContent = meta.title
      if (subtitleEl) {
        subtitleEl.textContent = meta.subtitle
        subtitleEl.hidden = !meta.subtitle
      }

      document.querySelectorAll('.mdr-settings-tab-btn').forEach(b => {
        b.classList.toggle('active', b === btn)
      })
      document.querySelectorAll('.mdr-settings-panel').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.tabPanel === tabKey)
      })
    })
  })

  // 主题卡片单选与隐藏 select 联动
  document.querySelectorAll('.mdr-theme-card').forEach(card => {
    card.addEventListener('click', () => {
      const val = card.dataset.themeValue
      if (val) void selectTheme(val)
    })
  })
  $('#pref-theme').addEventListener('change', event => {
    void selectTheme(event.target.value)
  })

  // 正文宽度滑块、重置与胶囊档位
  $('#pref-width').addEventListener('input', event => {
    void updateContentWidth(event.target.value)
  })
  const widthResetBtn = document.getElementById('pref-width-reset')
  if (widthResetBtn) {
    widthResetBtn.addEventListener('click', () => void updateContentWidth(72))
  }
  document.querySelectorAll('.mdr-pill-btn[data-width]').forEach(btn => {
    btn.addEventListener('click', () => void updateContentWidth(btn.dataset.width))
  })

  // 导出单张图片最大高度滑块、重置与胶囊档位
  $('#pref-image-height').addEventListener('input', event => {
    void updateImageExportHeight(event.target.value)
  })
  $('#pref-image-pixel-ratio').addEventListener('input', event => {
    void updateImageExportPixelRatio(event.target.value)
  })
  const heightResetBtn = document.getElementById('pref-height-reset')
  if (heightResetBtn) {
    heightResetBtn.addEventListener('click', () => void updateImageExportHeight(DEFAULT_IMAGE_EXPORT_HEIGHT))
  }
  document.querySelectorAll('.mdr-pill-btn[data-height], .mdr-pill-btn[data-height-min], .mdr-pill-btn[data-height-default], .mdr-pill-btn[data-height-max]').forEach(btn => {
    btn.addEventListener('click', () => void updateImageExportHeight(btn.dataset.height))
  })
  $('#pref-image-export-retries').addEventListener('change', event => {
    void updateImageExportNetworkSettings({imageExportRetries: event.target.value})
  })
  $('#pref-image-export-timeout').addEventListener('change', event => {
    void updateImageExportNetworkSettings({imageExportTimeoutSeconds: event.target.value})
  })
  document.querySelectorAll('[data-step-target]').forEach(button => {
    button.addEventListener('click', () => {
      const target = button.dataset.stepTarget
      const step = Number(button.dataset.step) || 1
      if (target === 'retries') {
        void updateImageExportNetworkSettings({imageExportRetries: preferences.imageExportRetries + step})
      } else if (target === 'timeout') {
        void updateImageExportNetworkSettings({imageExportTimeoutSeconds: preferences.imageExportTimeoutSeconds + step})
      }
    })
  })

  // 代码与源码换行
  $('#pref-code-wrap').addEventListener('change', async event => {
    preferences.codeWrap = event.target.checked
    applyPreferences()
    try { await chrome?.storage?.local?.set({preferences}) } catch {}
  })

  $('#pref-show-reading-progress')?.addEventListener('change', async event => {
    preferences.showReadingProgressBadge = event.target.checked
    applyPreferences()
    try { await chrome?.storage?.local?.set({preferences}) } catch {}
  })

  $('#pref-show-drop-refresh-notice')?.addEventListener('change', event => {
    void setDropRefreshNoticeHidden(!event.target.checked)
  })

  document.getElementById('mdr-about-copy-contact')?.addEventListener('click', async event => {
    const btn = event.currentTarget
    const email = btn.dataset.email || 'puppylyx@gmail.com'
    try {
      await copyTextToClipboard(email)
      toast('已复制联系方式')
      btn.classList.add('is-copied')
      const textSpan = btn.querySelector('.mdr-copy-text')
      if (textSpan) textSpan.textContent = '已复制'
      clearTimeout(btn._copiedTimer)
      btn._copiedTimer = setTimeout(() => {
        btn.classList.remove('is-copied')
        if (textSpan) textSpan.textContent = '复制'
      }, 2000)
    } catch (error) {
      toast(`复制失败：${error.message || error}`)
    }
  })

  const updateAutoDefaults = async changes => {
    for (const [name, value] of Object.entries(changes)) {
      const bounds = name === 'autoScrollInterval' ? [1, 15000] : [1, 800]
      preferences[name] = Math.round(Math.max(bounds[0], Math.min(bounds[1], Number(value) || bounds[0])))
    }
    syncSettingsUI()
    syncAutoScrollPanels()
    const runningDoc = docs.find(doc => doc.id === runningAutoScrollDocumentId)
    if (runningDoc && !autoScrollOverrides.has(runningDoc.id)) startAutoScroll(runningDoc, false)
    try { await chrome?.storage?.local?.set({preferences}) } catch {}
  }
  $('#pref-auto-interval').addEventListener('change', event => { void updateAutoDefaults({autoScrollInterval: event.target.value}) })
  $('#pref-auto-amount').addEventListener('change', event => { void updateAutoDefaults({autoScrollAmount: event.target.value}) })
  document.querySelectorAll('[data-auto-default-preset]').forEach(button => {
    button.addEventListener('click', () => {
      void updateAutoDefaults({autoScrollInterval: button.dataset.interval, autoScrollAmount: button.dataset.amount})
    })
  })
  document.querySelectorAll('[data-auto-default-step]').forEach(button => {
    button.addEventListener('click', () => {
      const preferenceKey = button.dataset.autoDefaultStep === 'interval' ? 'autoScrollInterval' : 'autoScrollAmount'
      void updateAutoDefaults({[preferenceKey]: preferences[preferenceKey] + Number(button.dataset.step)})
    })
  })


  // 危险操作：清除所有本地数据与缓存
  const clearDataBtn = document.getElementById('btn-clear-all-data')
  if (clearDataBtn) {
    clearDataBtn.addEventListener('click', async () => {
      const confirmed = window.confirm(
        '确定要清除所有本地数据与缓存吗？\n\n' +
        '• 此操作将重置所有偏好设置为出厂默认\n' +
        '• 清空所有已打开的文档标签与工作区记录\n' +
        '• 清除本地目录记忆与展开历史\n\n' +
        '注意：您的本地实际 Markdown 文件不会受到任何改动。'
      )
      if (!confirmed) return

      try {
        try { await chrome?.storage?.local?.clear() } catch {}
        try { await clearLegacyWorkspaceDatabase() } catch {}
        try { localStorage.clear() } catch {}
        try { sessionStorage.clear() } catch {}

        toast('已清除所有数据与缓存，正在重置...')
        setTimeout(() => {
          location.href = location.pathname
        }, 700)
      } catch (err) {
        toast(`清除失败：${err.message || err}`)
      }
    })
  }

  // 初始化一次 UI
  syncSettingsUI()
}

const isMac = /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '')

function initPlatformShortcuts() {
  if (isMac) return
  const openFileShortcut = document.getElementById('open-file-shortcut')
  if (openFileShortcut) openFileShortcut.textContent = 'Ctrl O'

  const openFileBtn = document.getElementById('open-file')
  if (openFileBtn) openFileBtn.title = '打开 Markdown 文件 (Ctrl+O)'

  const settingsBtn = document.getElementById('settings')
  if (settingsBtn) settingsBtn.title = '偏好设置 (Ctrl+,)'

  const settingsShortcutKbd = document.getElementById('settings-shortcut-kbd')
  if (settingsShortcutKbd) settingsShortcutKbd.textContent = 'Ctrl ,'

  const emptyShortcutOpen = document.getElementById('empty-shortcut-open')
  if (emptyShortcutOpen) emptyShortcutOpen.textContent = 'Ctrl O'

  const emptyShortcutOpenTip = document.getElementById('empty-shortcut-open-tip')
  if (emptyShortcutOpenTip) emptyShortcutOpenTip.textContent = 'Ctrl O'

  const emptyShortcutPrefTip = document.getElementById('empty-shortcut-pref-tip')
  if (emptyShortcutPrefTip) emptyShortcutPrefTip.textContent = 'Ctrl ,'
}

initSettingsModal()
initGlobalSearch()
initPlatformShortcuts()

document.querySelectorAll('.sidebar-tabs button').forEach(button => {
  button.addEventListener('click', () => setPanel(button.dataset.panel))
})

ui.taskClear.addEventListener('click', () => {
  for (let index = exportTasks.length - 1; index >= 0; index--) {
    if (exportTasks[index].status !== 'exporting') exportTasks.splice(index, 1)
  }
  renderExportTasks()
})

ui.taskList.addEventListener('click', event => {
  const cancelButton = event.target.closest('[data-cancel-task]')
  if (cancelButton) {
    const task = exportTasks.find(item => item.id === cancelButton.dataset.cancelTask)
    if (task?.status === 'exporting') {
      task.cancelRequested = true
      task.progressText = '正在取消'
      renderExportTasks()
    }
    return
  }
  const removeButton = event.target.closest('[data-remove-task]')
  if (!removeButton) return
  const taskIndex = exportTasks.findIndex(task => task.id === removeButton.dataset.removeTask)
  if (taskIndex >= 0 && exportTasks[taskIndex].status !== 'exporting') {
    exportTasks.splice(taskIndex, 1)
    renderExportTasks()
  }
})

initSidebarResize()
initSidebarCollapse()

ui.search.addEventListener('input', () => {
  clearTimeout(fileSearchTimer)
  const activePanel = document.querySelector('.sidebar-tabs button.active')?.dataset.panel
  if (activePanel === 'outline') renderOutline()
  else {
    ui.fileSearchTypes.classList.add('is-loading')
    fileSearchTimer = window.setTimeout(() => {
      ui.fileSearchTypes.classList.remove('is-loading')
      filterFiles(ui.search.value)
    }, 180)
  }
})

// 文档 iframe 内的点击事件：代码复制按钮、文档跳转链接
async function handlePreviewClick(event, documentDoc = activeDoc()) {
  const clickedImage = event.target.closest?.('img.mdr-viewable-img')
  if (clickedImage && !clickedImage.closest('a[href]')) return
  const exportButton = event.target.closest?.('.mdr-block__export-btn')
  if (exportButton) {
    event.preventDefault()
    event.stopPropagation()
    void exportCodeBlockPNG(exportButton.closest('.mdr-code-block'), exportButton, documentDoc)
    return
  }
  const copyBtn = event.target.closest('.mdr-block__copy-btn')
  if (copyBtn) {
    event.preventDefault()
    event.stopPropagation()
    const codeBlock = copyBtn.closest('.mdr-code-block')
    const codeElement = codeBlock ? codeBlock.querySelector('code') : null
    const textToCopy = codeElement ? (codeElement.textContent || '') : ''
    if (textToCopy) {
      try {
        await navigator.clipboard.writeText(textToCopy)
        copyBtn.classList.add('copied')
        clearTimeout(copyBtn._copiedTimer)
        copyBtn._copiedTimer = setTimeout(() => {
          copyBtn.classList.remove('copied')
        }, 1800)
        toast('代码已复制到剪贴板')
      } catch (err) {
        toast(`复制失败: ${err.message || err}`)
      }
    }
    return
  }

  const anchor = event.target.closest('a[href]')
  if (!anchor) return
  const href = anchor.getAttribute('href') || ''
  const doc = documentDoc
  if (href.startsWith('#') && !href.includes('://')) {
    event.preventDefault()
    void navigateDocumentToFragment(doc, href)
    return
  }
  event.preventDefault()
  event.stopPropagation()
  try {
    const resolvedURL = new URL(href, doc?.sourceURL || window.location.href)
    const openInBrowserTab = event.metaKey || event.ctrlKey
    void (async () => {
      if (!openInBrowserTab && await openMarkdownDocumentLink(resolvedURL.href)) return
      const result = await chrome.runtime.sendMessage({type: 'lumina:open-link', url: resolvedURL.href})
      if (!result?.ok) console.warn('无法在新标签页打开链接', result?.error || '未知错误')
    })().catch(error => console.warn('无法打开链接', error))
  } catch (error) {
    console.warn('Markdown 链接地址无效', error)
  }
}

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault()
    void openFilePicker()
  }
  if ((event.metaKey || event.ctrlKey) && event.key === ',') {
    event.preventDefault()
    if (ui.settings.classList.contains('show')) closeSettingsModal()
    else openSettingsModal()
  }
  if (event.key === 'Escape' && ui.settings.classList.contains('show')) closeSettingsModal()
})

window.addEventListener('focus', () => {
  void syncSharedAppearancePreferences()
  void pollActiveDocument()
})

window.addEventListener('hashchange', () => {
  const doc = activeDoc()
  if (!doc?.sourceURL || documentSourceURLKey(doc.sourceURL) !== documentSourceURLKey(location.href)) return
  const sourceURL = localDocumentURL(location.href) || cleanRemoteMarkdownURL(location.href, {preserveHash: true})
  if (!sourceURL) return
  doc.sourceURL = sourceURL
  doc.pendingFragment = location.hash
  if (doc.pendingFragment) void navigateDocumentToFragment(doc)
  writeTabStateToURL('replace')
})
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    void syncSharedAppearancePreferences()
    void pollDirectoryTree()
    void pollActiveDocument()
  }
})

// ==========================================================================
// 工作区状态恢复
// ==========================================================================
async function loadSessionTabs() {
  const legacyParameter = new URLSearchParams(location.search).get(TAB_QUERY_KEY)
  let legacyEntries = null
  if (legacyParameter) {
    const parsed = decodeLegacyTabParameter(legacyParameter)
    legacyEntries = parsed.entries
    const migration = await chrome.runtime.sendMessage({
      type: 'lumina:session-save',
      requestId: crypto.randomUUID(),
      sessionId: currentSessionId,
      tabs: tabPayloadFromLegacyEntries(parsed.entries),
      migration: true,
    })
    if (migration?.ok) {
      removeLegacyTabParameter()
      console.info('[LuminaChrome][session-cache] 已将 lumina-tab 迁移到扩展 IndexedDB', {
        sessionId: currentSessionId,
        tabCount: parsed.entries.length,
      })
      return parsed.entries
    }
    console.error('[LuminaChrome][session-cache] 迁移 lumina-tab 失败，保留地址栏参数', {
      sessionId: currentSessionId,
      error: migration?.error || 'IndexedDB 会话写入失败',
    })
  }

  const result = await chrome.runtime.sendMessage({type: 'lumina:session-get', sessionId: currentSessionId})
  if (!result?.ok) {
    console.error('[LuminaChrome][session-cache] 读取扩展 IndexedDB 会话失败', {
      sessionId: currentSessionId,
      error: result?.error || 'IndexedDB 会话读取失败',
    })
    return legacyEntries || []
  }
  const tabs = result.record?.tabs
  if (!tabs || typeof tabs !== 'object' || Array.isArray(tabs)) return legacyEntries || []
  const entries = parseSessionTabState(tabs)
  console.info('[LuminaChrome][session-cache] 已从扩展 IndexedDB 读取标签状态', {
    sessionId: currentSessionId,
    tabCount: entries.length,
    lastAccessedAt: result.record.lastAccessedAt || 0,
  })
  return legacyEntries?.length ? legacyEntries : entries
}

async function restoreWorkspace() {
  startExtensionVersionMonitor()
  startFileURLPermissionMonitor()
  await ensureSessionIdentity()
  await clearLegacyWorkspaceDatabase()
  let storedPreferences = null
  try {
    storedPreferences = (await chrome?.storage?.local?.get('preferences'))?.preferences
  } catch {}
  if (storedPreferences) Object.assign(preferences, storedPreferences)
  preferences.imageExportMaximumHeight = Math.max(MIN_IMAGE_EXPORT_HEIGHT, Math.min(MAX_IMAGE_EXPORT_HEIGHT, Number(preferences.imageExportMaximumHeight) || DEFAULT_IMAGE_EXPORT_HEIGHT))
  preferences.imageExportPixelRatio = Math.round(Math.max(MIN_IMAGE_EXPORT_PIXEL_RATIO, Math.min(MAX_IMAGE_EXPORT_PIXEL_RATIO, Number(preferences.imageExportPixelRatio) || DEFAULT_IMAGE_EXPORT_PIXEL_RATIO)) * 10) / 10
  preferences.imageExportRetries = Math.round(Math.max(0, Math.min(10, Number(preferences.imageExportRetries ?? 3))))
  preferences.imageExportTimeoutSeconds = Math.round(Math.max(1, Math.min(120, Number(preferences.imageExportTimeoutSeconds) || 30)))
  preferences.autoScrollInterval = Math.round(Math.max(1, Math.min(15000, Number(preferences.autoScrollInterval) || 20)))
  preferences.autoScrollAmount = Math.round(Math.max(1, Math.min(800, Number(preferences.autoScrollAmount) || 1)))
  syncSettingsUI()
  applyPreferences()

  rootHandle = null
  rootEntries = []
  fileIndex = []
  localTreeRoot = null
  additionalDirectoryRoots = []
  primaryRootTreeId = ''
  await restoreExpandedDirectories()
  const sessionEntries = await loadSessionTabs()
  if (await restoreTabsFromEntries(sessionEntries)) {
    delete window.__LUMINA_PENDING_TOKEN__
    delete window.__LUMINA_PENDING_DOCUMENT__
    persistState()
    return
  }

  const pendingToken = window.__LUMINA_PENDING_TOKEN__ || new URLSearchParams(location.search).get('openLocal')
  if (pendingToken) {
    const pending = window.__LUMINA_PENDING_DOCUMENT__
    if (pending?.source) {
      docs.length = 0
      const doc = {
        id: crypto.randomUUID(),
        title: pending.title || 'Markdown 文档',
        source: pending.source,
        sourceURL: localDocumentURL(pending.sourceURL) || pending.sourceURL,
        sourceFromLoadedPage: location.protocol === 'file:',
        pendingFragment: (() => { try { return new URL(pending.sourceURL).hash } catch { return '' } })(),
        objectURLs: [],
      }
      setDocument(doc, {persist: false})
      delete window.__LUMINA_PENDING_TOKEN__
      delete window.__LUMINA_PENDING_DOCUMENT__
      // Keep the tree anchored to the browser's original file:// location even
      // when a different Markdown file was opened from the tree.
      if (location.protocol === 'file:') await scanLocalDirectoryTree(location.href)
      renderFiles()
      updateControls()
      return
    }
    if (new URLSearchParams(location.search).has('openLocal')) writeTabStateToURL('replace')
  }

  renderTabs()
  const doc = activeDoc()
  if (doc) {
    if (doc.handle && await requestHandlePermission(doc.handle, 'read')) {
      try {
        const file = await doc.handle.getFile()
        doc.source = await file.text()
        doc.lastModified = file.lastModified
      } catch {}
    }
    await renderActive()
    updateControls()
    writeTabStateToURL('replace')
  }
}

window.addEventListener('popstate', () => {
  const url = new URL(location.href)
  if (url.searchParams.has(TAB_QUERY_KEY)) void loadSessionTabs().then(restoreTabsFromEntries)
})
window.addEventListener('pagehide', flushTabStateURLWrite)

void restoreWorkspace().then(startLiveWatchers).catch(error => {
  startLiveWatchers()
  toast(`恢复工作区失败：${error.message || error}`)
})
