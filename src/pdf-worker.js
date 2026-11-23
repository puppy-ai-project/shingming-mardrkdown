// Import jsPDF's readable browser build rather than its package-default minified entry.
import {jsPDF} from 'jspdf/dist/jspdf.es.js'

const sessions = new Map()
const outputs = new Map()

function encodeBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'lumina:pdf-offscreen') return
  const {action, payload = {}} = message
  if (action === 'ping') {
    sendResponse({ok: true})
    return
  }
  const {sessionId} = payload
  try {
    if (!sessionId) throw new Error('缺少 PDF 会话标识')
    if (action === 'init') {
      sessions.set(sessionId, new jsPDF({orientation: 'portrait', unit: 'pt', format: 'a4', compress: true}))
      sendResponse({ok: true})
      return
    }

    if (action === 'cancel') {
      sessions.delete(sessionId)
      outputs.delete(sessionId)
      sendResponse({ok: true})
      return
    }
    if (action === 'read-output') {
      const bytes = outputs.get(sessionId)
      if (!bytes) throw new Error('PDF 导出文件不存在')
      const part = bytes.subarray(payload.offset, payload.offset + payload.length)
      sendResponse({ok: true, base64: encodeBase64(part)})
      return
    }
    if (action === 'close') {
      outputs.delete(sessionId)
      sendResponse({ok: true})
      return
    }
    const pdf = sessions.get(sessionId)
    if (!pdf) throw new Error('PDF 后台处理尚未初始化')

    if (action === 'add-page') {
      if (payload.pageIndex > 0) pdf.addPage()
      pdf.addImage(payload.image, 'JPEG', payload.x, payload.y, payload.width, payload.height, undefined, 'FAST')
      sendResponse({ok: true})
      return
    }

    if (action === 'finish') {
      const bytes = new Uint8Array(pdf.output('arraybuffer'))
      sessions.delete(sessionId)
      outputs.set(sessionId, bytes)
      sendResponse({ok: true, size: bytes.length})
      return
    }

    throw new Error(`未知的 PDF 后台操作：${action}`)
  } catch (error) {
    sendResponse({ok: false, error: error?.message || String(error)})
  }
  return true
})
