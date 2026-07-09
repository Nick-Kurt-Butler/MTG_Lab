package mtgforgelab.bridge;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import forge.LobbyPlayer;
import forge.game.GameState;
import forge.deck.CardPool;
import forge.game.GameEntityView;
import forge.game.card.CardView;
import forge.game.event.GameEvent;
import forge.game.event.GameEventSpellAbilityCast;
import forge.game.event.GameEventSpellRemovedFromStack;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.IHasIcon;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.AbstractGuiGame;
import forge.gamemodes.net.DeltaPacket;
import forge.item.PaperCard;
import forge.localinstance.skin.FSkinProp;
import forge.player.PlayerZoneUpdate;
import forge.player.PlayerZoneUpdates;
import forge.trackable.TrackableCollection;
import forge.util.FSerializableFunction;
import forge.util.ITriggerEvent;

/**
 * Our {@link forge.gui.interfaces.IGuiGame} for one seat — the headless analogue
 * of Forge's {@code RemoteClientGuiGame}. Forge's stock {@code PlayerControllerHuman}
 * runs the human's turn and calls this object for every interactive question;
 * we forward the blocking questions to the WebSocket client (via
 * {@link DecisionChannel}) and push non-blocking UI state (prompt text, button
 * enablement, selectable-card highlights) so the board knows what is clickable.
 *
 * Display methods that merely mirror engine state are no-ops here: the client
 * already receives full per-seat {@code snapshot}s from {@link SnapshotBroadcaster}.
 *
 * See DESIGN.md §13. Engine source is never modified — this is the same contract
 * Forge's own network server fulfils for a remote human.
 */
public final class BridgeGui extends AbstractGuiGame {

    private final GameServer server;
    private final DecisionChannel channel;
    private final int seat;
    private final int gen;
    // The live player this GUI serves. Lets us read engine state (e.g. the current
    // mulligan count) at the exact moment we push UI, avoiding the snapshot's
    // event-ordering staleness.
    private forge.game.player.Player ownerPlayer;

    public BridgeGui(GameServer server, DecisionChannel channel, int seat, int gen) {
        this.server = server;
        this.channel = channel;
        this.seat = seat;
        this.gen = gen;
        setNetGame(); // matches RemoteClientGuiGame.isNetGame() == true
    }

    public void setOwnerPlayer(forge.game.player.Player p) { this.ownerPlayer = p; }

    // ---------------------------------------------------------------------
    // Helpers: blocking ask + non-blocking UI push
    // ---------------------------------------------------------------------

    /** Send a blocking prompt to this seat and wait for the client's response. */
    private JsonObject ask(String kind, String message, List<Object> options, Map<String, Object> extra) {
        if (!BridgeMain.isLiveGen(gen)) return null; // superseded game: don't block or prompt
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("kind", kind);
        d.put("seat", seat);
        d.put("prompt", message == null ? "" : message);
        if (options != null) d.put("options", options);
        if (extra != null) d.putAll(extra);
        return channel.ask(seat, d); // DecisionChannel tags type="prompt" + id and blocks
    }

    /** Attach a DelayedReveal's cards to a choice prompt as "look at these" context. */
    private void putReveal(Map<String, Object> extra, DelayedReveal dr) {
        if (dr == null || dr.getCards() == null || dr.getCards().isEmpty()) return;
        List<Object> rev = new ArrayList<>();
        int i = 0;
        for (CardView c : dr.getCards()) {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("index", i++); o.put("id", c.getId()); o.put("label", c.getName());
            rev.add(o);
        }
        extra.put("reveal", rev);
        if (dr.getMessagePrefix() != null) extra.put("revealPrefix", dr.getMessagePrefix());
    }

    /** Push a non-blocking UI-state message to this seat. */
    private void pushUi(Map<String, Object> msg) {
        msg.put("type", "ui");
        msg.put("seat", seat);
        server.sendToSeat(seat, Json.write(msg));
    }

    private List<Object> serialize(Collection<?> choices) {
        List<Object> out = new ArrayList<>();
        int i = 0;
        for (Object c : choices) {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("index", i++);
            o.put("id", idOf(c));
            o.put("label", labelOf(c));
            // Zone + owner so the UI can surface a candidate in its true location
            // (either player's hand/library/graveyard/exile/battlefield), rather
            // than guessing. null for non-card options.
            o.put("zone", zoneOf(c));
            o.put("owner", ownerOf(c));
            out.add(o);
        }
        return out;
    }

