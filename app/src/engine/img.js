// Route remote card art through Electron's disk-backed image cache
// (the `cardimg://` scheme handled in electron.cjs). The first load fetches +
// caches the image through Electron's authenticated network stack; every load
// after is served from local disk, which fixes the corporate proxy throttling
// that left random card images blank.
//
// Only wrap http(s) URLs, and only under Electron — detected via the preload
// bridge (window.forgeAPI), which is robust regardless of the user-agent string.
// In a plain browser the cardimg:// scheme doesn't exist, so pass the URL through.
function inElectron() { return typeof window !== 'undefined' && !!window.forgeAPI }

export function cimg(url) {
  if (!url || typeof url !== 'string') return url
  if (!/^https?:/i.test(url)) return url
  if (!inElectron()) return url
  return 'cardimg://fetch/' + encodeURIComponent(url)
}
