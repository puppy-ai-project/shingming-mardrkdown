# Shiming Markdown for Chrome

Shiming Markdown 是一款 Chrome 扩展，帮助你在浏览器中阅读和处理 Markdown 文档，支持本地文件、目录和远程 Markdown 页面。

[从 Chrome 网上应用店安装 Shiming Markdown](https://chromewebstore.google.com/detail/shiming-markdown/lhomgmdolfgfbpamgdjmkmicjemhljof)

## 功能

- 阅读本地 Markdown 文件，并浏览用户选择的目录。
- 在多个标签页中打开文档，并使用大纲和目录导航。
- 搜索已选目录和已打开文档中的内容。
- 渲染 GitHub Flavored Markdown、代码块、数学公式和 Mermaid 图表。
- 使用可写文件句柄打开的文件支持编辑和自动保存。
- 将文档、表格、代码块和图表导出为图片或 PDF。
- 自定义主题、阅读布局和代码显示方式。

本地文件和目录仅在用户通过 Chrome 文件选择器授权后访问。扩展不会在用户不知情的情况下扫描任意路径。文件句柄和工作区状态保存在当前浏览器配置中；扩展不会将 Markdown 原文上传到服务端。

## 开发

需要安装 Node.js 和 npm。

```sh
npm ci
npm run dev
```

在 `chrome://extensions` 中开启“开发者模式”，选择“加载已解压的扩展程序”，并选择本项目生成的 `dist/` 目录。开发命令会监听源文件并重新生成 `dist/`；每次构建后，请在 Chrome 扩展管理页面重新加载扩展。

## 生产构建

```sh
npm run build
```

构建结果包括可加载的扩展目录 `dist/`，以及用于提交到 Chrome 网上应用店的 ZIP 包 `release/`。生产构建会打包并压缩 JavaScript，不会刻意混淆代码。请勿直接加载 `src/` 或 `static/`。

## 浏览器版说明

- 如需直接打开 `file://` 地址阅读 Markdown 文件，请在扩展详情页启用“允许访问文件网址”。
- 直接通过浏览器打开的本地文件为只读，因为 Chrome 不会向扩展提供该文件的可写句柄。需要编辑和自动保存时，请使用“打开文件”并授权可写句柄。
- 目录句柄和工作区状态保存在当前 Chrome 配置中。你可以在 Chrome 的扩展或网站设置中撤销访问权限。
- 浏览器版不包含原生操作系统文件关联、Finder 集成，以及 macOS 账户或许可功能。

## 致谢

Shiming Markdown for Chrome 的开发参考了开源项目 [md-reader](https://github.com/md-reader/md-reader)。感谢该项目在浏览器 Markdown 阅读体验方面的探索与贡献。Shiming Markdown 是独立项目，并非 md-reader 的官方分支或发行版本。