    private static Integer idOf(Object o) {
        if (o instanceof GameEntityView g) return g.getId();
        if (o instanceof SpellAbilityView s) return s.getHostCard() == null ? null : s.getHostCard().getId();
        return null;
    }

    private static String labelOf(Object o) {
        if (o instanceof CardView c) return c.getName();
        if (o instanceof SpellAbilityView s) return s.getDescription();
        return String.valueOf(o);
    }

    /** The zone a candidate card currently lives in (lowercased), or null. */
    private static String zoneOf(Object o) {
        CardView c = cardOf(o);
        if (c == null) return null;
        ZoneType z = c.getZone();
        return z == null ? null : z.toString().toLowerCase(java.util.Locale.ROOT);
    }

    /** The owning player's id (matches snapshot player ids), or null. */
    private static Integer ownerOf(Object o) {
        if (o instanceof PlayerView p) return p.getId();
        CardView c = cardOf(o);
        if (c != null) { PlayerView ow = c.getOwner(); return ow == null ? null : ow.getId(); }
        return null;
    }

    private static CardView cardOf(Object o) {
        if (o instanceof CardView c) return c;
        if (o instanceof SpellAbilityView s) return s.getHostCard();
        return null;
    }

    private static Integer readInt(JsonObject resp, String key) {
        try {
            if (resp != null && resp.has("data")) {
                JsonObject data = resp.getAsJsonObject("data");
                if (data.has(key) && !data.get(key).isJsonNull()) return data.get(key).getAsInt();
            }
        } catch (Exception ignored) {}
        return null;
    }

    private static Boolean readBool(JsonObject resp, String key) {
        try {
            if (resp != null && resp.has("data")) {
                JsonObject data = resp.getAsJsonObject("data");
                if (data.has(key) && !data.get(key).isJsonNull()) return data.get(key).getAsBoolean();
            }
        } catch (Exception ignored) {}
        return null;
    }

    private static String readStr(JsonObject resp, String key) {
        try {
            if (resp != null && resp.has("data")) {
                JsonObject data = resp.getAsJsonObject("data");
                if (data.has(key) && !data.get(key).isJsonNull()) return data.get(key).getAsString();
            }
        } catch (Exception ignored) {}
        return null;
    }

    private static List<Integer> readIntArray(JsonObject resp, String key) {
        List<Integer> out = new ArrayList<>();
        try {
            if (resp != null && resp.has("data")) {
                JsonObject data = resp.getAsJsonObject("data");
                if (data.has(key) && data.get(key).isJsonArray()) {
                    for (JsonElement el : data.getAsJsonArray(key)) out.add(el.getAsInt());
                }
            }
        } catch (Exception ignored) {}
        return out;
    }

    // ---------------------------------------------------------------------
    // Blocking interactive questions (forwarded to the client)
    // ---------------------------------------------------------------------

    @Override
    public SpellAbilityView getAbilityToPlay(CardView hostCard, List<SpellAbilityView> abilities, ITriggerEvent triggerEvent) {
        if (abilities == null || abilities.isEmpty()) return null;
        System.err.println("[bridge] getAbilityToPlay " + (hostCard == null ? "?" : hostCard.getName())
                + " (" + abilities.size() + " option(s))");
        // Exactly one option -> take it. Forge would otherwise make you confirm a
        // redundant one-button menu (the "select twice" feel). Multiple options
        // (dual land's W/B, modal abilities) still go to the player to choose.
        if (abilities.size() == 1) return abilities.get(0);
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("cardId", hostCard == null ? null : hostCard.getId());
        extra.put("optional", true); // let the player back out of a card they clicked
        String title = hostCard == null ? "Choose an ability" : hostCard.getName();
        JsonObject resp = ask("chooseAbility", title, serialize(abilities), extra);
        Integer ix = readInt(resp, "choice");
        System.err.println("[bridge] getAbilityToPlay -> choice " + ix);
        if (ix == null || ix < 0 || ix >= abilities.size()) return null;
        return abilities.get(ix);
    }

    @Override
    public GameEntityView chooseSingleEntityForEffect(String title, List<? extends GameEntityView> optionList,
                                                      DelayedReveal delayedReveal, boolean isOptional) {
        if (optionList == null || optionList.isEmpty()) return null;
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("optional", isOptional);
        putReveal(extra, delayedReveal);
        JsonObject resp = ask("chooseEntity", title, serialize(optionList), extra);
        Integer ix = readInt(resp, "choice");
        if (ix == null || ix < 0 || ix >= optionList.size()) return null;
        return optionList.get(ix);
    }

