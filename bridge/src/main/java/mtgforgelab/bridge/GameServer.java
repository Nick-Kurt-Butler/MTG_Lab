package mtgforgelab.bridge;

import java.net.InetSocketAddress;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.IntFunction;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

/**
 * Embedded WebSocket server — our own local/WLAN transport (we deliberately do
 * not use Forge's networking). Binds to 0.0.0.0 so a WLAN peer can connect to
 * the host machine's IP.
 *
 * Seating: there are {@code humanSeats} human seats (1 for local-vs-AI, 2 for
 * WLAN 1v1). Each connecting client is assigned the lowest free human seat, or
 * spectator (seat -1) once all are taken. Each client is told its seat via a
 * {@code welcome} message. Snapshots are sent per seat ({@link #broadcastPerSeat})
 * and decisions are routed to a single seat ({@link #sendToSeat}) so a client
 * never receives another seat's hidden information.
 *
 * The game starts (via {@code onReady}) once all human seats are filled.
 */
public final class GameServer extends WebSocketServer {

    public static final int SPECTATOR = -1;

    /** Handles raw text messages from a client (responses / control). */
    public interface ClientMessageHandler {
        void onMessage(WebSocket conn, String message);
    }

    private final AtomicBoolean started = new AtomicBoolean(false);
    private volatile Runnable onReady;
    private volatile ClientMessageHandler messageHandler;
    private volatile int humanSeats = 1;
    private final Map<WebSocket, Integer> seats = new ConcurrentHashMap<>();
    private final Map<Integer, String> seatDeckNames = new ConcurrentHashMap<>();
    private volatile String lanIp = computeLanIp();

    /** Register the deck name a seat has chosen (shown in the WLAN lobby). */
    public void setSeatDeckName(int seat, String name) {
        if (seat >= 0 && name != null) seatDeckNames.put(seat, name);
    }
    /** Re-broadcast lobby state (e.g. after a seat picks its deck). */
    public void announceLobby() { broadcastLobby(); }

    public GameServer(InetSocketAddress address) {
        super(address);
        setReuseAddr(true);
    }

    public void setOnReady(Runnable r) { this.onReady = r; }
    public void setMessageHandler(ClientMessageHandler h) { this.messageHandler = h; }
    public void setHumanSeats(int n) { this.humanSeats = n; }

    @Override
    public synchronized void onOpen(WebSocket conn, ClientHandshake handshake) {
        int seat = lowestFreeSeat();
        seats.put(conn, seat);
        System.err.println("[bridge] client connected: " + conn.getRemoteSocketAddress() + " seat=" + seat);

        Map<String, Object> welcome = new LinkedHashMap<>();
        welcome.put("type", "welcome");
        welcome.put("seat", seat);
        welcome.put("humanSeats", humanSeats);
        conn.send(Json.write(welcome));
        broadcastLobby();

        // Start once every human seat is occupied.
        if (filledHumanSeats() >= humanSeats && started.compareAndSet(false, true) && onReady != null) {
            new Thread(onReady, "forge-game").start();
        }
    }

    /** Tell every client which human seats are currently filled (drives the WLAN lobby). */
    private void broadcastLobby() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "lobby");
        m.put("humanSeats", humanSeats);
        List<Boolean> filled = new ArrayList<>();
        List<String> deckNames = new ArrayList<>();
        for (int s = 0; s < humanSeats; s++) {
            filled.add(seats.containsValue(s));
            deckNames.add(seatDeckNames.get(s)); // null if not chosen yet
        }
        m.put("filled", filled);
        m.put("deckNames", deckNames);
        if (lanIp != null) m.put("ip", lanIp);
        broadcast(Json.write(m));
    }

    /** Best-effort LAN IPv4 of this host, so the WLAN host can share it. */
    private static String computeLanIp() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (ni.isLoopback() || !ni.isUp() || ni.isVirtual()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) return a.getHostAddress();
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    private int lowestFreeSeat() {
        for (int s = 0; s < humanSeats; s++) {
            if (!seats.containsValue(s)) return s;
        }
        return SPECTATOR;
    }

    private int filledHumanSeats() {
        int n = 0;
        for (int s = 0; s < humanSeats; s++) {
            if (seats.containsValue(s)) n++;
        }
        return n;
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        Integer seat = seats.remove(conn);
        if (seat != null) seatDeckNames.remove(seat);
        System.err.println("[bridge] client disconnected (" + code + "): " + reason);
        broadcastLobby();
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        ClientMessageHandler h = messageHandler;
        if (h != null) h.onMessage(conn, message);
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        System.err.println("[bridge] websocket error: " + ex);
    }

    @Override
    public void onStart() {
        System.err.println("[bridge] websocket server listening on " + getAddress());
    }

    /** Send each connected client a message built for its seat (built once per seat). */
    public void broadcastPerSeat(IntFunction<String> builder) {
        Map<Integer, String> cache = new HashMap<>();
        for (WebSocket conn : getConnections()) {
            if (!conn.isOpen()) continue;
            int seat = seats.getOrDefault(conn, SPECTATOR);
            String msg = cache.computeIfAbsent(seat, builder::apply);
            conn.send(msg);
        }
    }

    /** Send a message only to the connection(s) holding the given seat. */
    public void sendToSeat(int seat, String msg) {
        for (WebSocket conn : getConnections()) {
            if (conn.isOpen() && seats.getOrDefault(conn, SPECTATOR) == seat) {
                conn.send(msg);
            }
        }
    }

    /** Send a message to every connected client (used for simulator progress). */
    public void broadcast(String msg) {
        for (WebSocket conn : getConnections()) {
            if (conn.isOpen()) conn.send(msg);
        }
    }

    /** The seat assigned to a given connection, or {@link #SPECTATOR} if unknown. */
    public int seatOf(WebSocket conn) {
        return seats.getOrDefault(conn, SPECTATOR);
    }
}
