package com.powercard.remote;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;

/** “添加到桌面”系统弹窗（API 26+ requestPinAppWidget）。 */
final class WidgetPin {

    private WidgetPin() {
    }

    /**
     * 请求系统把本小组件固定到桌面。必须在 UI 线程调用。
     *
     * @return true 表示已发起请求（用户可能仍取消）；false 表示此设备/启动器不支持
     */
    static boolean requestPin(Activity activity) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(activity);
            if (!manager.isRequestPinAppWidgetSupported()) {
                return false;
            }
            ComponentName provider = new ComponentName(activity, PowerCardWidgetProvider.class);
            return manager.requestPinAppWidget(provider, null, null);
        } catch (Throwable ignored) {
            return false;
        }
    }
}
