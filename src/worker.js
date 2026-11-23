const activeOffscreenSessions = new Set()
let offscreenDocumentCreation = null
const sessionDatabaseName = 'shiming-sessions-v1'
const sessionStoreName = 'sessions'
const sessionIdPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
const tabSessionStoragePrefix = 'shiming_session_tab_'
const tabSessionIds = new Map()
const sessionCleanupAlarm = 'shiming-session-cleanup'
const sessionMissingCountsKey = 'shiming_session_missing_counts'
const sessionCleanupDebug = false
const sessionCleanupPeriodMinutes = sessionCleanupDebug ? 5 / 60 : 0.5
let sessionCleanupInProgress = false

async function ensureSessionCleanupAlarm() {
  const alarm = await chrome.alarms.get(sessionCleanupAlarm)
  if (!alarm || Math.abs(alarm.periodInMinutes - sessionCleanupPeriodMinutes) > 0.000001) {
    await chrome.alarms.create(sessionCleanupAlarm, {periodInMinutes: sessionCleanupPeriodMinutes})
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== sessionCleanupAlarm || sessionCleanupInProgress) return
  sessionCleanupInProgress = true
  void cleanupMissingSessions().catch(error => {
    console.error('[LuminaChrome][session-cache] 定时清理会话失败', error)
  }).finally(() => { sessionCleanupInProgress = false })
})

void ensureSessionCleanupAlarm().catch(error => {
  console.error('[LuminaChrome][session-cache] 创建会话清理定时任务失败', error)
})

function tabSessionStorageKey(tabId) {
  return `${tabSessionStoragePrefix}${tabId}`
}

async function rememberTabSession(tabId, sessionId) {
  if (!Number.isInteger(tabId) || !sessionIdPattern.test(String(sessionId || ''))) return
  tabSessionIds.set(tabId, sessionId)
  await chrome.storage.session.set({[tabSessionStorageKey(tabId)]: sessionId})
}

async function forgetTabSession(tabId) {
  tabSessionIds.delete(tabId)
  await chrome.storage.session.remove(tabSessionStorageKey(tabId))
}

async function findTabSession(tabId) {
  const inMemory = tabSessionIds.get(tabId)
  if (inMemory) return inMemory
  const key = tabSessionStorageKey(tabId)
  const stored = await chrome.storage.session.get(key)
  const sessionId = stored[key]
  if (sessionId) tabSessionIds.set(tabId, sessionId)
  return sessionId || ''
}

async function hydrateTabSessionIds() {
  try {
    const values = await chrome.storage.session.get(null)
    for (const [key, sessionId] of Object.entries(values)) {
      if (!key.startsWith(tabSessionStoragePrefix) || !sessionIdPattern.test(String(sessionId || ''))) continue
      const tabId = Number(key.slice(tabSessionStoragePrefix.length))
      if (Number.isInteger(tabId)) tabSessionIds.set(tabId, sessionId)
    }
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id) || !tab.url) continue
      let sessionId = ''
      try { sessionId = new URL(tab.url).searchParams.get('shiming-session') || '' } catch {}
      if (sessionIdPattern.test(sessionId)) await rememberTabSession(tab.id, sessionId)
    }
  } catch (error) {
    console.warn('[LuminaChrome][session-cache] 恢复 tab 与会话 ID 映射失败', error)
  }
}