    @Override
    public List<GameEntityView> chooseEntitiesForEffect(String title, List<? extends GameEntityView> optionList,
                                                        int min, int max, DelayedReveal delayedReveal) {
        List<GameEntityView> chosen = new ArrayList<>();
        if (optionList == null || optionList.isEmpty()) return chosen;
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("min", min);
        extra.put("max", max);
        putReveal(extra, delayedReveal);
        JsonObject resp = ask("chooseEntities", title, serialize(optionList), extra);
        for (int ix : readIntArray(resp, "choices")) {
            if (ix >= 0 && ix < optionList.size()) chosen.add(optionList.get(ix));
        }
        return chosen;
    }

    @Override
    public <T> List<T> getChoices(String message, int min, int max, List<T> choices, List<T> selected,
                                  FSerializableFunction<T, String> display) {
        List<T> out = new ArrayList<>();
        if (choices == null || choices.isEmpty()) return out;
        // min < 0 is a "reveal" (engine ignores the return) — don't block the game.
        if (min < 0) {
            Map<String, Object> msg = new LinkedHashMap<>();
            msg.put("kind", "reveal");
            msg.put("message", message);
            msg.put("options", serialize(choices));
            pushUi(msg);
            out.addAll(choices);
            return out;
        }
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("min", min);
        extra.put("max", max);
        JsonObject resp = ask("choose", message, serialize(choices), extra);
        for (int ix : readIntArray(resp, "choices")) {
            if (ix >= 0 && ix < choices.size()) out.add(choices.get(ix));
        }
        return out;
    }

    @Override
    public boolean confirm(CardView c, String question, boolean defaultIsYes, List<String> options) {
        JsonObject resp = ask("confirm", question, null, null);
        Boolean b = readBool(resp, "confirm");
        return b == null ? defaultIsYes : b;
    }

    @Override
    public boolean showConfirmDialog(String message, String title, String yesButtonText, String noButtonText, boolean defaultYes) {
        JsonObject resp = ask("confirm", title == null ? message : (title + "\n" + message), null, null);
        Boolean b = readBool(resp, "confirm");
        return b == null ? defaultYes : b;
    }

    @Override
    public int showOptionDialog(String message, String title, FSkinProp icon, List<String> options, int defaultOption) {
        if (options == null || options.isEmpty()) return defaultOption;
        JsonObject resp = ask("option", title == null ? message : (title + "\n" + message),
                serialize(options), null);
        Integer ix = readInt(resp, "choice");
        return (ix == null || ix < 0 || ix >= options.size()) ? defaultOption : ix;
    }

    @Override
    public String showInputDialog(String message, String title, FSkinProp icon, String initialInput,
                                  List<String> inputOptions, boolean isNumeric) {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("numeric", isNumeric);
        if (inputOptions != null) extra.put("options", serialize(inputOptions));
        JsonObject resp = ask("input", title == null ? message : (title + "\n" + message), null, extra);
        String s = readStr(resp, "value");
        return s == null ? initialInput : s;
    }

    @Override
    public Integer getInteger(String message, int min, int max, boolean sortDesc) { return askInteger(message, min, max); }
    @Override
    public Integer getInteger(String message, int min, int max, int cutoff) { return askInteger(message, min, max); }

    /** Ask the client for a number in [min,max]; default to min if unanswered. */
    private Integer askInteger(String message, int min, int max) {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("min", min);
        extra.put("max", max);
        JsonObject resp = ask("getInteger", message, null, extra);
        Integer v = readInt(resp, "value");
        if (v == null) return min;
        if (v < min) v = min;
        if (max >= min && v > max) v = max;
        return v;
    }

