// Player records. The two subclasses exist so the UI can tell which seat the
// human controls via `instanceof HumanPlayer` (see Board.jsx / LogPanel.jsx).
// The adapter assigns life / manaPool / hasPriority / libraryOrder each frame;
// the defaults here just keep things safe before the first snapshot.

class Player {
  constructor(name) {
    this.name = name || ''
    this.life = 20
    this.manaPool = {}
    this.hasPriority = false
    this.libraryOrder = []
  }
}

export class HumanPlayer extends Player {}
export class CpuPlayer extends Player {}
