export const TAB_QUERY_KEY = 'lumina-tab'
export const SESSION_QUERY_KEY = 'shiming-session'

// Keep every query parameter owned by the extension in one registry. Add new
// extension URL state here so display/copy URLs and document URLs stay clean.
export const EXTENSION_QUERY_PARAMS = Object.freeze([
  TAB_QUERY_KEY,
  SESSION_QUERY_KEY,
  'openLocal',
])

export function stripExtensionQueryParams(url) {
  for (const key of EXTENSION_QUERY_PARAMS) url.searchParams.delete(key)
  return url
}

export function cleanExtensionURL(value) {
  try {
    return stripExtensionQueryParams(new URL(value)).href
  } catch {
    return String(value || '')
  }
}
