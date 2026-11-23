# Shiming Markdown for Chrome

Shiming Markdown is a Chrome extension for reading and working with Markdown documents in the browser. It supports local files and directories, as well as remote Markdown pages.

## Features

- Read local Markdown files and browse user-selected directories.
- Open multiple documents in tabs with outline and directory navigation.
- Search across selected directories and open documents.
- Render GitHub Flavored Markdown, code blocks, math, and Mermaid diagrams.
- Edit files opened with a writable file handle and save changes automatically.
- Export documents, tables, code blocks, and diagrams as images or PDF.
- Customize themes, reading layout, and code display preferences.

Local file and directory access is granted by the user through Chrome's file picker. The extension does not silently scan arbitrary paths. File handles and workspace state are stored in the browser profile; Markdown source is not uploaded to a service by the extension.

## Development

Requirements: Node.js and npm.

```sh
npm ci
npm run dev
```

In `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose this project's generated `dist/` directory. The development command watches source files and rebuilds `dist/`; reload the extension from Chrome after changes.

## Production build

```sh
npm run build
```

This creates the loadable extension under `dist/` and a Chrome Web Store ZIP under `release/`. The production build bundles and minifies JavaScript; it does not intentionally obfuscate the code. Do not load `src/` or `static/` directly.

## Browser-specific behavior

- To render a Markdown file opened directly through a `file://` URL, enable **Allow access to file URLs** on the extension details page.
- Directly opened local files are read-only because Chrome does not provide the extension with a writable file handle for that page. Use **Open file** to grant a writable handle for editing and autosave.
- Directory handles and workspace state are stored in the current Chrome profile. Access can be revoked in Chrome's extension or site settings.
- Native operating-system file association, Finder integration, and macOS account or license features are not part of the browser edition.

## Acknowledgements

Shiming Markdown for Chrome was developed with inspiration from the open-source [md-reader](https://github.com/md-reader/md-reader) project. We appreciate its work on browser-based Markdown reading. Shiming Markdown is an independent project and is not an official fork or release of md-reader.
