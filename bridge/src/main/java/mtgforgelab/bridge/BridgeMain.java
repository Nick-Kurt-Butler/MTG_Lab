package mtgforgelab.bridge;

import java.io.File;
import java.net.InetSocketAddress;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import org.java_websocket.WebSocket;

import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.game.Game;
import forge.game.GameEndReason;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.GameOutcome;
import forge.game.Match;
import forge.game.card.Card;
import forge.game.player.GameLossReason;
import forge.game.player.Player;
import forge.game.player.PlayerOutcome;
import forge.game.player.PlayerStatistics;
import forge.game.player.PlayerView;
import forge.game.player.RegisteredPlayer;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.player.GamePlayerUtil;
import forge.player.LobbyPlayerHuman;
import forge.player.PlayerControllerHuman;
import forge.trackable.TrackableCollection;

/**
 * MTG Forge Lab — bridge backend (milestone 1: spectator over WebSocket).
 *
 * Boots the Forge engine headlessly, starts our embedded WebSocket server, and
 * when the first client connects, runs an AI-vs-AI game on a worker thread while
 * streaming live {@link forge.game.GameView} snapshots as JSON to all clients.
 *
 * This proves the full pipe — Forge engine → GameView → JSON → WebSocket → UI —
 * on real, complete games. The next milestone swaps one AI seat for a
 * PlayerControllerBridge that emits decision prompts and blocks on UI responses.
 *
 * Args: &lt;forge-gui-dir&gt; &lt;deckA.dck&gt; &lt;deckB.dck&gt; [port]
 */
public final class BridgeMain {

    public static void main(String[] args) throws Exception {
        try {
            run(args);
        } catch (Throwable t) {
            // Print the real cause ourselves; Forge's default uncaught handler
            // masks it as ExceptionInInitializerError.
            System.err.println("[bridge] FATAL:");
            t.printStackTrace();
            System.exit(1);
        }
    }

    private static void run(String[] args) throws Exception {
        if (args.length >= 1 && args[0].equals("catalog")) {
            if (args.length < 3) {
                System.err.println("Usage: java -jar bridge.jar catalog <forge-gui-dir> <out.json>");
                System.exit(1);
            }
            runCatalog(args[1], args[2]);
            return;
        }
        if (args.length < 3) {
            System.err.println("Usage: java -jar bridge.jar <forge-gui-dir> <deckA.dck> <deckB.dck> [port] [ai|pvp]");
            System.exit(1);
        }

        final Path forgeGuiDir = Path.of(args[0]).toAbsolutePath().normalize();
        final String deckA = args[1];
        final String deckB = args[2];
        final int port = args.length > 3 ? Integer.parseInt(args[3]) : 8088;
        final String mode = args.length > 4 ? args[4] : "ai"; // "ai" | "pvp" | "menu"
        // menu mode waits for a UI start request; reserve 2 seats so a WLAN guest
        // can take seat 1 (AI games simply leave seat 1 to the AI controller).
        final int humanSeats = ("pvp".equalsIgnoreCase(mode) || "menu".equalsIgnoreCase(mode)) ? 2 : 1;

        // Forge needs a GUI interface before init (asset paths etc.); ours is a no-op.
        GuiBase.setInterface(new HeadlessGui(forgeGuiDir));
        FModel.initialize(null, null);
        // Make Forge push the set of actionable cards (setWeaklySelectable) so the
        // UI can mark playable cards clickable. Off by default. See DESIGN.md §13.5.
        FModel.getPreferences().setPref(FPref.UI_SHOW_ACTIONABLE_HIGHLIGHTS, true);
        System.err.println("[bridge] Forge initialized (mode=" + mode + ", humanSeats=" + humanSeats + ")");

        final GameServer server = new GameServer(new InetSocketAddress("0.0.0.0", port));
        server.setHumanSeats(humanSeats);
        final DecisionChannel channel = new DecisionChannel(server);
        server.setMessageHandler((conn, msg) -> {
            channel.onClientMessage(msg);             // prompt responses
            handleControl(conn, msg, server, channel); // start-game / deck / sim requests
            handleAction(conn, msg, server);          // IGameController click actions
        });
        if ("menu".equalsIgnoreCase(mode)) {
            // Wait for the UI to pick decks and send a `start` control message.
            server.setOnReady(() -> System.err.println("[bridge] ready — waiting for a start request"));
        } else {
            // Direct CLI / test use: auto-start with the deck files passed as args.
            server.setOnReady(() -> runGame(deckA, deckB, server, channel, humanSeats));
        }
        server.start();

        // Keep the process alive; the server + game run on their own threads.
        new CountDownLatch(1).await();
    }

