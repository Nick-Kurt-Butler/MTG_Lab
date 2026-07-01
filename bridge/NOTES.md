# bridge — build & run notes

## Prerequisites (one time)
1. JDK 21+ and Maven on PATH:
   - `brew install --cask temurin@21 && brew install maven`
   - `export JAVA_HOME=$(/usr/libexec/java_home -v 21)`
2. Install Forge artifacts into your local Maven repo so this module can depend
   on them. From the cloned Forge repo:
   - `mvn -U -B clean -P windows-linux install`
   - This publishes `forge:forge-gui` / `forge:forge-ai` (version `2.0.13-SNAPSHOT`)
     to `~/.m2`. If your Forge version differs, update `<forge.version>` in `pom.xml`.

## Build
```
mvn -q clean package
```
Produces `target/bridge.jar` (uber-jar, main class `mtgforgelab.bridge.BridgeMain`).

### Gotchas solved (already done on this machine)
- Forge's full `install` fails at `forge-gui-mobile` (a jitpack TLS issue on a
  mobile-only dep). Irrelevant — `forge-core/game/ai/gui` install fine first,
  and those are all we depend on.
- Forge's installed POMs keep the literal `${revision}` property, which doesn't
  resolve for an external consumer. Fixed by rewriting it in the local repo:
  `find ~/.m2/repository/forge -name "*.pom" -exec sed -i '' 's/${revision}/2.0.13-SNAPSHOT/g' {} +`
- Forge needs a GUI interface before init; we ship a no-op `HeadlessGui`
  (copied from Forge's ForgeMatrixWriter tool) and call `GuiBase.setInterface`
  before `FModel.initialize`.

## Run (milestone 1 — VERIFIED working: spectator over WebSocket)
The bridge now boots Forge, listens on a WebSocket port, and on first client
connect runs an AI-vs-AI game while streaming live `GameView` snapshots as JSON.

IMPORTANT: everything lives under `~/Code/MTG/`. The first arg is Forge's
`forge-gui` dir (so Forge resolves `res/`, the card DB, and `res/languages/` for
the i18n bundle — an absolute path here is critical; a wrong dir fails with
`MissingResourceException: Can't find bundle for base name en-US`).

```
/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java \
  -jar ~/Code/MTG/MTG_Forge_Lab/bridge/target/bridge.jar \
  ~/Code/MTG/forge-master/forge-gui \
  ~/Code/MTG/MTG_Forge_Lab/bridge/test-decks/a.dck \
  ~/Code/MTG/MTG_Forge_Lab/bridge/test-decks/b.dck \
  8088
```
Then watch it from Node (requires Node 21+ for the global WebSocket):
```
node ~/Code/MTG/MTG_Forge_Lab/spectator/spectator.mjs ws://localhost:8088
```
Confirmed: snapshots stream (opening draws, library counts, phases) end to end.

## Status / next
- **Milestone 0 (DONE):** standalone module depends on Forge and runs a complete
  game. Validates build + linkage + asset loading.
- **Milestone 1 (DONE):** embedded WebSocket server (`GameServer`), event-bus
  `SnapshotBroadcaster`, and `ViewSerializer` (GameView → JSON). Spectator client
  renders live state over the wire.
- **Milestone 2 (DONE — decision bridge):** `PlayerControllerBridge extends
  PlayerControllerAi` routes selected decisions to a UI client and falls back to
  AI for the rest; `DecisionChannel` correlates request/response and blocks the
  game thread (LinkedBlockingQueue, 300s timeout → AI fallback); `LobbyPlayerBridge`
  installs the bridge controller on seat 0 (seat 1 = AI). Verified: the bridge
  sent a `mulliganKeep` decision, the `responder.mjs` client answered keep=true,
  and the game ran to completion (every non-overridden decision used the AI).
  Run it: start the bridge, then
  `node ~/Code/MTG/MTG_Forge_Lab/spectator/responder.mjs ws://localhost:8088`.
- **Milestone 3 (IN PROGRESS — gameplay decisions):**
  - DONE: `chooseSpellAbilityToPlay` (priority). Enumerates currently-playable
    non-mana abilities via `card.getAllPossibleAbilities(player, true)` across
    Hand/Battlefield/Graveyard/Exile/Command, sends a `priority` decision with
    indexed options, maps the chosen index back to the SpellAbility (null = pass).
    Auto-passes (no prompt) when there are no plays, to keep message volume sane.
    Verified: with all-lands decks the UI player was offered "Play land" each
    turn, `responder.mjs` chose it, lands resolved, and the game ran to a clean
    finish (53 priority decisions, no loop warnings).
  - DONE: `declareAttackers` / `declareBlockers`. Enumerate legal attackers +
    defenders / blockers + their blockable attackers via `CombatUtil`, send a
    `declareAttackers` / `declareBlockers` decision, and apply the chosen pairs
    to the `Combat` (each validated by `CombatUtil.canAttack` / `canBlock`;
    empty/timeout → AI declares). Verified both: with creature decks the UI
    player attacked and won; with Hill Giants (3/3) swinging into Grizzly Bears
    (2/2), the UI player was asked to block and chump-blocked via `addBlocker`
    (offered blockers shrank 7→6→5 as chumps died), game completed cleanly.
    Test decks: `test-decks/ca.dck` + `cb.dck`. Responder honors `NO_ATTACK=1`
    to decline attacks (used to exercise the blocker path).
  - NEXT decisions to override, in order: chooseTargetsFor /
    chooseSingleEntityForEffect (so chosen spells target via the UI instead of
    AI), assignCombatDamage (multi-block ordering), confirm,
    chooseCardsToDiscardToMaximumHandSize, mulligan card-bottoming.
  - KNOWN SIMPLIFICATIONS: the bridge controller still reports `isAI()==true`
    (keeps the engine on safe AI paths for un-overridden decisions). Cost
    payment / targeting for a UI-chosen spell currently fall back to the AI until
    those methods are overridden — fine for lands, to revisit for spells.
- **Milestone 4 (IN PROGRESS — the UI):** `app/` is a React/Vite client that
  connects to the bridge, renders the snapshot (both seats: life, hand [yours
  face-up, opponent backs], library/grave counts, battlefield with tapped/sick/
  P-T/damage, and the stack), and drives the four routed decisions via a bottom
  decision panel (mulliganKeep, priority play/pass, declareAttackers,
  declareBlockers). Builds clean (`npm run build`). Run steps in `app/README.md`.
  Uses the same message shapes proven by `responder.mjs`, so the data flow is
  verified; visual rendering needs a browser (run `npm run dev`).
- **Milestone 5 (DONE — per-seat views + seat identity):** the server assigns
  the first client seat 0 and later clients spectator (seat -1), sends a
  `welcome` {seat} message, and broadcasts a snapshot tailored per seat
  (`broadcastPerSeat`). `ViewSerializer.snapshot(view, viewerSeat)` reveals hand
  card faces only to the owner; everyone else gets `handCount` only. UI uses the
  welcome seat (no more hardcoded seat) and ignores decisions not addressed to
  it. Verified: seat 0 sees its own hand faces, opponent faces redacted.
- **Milestone 6 (DONE — WLAN 1v1 + per-seat decision routing):** the bridge
  takes a mode arg (`ai` | `pvp`). In `pvp` it installs a `LobbyPlayerBridge` on
  BOTH seats and waits for two clients before starting; the server assigns the
  lowest free seat and triggers `onReady` only when all human seats are filled.
  Decisions are now routed to a single seat (`DecisionChannel.ask(seat, …)` →
  `GameServer.sendToSeat`), so a player's private options (e.g. castable cards =
  their hand) never reach the opponent. Verified: with two responders the game
  waited for both, assigned seats 0/1, routed each seat only its own decisions,
  and ran to completion. Run pvp: append `pvp` to the bridge args; connect two
  clients (the 2nd from another machine at `ws://<host-ip>:8088`).
