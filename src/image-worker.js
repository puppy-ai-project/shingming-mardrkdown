import {Zip, ZipPassThrough} from 'fflate'

const zipSessions = new Map()
const outputs = new Map()

function createZipContext() {
  const chunks = []
  let resolveArchive
  let rejectArchive
  const completed = new Promise((resolve, reject) => {
    resolveArchive = resolve
    rejectArchive = reject
  })
  completed.catch(() => {})
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      rejectArchive(error)
      return
    }
    if (chunk?.length) chunks.push(chunk)
    if (final) resolveArchive(new Blob(chunks, {type: 'application/zip'}))
  })
  return {zip, completed, pageCount: 0, currentEntry: null}
}

function decodeBase64(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'lumina:image-offscreen') return
  const {action, payload = {}} = message
  if (action === 'ping') {
    sendResponse({ok: true})
    return
  }
  const {sessionId} = payload
  try {
    if (!sessionId) throw new Error('缺少 PNG 会话标识')
    if (action === 'init') {
      zipSessions.set(sessionId, payload.zip ? createZipContext() : null)
      sendResponse({ok: true})
      return
    }

    if (action === 'cancel') {
      zipSessions.delete(sessionId)
      outputs.delete(sessionId)
      sendResponse({ok: true})
      return
    }

    if (action === 'read-output') {
      const output = outputs.get(sessionId)
      if (!output) throw new Error('PNG 压缩包不存在')
      const part = output.bytes.subarray(payload.offset, payload.offset + payload.length)
      sendResponse({ok: true, base64: encodeBase64(part)})
      return
    }

    if (action === 'close') {
      outputs.delete(sessionId)
      sendResponse({ok: true})
      return
    }

    const zipContext = zipSessions.get(sessionId)
    if (action === 'add-page-start') {
      if (!zipContext) throw new Error('ZIP 尚未初始化')
      if (zipContext.currentEntry) throw new Error('上一张 PNG 尚未传输完成')
      zipContext.currentEntry = new ZipPassThrough(payload.filename)
      zipContext.zip.add(zipContext.currentEntry)
      sendResponse({ok: true})
      return
    }

    if (action === 'add-page-chunk') {
      if (!zipContext?.currentEntry || !payload.base64) throw new Error('没有待接收的 PNG 分片')
      zipContext.currentEntry.push(decodeBase64(payload.base64), false)
      sendResponse({ok: true})
      return
    }

    if (action === 'add-page-end') {
      if (!zipContext?.currentEntry) throw new Error('没有待结束的 PNG 分片')
      zipContext.currentEntry.push(new Uint8Array(), true)
      zipContext.currentEntry = null
      zipContext.pageCount++
      sendResponse({ok: true})
      return
    }

    if (action === 'add-page') {
      if (!payload.base64) throw new Error('没有收到 PNG 图片数据')
      const bytes = decodeBase64(payload.base64)
      if (zipContext) {
        const entry = new ZipPassThrough(payload.filename)
        zipContext.zip.add(entry)
        entry.push(bytes, true)
        zipContext.pageCount++
        sendResponse({ok: true})
      } else {
        sendResponse({ok: true, base64: payload.base64, mimeType: 'image/png'})
      }
      return
    }

    if (action === 'finish') {
      if (!zipContext) throw new Error('ZIP 尚未初始化')
      const archive = zipContext
      zipSessions.delete(sessionId)
      archive.zip.end()
      void archive.completed.then(async blob => {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        outputs.set(sessionId, {bytes, pageCount: archive.pageCount})
        sendResponse({ok: true, size: bytes.length, pageCount: archive.pageCount})
      }).catch(error => sendResponse({ok: false, error: error?.message || String(error)}))
      return true
    }

    throw new Error(`未知的图片导出操作：${action}`)
  } catch (error) {
    sendResponse({ok: false, error: error?.message || String(error)})
  }
  return true
})
