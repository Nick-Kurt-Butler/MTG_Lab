package mtgforgelab.bridge;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import forge.game.Game;
import forge.game.GameLog;
import forge.game.GameLogEntry;
import forge.game.GameView;
import forge.game.GameEntityView;
import forge.game.card.Card;
import forge.game.card.CardView;
import forge.game.combat.CombatView;
import forge.game.keyword.Keyword;
import forge.game.player.Player;
import forge.game.player.PlayerView;
import forge.game.spellability.StackItemView;
import forge.game.zone.ZoneType;
import forge.util.collect.FCollectionView;

/**
 * Converts Forge's {@link GameView} (its UI-facing trackable snapshot) into the
 * plain Map/List structure that {@link Json} serializes and the MTG Lab UI
 * consumes. This is the single place that defines our wire snapshot shape.
 *
 * Players are referenced by a stable 0-based index (iteration order of
 * {@code GameView.getPlayers()}); cards carry their controller's index.
 */
public final class ViewSerializer {

    // Evergreen keywords surfaced as badges in the MTG Lab board.
    private static final Keyword[] BADGE_KEYWORDS = {
        Keyword.FLYING, Keyword.REACH, Keyword.MENACE, Keyword.LIFELINK,
        Keyword.DEATHTOUCH, Keyword.TRAMPLE, Keyword.VIGILANCE, Keyword.HASTE,
        Keyword.FIRST_STRIKE, Keyword.DOUBLE_STRIKE, Keyword.DEFENDER,
    };

    public static Map<String, Object> snapshot(Game game, int viewerSeat) {
        GameView gv = game == null ? null : game.getView();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "snapshot");
        m.put("viewerSeat", viewerSeat);
        if (gv == null) {
            return m;
        }

        m.put("turn", gv.getTurn());
        m.put("phase", gv.getPhase() == null ? null : gv.getPhase().toString());
        try { m.put("mulligan", gv.isMulligan()); } catch (Throwable t) { /* older API */ }

        // Map player id -> the live Player (to read the owner's real library, which
        // the GameView hides even from its owner) and id -> index.
        Map<Integer, Player> realPlayers = new HashMap<>();
        if (game != null) {
            for (Player p : game.getPlayers()) realPlayers.put(p.getId(), p);
        }

        // Build player id -> index map first (cards reference controller by index).
        FCollectionView<PlayerView> pvs = gv.getPlayers();
        Map<Integer, Integer> idx = new HashMap<>();
        int i = 0;
        if (pvs != null) {
            for (PlayerView pv : pvs) {
                idx.put(pv.getId(), i++);
            }
        }

        List<Object> players = new ArrayList<>();
        i = 0;
        if (pvs != null) {
            for (PlayerView pv : pvs) {
                players.add(player(pv, i++, idx, viewerSeat, realPlayers.get(pv.getId())));
            }
        }
        m.put("players", players);

        PlayerView active = gv.getPlayerTurn();
        m.put("activePlayer", active == null ? null : idx.getOrDefault(active.getId(), 0));

        // Battlefield is shared visual space; emit all permanents with controller index.
        List<Object> battlefield = new ArrayList<>();
        if (pvs != null) {
            for (PlayerView pv : pvs) {
                FCollectionView<CardView> bf = pv.getCards(ZoneType.Battlefield);
                if (bf != null) {
                    for (CardView c : bf) battlefield.add(card(c, idx));
                }
            }
        }
        m.put("battlefield", battlefield);

        List<Object> stack = new ArrayList<>();
        FCollectionView<StackItemView> st = gv.getStack();
        if (st != null) {
            for (StackItemView si : st) {
                Map<String, Object> s = new LinkedHashMap<>();
                s.put("id", si.getId());
                s.put("text", String.valueOf(si));
                stack.add(s);
            }
        }
        m.put("stack", stack);

        // Combat: attacker -> defender (player or planeswalker/battle) and the
        // blockers on each attacker, so the UI can draw the connection arrows.
        try {
            CombatView cv = gv.getCombat();
            if (cv != null) {
                List<Object> combat = new ArrayList<>();
                for (CardView atk : cv.getAttackers()) {
                    if (atk == null) continue;
                    Map<String, Object> e = new LinkedHashMap<>();
                    e.put("attacker", atk.getId());
                    GameEntityView def = cv.getDefender(atk);
                    e.put("defender", def == null ? null : def.getId());
                    List<Integer> blk = new ArrayList<>();
                    FCollectionView<CardView> bs = cv.getBlockers(atk);
                    if (bs != null) for (CardView b : bs) blk.add(b.getId());
                    e.put("blockers", blk);
                    combat.add(e);
                }
                m.put("combat", combat);
            }
        } catch (Throwable t) { /* combat view optional */ }

        // Game log (chronological) — feeds LogPanel.
        List<Object> log = new ArrayList<>();
        GameLog gl = gv.getGameLog();
        if (gl != null) {
            for (GameLogEntry e : gl.getAllEntries()) {
                if (e != null && e.message() != null) log.add(e.message());
            }
        }
        m.put("log", log);

