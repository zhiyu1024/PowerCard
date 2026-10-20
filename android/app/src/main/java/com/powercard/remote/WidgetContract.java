package com.powercard.remote;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;

/** 桌面小组件常量：广播 action、PendingIntent 槽位、超时/过期时间。 */
final class WidgetContract {

    static final String ACTION_REFRESH_ALL = "com.powercard.remote.widget.REFRESH_ALL";
    static final String ACTION_WIDGET_REFRESH = "com.powercard.remote.widget.WIDGET_REFRESH";
    static final String ACTION_POWER_ON = "com.powercard.remote.widget.POWER_ON";
    static final String ACTION_POWER_OFF = "com.powercard.remote.widget.POWER_OFF";
    static final String ACTION_CONFIRM = "com.powercard.remote.widget.CONFIRM";
    static final String ACTION_CANCEL = "com.powercard.remote.widget.CANCEL";
    static final String ACTION_DELAYED_REFRESH = "com.powercard.remote.widget.DELAYED_REFRESH";

    /** 指令动作值（与 App/契约一致的 on / off）。 */
    static final String ACTION_ON = "on";
    static final String ACTION_OFF = "off";

    /** 两段式确认有效期：30 秒后在下一次渲染/点击时自动恢复。 */
    static final long PENDING_TTL_MS = 30_000L;

    /** 指令成功后延迟刷新（非精确闹钟），让界面更新为最新状态。 */
    static final long DELAYED_REFRESH_MS = 2_500L;

    /** “已发送/发送失败”提示在小组件上保留的时长。 */
    static final long LAST_ACTION_VISIBLE_MS = 20_000L;

    /**
     * 小组件单次网络超时上限：广播（goAsync）执行窗口约 10s，
     * 配置中的 requestTimeoutMs 最大 30s，这里 clamp 到 5s，避免被系统杀进程。
     */
    static final int WIDGET_TIMEOUT_MS = 5_000;
    static final int MIN_TIMEOUT_MS = 1_000;

    /** 宽度小于该值（dp）时使用紧凑 2×2 布局。 */
    static final int COMPACT_WIDTH_DP = 200;

    private static final int SLOT_POWER_ON = 1;
    private static final int SLOT_POWER_OFF = 2;
    private static final int SLOT_REFRESH = 3;
    private static final int SLOT_CANCEL = 4;
    private static final int SLOT_CONFIRM = 5;
    private static final int SLOT_DELAYED_REFRESH = 6;

    private WidgetContract() {
    }

    /**
     * 每个 appWidgetId + 动作使用独立 requestCode，避免 PendingIntent 复用导致点击串号。
     */
    static int requestCode(int appWidgetId, int slot) {
        return (appWidgetId * 16 + slot) & 0x7FFFFFFF;
    }

    /** 显式广播给小组件 provider（App 内部；receiver exported=false 也能收到）。 */
    static PendingIntent widgetBroadcast(Context context, int appWidgetId, String action, int slot) {
        Intent intent = new Intent(context, PowerCardWidgetProvider.class);
        intent.setAction(action);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        return PendingIntent.getBroadcast(
                context,
                requestCode(appWidgetId, slot),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static PendingIntent clickOn(Context context, int appWidgetId) {
        return widgetBroadcast(context, appWidgetId, ACTION_POWER_ON, SLOT_POWER_ON);
    }

    static PendingIntent clickOff(Context context, int appWidgetId) {
        return widgetBroadcast(context, appWidgetId, ACTION_POWER_OFF, SLOT_POWER_OFF);
    }

    static PendingIntent clickRefresh(Context context, int appWidgetId) {
        return widgetBroadcast(context, appWidgetId, ACTION_WIDGET_REFRESH, SLOT_REFRESH);
    }

    static PendingIntent clickCancel(Context context, int appWidgetId) {
        return widgetBroadcast(context, appWidgetId, ACTION_CANCEL, SLOT_CANCEL);
    }

    static PendingIntent clickConfirm(Context context, int appWidgetId) {
        return widgetBroadcast(context, appWidgetId, ACTION_CONFIRM, SLOT_CONFIRM);
    }

    /** 延迟刷新闹钟（非精确）。 */
    static PendingIntent delayedRefreshAlarm(Context context, int appWidgetId) {
        return widgetBroadcast(context, appWidgetId, ACTION_DELAYED_REFRESH, SLOT_DELAYED_REFRESH);
    }

    /** 打开 App（未配置 / 点击小组件空白处）。 */
    static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                context,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