void hydrateTabSessionIds()

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (changeInfo.status === 'complete' ? tab.url : '')
  if (!url) return
  let sessionId = ''
  try { sessionId = new URL(url).searchParams.get('shiming-session') || '' } catch {}
  if (sessionIdPattern.test(sessionId)) {
    void rememberTabSession(tabId, sessionId).catch(error => {
      console.warn('[LuminaChrome][session-cache] 更新 tab 与会话 ID 映射失败', {tabId, error: error?.message || String(error)})
    })
  } else if (changeInfo.status === 'complete') {
    void forgetTabSession(tabId).catch(error => {
      console.warn('[LuminaChrome][session-cache] 清除 tab 与会话 ID 映射失败', {tabId, error: error?.message || String(error)})
    })
  }
})

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void (async () => {
    let sessionId = ''
    try {
      sessionId = await findTabSession(tabId)
    } catch (error) {
      console.warn('[LuminaChrome][session-cache] 读取已关闭 tab 的会话 ID 失败', {tabId, error: error?.message || String(error)})
    }
    console.info('[LuminaChrome][session-cache] 浏览器标签已关闭', {
      tabId,
      sessionId: sessionId || null,
      isWindowClosing: Boolean(removeInfo.isWindowClosing),
    })
    if (!sessionCleanupDebug && sessionIdPattern.test(sessionId)) {
      try {
        const deleted = await deleteSessionRecord(sessionId)
        console.info('[LuminaChrome][session-cache] 已删除关闭标签对应的会话记录', {tabId, sessionId, deleted})
      } catch (error) {
        console.error('[LuminaChrome][session-cache] 删除关闭标签对应的会话记录失败', {
          tabId,
          sessionId,
          error: error?.message || String(error),
        })
      }
    }
    try {
      await forgetTabSession(tabId)
    } catch (error) {
      console.warn('[LuminaChrome][session-cache] 清除已关闭 tab 的会话映射失败', {tabId, error: error?.message || String(error)})
    }
  })()
})

function openSessionDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(sessionDatabaseName, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(sessionStoreName)) {
        database.createObjectStore(sessionStoreName, {keyPath: 'sessionId'})
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('打开会话 IndexedDB 失败'))
    request.onblocked = () => reject(new Error('会话 IndexedDB 升级被阻塞'))
  })
}

function readAllSessionRecords() {
  return openSessionDatabase().then(database => new Promise((resolve, reject) => {
    const transaction = database.transaction(sessionStoreName, 'readonly')
    const request = transaction.objectStore(sessionStoreName).getAll()
    let records = []
    request.onsuccess = () => { records = request.result }
    transaction.oncomplete = () => { database.close(); resolve(records) }
    transaction.onerror = transaction.onabort = () => {
      database.close()
      reject(transaction.error || new Error('扫描会话事务失败'))
    }
  }))
}

async function getOpenSessionIds() {
  const tabs = await chrome.tabs.query({})
  const ids = new Set()
  for (const tab of tabs) {
    for (const url of [tab.url, tab.pendingUrl]) {
      if (!url) continue
      try {
        const id = new URL(url).searchParams.get('shiming-session') || ''
        if (sessionIdPattern.test(id)) ids.add(id)
      } catch {}
    }
  }
  return ids
}

async function cleanupMissingSessions() {
  const [records, openIds, stored] = await Promise.all([
    readAllSessionRecords(), getOpenSessionIds(), chrome.storage.session.get(sessionMissingCountsKey),
  ])
  const previous = stored[sessionMissingCountsKey] || {}
  const counts = Object.create(null)
  const candidates = []
  for (const record of records) {
    const id = record.sessionId
    if (!sessionIdPattern.test(String(id || '')) || openIds.has(id)) continue
    const count = (Number(previous[id]) || 0) + 1
    counts[id] = count
    console.info('[LuminaChrome][session-cache] 扫描未找到会话', {sessionId: id, missingCount: count})
    if (count >= 15) candidates.push(record)
  }
  if (candidates.length) {
    const currentOpenIds = await getOpenSessionIds()
    for (const record of candidates) {
      if (currentOpenIds.has(record.sessionId)) {
        delete counts[record.sessionId]
        continue
      }
      if (sessionCleanupDebug) {
        console.info('[LuminaChrome][session-cache] 调试模式：待删除会话', {sessionId: record.sessionId, missingCount: counts[record.sessionId]})
      } else if (await deleteUnchangedSessionRecord(record)) delete counts[record.sessionId]
    }
  }
  await chrome.storage.session.set({[sessionMissingCountsKey]: counts})
  console.info('[LuminaChrome][session-cache] 会话定时扫描完成', {total: records.length, missing: Object.keys(counts).length})
}

