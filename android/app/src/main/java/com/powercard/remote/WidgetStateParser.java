package com.powercard.remote;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Java 版设备状态解析器（桌面小组件使用：小组件没有 WebView，不能复用 JS）。
 *
 * <p>行为与 {@code public/shared/parser.js} 的 {@code parseStatusResponse} 对齐：
 * <ol>
 *   <li>手动字段路径优先（{@code powerField} / {@code onlineField}，支持 {@code data.power}、{@code items.0.state}）；</li>
 *   <li>JSON 自动识别：广度优先递归（深度 ≤ 5），按候选键名优先级与出现顺序选择；</li>
 *   <li>纯文本 / HTML：key=value 行、整体词元、关键词兜底；</li>
 *   <li>API 信封保护：同时含 msg/message 与 data/result 的响应里，{@code status:0} 是接口状态码，不当电源值；</li>
 *   <li>在线推断：解析不到在线字段时“能访问即在线”，并标记 onlineInferred。</li>
 * </ol>
 *
 * <p>安全原则：无法明确映射时一律忽略，不猜测；HTML 同时出现“开机”“关机”时电源状态保持 unknown。</p>
 */
public final class WidgetStateParser {

    public static final String POWER_ON = "on";
    public static final String POWER_OFF = "off";
    public static final String POWER_UNKNOWN = "unknown";

    public static final String UNKNOWN_POWER_WARNING =
            "已连接，但无法识别电源状态；请在调试中指定字段或查看原始响应";

    private static final int MAX_JSON_DEPTH = 5;

    /** 电源候选键名 → 优先级（3 = 语义明确，1 = 泛化字段，只在值能明确映射时采用）。 */
    private static final Map<String, Integer> POWER_KEYS = new HashMap<>();
    /** 在线候选键名 → 优先级。 */
    private static final Map<String, Integer> ONLINE_KEYS = new HashMap<>();

    private static final Set<String> POWER_ON_VALUES = new HashSet<>();
    private static final Set<String> POWER_OFF_VALUES = new HashSet<>();
    private static final Set<String> ONLINE_ON_VALUES = new HashSet<>();
    private static final Set<String> ONLINE_OFF_VALUES = new HashSet<>();

    private static final Map<String, String> POWER_TEXT_VALUES = new HashMap<>();
    private static final Map<String, Boolean> ONLINE_TEXT_VALUES = new HashMap<>();

