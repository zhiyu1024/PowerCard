package com.powercard.remote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Java 版状态解析器单元测试。
 *
 * <p>测试样本与预期行为直接对应 {@code tests/unit/parser.test.js}（同一份
 * {@code public/shared/parser.js} 语义），确保小组件与 Web/Node 表现一致。</p>
 */
public class WidgetStateParserTest {

    private static WidgetStateParser.Result parse(String text, String contentType) {
        return WidgetStateParser.parse(text, contentType, "", "");
    }

    private static final String JSON_CT = "application/json; charset=utf-8";
    private static final String TEXT_CT = "text/plain; charset=utf-8";
    private static final String HTML_CT = "text/html; charset=utf-8";
    private static final String WARNING = "已连接，但无法识别电源状态；请在调试中指定字段或查看原始响应";

    @Test
    public void jsonAutoDetectsPowerAndOnline() {
        WidgetStateParser.Result result = parse("{\"power\":1,\"online\":true}", JSON_CT);
        assertEquals("on", result.power);
        assertTrue(result.online);
        assertFalse(result.onlineInferred);
        assertEquals("power", result.powerField);
        assertEquals("online", result.onlineField);
        assertNull(result.warning);
    }

    @Test
    public void jsonNestedFields() {
        WidgetStateParser.Result result = parse("{\"data\":{\"power\":\"off\",\"online\":0}}", JSON_CT);
        assertEquals("off", result.power);
        assertFalse(result.online);
        assertFalse(result.onlineInferred);
        assertEquals("data.power", result.powerField);
        assertEquals("data.online", result.onlineField);
    }

    @Test
    public void manualFieldWins() {
        WidgetStateParser.Result result = WidgetStateParser.parse(
                "{\"status\":\"off\",\"data\":{\"power\":\"on\"}}", JSON_CT, "data.power", "");
        assertEquals("on", result.power);
        assertEquals("data.power", result.powerField);
    }

    @Test
    public void manualFieldSupportsArrayIndex() {
        WidgetStateParser.Result result = WidgetStateParser.parse(
                "{\"items\":[{\"state\":\"on\"}]}", JSON_CT, "items.0.state", "");
        assertEquals("on", result.power);
        assertEquals("items.0.state", result.powerField);
    }

    @Test
    public void manualFieldMissFallsBackToAutoDetect() {
        WidgetStateParser.Result result = WidgetStateParser.parse(
                "{\"data\":{\"power\":\"on\"}}", JSON_CT, "does.not.exist", "");
        assertEquals("on", result.power);
        assertEquals("data.power", result.powerField);
    }

    @Test
    public void jsonDepthLimitIsFive() {
        WidgetStateParser.Result visible = parse(
                "{\"a\":{\"b\":{\"c\":{\"d\":{\"power\":\"on\"}}}}}", JSON_CT);
        assertEquals("on", visible.power);
        assertEquals("a.b.c.d.power", visible.powerField);

        WidgetStateParser.Result tooDeep = parse(
                "{\"a\":{\"b\":{\"c\":{\"d\":{\"e\":{\"power\":\"on\"}}}}}}", JSON_CT);
        assertEquals("unknown", tooDeep.power);
        assertNotNull(tooDeep.warning);
    }

    @Test
    public void genericStatusKeyOnlyUsedWhenValueIsClear() {
        WidgetStateParser.Result clear = parse("{\"status\":\"running\"}", JSON_CT);
        assertEquals("on", clear.power);
        assertEquals("status", clear.powerField);

        WidgetStateParser.Result ambiguous = parse("{\"status\":\"online\"}", JSON_CT);
        assertEquals("unknown", ambiguous.power);
        assertTrue(ambiguous.online);
        assertTrue(ambiguous.onlineInferred);
    }

    @Test
    public void apiEnvelopeStatusZeroIsNotPowerOff() {
        WidgetStateParser.Result result = parse(
                "{\"status\":0,\"msg\":\"OK\",\"data\":{\"online\":true,\"power\":\"on\"}}", JSON_CT);
        assertEquals("on", result.power);
        assertTrue(result.online);
        assertFalse(result.onlineInferred);
        assertEquals("data.power", result.powerField);
        assertEquals("data.online", result.onlineField);
        assertNull(result.warning);
    }

    @Test
    public void apiEnvelopeWithoutDataPowerStaysUnknown() {
        WidgetStateParser.Result result = parse(
                "{\"status\":0,\"msg\":\"OK\",\"data\":{\"online\":false}}", JSON_CT);
        assertEquals("unknown", result.power);
        assertFalse(result.online);
        assertFalse(result.onlineInferred);
        assertNotNull(result.warning);
    }

    @Test
    public void specificFieldWinsOverGenericField() {
        WidgetStateParser.Result result = parse("{\"status\":\"off\",\"power\":\"on\"}", JSON_CT);
        assertEquals("on", result.power);
        assertEquals("power", result.powerField);
    }

    @Test
    public void plainTextKeyValueLines() {
        WidgetStateParser.Result result = parse("power=off\nonline=1", TEXT_CT);
        assertEquals("off", result.power);
        assertTrue(result.online);
        assertEquals("power", result.powerField);
        assertEquals("online", result.onlineField);
    }

    @Test
    public void plainTextWholeToken() {
        WidgetStateParser.Result result = parse("  已开机  ", "text/plain");
        assertEquals("on", result.power);
        assertTrue(result.online);
        assertTrue(result.onlineInferred);
    }