function deleteUnchangedSessionRecord(snapshot) {
  return openSessionDatabase().then(database => new Promise((resolve, reject) => {
    const transaction = database.transaction(sessionStoreName, 'readwrite')
    const store = transaction.objectStore(sessionStoreName)
    const request = store.get(snapshot.sessionId)
    let deleted = false
    request.onsuccess = () => {
      const current = request.result
      if (current && current.lastAccessedAt === snapshot.lastAccessedAt && current.updatedAt === snapshot.updatedAt) {
        store.delete(snapshot.sessionId)
        deleted = true
      }
    }
    transaction.oncomplete = () => { database.close(); resolve(deleted) }
    transaction.onerror = transaction.onabort = () => {
      database.close()
      reject(transaction.error || new Error('清理会话事务失败'))
    }
  }))
}

function readSessionRecord(sessionId) {
  return openSessionDatabase().then(database => new Promise((resolve, reject) => {
    const transaction = database.transaction(sessionStoreName, 'readonly')
    const request = transaction.objectStore(sessionStoreName).get(sessionId)
    let record = null
    request.onsuccess = () => { record = request.result || null }
    request.onerror = () => reject(request.error || new Error('读取会话记录失败'))
    transaction.oncomplete = () => {
      database.close()
      resolve(record)
    }
    transaction.onerror = transaction.onabort = () => {
      database.close()
      reject(transaction.error || new Error('读取会话事务失败'))
    }
  }))
}

function deleteSessionRecord(sessionId) {
  if (!sessionIdPattern.test(String(sessionId || ''))) return Promise.resolve(false)
  return openSessionDatabase().then(database => new Promise((resolve, reject) => {
    const transaction = database.transaction(sessionStoreName, 'readwrite')
    transaction.objectStore(sessionStoreName).delete(sessionId)
    transaction.oncomplete = () => {
      database.close()
      resolve(true)
    }
    transaction.onerror = transaction.onabort = () => {
      database.close()
      reject(transaction.error || new Error('删除会话事务失败'))
    }
  }))
}

function updateSessionRecord(sessionId, update) {
  return openSessionDatabase().then(database => new Promise((resolve, reject) => {
    const transaction = database.transaction(sessionStoreName, 'readwrite')
    const store = transaction.objectStore(sessionStoreName)
    const request = store.get(sessionId)
    let record = null
    request.onsuccess = () => {
      try {
        record = update(request.result || null)
        store.put(record)
      } catch (error) {
        transaction.abort()
        reject(error)
      }
    }
    request.onerror = () => reject(request.error || new Error('读取会话记录失败'))
    transaction.oncomplete = () => {
      database.close()
      resolve(record)
    }
    transaction.onerror = transaction.onabort = () => {
      database.close()
      reject(transaction.error || new Error('写入会话事务失败'))
    }
  }))
}

