package mtgforgelab.bridge;

import com.google.common.eventbus.Subscribe;

import forge.game.Game;
import forge.game.event.GameEvent;

/**
 * Subscribes to a {@link Game}'s Guava event bus and, on every game event,
 * serializes the current {@link forge.game.GameView} to JSON and broadcasts it
 * to all connected clients. The trackable view always reflects current engine
 * state, so re-reading it per event yields a correct full snapshot.
 *
 * (Full snapshots per event are fine for proving the pipe; delta-sync /
 * throttling is a later optimization.)
 */
public final class SnapshotBroadcaster {

    private final Game game;
    private final GameServer server;
    private final int gen;

    public SnapshotBroadcaster(Game game, GameServer server, int gen) {
        this.game = game;
        this.server = server;
        this.gen = gen;
    }

    @Subscribe
    public void onGameEvent(GameEvent event) {
        if (!BridgeMain.isLiveGen(gen)) return; // superseded game: stop broadcasting
        try {
            server.broadcastPerSeat(seat -> Json.write(ViewSerializer.snapshot(game, seat)));
        } catch (Exception e) {
            // Never let a serialization hiccup break the engine thread.
            System.err.println("[bridge] snapshot error: " + e);
        }
    }
}
