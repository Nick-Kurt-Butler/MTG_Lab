package mtgforgelab.bridge;

import java.util.Map;

/**
 * Tiny, dependency-free JSON writer. Serializes nested {@link Map} / {@link Iterable}
 * / String / Number / Boolean / null structures into a JSON string. Map keys are
 * stringified. This keeps the bridge self-contained (no Gson/Jackson on the
 * classpath required) and avoids hand-managed comma bugs by walking the structure.
 */
public final class Json {

    public static String write(Object o) {
        StringBuilder sb = new StringBuilder();
        write(o, sb);
        return sb.toString();
    }

    private static void write(Object o, StringBuilder sb) {
        if (o == null) {
            sb.append("null");
        } else if (o instanceof String s) {
            string(s, sb);
        } else if (o instanceof Boolean || o instanceof Number) {
            sb.append(o.toString());
        } else if (o instanceof Map<?, ?> m) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                string(String.valueOf(e.getKey()), sb);
                sb.append(':');
                write(e.getValue(), sb);
            }
            sb.append('}');
        } else if (o instanceof Iterable<?> it) {
            sb.append('[');
            boolean first = true;
            for (Object x : it) {
                if (!first) sb.append(',');
                first = false;
                write(x, sb);
            }
            sb.append(']');
        } else {
            string(o.toString(), sb);
        }
    }

    private static void string(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    private Json() {}
}