    @Test
    public void htmlWithBothPowerKeywordsIsNotGuessed() {
        WidgetStateParser.Result result = parse(
                "<html><body><h1>开机</h1><button>关机</button><p>开机卡在线</p></body></html>",
                HTML_CT);
        assertEquals("unknown", result.power);
        assertEquals(WARNING, result.warning);
        assertTrue(result.online);
        assertFalse(result.onlineInferred);
    }

    @Test
    public void cardOnlineLabelIsNotPowerOn() {
        WidgetStateParser.Result result = parse("<div>开机卡在线</div>", "text/html");
        assertEquals("unknown", result.power);
        assertNotNull(result.warning);
        assertTrue(result.online);
    }

    @Test
    public void htmlSinglePowerDescriptionIsDetected() {
        WidgetStateParser.Result result = parse(
                "<html><body><p>电脑已开机</p><p>开机卡在线</p></body></html>", "text/html");
        assertEquals("on", result.power);
        assertTrue(result.online);
        assertNull(result.warning);
    }

    @Test
    public void htmlOfflineKeyword() {
        WidgetStateParser.Result result = parse("<div>设备状态：离线</div>", "text/html");
        assertFalse(result.online);
        assertFalse(result.onlineInferred);
        assertEquals("unknown", result.power);
    }

    @Test
    public void unrecognizedTextInfersOnline() {
        WidgetStateParser.Result result = parse("无法识别的响应内容", TEXT_CT);
        assertEquals("unknown", result.power);
        assertTrue(result.online);
        assertTrue(result.onlineInferred);
        assertNull(result.powerField);
        assertNull(result.onlineField);
        assertFalse(result.hasMapping());
        assertNotNull(result.warning);
        assertTrue(result.warning.contains("无法识别电源状态"));
    }

    @Test
    public void plainOkMeansOnlineButNotPower() {
        WidgetStateParser.Result result = parse("OK", "text/plain");
        assertEquals("unknown", result.power);
        assertTrue(result.online);
        assertFalse(result.onlineInferred);
        assertNull(result.powerField);
        assertNull(result.onlineField);
        assertNotNull(result.warning);
    }

    @Test
    public void jsonContentTypeButNotJsonFallsBackToText() {
        WidgetStateParser.Result result = parse("power: off", "application/json");
        assertEquals("off", result.power);
    }

    @Test
    public void explicitOnlineFalseIsNotOverriddenByInference() {
        WidgetStateParser.Result result = parse("{\"power\":\"on\",\"online\":false}", JSON_CT);
        assertFalse(result.online);
        assertFalse(result.onlineInferred);
        assertEquals("on", result.power);
    }

    @Test
    public void powerAndOnlineValueMapping() {
        assertEquals("on", WidgetStateParser.mapPowerValue(Boolean.TRUE));
        assertEquals("off", WidgetStateParser.mapPowerValue(Boolean.FALSE));
        assertEquals("on", WidgetStateParser.mapPowerValue(1));
        assertEquals("off", WidgetStateParser.mapPowerValue(0));
        assertEquals("on", WidgetStateParser.mapPowerValue("ON"));
        assertEquals("on", WidgetStateParser.mapPowerValue(" 已开机 "));
        assertEquals("off", WidgetStateParser.mapPowerValue("off"));
        assertEquals("off", WidgetStateParser.mapPowerValue("关机"));
        assertNull(WidgetStateParser.mapPowerValue(2));
        assertNull(WidgetStateParser.mapPowerValue("unknown"));
        assertNull(WidgetStateParser.mapPowerValue(null));

        assertEquals(Boolean.TRUE, WidgetStateParser.mapOnlineValue(Boolean.TRUE));
        assertEquals(Boolean.FALSE, WidgetStateParser.mapOnlineValue(Boolean.FALSE));
        assertEquals(Boolean.TRUE, WidgetStateParser.mapOnlineValue(1));
        assertEquals(Boolean.FALSE, WidgetStateParser.mapOnlineValue(0));
        assertEquals(Boolean.TRUE, WidgetStateParser.mapOnlineValue("在线"));
        assertEquals(Boolean.FALSE, WidgetStateParser.mapOnlineValue("离线"));
        assertNull(WidgetStateParser.mapOnlineValue("maybe"));
    }

    @Test
    public void keyNormalization() {
        assertEquals("powerstate", WidgetStateParser.normalizeKey("Power_State"));
        assertEquals("powerstatus", WidgetStateParser.normalizeKey("power-status"));
        assertEquals("isonline", WidgetStateParser.normalizeKey("is online"));
        assertEquals("online", WidgetStateParser.normalizeKey("ONLINE"));
    }

    @Test
    public void fieldPathResolution() {
        Object root = parseJson("{\"items\":[{\"state\":\"on\"}]}");
        assertEquals("on", WidgetStateParser.resolveFieldPath(root, "items.0.state"));
        assertNull(WidgetStateParser.resolveFieldPath(root, "items.1.state"));
        assertNull(WidgetStateParser.resolveFieldPath(root, "items.0.state.x"));
        assertNull(WidgetStateParser.resolveFieldPath(root, "does.not.exist"));
    }

    @Test
    public void powerLabels() {
        assertEquals("电脑已开机", WidgetStateParser.powerLabel("on"));
        assertEquals("电脑已关机", WidgetStateParser.powerLabel("off"));
        assertEquals("状态未知", WidgetStateParser.powerLabel("unknown"));
    }

    private static Object parseJson(String json) {
        try {
            return new org.json.JSONTokener(json).nextValue();
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }
}
