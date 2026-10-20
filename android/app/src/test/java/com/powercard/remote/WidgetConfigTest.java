package com.powercard.remote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 小组件配置解析与超时 clamp（纯 Java，无需 Android 运行时）。 */
public class WidgetConfigTest {

    @Test
    public void emptyJsonMeansUnconfigured() {
        WidgetConfig config = WidgetConfig.fromJson("{}");
        assertFalse(config.hasStatusUrl());
        assertEquals("", config.statusUrl);
        assertEquals(5000, config.requestTimeoutMs);
    }

    @Test
    public void invalidJsonFallsBackToEmpty() {
        WidgetConfig config = WidgetConfig.fromJson("not json");
        assertFalse(config.hasStatusUrl());
    }

    @Test
    public void parsesFieldsAndCommandUrls() {
        WidgetConfig config = WidgetConfig.fromJson("{"
                + "\"statusUrl\":\"http://192.168.1.50/api/status\","
                + "\"powerOnUrl\":\"http://192.168.1.50/api/power/on\","
                + "\"powerOffUrl\":\"http://192.168.1.50/api/power/off\","
                + "\"powerField\":\"data.power\","
                + "\"onlineField\":\"data.online\","
                + "\"requestTimeoutMs\":5000}");
        assertTrue(config.hasStatusUrl());
        assertEquals("data.power", config.powerField);
        assertEquals("data.online", config.onlineField);
        assertEquals("http://192.168.1.50/api/power/on", config.commandUrl(WidgetContract.ACTION_ON));
        assertEquals("http://192.168.1.50/api/power/off", config.commandUrl(WidgetContract.ACTION_OFF));
    }

    @Test
    public void statusUrlMustBeHttpOrHttps() {
        assertFalse(WidgetConfig.fromJson("{\"statusUrl\":\"ftp://host/status\"}").hasStatusUrl());
        assertFalse(WidgetConfig.fromJson("{\"statusUrl\":\"not-a-url\"}").hasStatusUrl());
        assertFalse(WidgetConfig.fromJson("{\"statusUrl\":\"\"}").hasStatusUrl());
        assertTrue(WidgetConfig.fromJson("{\"statusUrl\":\"https://host/status\"}").hasStatusUrl());
    }

    @Test
    public void widgetNetworkTimeoutIsClampedToBroadcastWindow() {
        WidgetConfig high = WidgetConfig.fromJson("{\"requestTimeoutMs\":30000}");
        assertEquals(WidgetContract.WIDGET_TIMEOUT_MS, high.widgetTimeoutMs());
        assertEquals(5000, high.widgetTimeoutMs());

        WidgetConfig low = WidgetConfig.fromJson("{\"requestTimeoutMs\":100}");
        assertEquals(WidgetContract.MIN_TIMEOUT_MS, low.widgetTimeoutMs());

        WidgetConfig normal = WidgetConfig.fromJson("{\"requestTimeoutMs\":4000}");
        assertEquals(4000, normal.widgetTimeoutMs());
    }
}