        m.put("gameOver", gv.isGameOver());
        if (gv.isGameOver()) {
            m.put("winner", gv.getWinningPlayerName());
        }
        return m;
    }

    private static Map<String, Object> player(PlayerView pv, int index, Map<Integer, Integer> idx, int viewerSeat, Player real) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("index", index);
        p.put("id", pv.getId());
        p.put("name", pv.getName());
        p.put("life", pv.getLife());
        try { p.put("hasPriority", pv.getHasPriority()); } catch (Throwable t) { /* older API */ }
        // Mulligan bookkeeping (drives the "Mulligan to X" label + bottom count).
        // London: you bottom `mulliganCount` cards; the next mulligan lands you at
        // `maxHandSize - mulliganCount - 1`.
        try {
            if (real != null) {
                p.put("mulliganCount", real.getStats().getMulliganCount());
                p.put("maxHandSize", real.getMaxHandSize());
            }
        } catch (Throwable t) { /* optional */ }
        // Floating mana pool (so the player bar can show what you've tapped for).
        try {
            Map<String, Object> pool = new LinkedHashMap<>();
            int[][] colors = {
                { forge.card.mana.ManaAtom.WHITE, 'W' }, { forge.card.mana.ManaAtom.BLUE, 'U' },
                { forge.card.mana.ManaAtom.BLACK, 'B' }, { forge.card.mana.ManaAtom.RED, 'R' },
                { forge.card.mana.ManaAtom.GREEN, 'G' }, { forge.card.mana.ManaAtom.COLORLESS, 'C' },
            };
            for (int[] cc : colors) {
                int n = pv.getMana((byte) cc[0]);
                if (n > 0) pool.put(String.valueOf((char) cc[1]), n);
            }
            p.put("manaPool", pool);
        } catch (Throwable t) { /* mana optional */ }

        // Hand size is public; the card faces are hidden from everyone except
        // the owner (a spectator, seat -1, sees neither hand's faces).
        FCollectionView<CardView> hand = pv.getCards(ZoneType.Hand);
        p.put("handCount", hand == null ? 0 : hand.size());
        p.put("hand", index == viewerSeat ? cards(hand, idx) : new ArrayList<>());

        p.put("graveyard", cards(pv.getCards(ZoneType.Graveyard), idx));
        p.put("exile", cards(pv.getCards(ZoneType.Exile), idx));
        FCollectionView<CardView> lib = pv.getCards(ZoneType.Library);
        p.put("librarySize", lib == null ? 0 : lib.size());
        // The owner may review their own library contents — a known multiset. The
        // GameView hides library names even from the owner, so read the real Cards
        // from the live zone. Order is never sent (the UI groups by name).
        // Library is sent in true order (index 0 = top). `visible` marks a card the
        // owner may actually see face-up right now (e.g. "play with the top card
        // revealed"); the client shows the rest face-down in the ordered view.
        p.put("library", index == viewerSeat ? libraryCards(real, pv) : new ArrayList<>());
        return p;
    }

    private static List<Object> libraryCards(Player real, PlayerView ownerView) {
        List<Object> out = new ArrayList<>();
        if (real == null) return out;
        for (Card c : real.getCardsIn(ZoneType.Library)) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.getId());
            m.put("name", c.getName());
            m.put("types", c.getType() == null ? null : c.getType().toString());
            boolean vis = false;
            try { vis = ownerView != null && c.getView() != null && c.getView().canBeShownTo(ownerView); }
            catch (Throwable t) { /* default hidden */ }
            m.put("visible", vis);
            out.add(m);
        }
        return out;
    }

    private static List<Object> cards(FCollectionView<CardView> cv, Map<Integer, Integer> idx) {
        List<Object> out = new ArrayList<>();
        if (cv != null) {
            for (CardView c : cv) out.add(card(c, idx));
        }
        return out;
    }

    private static Map<String, Object> card(CardView c, Map<Integer, Integer> idx) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", c.getId());

        CardView.CardStateView st = c.getCurrentState();
        m.put("name", st == null ? c.getName() : st.getName());
        if (st != null) {
            m.put("power", st.getPower());
            m.put("toughness", st.getToughness());
            m.put("types", st.getType() == null ? null : st.getType().toString());
            StringBuilder kw = new StringBuilder();
            for (Keyword k : BADGE_KEYWORDS) {
                if (st.hasKeyword(k)) kw.append(k.name().toLowerCase(java.util.Locale.ROOT)).append(' ');
            }
            m.put("keywords", kw.toString().trim());
        }
        m.put("tapped", c.isTapped());
        m.put("sick", c.isSick());
        m.put("damage", c.getDamage());

        PlayerView ctrl = c.getController();
        m.put("controller", ctrl == null ? null : idx.get(ctrl.getId()));

        Map<?, ?> counters = c.getCounters();
        if (counters != null && !counters.isEmpty()) {
            Map<String, Object> cc = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : counters.entrySet()) {
                cc.put(String.valueOf(e.getKey()), e.getValue());
            }
            m.put("counters", cc);
        }
        return m;
    }

    private ViewSerializer() {}
}
