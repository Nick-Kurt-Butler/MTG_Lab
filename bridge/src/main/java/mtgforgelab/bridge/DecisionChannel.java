package mtgforgelab.bridge;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Bridges the (blocking) Forge game thread to the (async) WebSocket clients.
 *
 * When a {@link PlayerControllerBridge} needs a player decision, it calls
 * {@link #ask}: a {@code decision} message is broadcast with a unique id, and
 * the game thread blocks until a matching {@code response} arrives from a client
 * (delivered on a WebSocket thread via {@link #onClientMessage}). If no response
 * arrives within the timeout, {@code ask} returns null and the caller falls back
 * to the AI.
 */
public final class DecisionChannel {

    private static final long RESPONSE_TIMEOUT_SECONDS = 300;

    private final GameServer server;
    private final AtomicLong nextId = new AtomicLong(1);
    private final Map<Long, LinkedBlockingQueue<JsonObject>> pending = new ConcurrentHashMap<>();

    public DecisionChannel(GameServer server) {
        this.server = server;
    }

    /** Invoked on a WebSocket thread for every inbound client text message. */
    public void onClientMessage(String raw) {
        try {
            JsonObject m = JsonParser.parseString(raw).getAsJsonObject();
            String type = m.has("type") ? m.get("type").getAsString() : "";
            if ("response".equals(type) && m.has("id")) {
                LinkedBlockingQueue<JsonObject> q = pending.get(m.get("id").getAsLong());
                if (q != null) q.offer(m);
            }
        } catch (Exception e) {
            System.err.println("[bridge] ignoring bad client message: " + e);
        }
    }

    /**
     * Send a decision to the given seat's client and block the calling (game)
     * thread until a response with the matching id arrives. Returns null on
     * timeout.
     */
    public JsonObject ask(int seat, Map<String, Object> decision) {
        long id = nextId.getAndIncrement();
        decision.put("type", "prompt");
        decision.put("id", id);

        LinkedBlockingQueue<JsonObject> q = new LinkedBlockingQueue<>();
        pending.put(id, q);
        try {
            server.sendToSeat(seat, Json.write(decision));
            return q.poll(RESPONSE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } finally {
            pending.remove(id);
        }
    }
}
