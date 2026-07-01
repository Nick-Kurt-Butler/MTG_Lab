// WebSocket client for the Forge bridge. Protocol (DESIGN.md §13.5):
//   server -> client:
//     { type:'welcome', seat }
//     { type:'snapshot', ... }                      full board state for this seat
//     { type:'ui', seat, kind, ... }                non-blocking UI pushes:
//         kind:'message'  { message }
//         kind:'buttons'  { ok, cancel, okLabel, cancelLabel, focusOk }
//         kind:'selectables' / 'weaklySelectable' { cards:[ids], min, max }
//         kind:'reveal'   { message, options }
//     { type:'prompt', id, kind, prompt, options?, ... }   blocking question
//   client -> server:
//     { type:'response', id, data }                 answer to a prompt
//     { type:'action', kind, ... }                  an IGameController click:
//         selectCard {cardId} · selectPlayer {playerId}
//         selectButtonOk · selectButtonCancel · passPriority · useMana {color}
//     { type:'control', action:'start', ... }
//
// Forge's engine is the authority: it runs the human's turn via its own input
// system and asks us questions; we render snapshots/ui and forward clicks.

export function connectBridge(url, handlers) {
  const ws = new WebSocket(url)

  ws.addEventListener('open', () => handlers.onOpen?.())
  ws.addEventListener('close', () => handlers.onClose?.())
  ws.addEventListener('error', e => handlers.onError?.(e))

  ws.addEventListener('message', ev => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    switch (msg.type) {
      case 'snapshot': handlers.onSnapshot?.(msg); break
      case 'ui':       handlers.onUi?.(msg); break
      case 'prompt':   handlers.onPrompt?.(msg); break
      case 'welcome':  handlers.onWelcome?.(msg.seat); break
      case 'sim':      handlers.onSim?.(msg); break
      case 'lobby':    handlers.onLobby?.(msg); break
      default: break
    }
  })

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  }

  return {
    respond(id, data) { send({ type: 'response', id, data: data || {} }) },
    action(kind, fields) { send({ type: 'action', kind, ...(fields || {}) }) },
    send,
    close() { ws.close() },
  }
}