    @Override
    public Map<CardView, Integer> assignCombatDamage(CardView attacker, List<CardView> blockers, int damage,
                                                     GameEntityView defender, boolean overrideOrder, boolean maySkip) {
        Map<CardView, Integer> map = new LinkedHashMap<>();
        if (blockers == null || blockers.isEmpty()) { map.put(null, damage); return map; }
        // Trample (or "divide as you choose") lets excess spill onto the defender
        // — the player or planeswalker — but only after each blocker has lethal.
        boolean trample = attacker != null && attacker.getCurrentState() != null && attacker.getCurrentState().hasTrample();
        boolean canDefender = defender != null && (overrideOrder || trample);
        // Single blocker, fixed order, no trample spill: no choice to make.
        if (blockers.size() == 1 && !overrideOrder && !canDefender) { map.put(blockers.get(0), damage); return map; }
        // Options carry each blocker's lethal so the client can enforce the
        // assign-lethal-before-moving-on rule (unless overrideOrder = free split).
        List<Object> opts = new ArrayList<>();
        for (int i = 0; i < blockers.size(); i++) {
            CardView b = blockers.get(i);
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("index", i); o.put("id", b.getId()); o.put("label", b.getName());
            o.put("lethal", Math.max(0, b.getLethalDamage()));
            opts.add(o);
        }
        if (canDefender) {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("index", blockers.size()); o.put("id", -1); o.put("lethal", 0); o.put("isDefender", true);
            o.put("label", defender instanceof PlayerView pv ? pv.getName() : "Defender");
            opts.add(o);
        }
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("amount", damage);
        extra.put("maySkip", maySkip);
        extra.put("mode", "damage");
        extra.put("overrideOrder", overrideOrder);
        if (attacker != null) extra.put("sourceName", attacker.getName());
        JsonObject resp = ask("assignAmount", "Assign " + damage + " combat damage", opts, extra);
        List<Integer> amounts = readIntArray(resp, "amounts");
        int total = 0;
        if (amounts.size() == opts.size()) {
            for (int i = 0; i < opts.size(); i++) {
                int a = Math.max(0, amounts.get(i));
                if (i < blockers.size()) { if (a > 0) map.put(blockers.get(i), a); }
                else if (a > 0) map.put(null, a); // defender row (trample overflow)
                total += a;
            }
        }
        // Safety: the engine expects the full `damage` assigned. If the client's
        // split is invalid/absent, dump it all on the first blocker.
        if (total != damage) { map.clear(); map.put(blockers.get(0), damage); }
        return map;
    }

    @Override
    public Map<Object, Integer> assignGenericAmount(CardView effectSource, Map<Object, Integer> target,
                                                    int amount, boolean atLeastOne, String amountLabel) {
        Map<Object, Integer> result = new LinkedHashMap<>();
        if (target == null || target.isEmpty()) return result;
        List<Object> keys = new ArrayList<>(target.keySet());
        List<Object> opts = new ArrayList<>();
        for (int i = 0; i < keys.size(); i++) {
            Object k = keys.get(i);
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("index", i);
            o.put("id", k instanceof GameEntityView g ? g.getId() : null);
            o.put("label", labelOf(k));
            opts.add(o);
        }
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("amount", amount);
        extra.put("atLeastOne", atLeastOne);
        extra.put("mode", "amount");
        if (amountLabel != null) extra.put("label", amountLabel);
        JsonObject resp = ask("assignAmount", amountLabel != null ? amountLabel : ("Distribute " + amount), opts, extra);
        List<Integer> amts = readIntArray(resp, "amounts");
        int total = 0;
        if (amts.size() == keys.size()) {
            for (int i = 0; i < keys.size(); i++) { int a = Math.max(0, amts.get(i)); result.put(keys.get(i), a); total += a; }
        }
        if (total != amount) { result.clear(); for (Object k : keys) result.put(k, 0); result.put(keys.get(0), amount); }
        return result;
    }

    @Override
    public <T> forge.gui.interfaces.IGuiGame.OrderResult<T> order(String title, String top, int remainingObjectsMin,
            int remainingObjectsMax, List<T> sourceChoices, List<T> destChoices, CardView referenceCard,
            boolean sideboardingMode, boolean showRememberCheckbox) {
        List<T> pool = new ArrayList<>();
        if (destChoices != null) pool.addAll(destChoices);
        if (sourceChoices != null) pool.addAll(sourceChoices);
        int n = pool.size();
        // Forge frames this as how many objects must *remain* in the source; we
        // convert to how many *move* into the returned (ordered) list. -1 = no
        // bound on that side. Pure ordering (order triggers, arrange the top of
        // library) keeps every card, so movedMin==movedMax==n. A subset pick
        // (scry: which cards go to the bottom; surveil: which go to the yard)
        // lets the player choose a subset AND its order — a different UI.
        int movedMin = remainingObjectsMax >= 0 ? Math.max(0, n - remainingObjectsMax) : 0;
        int movedMax = remainingObjectsMin >= 0 ? Math.min(n, n - remainingObjectsMin) : n;
        boolean subset = movedMin < n || movedMax < n;
        if (n == 0 || (n == 1 && !subset)) return new forge.gui.interfaces.IGuiGame.OrderResult<>(pool, false);
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("min", movedMin);
        extra.put("max", movedMax);
        extra.put("subset", subset);
        if (top != null) extra.put("top", top);
        if (showRememberCheckbox) extra.put("remember", true);
        if (referenceCard != null) extra.put("cardId", referenceCard.getId());
        JsonObject resp = ask("order", title, serialize(pool), extra);
        List<Integer> idxs = readIntArray(resp, "order");
        List<T> result = subset ? pickByIndices(pool, idxs, movedMin, movedMax) : reorderByIndices(pool, idxs);
        Boolean remember = readBool(resp, "remember");
        return new forge.gui.interfaces.IGuiGame.OrderResult<>(result, remember != null && remember);
    }