    /** Monotonic game generation. A new game supersedes older ones; a stale game
     *  (gen != liveGen) goes inert so an exited-then-restarted game can't interfere. */
    private static volatile int liveGen = 0;
    public static boolean isLiveGen(int gen) { return gen == liveGen; }

    /** Human controllers by seat, populated while a game is wired and live. */
    private static final Map<Integer, PlayerControllerHuman> seatControllers = new ConcurrentHashMap<>();

    /** Worker pool for client actions: a click that nests a blocking prompt
     *  (e.g. getAbilityToPlay) must not stall the WS receive loop. See DESIGN.md §13.3. */
    private static final ExecutorService inputPool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "forge-input");
        t.setDaemon(true);
        return t;
    });

    // ── Headless AI-vs-AI simulator (stat engine) ──────────────────────────
    private static final ExecutorService simPool = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "forge-sim"); t.setDaemon(true); return t;
    });
    // Forces a single runaway game (rare AI stall) to end so it can't hang the batch.
    private static final java.util.concurrent.ScheduledExecutorService simWatchdog =
        Executors.newScheduledThreadPool(1, r -> { Thread t = new Thread(r, "forge-sim-wd"); t.setDaemon(true); return t; });
    private static volatile boolean simCancel = false;

    private static void sim(GameServer server, Map<String, Object> msg) {
        msg.put("type", "sim");
        server.broadcast(Json.write(msg));
    }

    /** Kick off a batch simulation: main deck vs each opponent, N games each. */
    private static void handleSim(JsonObject m, GameServer server) {
        simCancel = false;
        simPool.submit(() -> {
            try { runSim(m, server); }
            catch (Throwable t) {
                t.printStackTrace();
                Map<String, Object> e = new LinkedHashMap<>();
                e.put("kind", "error"); e.put("message", String.valueOf(t));
                sim(server, e);
            }
        });
    }

    private static void runSim(JsonObject m, GameServer server) {
        JsonObject mainObj = m.getAsJsonObject("main");
        // Single matchup: prefer `opponent`, fall back to first of legacy `opponents`.
        JsonObject oppObj = m.getAsJsonObject("opponent");
        if (oppObj == null && m.has("opponents") && m.getAsJsonArray("opponents").size() > 0)
            oppObj = m.getAsJsonArray("opponents").get(0).getAsJsonObject();
        int n = m.has("n") && !m.get("n").isJsonNull() ? Math.max(1, m.get("n").getAsInt()) : 10;
        if (mainObj == null || oppObj == null) {
            Map<String, Object> e = new LinkedHashMap<>(); e.put("kind", "error"); e.put("message", "need a main deck and an opponent deck"); sim(server, e); return;
        }
        final JsonObject opp = oppObj;
        String mainName = mainObj.has("name") ? mainObj.get("name").getAsString() : "Main";
        String oppName = opp.has("name") ? opp.get("name").getAsString() : "Opponent";
        // Run games in parallel across cores — each game is independent. Leave one
        // core free for the UI/engine. The UI may override with `threads`.
        int cores = Runtime.getRuntime().availableProcessors();
        int threads = m.has("threads") && !m.get("threads").isJsonNull()
                ? Math.max(1, Math.min(cores, m.get("threads").getAsInt()))
                : Math.max(1, cores - 1);
        if (m.has("gameTimeout") && !m.get("gameTimeout").isJsonNull())
            simGameTimeoutSec = Math.max(5, m.get("gameTimeout").getAsInt());
        if (m.has("aiTimeout") && !m.get("aiTimeout").isJsonNull())
            simAiTimeoutSec = Math.max(1, m.get("aiTimeout").getAsInt());

        long startMs = System.currentTimeMillis();
        long lastSent = 0;
        int done = 0;

        // Aggregates (all updated on this single consumer thread — no locks needed).
        int wins = 0, losses = 0, draws = 0, errors = 0;
        int onPlayGames = 0, onPlayWins = 0, onDrawGames = 0, onDrawWins = 0;
        long turnSum = 0, mainMullSum = 0, oppMullSum = 0;
        long winMarginSum = 0, lossMarginSum = 0;
        java.util.List<Integer> turnList = new ArrayList<>();
        Map<Integer, Integer> turnHist = new java.util.TreeMap<>();
        Map<Integer, Integer> mainMullHist = new java.util.TreeMap<>();
        Map<Integer, Integer> oppMullHist = new java.util.TreeMap<>();
        Map<String, Integer> winReasons = new LinkedHashMap<>();
        Map<String, Integer> lossReasons = new LinkedHashMap<>();
        int fastestWin = Integer.MAX_VALUE, slowestWin = 0;

        ExecutorService pool = Executors.newFixedThreadPool(threads, r -> {
            Thread t = new Thread(r, "forge-sim-w"); t.setDaemon(true); return t;
        });
        try {
            java.util.concurrent.ExecutorCompletionService<SimResult> ecs = new java.util.concurrent.ExecutorCompletionService<>(pool);
            int submitted = 0;
            for (int i = 0; i < n && !simCancel; i++) { ecs.submit(() -> playOne(mainObj, opp)); submitted++; }

            for (int i = 0; i < submitted; i++) {
                if (simCancel) break;
                SimResult r;
                try { r = ecs.take().get(); } catch (Exception ex) { r = new SimResult(); r.outcome = -2; }
                done++;

                if (r.outcome == -2) { errors++; }
                else {
                    if (r.outcome == 0) wins++; else if (r.outcome == 1) losses++; else draws++;
                    turnList.add(r.turns); turnHist.merge(r.turns, 1, Integer::sum); turnSum += r.turns;
                    mainMullHist.merge(r.mainMulls, 1, Integer::sum); mainMullSum += r.mainMulls;
                    oppMullHist.merge(r.oppMulls, 1, Integer::sum); oppMullSum += r.oppMulls;
                    if (r.outcome != -1) { // not a draw → on play/draw split for the main deck
                        if (r.mainOnPlay) { onPlayGames++; if (r.outcome == 0) onPlayWins++; }
                        else { onDrawGames++; if (r.outcome == 0) onDrawWins++; }
                    }
                    if (r.outcome == 0) { // main won → record how the opponent lost + margin
                        if (r.loserReason != null) winReasons.merge(r.loserReason, 1, Integer::sum);
                        winMarginSum += r.winMargin;
                        fastestWin = Math.min(fastestWin, r.turns); slowestWin = Math.max(slowestWin, r.turns);
                    } else if (r.outcome == 1) { // main lost → record how the main deck lost + margin
                        if (r.loserReason != null) lossReasons.merge(r.loserReason, 1, Integer::sum);
                        lossMarginSum += r.winMargin;
                    }
                }

                long now = System.currentTimeMillis();
                if (now - lastSent > 80 || done == n) {
                    lastSent = now;
                    long elapsed = now - startMs;
                    long eta = done > 0 ? (long) ((double) elapsed / done * (n - done)) : 0;
                    Map<String, Object> p = new LinkedHashMap<>();
                    p.put("kind", "progress"); p.put("done", done); p.put("total", n);
                    p.put("elapsedMs", elapsed); p.put("etaMs", eta);
                    p.put("wins", wins); p.put("losses", losses); p.put("draws", draws); p.put("threads", threads);
                    sim(server, p);
                }
            }
        } finally {
            pool.shutdownNow();
        }

        if (simCancel) {
            Map<String, Object> c = new LinkedHashMap<>(); c.put("kind", "cancelled"); c.put("done", done); c.put("total", n); sim(server, c); return;
        }

        int counted = wins + losses + draws;
        java.util.Collections.sort(turnList);
        Map<String, Object> turns = new LinkedHashMap<>();
        turns.put("avg", counted > 0 ? (double) turnSum / counted : 0.0);
        turns.put("median", median(turnList));
        turns.put("min", turnList.isEmpty() ? 0 : turnList.get(0));
        turns.put("max", turnList.isEmpty() ? 0 : turnList.get(turnList.size() - 1));
        turns.put("hist", turnHist);

        Map<String, Object> onPlay = new LinkedHashMap<>();
        onPlay.put("games", onPlayGames); onPlay.put("wins", onPlayWins);
        onPlay.put("winRate", onPlayGames > 0 ? (double) onPlayWins / onPlayGames : 0.0);
        Map<String, Object> onDraw = new LinkedHashMap<>();
        onDraw.put("games", onDrawGames); onDraw.put("wins", onDrawWins);
        onDraw.put("winRate", onDrawGames > 0 ? (double) onDrawWins / onDrawGames : 0.0);

        Map<String, Object> report = new LinkedHashMap<>();
        report.put("kind", "done");
        report.put("main", mainName); report.put("opponent", oppName);
        report.put("games", counted); report.put("errors", errors);
        report.put("wins", wins); report.put("losses", losses); report.put("draws", draws);
        report.put("winRate", counted > 0 ? (double) wins / counted : 0.0);
        // 95% CI half-width on the win rate (Wald), so the user knows if N is big enough.
        double wr = counted > 0 ? (double) wins / counted : 0.0;
        report.put("winRateCI", counted > 0 ? 1.96 * Math.sqrt(wr * (1 - wr) / counted) : 0.0);
        report.put("onPlay", onPlay); report.put("onDraw", onDraw);
        report.put("turns", turns);
        Map<String, Object> mainMull = new LinkedHashMap<>();
        mainMull.put("avg", counted > 0 ? (double) mainMullSum / counted : 0.0); mainMull.put("hist", mainMullHist);
        Map<String, Object> oppMull = new LinkedHashMap<>();
        oppMull.put("avg", counted > 0 ? (double) oppMullSum / counted : 0.0); oppMull.put("hist", oppMullHist);
        report.put("mainMulligans", mainMull); report.put("oppMulligans", oppMull);
        report.put("winReasons", winReasons); report.put("lossReasons", lossReasons);
        report.put("avgWinMargin", wins > 0 ? (double) winMarginSum / wins : 0.0);
        report.put("avgLossMargin", losses > 0 ? (double) lossMarginSum / losses : 0.0);
        report.put("fastestWin", fastestWin == Integer.MAX_VALUE ? 0 : fastestWin);
        report.put("slowestWin", slowestWin);
        report.put("elapsedMs", System.currentTimeMillis() - startMs); report.put("threads", threads);
        sim(server, report);
    }

    private static double median(java.util.List<Integer> sorted) {
        int s = sorted.size();
        if (s == 0) return 0.0;
        if (s % 2 == 1) return sorted.get(s / 2);
        return (sorted.get(s / 2 - 1) + sorted.get(s / 2)) / 2.0;
    }

    /** Result of a single simulated game. */
    private static class SimResult {
        int outcome = -2;       // 0=main win, 1=opp win (main loss), -1=draw, -2=error
        int turns = 0;
        int mainMulls = 0, oppMulls = 0;
        boolean mainOnPlay = false;
        String loserReason = null; // GameLossReason of the losing player (null for draw/error)
        int winMargin = 0;         // winner's remaining life advantage (lifeDelta)
    }

    /** Per-game wall-clock cap (seconds). Forge games normally finish in a few
     *  seconds; a rare AI stall is force-drawn so it can't hang the batch. */
    private static volatile int simGameTimeoutSec = 60;
    /** Ceiling on AI think time per expensive decision (Forge default 5s). Lower
     *  values trim the slow-turn tail with little quality loss on simple decks. */
    private static volatile int simAiTimeoutSec = 3;

    /** Play one AI-vs-AI game and collect rich per-game stats.
     *  Decks are built per game so concurrent games share no mutable state. */
    private static SimResult playOne(JsonObject mainObj, JsonObject oppObj) {
        SimResult res = new SimResult();
        try {
            List<RegisteredPlayer> players = new ArrayList<>();
            RegisteredPlayer rp0 = new RegisteredPlayer(buildDeck(mainObj));
            rp0.setPlayer(GamePlayerUtil.createAiPlayer("Main", 0));
            RegisteredPlayer rp1 = new RegisteredPlayer(buildDeck(oppObj));
            rp1.setPlayer(GamePlayerUtil.createAiPlayer("Opp", 1));
            players.add(rp0); players.add(rp1);

            GameRules rules = new GameRules(GameType.Constructed);
            rules.setAppliedVariants(EnumSet.of(GameType.Constructed));
            Match match = new Match(rules, players, "sim");
            Game game = match.createGame();
            // Cap AI think time so a few slow turns can't drag the game out.
            game.AI_TIMEOUT = simAiTimeoutSec;
            game.AI_CAN_USE_TIMEOUT = true;

            // Watchdog: if this game runs past the cap (AI stall / loop), force it
            // to a draw so startGame() returns and the batch can't hang. Same trick
            // Forge's own SimulateMatch uses.
            java.util.concurrent.ScheduledFuture<?> wd = simWatchdog.schedule(() -> {
                try { if (!game.isGameOver()) game.setGameOver(GameEndReason.Draw); }
                catch (Throwable ignore) {}
            }, simGameTimeoutSec, java.util.concurrent.TimeUnit.SECONDS);
            try {
                match.startGame(game);
            } finally {
                wd.cancel(false);
            }

            GameOutcome outcome = game.getOutcome();
            res.turns = outcome != null ? outcome.getLastTurnNumber() : 0;
            res.winMargin = outcome != null ? outcome.getLifeDelta() : 0;

            Player starter = game.getStartingPlayer();
            res.mainOnPlay = starter != null && starter.getRegisteredPlayer() == rp0;

            RegisteredPlayer winner = outcome != null ? outcome.getWinningPlayer() : null;
            res.outcome = winner == null ? -1 : (winner == rp0 ? 0 : 1);

            if (outcome != null) {
                for (Map.Entry<RegisteredPlayer, PlayerStatistics> e : outcome) {
                    PlayerStatistics st = e.getValue();
                    if (st == null) continue;
                    if (e.getKey() == rp0) res.mainMulls = st.getMulliganCount();
                    else res.oppMulls = st.getMulliganCount();
                    // Record the losing player's reason (skip the winner / draws).
                    PlayerOutcome po = st.getOutcome();
                    if (po != null && !po.hasWon() && po.lossState != null
                            && po.lossState != GameLossReason.IntentionalDraw) {
                        boolean isLoser = (res.outcome == 0 && e.getKey() == rp1)
                                || (res.outcome == 1 && e.getKey() == rp0);
                        if (isLoser) res.loserReason = po.lossState.name();
                    }
                }
            }
            return res;
        } catch (Throwable t) {
            System.err.println("[bridge] sim game error: " + t);
            res.outcome = -2;
            return res;
        }
    }

    /** Pending per-seat deck choices (WLAN: each human picks their own). */
    private static final Map<Integer, JsonObject> seatDecks = new ConcurrentHashMap<>();

    /** Handle a `{type:'control', action:'start'|'deck'|'sim', ...}` request from the UI. */
    private static void handleControl(WebSocket conn, String raw, GameServer server, DecisionChannel channel) {
        try {
            JsonObject m = JsonParser.parseString(raw).getAsJsonObject();
            if (!"control".equals(str(m, "type"))) return;
            final String action = str(m, "action");
            if ("sim".equals(action)) { handleSim(m, server); return; }
            if ("simCancel".equals(action)) { simCancel = true; return; }
            if ("stops".equals(action)) {
                // Arena-style per-step stops for this seat (see BridgeGui).
                int seat = server.seatOf(conn);
                if (seat >= 0) {
                    java.util.Set<String> set = new java.util.HashSet<>();
                    if (m.has("stops") && m.get("stops").isJsonArray())
                        for (JsonElement el : m.getAsJsonArray("stops")) set.add(el.getAsString());
                    BridgeGui.setStops(seat, set);
                }
                return;
            }
            if ("deck".equals(action)) {
                // A seat announced its chosen deck (WLAN lobby). Store it for `start`.
                int seat = server.seatOf(conn);
                if (seat >= 0 && m.has("deck") && m.get("deck").isJsonObject()) {
                    JsonObject deck = m.getAsJsonObject("deck");
                    seatDecks.put(seat, deck);
                    server.setSeatDeckName(seat, deck.has("name") ? deck.get("name").getAsString() : ("Player " + (seat + 1)));
                    server.announceLobby();
                }
                return;
            }
            if (!"start".equals(action)) return;

            String gmode = m.has("mode") ? m.get("mode").getAsString() : "ai";
            JsonArray decks = m.getAsJsonArray("decks");
            // Each seat's deck: prefer what that seat picked (WLAN guest), else the
            // deck the start payload carried for it (local modes / host fallback).
            JsonObject deck0 = seatDecks.get(0);
            JsonObject deck1 = seatDecks.get(1);
            if (deck0 == null && decks != null && decks.size() > 0) deck0 = decks.get(0).getAsJsonObject();
            if (deck1 == null && decks != null && decks.size() > 1) deck1 = decks.get(1).getAsJsonObject();
            if (deck0 == null || deck1 == null) { System.err.println("[bridge] start: need 2 decks"); return; }

            Deck d0 = buildDeck(deck0);
            Deck d1 = buildDeck(deck1);

            List<RegisteredPlayer> players = new ArrayList<>();
            // The human's chosen username (from the client profile); the AI is
            // simply "AI". Names flow into player bars and every Forge log line.
            final String you = str(m, "you").isEmpty() ? "You" : str(m, "you");
            RegisteredPlayer rp0 = new RegisteredPlayer(d0);
            // "ai2" = AI vs AI (you spectate seat 0). Otherwise seat 0 is you.
            if ("ai2".equalsIgnoreCase(gmode)) rp0.setPlayer(GamePlayerUtil.createAiPlayer("AI 1", 0));
            else rp0.setPlayer(new LobbyPlayerHuman(you));
            players.add(rp0);
            RegisteredPlayer rp1 = new RegisteredPlayer(d1);
            if ("pvp".equalsIgnoreCase(gmode)) {
                rp1.setPlayer(new LobbyPlayerHuman("Player 2"));
            } else {
                rp1.setPlayer(GamePlayerUtil.createAiPlayer("ai2".equalsIgnoreCase(gmode) ? "AI 2" : "AI", 1));
            }
            players.add(rp1);

            final int gen = ++liveGen; // supersede any previous (e.g. exited) game
            seatDecks.clear(); // consumed — don't leak into the next game
            new Thread(() -> runMatch(players, server, channel, gen), "forge-game").start();
        } catch (Exception e) {
            System.err.println("[bridge] control error: " + e);
        }
    }

    private static String str(JsonObject o, String k) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : "";
    }

    /** Route a `{type:'action', kind:'selectCard'|…}` click to the seat's controller. */
    private static void handleAction(WebSocket conn, String raw, GameServer server) {
        try {
            JsonObject m = JsonParser.parseString(raw).getAsJsonObject();
            if (!"action".equals(str(m, "type"))) return;
            final int seat = server.seatOf(conn);
            final PlayerControllerHuman ctrl = seatControllers.get(seat);
            if (ctrl == null) return;
            final String kind = str(m, "kind");
            // Run off the WS thread so a nested blocking prompt can be answered.
            inputPool.submit(() -> dispatchAction(ctrl, kind, m));
        } catch (Exception e) {
            System.err.println("[bridge] action error: " + e);
        }
    }

    /** Translate one client action into the matching {@code IGameController} call. */
    private static void dispatchAction(PlayerControllerHuman ctrl, String kind, JsonObject m) {
        try {
            switch (kind) {
                case "selectCard": {
                    Card c = ctrl.getGame().findById(m.get("cardId").getAsInt());
                    if (c != null) ctrl.selectCard(c.getView(), null, null);
                    break;
                }
                case "selectPlayer": {
                    int id = m.get("playerId").getAsInt();
                    for (Player p : ctrl.getGame().getPlayers()) {
                        if (p.getId() == id) { ctrl.selectPlayer(p.getView(), null); break; }
                    }
                    break;
                }
                case "selectButtonOk":     ctrl.selectButtonOk(); break;
                case "selectButtonCancel": ctrl.selectButtonCancel(); break;
                case "passPriority":       ctrl.passPriority(); break;
                case "useMana":            ctrl.useMana((byte) m.get("color").getAsInt()); break;
                default: System.err.println("[bridge] unknown action: " + kind);
            }
        } catch (Exception e) {
            System.err.println("[bridge] dispatch error (" + kind + "): " + e);
        }
    }

    /** Build a Forge Deck from {name, cards:{cardName:count}} sent by the UI. */
    private static Deck buildDeck(JsonObject deckObj) {
        Deck d = new Deck(deckObj.has("name") ? deckObj.get("name").getAsString() : "Deck");
        if (deckObj.has("cards") && deckObj.get("cards").isJsonObject()) {
            for (Map.Entry<String, JsonElement> e : deckObj.getAsJsonObject("cards").entrySet()) {
                int count = e.getValue().getAsInt();
                if (count <= 0) continue;
                forge.item.PaperCard pc = forge.StaticData.instance().getCommonCards().getCard(e.getKey());
                if (pc != null) d.getMain().add(pc, count);
                else System.err.println("[bridge] unknown card skipped: " + e.getKey());
            }
        }
        return d;
    }

    /**
     * Build a game with the deck files passed on the command line (test/CLI path).
     * Seats [0, humanSeats) are UI-routed bridge controllers; the rest are AI.
     */
    private static void runGame(String deckA, String deckB, GameServer server, DecisionChannel channel, int humanSeats) {
        try {
            final String[] deckPaths = { deckA, deckB };
            final List<RegisteredPlayer> players = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                final Deck deck = DeckSerializer.fromFile(new File(deckPaths[i]));
                if (deck == null) {
                    System.err.println("[bridge] could not load deck: " + deckPaths[i]);
                    return;
                }
                final RegisteredPlayer rp = new RegisteredPlayer(deck);
                if (i < humanSeats) {
                    rp.setPlayer(new LobbyPlayerHuman("Player " + (i + 1)));
                } else {
                    rp.setPlayer(GamePlayerUtil.createAiPlayer("AI-" + deck.getName(), i));
                }
                players.add(rp);
            }
            runMatch(players, server, channel, ++liveGen);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    /** Run a match to completion, broadcasting per-seat snapshots; blocks the caller. */
    private static void runMatch(List<RegisteredPlayer> players, GameServer server, DecisionChannel channel, int gen) {
        try {
            final GameType type = GameType.Constructed;
            final GameRules rules = new GameRules(type);
            rules.setAppliedVariants(EnumSet.of(type));
            final Match match = new Match(rules, players, "MTGForgeLab");
            final Game game = match.createGame();

            // Wire each human seat's BridgeGui (mirrors Forge's HostedMatch). DESIGN.md §13.4.
            // Seat == player index, which matches GameServer seat assignment and ViewSerializer.
            seatControllers.clear();
            int seat = 0;
            for (Player p : game.getPlayers()) {
                if (p.getController() instanceof PlayerControllerHuman hc) {
                    final BridgeGui gui = new BridgeGui(server, channel, seat, gen);
                    hc.setGui(gui);
                    gui.setOwnerPlayer(p);
                    gui.setGameView(null);
                    gui.setGameView(game.getView());
                    gui.setOriginalGameController(p.getView(), hc);
                    gui.openView(new TrackableCollection<PlayerView>(p.getView()));
                    seatControllers.put(seat, hc);
                }
                seat++;
            }

            game.subscribeToEvents(new SnapshotBroadcaster(game, server, gen));
            System.err.println("[bridge] starting game (gen " + gen + ")");
            match.startGame(game);
            if (isLiveGen(gen)) server.broadcastPerSeat(s -> Json.write(ViewSerializer.snapshot(game, s)));
            System.err.println("[bridge] game finished (gen " + gen + ")");
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            if (isLiveGen(gen)) seatControllers.clear();
        }
    }

    /** Export Forge's full card pool to a JSON the deck builder / UI can read. */
    private static void runCatalog(String forgeGuiDirArg, String outFile) throws Exception {
        final Path forgeGuiDir = Path.of(forgeGuiDirArg).toAbsolutePath().normalize();
        GuiBase.setInterface(new HeadlessGui(forgeGuiDir));
        FModel.initialize(null, null);

        java.util.Map<String, forge.item.PaperCard> byName = new java.util.LinkedHashMap<>();
        for (forge.item.PaperCard pc : forge.StaticData.instance().getCommonCards().getAllCards()) {
            byName.putIfAbsent(pc.getName(), pc);
        }

        java.util.List<Object> out = new ArrayList<>();
        for (forge.item.PaperCard pc : byName.values()) {
            forge.card.CardRules r = pc.getRules();
            if (r == null) continue;
            java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
            m.put("name", pc.getName());
            m.put("type_line", r.getType() == null ? "" : r.getType().toString());
            m.put("mana_cost", r.getManaCost() == null ? "" : r.getManaCost().toString());
            m.put("cmc", r.getManaCost() == null ? 0 : r.getManaCost().getCMC());
            m.put("colors", colorString(r.getColor()));
            m.put("color_identity", colorString(r.getColorIdentity()));
            m.put("oracle_text", r.getOracleText() == null ? "" : r.getOracleText());
            m.put("power", r.getPower() == null ? "" : r.getPower());
            m.put("toughness", r.getToughness() == null ? "" : r.getToughness());
            m.put("rarity", String.valueOf(pc.getRarity()));
            // Card art straight from Forge's own Scryfall scheme (set + collector number).
            String[] imgs = imageUrls(pc, r);
            m.put("image_url", imgs[0]);
            m.put("image_url_back", imgs[1]);
            // Non-Forge display fields the builder tolerates (defaults).
            m.put("usd_price", 0);
            m.put("popularity", 0);
            m.put("decks", 0);
            out.add(m);
        }
        java.nio.file.Files.writeString(java.nio.file.Path.of(outFile), Json.write(out));
        System.err.println("[bridge] wrote catalog: " + out.size() + " cards -> " + outFile);
    }

    /** Front/back card image URLs via Forge's own Scryfall scheme (set + collector #). */
    private static String[] imageUrls(forge.item.PaperCard pc, forge.card.CardRules r) {
        final String base = "https://api.scryfall.com/cards/";
        String front = "", back = "";
        try {
            forge.card.CardEdition ed = forge.StaticData.instance().getEditions().get(pc.getEdition());
            String setCode = ed != null ? ed.getScryfallCode() : "";
            String langCode = ed != null ? ed.getCardsLangCode() : "";
            String f = forge.util.ImageUtil.getScryfallDownloadUrl(pc, "", setCode, langCode, false);
            if (f != null) front = base + f;
            if (r.getOtherPart() != null) {
                String b = forge.util.ImageUtil.getScryfallDownloadUrl(pc, "back", setCode, langCode, false);
                if (b != null) back = base + b;
            }
        } catch (Exception ignored) {
        }
        return new String[] { front, back };
    }

    private static String colorString(forge.card.ColorSet cs) {
        if (cs == null) return "C";
        StringBuilder sb = new StringBuilder();
        if (cs.hasWhite()) sb.append('W');
        if (cs.hasBlue()) sb.append('U');
        if (cs.hasBlack()) sb.append('B');
        if (cs.hasRed()) sb.append('R');
        if (cs.hasGreen()) sb.append('G');
        return sb.length() == 0 ? "C" : sb.toString();
    }

    private BridgeMain() {}
}
