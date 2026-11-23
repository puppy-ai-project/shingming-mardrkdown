---
name: lumina-chrome-production
description: Build and verify the Lumina Markdown Chrome extension ZIP when the user explicitly requests a production package or release. Do not use for ordinary development builds.
---

# Lumina Chrome Production

Use this repository skill for production packaging of the Chrome extension in this repository. The repository-local `.agents/skills/` placement keeps it discoverable to agents working in `lumina-chrome/`.

## Release workflow

1. Confirm the user explicitly requests a production package/release. Increment `package.json`'s patch version exactly once before building, and keep the root package version fields in `package-lock.json` synchronized. The build generates the mirrored manifest version from `package.json`. Do not bump the version for ordinary development builds or validation.
2. Before every production build, inspect `git status`. Commit all intended, release-related code changes before bumping the version or building; do not leave implementation changes uncommitted for the package. Do not include unrelated user changes in that commit.
3. Work from this repository root; edit `src/`, `static/`, or `scripts/` only as needed. Treat `dist/` as generated and never hand-edit it.
4. Run `npm run build`. This creates the MV3 extension in `dist/` and the Chrome Web Store upload archive at `release/shiming-markdown-chrome-v<manifest-version>.zip`. Bundling and minification are permitted; obfuscation is prohibited. Keep all functionality discernible and executable code inside the package.
5. Verify that the ZIP opens and contains `manifest.json` at its archive root (not nested under `dist/`), the manifest is MV3, and every referenced runtime file is present. Confirm the archive contains no source maps, obfuscation, or remotely hosted executable code, and retains the intended Markdown-only `file://` content-script patterns, including supported query-string forms.
6. A production packaging/release request (for example, “打生产包”, “生成 release”) authorizes completing the release: create an annotated Git tag `v<manifest-version>` at the release commit, and push the current release branch plus tag to the extension repository's configured remote. Before tagging/pushing, verify the tag does not already exist locally or remotely and that the release commit is based on the intended remote branch. Never force-push. Skip the tag and push only when the user explicitly limits the request to package-only/no-push.
7. Report the version, both the `dist/` directory and ZIP path, and the pushed branch/tag. Do not upload the ZIP to the Chrome Web Store unless separately requested.

The development build must remain the normal build path. Only produce the release ZIP as part of the explicitly requested production build.