    @Override
    public <T> List<T> insertInList(String title, T newItem, List<T> oldItems) {
        List<T> out = new ArrayList<>();
        if (oldItems != null) out.addAll(oldItems);
        if (out.isEmpty()) { out.add(newItem); return out; }
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("newItem", labelOf(newItem));
        JsonObject resp = ask("insert", title, serialize(oldItems), extra);
        Integer pos = readInt(resp, "position");
        int p = (pos == null || pos < 0 || pos > out.size()) ? 0 : pos;
        out.add(p, newItem);
        return out;
    }

    @Override
    public List<CardView> manipulateCardList(String title, Iterable<CardView> cards, Iterable<CardView> manipulable,
                                             boolean toTop, boolean toBottom, boolean toAnywhere) {
        List<CardView> list = new ArrayList<>();
        if (cards != null) for (CardView c : cards) list.add(c);
        if (list.size() <= 1) return list;
        java.util.Set<Integer> movable = new java.util.HashSet<>();
        if (manipulable != null) for (CardView c : manipulable) movable.add(c.getId());
        List<Object> opts = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            CardView c = list.get(i);
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("index", i); o.put("id", c.getId()); o.put("label", c.getName());
            o.put("movable", movable.contains(c.getId()));
            opts.add(o);
        }
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("toTop", toTop); extra.put("toBottom", toBottom); extra.put("toAnywhere", toAnywhere);
        JsonObject resp = ask("manipulate", title, opts, extra);
        return reorderByIndices(list, readIntArray(resp, "order"));
    }

    /** Pick a subset from the pool by client-supplied indices, in the given order
     *  (for scry/surveil/`many`: which cards move, ordered). Drops invalid/dup
     *  indices; if the result count falls outside [min,max], fall back to the
     *  first `min` cards so the engine still gets a legal answer. */
    private static <T> List<T> pickByIndices(List<T> pool, List<Integer> order, int min, int max) {
        List<T> out = new ArrayList<>();
        boolean[] used = new boolean[pool.size()];
        if (order != null) {
            for (int ix : order) if (ix >= 0 && ix < pool.size() && !used[ix]) { out.add(pool.get(ix)); used[ix] = true; }
        }
        if (out.size() < min || out.size() > max) {
            out.clear();
            for (int i = 0; i < min && i < pool.size(); i++) out.add(pool.get(i));
        }
        return out;
    }

    /** Rebuild a list from a client-supplied index order; keep original order if invalid. */
    private static <T> List<T> reorderByIndices(List<T> pool, List<Integer> order) {
        List<T> out = new ArrayList<>();
        if (order != null && order.size() == pool.size()) {
            boolean[] used = new boolean[pool.size()];
            for (int ix : order) { if (ix >= 0 && ix < pool.size() && !used[ix]) { out.add(pool.get(ix)); used[ix] = true; } }
        }
        if (out.size() != pool.size()) { out.clear(); out.addAll(pool); }
        return out;
    }

    @Override
    public void updateRevealedCards(TrackableCollection<CardView> collection) {
        if (collection == null || collection.isEmpty()) return;
        List<Object> opts = new ArrayList<>();
        int i = 0;
        for (CardView c : collection) {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("index", i++); o.put("id", c.getId()); o.put("label", c.getName());
            o.put("zone", c.getZone() == null ? null : c.getZone().toString().toLowerCase(java.util.Locale.ROOT));
            o.put("owner", c.getOwner() == null ? null : c.getOwner().getId());
            opts.add(o);
        }
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("kind", "reveal");
        msg.put("message", "Revealed cards");
        msg.put("options", opts);
        pushUi(msg);
    }

    @Override
    public List<PaperCard> sideboard(CardPool sideboard, CardPool main, String message) {
        return null; // no sideboarding
    }

    @Override
    public PlayerZoneUpdates openZones(PlayerView controller, Collection<ZoneType> zones,
                                       Map<PlayerView, Object> players, boolean backupLastZones) {
        return null;
    }

    @Override
    public void restoreOldZones(PlayerView playerView, PlayerZoneUpdates playerZoneUpdates) { }

    // ---------------------------------------------------------------------
    // Non-blocking UI-state pushes (so the board knows what's actionable)
    // ---------------------------------------------------------------------

    @Override
    public void showPromptMessage(PlayerView playerView, String message, CardView card) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", "message");
        m.put("message", message);
        pushUi(m);
    }

    @Override
    public void updateButtons(PlayerView owner, String label1, String label2, boolean enable1, boolean enable2, boolean focus1) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", "buttons");
        m.put("okLabel", label1);
        m.put("cancelLabel", label2);
        m.put("ok", enable1);
        m.put("cancel", enable2);
        m.put("focusOk", focus1);
        // The engine sets the mulligan flag (updateIsMulligan) right before pushing
        // these buttons, so reading it here is reliable — unlike the snapshot, which
        // is only re-broadcast on game events and can be stale during an input.
        try {
            forge.game.GameView gv = getGameView();
            if (gv != null) m.put("mulligan", gv.isMulligan());
        } catch (Throwable t) { /* optional */ }
        // Live mulligan count + max hand size, read now (not from the snapshot, whose
        // count lags because GameEventMulligan fires before the stat is incremented).
        // Drives the accurate "Mulligan to X" label.
        try {
            if (ownerPlayer != null) {
                m.put("mulliganCount", ownerPlayer.getStats().getMulliganCount());
                m.put("maxHandSize", ownerPlayer.getMaxHandSize());
                // Forge's authoritative "has any action other than pass" (excludes
                // pointless mana taps). Computed at priority before this push, so it's
                // fresh here. Drives reliable auto-pass.
                m.put("hasActions", ownerPlayer.getView().hasAvailableActions());
            }
        } catch (Throwable t) { /* optional */ }
        pushUi(m);
    }

    @Override
    public void setSelectables(Iterable<CardView> cards, int min, int max) {
        super.setSelectables(cards, min, max);
        pushSelectables("selectables", cards, min, max);
    }

    @Override
    public void clearSelectables() {
        super.clearSelectables();
        pushSelectables("selectables", java.util.Collections.emptyList(), 0, 0);
    }

    @Override
    public void setWeaklySelectable(Iterable<CardView> cards) {
        super.setWeaklySelectable(cards);
        pushSelectables("weaklySelectable", cards, 0, 0);
    }

    @Override
    public void clearWeaklySelectable() {
        super.clearWeaklySelectable();
        pushSelectables("weaklySelectable", java.util.Collections.emptyList(), 0, 0);
    }

    private void pushSelectables(String kind, Iterable<CardView> cards, int min, int max) {
        List<Integer> ids = new ArrayList<>();
        List<Object> info = new ArrayList<>();
        for (CardView c : cards) {
            ids.add(c.getId());
            // Carry identity + zone + owner so the UI can inject a selectable that
            // lives in a hidden zone (opponent hand, either library) into the right
            // place and light up that zone's button. Visible cards ignore this.
            Map<String, Object> ci = new LinkedHashMap<>();
            ci.put("id", c.getId());
            CardView.CardStateView st = c.getCurrentState();
            ci.put("name", st == null ? c.getName() : st.getName());
            ZoneType z = c.getZone();
            ci.put("zone", z == null ? null : z.toString().toLowerCase(java.util.Locale.ROOT));
            PlayerView ow = c.getOwner();
            ci.put("owner", ow == null ? null : ow.getId());
            info.add(ci);
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", kind);
        m.put("cards", ids);
        m.put("cardInfo", info);
        m.put("min", min);
        m.put("max", max);
        pushUi(m);
    }

    // Cards the engine asks us to highlight (e.g. the London-mulligan cards chosen
    // to bottom). Forge toggles them one at a time; we accumulate and push the full
    // set so the UI can show them selected (gold).
    private final java.util.Set<Integer> highlighted = new java.util.LinkedHashSet<>();

    @Override
    public void setHighlighted(Iterable<GameEntityView> entities, boolean b) {
        if (entities != null) {
            for (GameEntityView e : entities) {
                if (e == null) continue;
                if (b) highlighted.add(e.getId()); else highlighted.remove(e.getId());
            }
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", "highlighted");
        m.put("cards", new ArrayList<>(highlighted));
        pushUi(m);
    }

    // ---------------------------------------------------------------------
    // Display methods we don't need (we broadcast our own snapshots)
    // ---------------------------------------------------------------------

    @Override protected void updateCurrentPlayer(PlayerView player) { }
    @Override public void openView(TrackableCollection<PlayerView> myPlayers) { }
    @Override public void afterGameEnd() { }
    @Override public void showCombat() { }
    @Override public void flashIncorrectAction() { }
    @Override public void alertUser() { }
    @Override public void updatePhase(boolean saveState) { }
    @Override public void updateTurn(PlayerView player) { }
    @Override public void updatePlayerControl() { }
    @Override public void enableOverlay() { }
    @Override public void disableOverlay() { }
    @Override public void finishGame() { }
    @Override public void showManaPool(PlayerView player) { }
    @Override public void hideManaPool(PlayerView player) { }
    @Override public void updateStack() { }
    @Override public void notifyStackAddition(GameEventSpellAbilityCast event) { }
    @Override public void notifyStackRemoval(GameEventSpellRemovedFromStack event) { }
    @Override public void handleLandPlayed(CardView land) { }
    @Override public void handleGameEvent(GameEvent event) { }
    @Override public Iterable<PlayerZoneUpdate> tempShowZones(PlayerView controller, Iterable<PlayerZoneUpdate> zonesToUpdate) { return zonesToUpdate; }
    @Override public void hideZones(PlayerView controller, Iterable<PlayerZoneUpdate> zonesToUpdate) { }
    @Override public void updateZones(Iterable<PlayerZoneUpdate> zonesToUpdate) { }
    @Override public void updateCards(Iterable<CardView> cards) { }
    @Override public void updateManaPool(Iterable<PlayerView> manaPoolUpdate) { }
    @Override public void updateLives(Iterable<PlayerView> livesUpdate) { }
    @Override public void updateShards(Iterable<PlayerView> shardsUpdate) { }
    @Override public void updateDependencies() { }
    @Override public void setPanelSelection(CardView hostCard) { }
    @Override public void message(String message, String title) { }
    @Override public void showErrorDialog(String message, String title) { }
    @Override public GameState getGamestate() { return null; }
    @Override public void setCard(CardView card) { }
    @Override public void setPlayerAvatar(LobbyPlayer player, IHasIcon ihi) { }
    // Arena-style stops: which (turn-relative) steps this seat wants a priority
    // window at. A step not in the set is auto-passed server-side. Forge only
    // consults this when the stack is empty, so you never miss responding to a
    // spell/ability — you just don't stop at empty steps you didn't ask for.
    // Absent (no client config yet) → stop everywhere (safe legacy behavior).
    private static final Map<Integer, java.util.Set<String>> SEAT_STOPS = new java.util.concurrent.ConcurrentHashMap<>();
    public static void setStops(int seat, java.util.Set<String> stops) {
        if (stops == null) SEAT_STOPS.remove(seat); else SEAT_STOPS.put(seat, stops);
    }

    @Override
    public boolean isUiSetToSkipPhase(PlayerView playerTurn, PhaseType phase) {
        java.util.Set<String> stops = SEAT_STOPS.get(seat);
        if (stops == null || phase == null) return false; // no config → never skip
        boolean myTurn = ownerPlayer != null && ownerPlayer.getView() != null
                && playerTurn != null && ownerPlayer.getView().getId() == playerTurn.getId();
        // First-strike damage shares the "Combat Damage" stop toggle.
        PhaseType p = phase == PhaseType.COMBAT_FIRST_STRIKE_DAMAGE ? PhaseType.COMBAT_DAMAGE : phase;
        String key = (myTurn ? "my:" : "opp:") + p.name();
        return !stops.contains(key); // skip (auto-pass) unless a stop is set here
    }
    @Override public void showWaitingTimer(PlayerView forPlayer, String waitingForPlayerName) { }
    @Override public void applyDelta(DeltaPacket packet) { }
}