function normalizeSessionTabs(tabs) {
  if (!tabs || typeof tabs !== 'object' || Array.isArray(tabs)) throw new Error('会话标签数据格式无效')
  const normalized = Object.create(null)
  for (const [path, value] of Object.entries(tabs)) {
    if (!path || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const tagNum = Number(value.tagNum)
    const isCurrentTag = Number(value.isCurrentTag)
    const scrollTop = Number(value.scrollTop)
    if (!Number.isInteger(tagNum) || tagNum < 0 || ![0, 1].includes(isCurrentTag)) continue
    normalized[path] = {
      tagNum,
      isCurrentTag,
      scrollTop: Number.isFinite(scrollTop) && scrollTop >= -1 ? scrollTop : -1,
    }
  }
  return normalized
}

async function claimSessionId(requestedId, senderTabId) {
  if (!Number.isInteger(senderTabId)) throw new Error('无法确定当前浏览器标签页')
  let sessionId = typeof requestedId === 'string' && sessionIdPattern.test(requestedId) ? requestedId : crypto.randomUUID()
  const tabs = await chrome.tabs.query({})
  const duplicate = tabs.some(tab => {
    if (tab.id === senderTabId) return false
    return [tab.url, tab.pendingUrl].some(url => {
      if (!url) return false
      try { return new URL(url).searchParams.get('shiming-session') === sessionId } catch { return false }
    })
  })
  if (!duplicate) return {sessionId, copied: false}
  const originalSessionId = sessionId
  sessionId = crypto.randomUUID()
  const copied = await copySessionRecord(originalSessionId, sessionId)
  console.info('[LuminaChrome][session-cache] 检测到重复会话，已分配新会话', {tabId: senderTabId, originalSessionId, sessionId, copied})
  return {sessionId, copied}
}

function copySessionRecord(sourceSessionId, targetSessionId) {
  return openSessionDatabase().then(database => new Promise((resolve, reject) => {
    const transaction = database.transaction(sessionStoreName, 'readwrite')
    const store = transaction.objectStore(sessionStoreName)
    const request = store.get(sourceSessionId)
    let copied = false
    request.onsuccess = () => {
      if (!request.result) return
      store.add({...request.result, sessionId: targetSessionId, lastAccessedAt: Date.now()})
      copied = true
    }
    transaction.oncomplete = () => { database.close(); resolve(copied) }
    transaction.onerror = transaction.onabort = () => {
      database.close()
      reject(transaction.error || new Error('复制会话记录失败'))
    }
  }))
}

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({url: chrome.runtime.getURL('index.html')})
})

const installReportedStorageKey = 'shiming_install_reported_v1'
let installReportInProgress = null

