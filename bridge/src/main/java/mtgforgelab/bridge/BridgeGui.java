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
import forge.ai.GameState;
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
    public Map<CardView, Integer> assignCombatDamage(CardView attacker, List<CardView> blockers, int damage,
                                                     GameEntityView defender, boolean overrideOrder, boolean maySkip) {
        // First cut: assign all damage to the first blocker (legal), or to the
        // defender (null key) if there are no blockers. Interactive ordering is a
        // future prompt kind (DESIGN.md §11.5).
        Map<CardView, Integer> map = new LinkedHashMap<>();
        if (blockers != null && !blockers.isEmpty()) {
            map.put(blockers.get(0), damage);
        } else {
            map.put(null, damage);
        }
        return map;
    }

    @Override
    public Map<Object, Integer> assignGenericAmount(CardView effectSource, Map<Object, Integer> target,
                                                    int amount, boolean atLeastOne, String amountLabel) {
        // First cut: put the whole amount on the first candidate.
        Map<Object, Integer> result = new LinkedHashMap<>();
        if (target != null && !target.isEmpty()) {
            result.put(target.keySet().iterator().next(), amount);
        }
        return result;
    }

    @Override
    public <T> forge.gui.interfaces.IGuiGame.OrderResult<T> order(String title, String top, int remainingObjectsMin,
            int remainingObjectsMax, List<T> sourceChoices, List<T> destChoices, CardView referenceCard,
            boolean sideboardingMode, boolean showRememberCheckbox) {
        // First cut: keep the given order (no reordering UI yet).
        List<T> ordered = new ArrayList<>();
        if (destChoices != null) ordered.addAll(destChoices);
        if (sourceChoices != null) ordered.addAll(sourceChoices);
        return new forge.gui.interfaces.IGuiGame.OrderResult<>(ordered, false);
    }

    @Override
    public <T> List<T> insertInList(String title, T newItem, List<T> oldItems) {
        List<T> out = new ArrayList<>();
        out.add(newItem);
        if (oldItems != null) out.addAll(oldItems);
        return out;
    }

    @Override
    public List<CardView> manipulateCardList(String title, Iterable<CardView> cards, Iterable<CardView> manipulable,
                                             boolean toTop, boolean toBottom, boolean toAnywhere) {
        // Not used in the common path; return the cards unchanged.
        List<CardView> out = new ArrayList<>();
        if (cards != null) for (CardView c : cards) out.add(c);
        return out;
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
    @Override public boolean isUiSetToSkipPhase(PlayerView playerTurn, PhaseType phase) { return false; }
    @Override public void showWaitingTimer(PlayerView forPlayer, String waitingForPlayerName) { }
    @Override public void applyDelta(DeltaPacket packet) { }
}
