---
name: lumina-chrome
description: Develop and maintain the Lumina Markdown Chrome extension, including its file:// Markdown handling, build output, and release validation.
---

# Lumina Chrome Extension

Use this skill for Chrome extension feature work in this repository. Do not use `backup-chrome_extension/` or the legacy `chrome_extension/` tree as its source.

## Source and generated files

- Edit extension code in `src/`, static UI/resources in `static/`, and build configuration in `scripts/` or `package.json`.
- Chrome loads only `dist/`. Treat it as generated output; do not hand-edit it.
- Keep runtime resources local to the extension. Production JavaScript may be bundled and minified, but must never be obfuscated; do not emit source maps.
- The version displayed in Settings/About must be read dynamically from `chrome.runtime.getManifest().version`; do not hardcode a separate UI version. Keep the build-generated manifest version as the single source of truth.

## Local Markdown behavior

- Directly opened local Markdown pages are handled by `src/content.js`, which must remain scoped to Markdown file URLs and pass the original text and `file://` URL to the extension worker.
- `src/worker.js` returns local-file content only through the active message, and `src/content.js` embeds the extension reader as a full-window frame without changing the original document URL except for its Lumina session query state. Never persist Markdown source, rendered document data, or browser tab IDs; do not encode workspace tabs in the page URL. Store session-owned tab descriptors, the `location.href` Markdown parent directory URL, and user-selected directory handles in extension IndexedDB under the page's `luminaSessionId`; do not persist directory-entry snapshots. Use structured-clone extension messaging for File System Access handles. Reconcile stored sessions against `luminaSessionId` values reported by open Markdown tabs after a 60-second startup/close grace period. Do not persist folder expansion state. On refresh, restore the session's tabs and directory roots, reread Markdown, and rescan directories. Persist user preferences separately.
- Preserve the source URL for relative local assets. Direct browser-opened files are read-only because the extension has no writable file handle; use the File System Access picker for editing and autosave.
- Do not request broader host permissions or inject on non-Markdown pages without a clear feature requirement.

## Build and verification

After every change to this extension, run the development build from this repository root:

1. Run `npm run dev`, wait for the initial `[watch] build finished` message, then stop the watcher. This generates a non-obfuscated development bundle in `dist/`.
2. Run `node --check dist/app.js`, `node --check dist/worker.js`, and `node --check dist/content.js`; parse `dist/manifest.json` and confirm it remains Manifest V3, includes the intended `file://` content-script match, and points only to generated files.
3. Check that no `.map` files or remote JavaScript/CSS dependencies entered `dist/`.

Run `npm run build` (the production build) only when the user explicitly asks to build production. Generic build, validation, or development requests do not authorize producing a production package. Leave `dist/` as the development build unless production was expressly requested. In the final handoff, state what was built and any browser interaction that still needs manual verification. When testing direct local Markdown handling, enable **Allow access to file URLs**, reload the unpacked extension from `dist`, then reopen or refresh the `.md` tab.

For every explicitly requested production package, use `.agents/skills/lumina-chrome-production/SKILL.md` and increment the patch version exactly once before building. Keep `package.json` and the root package version fields in `package-lock.json` synchronized. Do not change versions for development builds or checks. A package-only request does not by itself authorize creating a Git tag or pushing to a remote.
