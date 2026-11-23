import {stripExtensionQueryParams} from './url-params.js'

const markdownPath = /\.(?:md|markdown|mdown|mkd|mdx|mdc|txt)$/i
const rawMarkdownContentTypes = new Set([
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'application/markdown',
  'application/x-markdown',
])

async function mountLuminaShell(token, title, documentData) {
  if (document.documentElement.dataset.luminaMounted === 'true') return
  document.documentElement.dataset.luminaMounted = 'true'

  const extensionURL = path => chrome.runtime.getURL(path)
  const response = await fetch(extensionURL('index.html'))
  if (!response.ok) throw new Error('无法加载 Shiming 阅读界面')
  const shell = new DOMParser().parseFromString(await response.text(), 'text/html')

  const styleLoads = []
  for (const [href, rel] of [['styles.css', 'stylesheet'], ['katex.min.css', 'stylesheet']]) {
    const link = document.createElement('link')
    link.rel = rel
    link.href = extensionURL(href)
    styleLoads.push(new Promise(resolve => {
      link.addEventListener('load', resolve, {once: true})
      link.addEventListener('error', resolve, {once: true})
    }))
    document.head.append(link)
  }
  const favicon = document.createElement('link')
  favicon.id = 'lumina-markdown-favicon'
  favicon.rel = 'icon'
  favicon.type = 'image/png'
  favicon.href = extensionURL('icon32.png')
  document.head.append(favicon)

  document.body.replaceChildren(...[...shell.body.childNodes].map(node => document.importNode(node, true)))
  document.querySelectorAll('img[src]').forEach(image => {
    const path = image.getAttribute('src')
    if (path && !/^(?:https?:|data:|blob:|chrome-extension:)/i.test(path)) image.src = extensionURL(path)
  })
  document.title = title
  window.__LUMINA_PENDING_TOKEN__ = token
  window.__LUMINA_PENDING_DOCUMENT__ = documentData
  await Promise.all(styleLoads)
  await import(extensionURL('viewer.min.js'))
  await import(extensionURL('app.js'))
}

if (location.protocol === 'file:' && markdownPath.test(location.pathname)) {
  const source = document.body?.innerText ?? document.documentElement?.innerText ?? ''
  if (source.trim()) {
    chrome.runtime.sendMessage({
      type: 'lumina:open-local-markdown',
      document: {
        source,
        sourceURL: location.href,
        title: decodeURIComponent(location.pathname.split('/').pop() || 'Markdown 文档'),
      },
    }).then(result => {
      if (!result?.ok || !result.token) return
      return mountLuminaShell(result.token, decodeURIComponent(location.pathname.split('/').pop() || 'Markdown 文档'), result.document)
    }).catch(error => {
      document.documentElement.dataset.luminaMounted = 'false'
      console.error('Unable to render this Markdown file:', error)
    })
  }
}

// Only take over raw Markdown responses. Sites such as GitHub render .md
// files as a normal HTML page and should keep their own document UI.
const contentType = (document.contentType || '').split(';', 1)[0].trim().toLowerCase()
if (['http:', 'https:'].includes(location.protocol)
  && /\.md$/i.test(location.pathname)
  && rawMarkdownContentTypes.has(contentType)) {
  const documentURL = new URL(location.href)
  stripExtensionQueryParams(documentURL)
  const sourceURL = documentURL.href
  documentURL.hash = ''
  const title = (() => {
    try { return decodeURIComponent(location.pathname.split('/').pop() || 'Markdown 文档') } catch { return location.pathname.split('/').pop() || 'Markdown 文档' }
  })()
  const source = document.body?.innerText ?? document.documentElement?.innerText ?? ''
  if (source.trim()) {
    mountLuminaShell(crypto.randomUUID(), title, {source, sourceURL, title})
      .catch(error => {
        document.documentElement.dataset.luminaMounted = 'false'
        console.error('Unable to render this remote Markdown page:', error)
      })
  }
}
