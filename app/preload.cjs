// Bridges a few safe main-process capabilities to the renderer. The renderer
// can't fetch() Scryfall directly (the corporate proxy resets/blocks it) nor
// fetch() our custom cardimg:// scheme (Chromium forbids fetch on non-http
// schemes), so the art-picker's "list printings" call goes over IPC to the main
// process, which uses Electron's HTTP/1.1 net stack + request queue.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('forgeAPI', {
  printings: name => ipcRenderer.invoke('scryfall:printings', name),
})