function reportExtensionInstallOnce() {
  if (installReportInProgress) return installReportInProgress
  installReportInProgress = (async () => {
    const stored = await chrome.storage.local.get(installReportedStorageKey)
    if (stored[installReportedStorageKey] === true) return {reported: true, alreadyReported: true}

    const version = chrome.runtime.getManifest().version
    const url = `${__LUMINA_INSTALL_API_BASE__}/chrome/install?version=${encodeURIComponent(version)}`
    const response = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain;charset=UTF-8'},
      body: '',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`安装上报请求失败（HTTP ${response.status}）`)

    await chrome.storage.local.set({[installReportedStorageKey]: true})
    return {reported: true, alreadyReported: false}
  })().finally(() => { installReportInProgress = null })
  return installReportInProgress
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'lumina:report-install') return
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ok: false, error: '无效的安装上报请求'})
    return
  }
  if (__LUMINA_DEV__) {
    sendResponse({ok: true, skipped: 'development'})
    return
  }
  void reportExtensionInstallOnce()
    .then(result => sendResponse({ok: true, ...result}))
    .catch(error => sendResponse({ok: false, error: String(error?.message || error)}))
  return true
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'lumina:session-claim') {
    void claimSessionId(message.sessionId, sender.tab?.id)
      .then(async result => {
        await rememberTabSession(sender.tab.id, result.sessionId)
        sendResponse({ok: true, ...result})
      })
      .catch(error => sendResponse({ok: false, error: String(error?.message || error)}))
    return true
  }

  if (message?.type === 'lumina:session-get') {
    if (sender.id !== chrome.runtime.id || typeof message.sessionId !== 'string' || !message.sessionId) {
      sendResponse({ok: false, error: '无效的会话读取请求'})
      return
    }
    void readSessionRecord(message.sessionId)
      .then(record => sendResponse({ok: true, record}))
      .catch(error => sendResponse({ok: false, error: String(error?.message || error)}))
    return true
  }

  if (message?.type === 'lumina:session-save') {
    if (sender.id !== chrome.runtime.id || typeof message.sessionId !== 'string' || !message.sessionId) {
      sendResponse({ok: false, error: '无效的会话保存请求'})
      return
    }
    void Promise.resolve().then(() => normalizeSessionTabs(message.tabs)).then(tabs =>
      updateSessionRecord(message.sessionId, previous => {
        const now = Date.now()
        return {
          ...(previous || {}),
          sessionId: message.sessionId,
          version: 1,
          tabs,
          updatedAt: now,
          lastAccessedAt: now,
        }
      })
    ).then(record => {
      console.info('[LuminaChrome][session-cache] Worker 已保存会话标签', {
        requestId: message.requestId || '',
        sessionId: message.sessionId,
        tabCount: Object.keys(record.tabs).length,
        migration: Boolean(message.migration),
      })
      sendResponse({ok: true, saved: true, sessionId: message.sessionId, tabCount: Object.keys(record.tabs).length})
    }).catch(error => {
      console.error('[LuminaChrome][session-cache] Worker 保存会话失败', {
        requestId: message.requestId || '',
        sessionId: message.sessionId,
        name: error?.name,
        message: error?.message || String(error),
      })
      sendResponse({ok: false, error: String(error?.message || error)})
    })
    return true
  }

  if (message?.type === 'lumina:pdf-worker' || message?.type === 'lumina:image-worker') {
    void (async () => {
      const isPDF = message.type === 'lumina:pdf-worker'
      const targetType = isPDF ? 'lumina:pdf-offscreen' : 'lumina:image-offscreen'
      const sessionKey = `${message.type}:${message.payload?.sessionId}`
      const offscreenURL = chrome.runtime.getURL('offscreen.html')
      if (!offscreenDocumentCreation) {
        offscreenDocumentCreation = (async () => {
          const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenURL]})
          if (!contexts.length) {
            await chrome.offscreen.createDocument({
              url: 'offscreen.html',
              reasons: ['BLOBS'],
              justification: '在扩展后台处理 PDF 和 PNG 导出，避免阻塞文档页面',
            })
          }
        })().finally(() => { offscreenDocumentCreation = null })
      }
      await offscreenDocumentCreation
      let ready = false
      for (let attempt = 0; attempt < 30 && !ready; attempt++) {
        const response = await chrome.runtime.sendMessage({type: targetType, action: 'ping'})
        ready = Boolean(response?.ok)
        if (!ready) await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!ready) throw new Error('导出后台页面启动超时')
      const response = await chrome.runtime.sendMessage({type: targetType, action: message.action, payload: message.payload})
      if (message.action === 'init' && response?.ok) activeOffscreenSessions.add(sessionKey)
      if (message.action === 'cancel' || message.action === 'close') {
        activeOffscreenSessions.delete(sessionKey)
        if (!activeOffscreenSessions.size) await chrome.offscreen.closeDocument()
      }
      sendResponse(response || {ok: false, error: '导出后台没有返回结果'})
    })().catch(error => sendResponse({ok: false, error: String(error?.message || error)}))
    return true
  }

  if (message?.type === 'lumina:open-file-url-access-settings') {
    void chrome.tabs.create({url: `chrome://extensions/?id=${chrome.runtime.id}`, active: true})
      .then(tab => sendResponse({ok: true, tabId: tab.id}))
      .catch(error => sendResponse({ok: false, error: String(error?.message || error)}))
    return true
  }

  if (message?.type === 'lumina:get-file-url-access') {
    Promise.resolve()
      .then(() => chrome.extension.isAllowedFileSchemeAccess())
      .then(allowed => sendResponse({ok: true, allowed}))
      .catch(error => sendResponse({ok: false, error: String(error?.message || error)}))
    return true
  }

  if (message?.type === 'lumina:open-link' && typeof message.url === 'string') {
    void chrome.tabs.create({url: message.url, active: true})
      .then(tab => sendResponse({ok: true, tabId: tab.id}))
      .catch(error => sendResponse({ok: false, error: String(error?.message || error)}))
    return true
  }

  if (message?.type === 'lumina:open-local-markdown') {
    const token = crypto.randomUUID()
    sendResponse({ok: true, token, document: message.document})
    return
  }

  if (message?.type === 'lumina:scan-local-tree') {
    if (!sender.url?.startsWith('file://') || typeof message.fileURL !== 'string' || !isFileURL(message.fileURL)) {
      sendResponse({ok: false, error: '仅允许从本地 Markdown 页面读取目录'})
      return
    }
    void scanLocalTree(message.fileURL).then(sendResponse).catch(error => {
      sendResponse({ok: false, error: String(error?.message || error)})
    })
    return true
  }

  if (message?.type === 'lumina:read-local-markdown') {
    if (!sender.url?.startsWith('file://') || typeof message.fileURL !== 'string' || !isWithinDocumentDirectory(message.fileURL, sender.url) || !markdownFile.test(new URL(message.fileURL).pathname)) {
      sendResponse({ok: false, error: '仅允许从本地 Markdown 页面读取文件'})
      return
    }
    void fetch(message.fileURL).then(response => response.text()).then(source => {
      sendResponse({ok: true, source})
    }).catch(error => sendResponse({ok: false, error: String(error?.message || error)}))
    return true
  }

  if (message?.type === 'lumina:read-remote-markdown') {
    const senderURL = getRemoteMarkdownURL(sender.url)
    const documentURL = getRemoteMarkdownURL(message.url)
    const localMarkdownSender = isFileURL(sender.url) && markdownFile.test(new URL(sender.url).pathname)
    if ((!senderURL && !localMarkdownSender) || !documentURL) {
      sendResponse({ok: false, error: '仅支持从 Markdown 网页读取 HTTP/HTTPS Markdown 文本'})
      return
    }
    console.info('[LuminaChrome][remote-markdown] Worker 收到请求', {url: documentURL.href, senderURL: sender.url})
    void (async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20_000)
      try {
        const response = await fetch(documentURL.href, {cache: 'no-store', credentials: 'omit', redirect: 'follow', signal: controller.signal})
        const finalURL = getRemoteMarkdownURL(response.url)
        if (!response.ok || !finalURL) throw new Error('无法读取远程 Markdown 页面')
        const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
        if (contentType && !['text/markdown', 'text/x-markdown', 'text/plain', 'application/markdown', 'application/x-markdown', 'application/octet-stream'].includes(contentType)) {
          throw new Error('该地址没有返回 Markdown 文本')
        }
        const source = await response.text()
        console.info('[LuminaChrome][remote-markdown] Worker 读取完成', {url: finalURL.href, sourceLength: source.length})
        sendResponse({ok: true, source})
      } catch (error) {
        const reason = controller.signal.aborted ? '远程 Markdown 读取超时（20 秒）' : String(error?.message || error)
        console.error('[LuminaChrome][remote-markdown] Worker 读取失败', {url: documentURL.href, error: reason})
        sendResponse({ok: false, error: reason})
      } finally {
        clearTimeout(timeout)
      }
    })()
    return true
  }

  if (message?.type === 'lumina:read-export-image') {
    const imageURL = parseExportImageURL(message.url, message.documentURL, sender)
    if (!imageURL) {
      const reason = sender.id !== chrome.runtime.id ? '消息来源不是当前扩展' : '图片地址或文档来源无效'
      console.warn('[LuminaChrome][image-export] 请求被拒绝:', reason, '图片地址:', String(message.url || ''), '文档地址:', String(message.documentURL || ''), '发送方:', String(sender.url || ''))
      sendResponse({ok: false, error: `图片地址不允许导出：${reason}`})
      return
    }
    console.info('[LuminaChrome][image-export] Worker 收到图片请求', {url: imageURL.href, senderURL: sender.url})
    void (async () => {
      const controller = new AbortController()
      const timeoutMs = Math.max(1000, Math.min(120_000, Number(message.timeoutMs) || 30_000))
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(imageURL.href, {cache: 'force-cache', credentials: 'omit', redirect: 'follow', signal: controller.signal})
        if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}）`)
        const blob = await response.blob()
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const mime = exportImageMime(bytes, blob.type)
        if (!mime) throw new Error('资源不是受支持的图片')
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
        }
        const dataURL = `data:${mime};base64,${btoa(binary)}`
        console.info('[LuminaChrome][image-export] Worker 下载完成', {url: imageURL.href, mime, byteLength: bytes.length})
        sendResponse({ok: true, dataURL})
      } catch (error) {
        const reason = controller.signal.aborted ? `图片下载超时（${Math.ceil(timeoutMs / 1000)} 秒）` : String(error?.message || error)
        console.error('[LuminaChrome][image-export] Worker 图片下载失败', {url: imageURL.href, error: reason})
        sendResponse({ok: false, error: reason})
      } finally {
        clearTimeout(timeout)
      }
    })()
    return true
  }
})

const markdownFile = /\.(?:md|markdown|mdown|mkd|mdx|mdc|txt)$/i
const maxScannedDirectories = 2000
const maxDirectoryDepth = 24

function getRemoteMarkdownURL(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || !/\.md$/i.test(url.pathname)) return null
    return url
  } catch {
    return null
  }
}

function isFileURL(value) {
  try { return new URL(value).protocol === 'file:' } catch { return false }
}

function isWithinDocumentDirectory(fileURL, documentURL) {
  try {
    const file = new URL(fileURL)
    const documentDirectory = new URL('.', documentURL)
    return file.protocol === 'file:' && file.pathname.startsWith(documentDirectory.pathname)
  } catch {
    return false
  }
}

function isWithinDocumentAssetScope(fileURL, documentURL) {
  try {
    const file = new URL(fileURL)
    const document = new URL(documentURL)
    if (file.protocol !== 'file:' || document.protocol !== 'file:') return false

    const allowedDirectories = [new URL('.', document), new URL('../', document)]
    return allowedDirectories.some(directory => file.pathname.startsWith(directory.pathname))
  } catch {
    return false
  }
}

function parseExportImageURL(value, documentValue, sender) {
  try {
    const resource = new URL(value)
    // The reader shell is injected into the original Markdown page, so
    // sender.url is often the website URL rather than chrome-extension://.
    // sender.id is the reliable signal that this request came from our
    // extension content script or extension page.
    if (sender.id !== chrome.runtime.id) return null
    if (['http:', 'https:'].includes(resource.protocol)) {
      return !resource.username && !resource.password ? resource : null
    }
    const document = new URL(documentValue)
    if (!markdownFile.test(document.pathname)) return null
    if (document.protocol === 'file:') {
      return resource.protocol === 'file:' && isWithinDocumentAssetScope(resource.href, document.href) ? resource : null
    }
    return null
  } catch {
    return null
  }
}

function exportImageMime(bytes, responseType) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return /^image\//i.test(responseType) ? responseType : ''
}

function parseDirectoryListing(html, directoryURL) {
  const entries = []
  for (const argumentText of findAddRowArguments(html)) {
    const args = parseJavaScriptArguments(argumentText)
    if (!args || args.length < 3) continue
    const name = String(args[0] ?? '')
    const encodedPath = String(args[1] ?? '')
    if (!name || name === '.' || name === '..' || name.startsWith('.')) continue
    try {
      entries.push({
        name,
        url: new URL(encodedPath, directoryURL).href,
        isDirectory: args[2] === true || args[2] === 1 || args[2] === 'true',
      })
    } catch {}
  }

  // Chromium has changed the internal directory-listing markup between
  // versions. Older builds expose links instead of inline addRow calls.
  if (entries.length === 0) {
    const anchors = /<a\b([^>]*?)href\s*=\s*("[^"]*"|'[^']*')[^>]*>([\s\S]*?)<\/a\s*>/gi
    for (const match of html.matchAll(anchors)) {
      const href = match[2].slice(1, -1)
      if (!href || href.startsWith('?') || href === '../' || href === '..') continue
      const name = decodeHtmlText(match[3].replace(/<[^>]*>/g, '').trim()) || decodeURIComponent(href.replace(/\/$/, '').split('/').pop() || '')
      if (!name || name.startsWith('.')) continue
      try {
        entries.push({name, url: new URL(href, directoryURL).href, isDirectory: href.endsWith('/')})
      } catch {}
    }
  }
  return entries
}

function* findAddRowArguments(html) {
  const invocation = /\baddRow\s*\(/gi
  for (const match of html.matchAll(invocation)) {
    if (/\bfunction\s*$/.test(html.slice(0, match.index))) continue
    const start = match.index + match[0].length
    let depth = 1
    let quote = ''
    let escaped = false
    for (let index = start; index < html.length; index++) {
      const char = html[index]
      if (escaped) { escaped = false; continue }
      if (quote && char === '\\') { escaped = true; continue }
      if (quote) {
        if (char === quote) quote = ''
        continue
      }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue }
      if (char === '(') depth++
      else if (char === ')' && --depth === 0) {
        yield html.slice(start, index)
        break
      }
    }
  }
}

function parseJavaScriptArguments(value) {
  const args = []
  let start = 0
  let quote = ''
  let escaped = false
  for (let index = 0; index <= value.length; index++) {
    const char = value[index]
    if (escaped) { escaped = false; continue }
    if (quote && char === '\\') { escaped = true; continue }
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char !== ',' && index < value.length) continue
    const raw = value.slice(start, index).trim()
    start = index + 1
    if (raw === 'true') args.push(true)
    else if (raw === 'false') args.push(false)
    else if (/^-?\d+(?:\.\d+)?$/.test(raw)) args.push(Number(raw))
    else if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      const body = raw.slice(1, -1)
      try { args.push(raw.startsWith('"') ? JSON.parse(raw) : decodeJavaScriptString(body)) } catch { return null }
    } else args.push(raw)
  }
  return args
}

function decodeJavaScriptString(value) {
  return value.replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/g, (_match, escaped) => {
    if (escaped.startsWith('u')) return String.fromCharCode(parseInt(escaped.slice(1), 16))
    if (escaped.startsWith('x')) return String.fromCharCode(parseInt(escaped.slice(1), 16))
    return ({n: '\n', r: '\r', t: '\t', b: '\b', f: '\f'})[escaped] ?? escaped
  })
}

function decodeHtmlText(value) {
  return value.replace(/&(?:amp|quot|#39|lt|gt);/g, entity => ({'&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>'})[entity])
}

async function scanLocalTree(fileURL) {
  if (!isFileURL(fileURL) || !markdownFile.test(new URL(fileURL).pathname)) {
    return {ok: false, error: '无效的本地 Markdown 地址'}
  }
  const rootURL = new URL('.', fileURL).href
  const rootPath = new URL(rootURL).pathname
  const rootName = decodeURIComponent(new URL(rootURL).pathname.split('/').filter(Boolean).pop() || '本地目录')
  const visited = new Set()
  let scanned = 0

  async function scanDirectory(directoryURL, depth, relativePath = '') {
    if (depth > maxDirectoryDepth || scanned >= maxScannedDirectories || visited.has(directoryURL)) return []
    visited.add(directoryURL)
    scanned++

    let html
    try {
      const response = await fetch(directoryURL, {cache: 'no-store'})
      html = await response.text()
    } catch (error) {
      if (depth === 0) throw new Error(`无法读取同级目录：${error?.message || error}`)
      return []
    }

    if (depth === 0 && !/addRow\s*\(/i.test(html)) {
      throw new Error('Chrome 未返回可识别的本地目录列表')
    }
    const listing = parseDirectoryListing(html, directoryURL)
    const files = listing
      .filter(entry => !entry.isDirectory && markdownFile.test(entry.name))
      .map(entry => ({kind: 'file', name: entry.name, path: relativePath ? `${relativePath}/${entry.name}` : entry.name, url: entry.url}))
    const directories = listing.filter(entry => entry.isDirectory)

    for (const entry of directories) {
      let childURL
      try { childURL = new URL(entry.url, directoryURL).href } catch { continue }
      if (!new URL(childURL).pathname.startsWith(rootPath)) continue
      const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name
      const children = await scanDirectory(childURL.endsWith('/') ? childURL : `${childURL}/`, depth + 1, childPath)
      if (children.length) files.push({kind: 'directory', name: entry.name, path: childPath, url: childURL, children})
    }

    return files.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-CN', {numeric: true})
    })
  }

  const entries = await scanDirectory(rootURL, 0)
  return {ok: true, root: {name: rootName, url: rootURL}, entries}
}
