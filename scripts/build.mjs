import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {watch as watchFiles} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as esbuild from 'esbuild'
import {zipSync} from 'fflate'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const production = process.argv.includes('--production')
const noZip = process.argv.includes('--no-zip')
const watch = process.argv.includes('--watch')
const clean = process.argv.includes('--clean')
const installReportBaseURL = watch ? 'http://127.0.0.1:8900' : 'https://lumina.withqq.com'
const releaseDir = path.join(root, 'release')
const markdownExtensions = ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'mdc', 'txt']
// Chrome match patterns support path wildcards, so inject only into files the
// content script can render instead of every local file URL.
const markdownFileMatchPatterns = markdownExtensions.flatMap(extension => [
  `file:///*.${extension}`,
  `file:///*.${extension}?*`,
  `file:///*.${extension.toUpperCase()}`,
  `file:///*.${extension.toUpperCase()}?*`,
])
const remoteMarkdownMatchPatterns = ['*://*/*.md', '*://*/*.md?*', '*://*/*.MD', '*://*/*.MD?*']

const pdfWorkerPolicyPlugin = {
  name: 'pdf-worker-policy-cleanup',
  setup(build) {
    build.onLoad({filter: /\/jspdf\/dist\/jspdf\.es\.js$/}, async args => {
      let contents = await readFile(args.path, 'utf8')
      const remoteViewerBranches = /case\s*["']pdfobjectnewwindow["']:[\s\S]*?case\s*["']dataurlnewwindow["']:/
      if (!remoteViewerBranches.test(contents)) {
        throw new Error('Could not find jsPDF PDF viewer branches to remove from the extension bundle.')
      }
      contents = contents.replace(
        remoteViewerBranches,
        'case "pdfobjectnewwindow":\n      case "pdfjsnewwindow":\n        throw new Error("Opening a PDF viewer window is not supported.");\n      case "dataurlnewwindow":',
      )
      if (contents.includes('cdnjs.cloudflare.com/ajax/libs/pdfobject')) {
        throw new Error('The jsPDF bundle still references the remote PDFObject viewer.')
      }
      return {contents, loader: 'js', resolveDir: path.dirname(args.path)}
    })
  },
}

const supportedGlobalObjectPlugin = {
  name: 'supported-global-object',
  setup(build) {
    build.onLoad({filter: /\.(?:js|mjs|cjs)$/}, async args => {
      if (/\/core-js\/internals\/global-this\.js$/.test(args.path)) {
        // Chrome 120 supports globalThis; avoid core-js's Function-constructor fallback.
        return {contents: 'module.exports = globalThis', loader: 'js'}
      }
      if (/\/core-js\/internals\/object-create\.js$/.test(args.path)) {
        // Chrome 120 supports Object.create; omit core-js's obsolete IE iframe/script fallback.
        return {contents: 'module.exports = Object.create', loader: 'js'}
      }
      if (/\/lodash-es\/_root\.js$/.test(args.path)) {
        // Lodash's fallback also constructs a Function only to obtain the global object.
        return {contents: 'export default globalThis', loader: 'js'}
      }
      const contents = await readFile(args.path, 'utf8')
      const sanitized = contents.replace(/Function\(\s*(["'])return this\1\s*\)\s*\(\s*\)/g, 'globalThis')
      if (sanitized === contents) return null
      return {contents: sanitized, loader: 'js', resolveDir: path.dirname(args.path)}
    })
  },
}

if (clean) {
  await rm(dist, {recursive: true, force: true})
  process.exit(0)
}

// Recreate generated output so artifacts from previous build strategies cannot
// leak into the unpacked extension or release archive.
await rm(dist, {recursive: true, force: true})
await mkdir(dist, {recursive: true})
for (const file of ['index.html', 'offscreen.html', 'viewer.min.js', 'icon.svg', 'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png']) {
  await cp(path.join(root, 'static', file), path.join(dist, file))
}
async function writeStylesheet() {
  const [bootstrapCss, appCss] = await Promise.all([
    readFile(path.join(root, 'node_modules/bootstrap/dist/css/bootstrap.min.css'), 'utf8'),
    readFile(path.join(root, 'static/styles.css'), 'utf8'),
  ])
  await writeFile(path.join(dist, 'styles.css'), `${bootstrapCss}\n${appCss}`)
}
await writeStylesheet()
await cp(path.join(root, 'node_modules/katex/dist/katex.min.css'), path.join(dist, 'katex.min.css'))
await mkdir(path.join(dist, 'fonts'), {recursive: true})
await cp(path.join(root, 'node_modules/katex/dist/fonts'), path.join(dist, 'fonts'), {recursive: true})
await writeFile(path.join(dist, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'Shiming Markdown',
  description: '在 Chrome 中阅读本地 Markdown 文档及网页中的 Markdown 页面，浏览目录，使用大纲和全文搜索快速导航，并支持 Mermaid 流程图、数学公式、图片查看，以及导出 PDF 和 PNG。文档内容仅在浏览器中读取。',
  version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
  minimum_chrome_version: '120',
  action: {default_title: '打开 Shiming Markdown', default_icon: {16: 'icon16.png', 32: 'icon32.png'}},
  background: {service_worker: 'worker.js', type: 'module'},
  content_scripts: [{matches: [...markdownFileMatchPatterns, ...remoteMarkdownMatchPatterns], js: ['content.js'], run_at: 'document_idle'}],
  host_permissions: ['http://127.0.0.1/*', 'https://lumina.withqq.com/*', '*://*/*'],
  web_accessible_resources: [{resources: ['index.html', 'app.js', 'viewer.min.js', 'styles.css', 'katex.min.css', 'fonts/*', 'icon32.png', 'icon128.png'], matches: ['file:///*', '*://*/*']}],
  permissions: ['storage', 'offscreen', 'tabs', 'alarms'],
  icons: {16: 'icon16.png', 32: 'icon32.png', 48: 'icon48.png', 128: 'icon128.png'},
  content_security_policy: {extension_pages: "script-src 'self'; object-src 'self'; img-src 'self' data: blob: https: http: file:;"},
}, null, 2))

const commonBuildOptions = {
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  define: {
    __LUMINA_INSTALL_API_BASE__: JSON.stringify(installReportBaseURL),
    __LUMINA_DEV__: JSON.stringify(watch),
  },
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  plugins: [supportedGlobalObjectPlugin],
}

const context = await esbuild.context({
  entryPoints: {
    app: path.join(root, 'src/app.js'),
    worker: path.join(root, 'src/worker.js'),
    imageWorker: path.join(root, 'src/image-worker.js'),
    content: path.join(root, 'src/content.js'),
  },
  ...commonBuildOptions,
  minify: production,
  metafile: true,
})
// Apply the same PDF dependency cleanup before optional production minification.
const pdfWorkerContext = await esbuild.context({
  entryPoints: {pdfWorker: path.join(root, 'src/pdf-worker.js')},
  ...commonBuildOptions,
  minify: production,
  metafile: true,
  plugins: [pdfWorkerPolicyPlugin, supportedGlobalObjectPlugin],
})

if (watch) {
  await Promise.all([context.watch(), pdfWorkerContext.watch()])
  watchFiles(path.join(root, 'static'), {recursive: true}, async (_event, name) => {
    if (!name) return
    if (name.toString() === 'styles.css') {
      try { await writeStylesheet() } catch {}
      return
    }
    const source = path.join(root, 'static', name.toString())
    const destination = path.join(dist, name.toString())
    try {
      await mkdir(path.dirname(destination), {recursive: true})
      await cp(source, destination)
    } catch {}
  })
  console.log(`Shiming Markdown dev build watching; load ${dist} as an unpacked extension.`)
} else {
  await Promise.all([context.rebuild(), pdfWorkerContext.rebuild()])
  if (production) {
    if (!noZip) {
      const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'))
      const zipFiles = {}
      async function addDirectory(directory, archivePath = '') {
        for (const entry of await readdir(directory, {withFileTypes: true})) {
          if (entry.name === '.DS_Store' || entry.name.endsWith('.map')) continue
          const absolutePath = path.join(directory, entry.name)
          const relativePath = path.posix.join(archivePath, entry.name)
          if (entry.isDirectory()) await addDirectory(absolutePath, relativePath)
          else if (entry.isFile()) zipFiles[relativePath] = new Uint8Array(await readFile(absolutePath))
        }
      }
      await addDirectory(dist)
      await mkdir(releaseDir, {recursive: true})
      const packagePath = path.join(releaseDir, `shiming-markdown-chrome-v${manifest.version}.zip`)
      await writeFile(packagePath, zipSync(zipFiles, {level: 6}))
      console.log(`Created Chrome Web Store package: ${packagePath}`)
    }
  }
  console.log(`Built ${production ? 'production' : 'development'} Chrome extension: ${dist}`)
  await Promise.all([context.dispose(), pdfWorkerContext.dispose()])
}