- **Milestone 7 (targeting + common decisions):**
  - `chooseSingleEntityForEffect` → `chooseEntity` (pick one / optional none).
  - `chooseEntitiesForEffect` → `chooseCards` (pick min..max entities).
  - `confirmAction` → `confirm` (yes/no).
  - `chooseCardsToDiscardToMaximumHandSize` → `chooseCards` (exact N). VERIFIED
    firing: with an all-lands deck + PASS_ALL the hand grew and the UI chose the
    discard each turn (53 prompts), game continued.
  - `tuckCardsViaMulligan` (London bottoming) → `chooseCards` (exact N).
  - `announceRequirements` (X) + `chooseNumberForCostReduction` → `number`.
  - All with AI fallback; bridge + app build clean; full games complete.
  - UI panels added: confirm (Yes/No), number (input), chooseCards (multi-select
    with min/max). Responder handles all new kinds.
  - STILL AI (deferred, riskier): `chooseTargetsFor` (spell/ability *target*
    selection — must populate TargetChoices respecting restrictions; invalid
    targets can loop the engine, so it needs its own deck-tested pass),
    `chooseModeForAbility` (modal "choose one"), `orderBlockers`/combat damage
    assignment order (multi-block).
- **Then (UX / packaging):** click-the-board targeting & combat selection, card
  art/log/phase controls, host-join lobby screen, Electron packaging.

### Components (all in `bridge/src/main/java/mtgforgelab/bridge/`)
- `BridgeMain` — boot Forge, start server, run game on a worker thread.
- `GameServer` — embedded `org.java_websocket` server (our local/WLAN transport).
- `SnapshotBroadcaster` — `@Subscribe` to Forge's Guava event bus; broadcasts.
- `ViewSerializer` — GameView/PlayerView/CardView → snapshot Map.
- `DecisionChannel` — request/response correlation; blocks game thread for UI answers.
- `PlayerControllerBridge` — UI-routed decisions, AI fallback (extends PlayerControllerAi).
- `LobbyPlayerBridge` — installs the bridge controller on a seat.
- `Json` — tiny dependency-free JSON writer (Gson is used for parsing responses).

### Verification clients (`spectator/`)
- `spectator.mjs` — read-only; renders live snapshots.
- `responder.mjs` — answers decisions (keep=true for mulligan); proves the loop.