    private static final Pattern NORMALIZE_KEY = Pattern.compile("[\\s_\\-]+");
    private static final Pattern KEY_VALUE_LINE = Pattern.compile(
            "^\\s*([A-Za-z][A-Za-z0-9 _\\-.]{0,48})\\s*[=:]\\s*(.+?)\\s*$");
    private static final Pattern POWER_ON_KEYWORD = Pattern.compile("已开机|开机(?!卡)|运行中|正在运行");
    private static final Pattern POWER_OFF_KEYWORD = Pattern.compile("已关机|关机(?!卡)");
    private static final Pattern ONLINE_KEYWORD = Pattern.compile("在线|\\bonline\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern OFFLINE_KEYWORD = Pattern.compile("离线|\\boffline\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern HTML_HINT = Pattern.compile(
            "<\\s*(!doctype|html|head|body|div|table|p|span|h[1-6]|button|section)\\b",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern HTML_COMMENT = Pattern.compile("<!--[\\s\\S]*?-->");
    private static final Pattern HTML_SCRIPT = Pattern.compile("<(script|style)\\b[\\s\\S]*?</\\1>",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern HTML_BR = Pattern.compile("<br\\s*/?>", Pattern.CASE_INSENSITIVE);
    private static final Pattern HTML_BLOCK_END = Pattern.compile(
            "</(p|div|tr|li|h[1-6]|section|table|article|header|footer|button)>",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern HTML_TAG = Pattern.compile("<[^>]*>");
    private static final Pattern ENTITY_HEX = Pattern.compile("&#x([0-9a-f]+);", Pattern.CASE_INSENSITIVE);
    private static final Pattern ENTITY_DEC = Pattern.compile("&#(\\d+);");
    private static final Pattern ENTITY_NAMED = Pattern.compile("&([a-z]+);", Pattern.CASE_INSENSITIVE);
    private static final Pattern ENTITY_AMP = Pattern.compile("&amp;", Pattern.CASE_INSENSITIVE);
    private static final Pattern ARRAY_INDEX = Pattern.compile("\\d+");

    static {
        POWER_KEYS.put("power", 3);
        POWER_KEYS.put("powerstate", 3);
        POWER_KEYS.put("powerstatus", 3);
        POWER_KEYS.put("pcpower", 3);
        POWER_KEYS.put("pcstatus", 3);
        POWER_KEYS.put("pcstate", 3);
        POWER_KEYS.put("computerstatus", 3);
        POWER_KEYS.put("onoff", 3);
        POWER_KEYS.put("running", 2);
        POWER_KEYS.put("state", 1);
        POWER_KEYS.put("status", 1);
        POWER_KEYS.put("switch", 1);

        ONLINE_KEYS.put("online", 3);
        ONLINE_KEYS.put("onlinestatus", 3);
        ONLINE_KEYS.put("cardonline", 3);
        ONLINE_KEYS.put("isonline", 3);
        ONLINE_KEYS.put("deviceonline", 3);
        ONLINE_KEYS.put("connected", 3);
        ONLINE_KEYS.put("connect", 2);
        ONLINE_KEYS.put("link", 2);
        ONLINE_KEYS.put("wifi", 2);
        ONLINE_KEYS.put("networkstatus", 2);

        addAll(POWER_ON_VALUES, "true", "1", "on", "open", "开机", "已开机", "运行", "running", "up", "started");
        addAll(POWER_OFF_VALUES, "false", "0", "off", "close", "关机", "已关机", "停止", "stopped", "down");
        addAll(ONLINE_ON_VALUES, "true", "1", "on", "online", "在线", "connected", "ok");
        addAll(ONLINE_OFF_VALUES, "false", "0", "off", "offline", "离线", "disconnected", "error");

        POWER_TEXT_VALUES.put("on", POWER_ON);
        POWER_TEXT_VALUES.put("open", POWER_ON);
        POWER_TEXT_VALUES.put("开机", POWER_ON);
        POWER_TEXT_VALUES.put("已开机", POWER_ON);
        POWER_TEXT_VALUES.put("运行", POWER_ON);
        POWER_TEXT_VALUES.put("running", POWER_ON);
        POWER_TEXT_VALUES.put("up", POWER_ON);
        POWER_TEXT_VALUES.put("started", POWER_ON);
        POWER_TEXT_VALUES.put("off", POWER_OFF);
        POWER_TEXT_VALUES.put("close", POWER_OFF);
        POWER_TEXT_VALUES.put("关机", POWER_OFF);
        POWER_TEXT_VALUES.put("已关机", POWER_OFF);
        POWER_TEXT_VALUES.put("停止", POWER_OFF);
        POWER_TEXT_VALUES.put("stopped", POWER_OFF);
        POWER_TEXT_VALUES.put("down", POWER_OFF);

        ONLINE_TEXT_VALUES.put("online", Boolean.TRUE);
        ONLINE_TEXT_VALUES.put("在线", Boolean.TRUE);
        ONLINE_TEXT_VALUES.put("connected", Boolean.TRUE);
        ONLINE_TEXT_VALUES.put("ok", Boolean.TRUE);
        ONLINE_TEXT_VALUES.put("offline", Boolean.FALSE);
        ONLINE_TEXT_VALUES.put("离线", Boolean.FALSE);
        ONLINE_TEXT_VALUES.put("disconnected", Boolean.FALSE);
        ONLINE_TEXT_VALUES.put("error", Boolean.FALSE);
    }

    private WidgetStateParser() {
    }

    /** 解析结果（字段语义与 JS 版 parseStatusResponse 一致）。 */
    public static final class Result {
        public final String power;
        public final boolean online;
        public final boolean onlineInferred;
        public final String powerField;
        public final String onlineField;
        public final String warning;

        Result(String power, boolean online, boolean onlineInferred,
               String powerField, String onlineField, String warning) {
            this.power = power;
            this.online = online;
            this.onlineInferred = onlineInferred;
            this.powerField = powerField;
            this.onlineField = onlineField;
            this.warning = warning;
        }

        public boolean hasMapping() {
            return powerField != null || onlineField != null;
        }
    }

    /**
     * 解析一次成功的设备状态响应。
     *
     * @param text        设备返回的原始文本
     * @param contentType HTTP content-type（可空）
     * @param powerField  手动电源字段路径，空 = 自动
     * @param onlineField 手动在线字段路径，空 = 自动
     */
    public static Result parse(String text, String contentType, String powerField, String onlineField) {
        String rawText = text == null ? "" : text;
        String trimmed = rawText.trim();
        String contentTypeSafe = contentType == null ? "" : contentType;

        Object json = null;
        boolean jsonHint = contentTypeSafe.toLowerCase(Locale.ROOT).contains("json")
                || trimmed.startsWith("[")
                || trimmed.startsWith("{");
        if (jsonHint) {
            try {
                Object parsed = new JSONTokener(trimmed).nextValue();
                if (parsed instanceof JSONObject || parsed instanceof JSONArray) {
                    json = parsed;
                }
            } catch (Throwable ignored) {
                json = null;
            }
        }

        String power = POWER_UNKNOWN;
        Boolean online = null;
        String powerPath = null;
        String onlinePath = null;

        if (json != null) {
            if (powerField != null && !powerField.trim().isEmpty()) {
                String mapped = mapPowerValue(resolveFieldPath(json, powerField));
                if (mapped != null) {
                    power = mapped;
                    powerPath = powerField.trim();
                }
            }
            if (onlineField != null && !onlineField.trim().isEmpty()) {
                Boolean mapped = mapOnlineValue(resolveFieldPath(json, onlineField));
                if (mapped != null) {
                    online = mapped;
                    onlinePath = onlineField.trim();
                }
            }

            List<Candidate> candidates = collectCandidates(json);
            if (POWER_UNKNOWN.equals(power)) {
                PowerPick picked = pickPowerCandidate(candidates);
                if (picked != null) {
                    power = picked.mapped;
                    powerPath = picked.path;
                }
            }
            if (online == null) {
                OnlinePick picked = pickOnlineCandidate(candidates);
                if (picked != null) {
                    online = picked.mapped;
                    onlinePath = picked.path;
                }
            }
        } else {
            TextStatus parsed = parseTextStatus(rawText, contentTypeSafe);
            power = parsed.power == null ? POWER_UNKNOWN : parsed.power;
            online = parsed.online;
            powerPath = parsed.powerPath;
            onlinePath = parsed.onlinePath;
        }

        boolean onlineInferred = online == null;
        boolean resolvedOnline = onlineInferred ? true : online;
        String warning = POWER_UNKNOWN.equals(power) ? UNKNOWN_POWER_WARNING : null;
        return new Result(power, resolvedOnline, onlineInferred, powerPath, onlinePath, warning);
    }

    /** 键名归一化：小写并去掉下划线、连字符与空白（"Power State" → "powerstate"）。 */
    public static String normalizeKey(String key) {
        if (key == null) {
            return "";
        }
        return NORMALIZE_KEY.matcher(key.toLowerCase(Locale.ROOT)).replaceAll("");
    }

    /** 把设备返回值映射为电源状态；无法明确映射时返回 null。 */
    public static String mapPowerValue(Object value) {
        if (value instanceof Boolean) {
            return ((Boolean) value) ? POWER_ON : POWER_OFF;
        }
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (number == 1.0d) {
                return POWER_ON;
            }
            if (number == 0.0d) {
                return POWER_OFF;
            }
            return null;
        }
        if (!(value instanceof String)) {
            return null;
        }
        String token = ((String) value).trim().toLowerCase(Locale.ROOT);
        if (token.isEmpty()) {
            return null;
        }
        if (POWER_ON_VALUES.contains(token)) {
            return POWER_ON;
        }
        if (POWER_OFF_VALUES.contains(token)) {
            return POWER_OFF;
        }
        return null;
    }

    /** 把设备返回值映射为在线状态；无法明确映射时返回 null。 */
    public static Boolean mapOnlineValue(Object value) {
        if (value instanceof Boolean) {
            return (Boolean) value;
        }
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (number == 1.0d) {
                return Boolean.TRUE;
            }
            if (number == 0.0d) {
                return Boolean.FALSE;
            }
            return null;
        }
        if (!(value instanceof String)) {
            return null;
        }
        String token = ((String) value).trim().toLowerCase(Locale.ROOT);
        if (token.isEmpty()) {
            return null;
        }
        if (ONLINE_ON_VALUES.contains(token)) {
            return Boolean.TRUE;
        }
        if (ONLINE_OFF_VALUES.contains(token)) {
            return Boolean.FALSE;
        }
        return null;
    }

    /** 解析点路径，支持数组下标：data.power、items.0.state；未命中返回 null。 */
    public static Object resolveFieldPath(Object root, String dottedPath) {
        if (dottedPath == null) {
            return null;
        }
        String path = dottedPath.trim();
        if (path.isEmpty()) {
            return null;
        }
        Object current = root;
        for (String part : path.split("\\.", -1)) {
            if (current == null) {
                return null;
            }
            if (current instanceof JSONArray) {
                if (!ARRAY_INDEX.matcher(part).matches()) {
                    return null;
                }
                JSONArray array = (JSONArray) current;
                int index = Integer.parseInt(part);
                if (index >= array.length()) {
                    return null;
                }
                current = jsonValue(array.opt(index));
            } else if (current instanceof JSONObject) {
                JSONObject object = (JSONObject) current;
                if (!object.has(part)) {
                    return null;
                }
                current = jsonValue(object.opt(part));
            } else {
                return null;
            }
            if (current == null) {
                return null;
            }
        }
        return current;
    }

    /** 电源状态对应的中文文案（与 docs/api-contract.md 第 5 节一致）。 */
    public static String powerLabel(String power) {
        if (POWER_ON.equals(power)) {
            return "电脑已开机";
        }
        if (POWER_OFF.equals(power)) {
            return "电脑已关机";
        }
        return "状态未知";
    }

    /* ---------------------------------------------------------------------
       JSON 自动识别
       --------------------------------------------------------------------- */

    private static final class Node {
        final Object node;
        final String path;
        final int depth;

        Node(Object node, String path, int depth) {
            this.node = node;
            this.path = path;
            this.depth = depth;
        }
    }

    private static final class Candidate {
        final boolean power;
        final String path;
        final Object value;
        final int priority;
        final int order;

        Candidate(boolean power, String path, Object value, int priority, int order) {
            this.power = power;
            this.path = path;
            this.value = value;
            this.priority = priority;
            this.order = order;
        }
    }

    private static final class PowerPick {
        final String mapped;
        final String path;

        PowerPick(String mapped, String path) {
            this.mapped = mapped;
            this.path = path;
        }
    }

    private static final class OnlinePick {
        final Boolean mapped;
        final String path;

        OnlinePick(Boolean mapped, String path) {
            this.mapped = mapped;
            this.path = path;
        }
    }

    private static Object jsonValue(Object value) {
        return value == JSONObject.NULL ? null : value;
    }

    private static boolean looksLikeApiEnvelope(JSONObject node) {
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = node.keys();
        while (iterator.hasNext()) {
            keys.add(normalizeKey(iterator.next()));
        }
        boolean hasMessage = keys.contains("msg") || keys.contains("message");
        boolean hasPayload = keys.contains("data") || keys.contains("result");
        return hasMessage && hasPayload;
    }

    private static List<Candidate> collectCandidates(Object root) {
        List<Candidate> candidates = new ArrayList<>();
        ArrayDeque<Node> queue = new ArrayDeque<>();
        queue.add(new Node(root, "", 0));
        int order = 0;

        while (!queue.isEmpty()) {
            Node current = queue.poll();
            if (current.depth >= MAX_JSON_DEPTH) {
                continue;
            }
            if (current.node instanceof JSONArray) {
                JSONArray array = (JSONArray) current.node;
                for (int index = 0; index < array.length(); index += 1) {
                    queue.add(new Node(
                            jsonValue(array.opt(index)),
                            current.path.isEmpty() ? String.valueOf(index) : current.path + "." + index,
                            current.depth + 1));
                }
                continue;
            }
            if (!(current.node instanceof JSONObject)) {
                continue;
            }
            JSONObject object = (JSONObject) current.node;
            boolean envelope = looksLikeApiEnvelope(object);
            Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) {
                String key = iterator.next();
                Object value = jsonValue(object.opt(key));
                String childPath = current.path.isEmpty() ? key : current.path + "." + key;
                String normalized = normalizeKey(key);

                Integer powerPriority = POWER_KEYS.get(normalized);
                if (powerPriority != null) {
                    // 泛化键（state/status/switch）在 API 信封里大概率是接口状态码；
                    // 只有字符串这类语义明确的值才采用，数字/布尔一律跳过。
                    boolean ambiguousEnvelopeCode = envelope && powerPriority < 2 && !(value instanceof String);
                    if (!ambiguousEnvelopeCode) {
                        candidates.add(new Candidate(true, childPath, value, powerPriority, order));
                        order += 1;
                    }
                }
                Integer onlinePriority = ONLINE_KEYS.get(normalized);
                if (onlinePriority != null) {
                    candidates.add(new Candidate(false, childPath, value, onlinePriority, order));
                    order += 1;
                }
                if (value instanceof JSONObject || value instanceof JSONArray) {
                    queue.add(new Node(value, childPath, current.depth + 1));
                }
            }
        }
        return candidates;
    }

    private static PowerPick pickPowerCandidate(List<Candidate> candidates) {
        Candidate best = null;
        String bestMapped = null;
        for (Candidate candidate : candidates) {
            if (!candidate.power) {
                continue;
            }
            String mapped = mapPowerValue(candidate.value);
            if (mapped == null) {
                continue;
            }
            if (best == null
                    || candidate.priority > best.priority
                    || (candidate.priority == best.priority && candidate.order < best.order)) {
                best = candidate;
                bestMapped = mapped;
            }
        }
        return best == null ? null : new PowerPick(bestMapped, best.path);
    }

    private static OnlinePick pickOnlineCandidate(List<Candidate> candidates) {
        Candidate best = null;
        Boolean bestMapped = null;
        for (Candidate candidate : candidates) {
            if (candidate.power) {
                continue;
            }
            Boolean mapped = mapOnlineValue(candidate.value);
            if (mapped == null) {
                continue;
            }
            if (best == null
                    || candidate.priority > best.priority
                    || (candidate.priority == best.priority && candidate.order < best.order)) {
                best = candidate;
                bestMapped = mapped;
            }
        }
        return best == null ? null : new OnlinePick(bestMapped, best.path);
    }

    /* ---------------------------------------------------------------------
       纯文本 / HTML
       --------------------------------------------------------------------- */

    private static final class TextStatus {
        String power;
        Boolean online;
        String powerPath;
        String onlinePath;
    }

    private static boolean looksLikeHtml(String rawText, String contentType) {
        if (contentType != null && contentType.toLowerCase(Locale.ROOT).contains("html")) {
            return true;
        }
        return rawText != null && HTML_HINT.matcher(rawText).find();
    }

    private static String stripHtmlTags(String html) {
        String output = HTML_COMMENT.matcher(html).replaceAll(" ");
        output = HTML_SCRIPT.matcher(output).replaceAll(" ");
        output = HTML_BR.matcher(output).replaceAll("\n");
        output = HTML_BLOCK_END.matcher(output).replaceAll("\n");
        output = HTML_TAG.matcher(output).replaceAll(" ");
        return output;
    }

    private static String decodeEntities(String text) {
        String output = replaceDecoded(text, ENTITY_HEX, new Decoder() {
            @Override
            public String decode(Matcher match) {
                int code = Integer.parseInt(match.group(1), 16);
                return new String(Character.toChars(code));
            }
        });
        output = replaceDecoded(output, ENTITY_DEC, new Decoder() {
            @Override
            public String decode(Matcher match) {
                int code = Integer.parseInt(match.group(1));
                return new String(Character.toChars(code));
            }
        });
        output = replaceDecoded(output, ENTITY_NAMED, new Decoder() {
            @Override
            public String decode(Matcher match) {
                String key = match.group(1).toLowerCase(Locale.ROOT);
                switch (key) {
                    case "nbsp":
                        return " ";
                    case "lt":
                        return "<";
                    case "gt":
                        return ">";
                    case "quot":
                        return "\"";
                    case "apos":
                        return "'";
                    default:
                        return match.group(0);
                }
            }
        });
        return ENTITY_AMP.matcher(output).replaceAll("&");
    }

    private interface Decoder {
        String decode(Matcher match);
    }

    private static String replaceDecoded(String input, Pattern pattern, Decoder decoder) {
        Matcher matcher = pattern.matcher(input);
        StringBuilder builder = new StringBuilder(input.length());
        int last = 0;
        while (matcher.find()) {
            builder.append(input, last, matcher.start());
            try {
                builder.append(decoder.decode(matcher));
            } catch (Throwable ignored) {
                builder.append(matcher.group(0));
            }
            last = matcher.end();
        }
        builder.append(input, last, input.length());
        return builder.toString();
    }

    private static TextStatus parseTextStatus(String rawText, String contentType) {
        String text = looksLikeHtml(rawText, contentType)
                ? decodeEntities(stripHtmlTags(rawText))
                : decodeEntities(rawText);

        TextStatus status = new TextStatus();

        // 1) 优先识别 key=value / key: value 行（例如 power=on、online: 1）
        for (String line : text.split("\\r?\\n", -1)) {
            Matcher matcher = KEY_VALUE_LINE.matcher(line);
            if (!matcher.matches()) {
                continue;
            }
            String rawKey = matcher.group(1).trim();
            String rawValue = cleanupTextValue(matcher.group(2));
            if (rawValue.isEmpty()) {
                continue;
            }
            String normalizedKey = normalizeKey(rawKey);
            if (status.power == null && POWER_KEYS.containsKey(normalizedKey)) {
                String mapped = mapPowerValue(rawValue);
                if (mapped != null) {
                    status.power = mapped;
                    status.powerPath = rawKey;
                }
            }
            if (status.online == null && ONLINE_KEYS.containsKey(normalizedKey)) {
                Boolean mapped = mapOnlineValue(rawValue);
                if (mapped != null) {
                    status.online = mapped;
                    status.onlinePath = rawKey;
                }
            }
        }

        // 2) 整体只有一个词元时直接映射（如响应体就是 "on" / "已开机"）；刻意不映射 "1"/"0"
        String trimmedLower = text.trim().toLowerCase(Locale.ROOT);
        if (status.power == null) {
            status.power = POWER_TEXT_VALUES.get(trimmedLower);
        }
        if (status.online == null) {
            status.online = ONLINE_TEXT_VALUES.get(trimmedLower);
        }

        // 3) 关键词兜底：同时出现开机/关机时视为不明确，绝不猜测
        if (status.power == null) {
            boolean hasOnKeyword = POWER_ON_KEYWORD.matcher(text).find();
            boolean hasOffKeyword = POWER_OFF_KEYWORD.matcher(text).find();
            if (hasOnKeyword && !hasOffKeyword) {
                status.power = POWER_ON;
            } else if (!hasOnKeyword && hasOffKeyword) {
                status.power = POWER_OFF;
            }
        }
        if (status.online == null) {
            boolean hasOnlineKeyword = ONLINE_KEYWORD.matcher(text).find();
            boolean hasOfflineKeyword = OFFLINE_KEYWORD.matcher(text).find();
            if (hasOnlineKeyword && !hasOfflineKeyword) {
                status.online = Boolean.TRUE;
            } else if (!hasOnlineKeyword && hasOfflineKeyword) {
                status.online = Boolean.FALSE;
            }
        }

        return status;
    }

    private static String cleanupTextValue(String raw) {
        String value = raw.trim();
        if (!value.isEmpty() && (value.startsWith("\"") || value.startsWith("'"))) {
            value = value.substring(1);
        }
        if (!value.isEmpty() && (value.endsWith("\"") || value.endsWith("'"))) {
            value = value.substring(0, value.length() - 1);
        }
        if (!value.isEmpty() && (value.endsWith(";") || value.endsWith(","))) {
            value = value.substring(0, value.length() - 1);
        }
        return value.trim();
    }

    private static void addAll(Set<String> target, String... values) {
        for (String value : values) {
            target.add(value);
        }
    }
}
