package com.powercard.remote;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 小组件 RemoteViews 渲染：4×2 / 2×2 各一套普通布局与确认态布局。
 *
 * <p>根据 {@link AppWidgetManager#getAppWidgetOptions(int)} 的 minWidth 选择标准/紧凑布局；
 * 只用 RemoteViews 支持的控件（LinearLayout / TextView），不动态 addView。</p>
 */
final class WidgetRenderer {

    private WidgetRenderer() {
    }

    static void render(Context context, int appWidgetId) {
        Bundle options = AppWidgetManager.getInstance(context).getAppWidgetOptions(appWidgetId);
        render(context, appWidgetId, options);
    }

    static void render(Context context, int appWidgetId, Bundle options) {
        WidgetConfig config = WidgetConfig.fromJson(new SecureConfigStore(context).load());
        WidgetStore store = new WidgetStore(context);
        boolean compact = isCompact(options);
        boolean configured = config.hasStatusUrl();
        String pendingAction = configured ? store.getPendingAction(appWidgetId) : null;

        RemoteViews views;
        if (pendingAction != null) {
            views = buildConfirm(context, appWidgetId, compact, pendingAction);
        } else {
            views = buildNormal(context, appWidgetId, compact, configured, store);
        }
        AppWidgetManager.getInstance(context).updateAppWidget(appWidgetId, views);
    }

    /* ---------------------------------------------------------------------
       布局选择
       --------------------------------------------------------------------- */

    private static boolean isCompact(Bundle options) {
        if (options == null) {
            return false;
        }
        int minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250);
        int minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110);
        return minWidth < WidgetContract.COMPACT_WIDTH_DP || minHeight < 90;
    }

    /* ---------------------------------------------------------------------
       普通态
       --------------------------------------------------------------------- */

    private static RemoteViews buildNormal(Context context, int appWidgetId, boolean compact,
                                           boolean configured, WidgetStore store) {
        int layout = compact ? R.layout.widget_powercard_2x2 : R.layout.widget_powercard_4x2;
        RemoteViews views = new RemoteViews(context.getPackageName(), layout);

        if (!configured) {
            if (compact) {
                // 2×2 空间有限：两行显示“未配置 / 打开 App 设置”
                views.setTextViewText(R.id.widget_power_state,
                        context.getString(R.string.widget_unconfigured));
                views.setTextViewText(R.id.widget_status_line,
                        context.getString(R.string.widget_unconfigured_action));
            } else {
                // 4×2 直接显示完整提示“未配置 · 打开 App 设置”
                views.setTextViewText(R.id.widget_power_state,
                        context.getString(R.string.widget_unconfigured_full));
                views.setTextViewText(R.id.widget_status_line, "");
            }
            views.setViewVisibility(R.id.widget_actions, View.GONE);
            views.setOnClickPendingIntent(R.id.widget_root, WidgetContract.openApp(context));
            return views;
        }

        views.setViewVisibility(R.id.widget_actions, View.VISIBLE);
        views.setOnClickPendingIntent(R.id.widget_btn_on, WidgetContract.clickOn(context, appWidgetId));
        views.setOnClickPendingIntent(R.id.widget_btn_off, WidgetContract.clickOff(context, appWidgetId));
        views.setOnClickPendingIntent(R.id.widget_btn_refresh,
                WidgetContract.clickRefresh(context, appWidgetId));

        WidgetStore.Status status = store.loadStatus(appWidgetId);
        long now = System.currentTimeMillis();
        boolean actionFresh = status.isActionFresh(now, WidgetContract.LAST_ACTION_VISIBLE_MS);

        String powerText;
        String statusText;
        if (status.hasSuccess()) {
            powerText = powerLabel(context, status.power);
            if (actionFresh) {
                statusText = status.actionMessage;
            } else if (status.isErrorLatest()) {
                // 失败时保留上次成功状态与时间
                statusText = context.getString(
                        R.string.widget_status_error_last, formatTime(status.updatedAt));
            } else if (status.online) {
                statusText = context.getString(
                        R.string.widget_status_online_time, formatTime(status.updatedAt));
            } else {
                statusText = context.getString(
                        R.string.widget_status_offline_time, formatTime(status.updatedAt));
            }
        } else if (status.isErrorLatest()) {
            powerText = context.getString(R.string.widget_power_unknown);
            String reason = status.errorMessage != null
                    ? status.errorMessage
                    : context.getString(R.string.widget_error_unknown);
            statusText = context.getString(R.string.widget_status_error_now, reason);
        } else if (actionFresh) {
            powerText = context.getString(R.string.widget_power_unknown);
            statusText = status.actionMessage;
        } else {
            // 首次刷新尚未完成
            powerText = context.getString(R.string.widget_power_unknown);
            statusText = context.getString(R.string.widget_status_loading);
        }

        views.setTextViewText(R.id.widget_power_state, powerText);
        views.setTextViewText(R.id.widget_status_line, statusText);
        return views;
    }

    /* ---------------------------------------------------------------------
       确认态（两段式第二段）
       --------------------------------------------------------------------- */

    private static RemoteViews buildConfirm(Context context, int appWidgetId, boolean compact,
                                            String pendingAction) {
        int layout = compact
                ? R.layout.widget_powercard_2x2_confirm
                : R.layout.widget_powercard_4x2_confirm;
        RemoteViews views = new RemoteViews(context.getPackageName(), layout);
        boolean powerOn = WidgetContract.ACTION_ON.equals(pendingAction);

        views.setTextViewText(R.id.widget_confirm_title, context.getString(
                powerOn ? R.string.widget_confirm_on_title : R.string.widget_confirm_off_title));
        views.setViewVisibility(R.id.widget_btn_confirm_on, powerOn ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.widget_btn_confirm_off, powerOn ? View.GONE : View.VISIBLE);
        views.setOnClickPendingIntent(R.id.widget_btn_cancel,
                WidgetContract.clickCancel(context, appWidgetId));
        views.setOnClickPendingIntent(R.id.widget_btn_confirm_on,
                WidgetContract.clickConfirm(context, appWidgetId));
        views.setOnClickPendingIntent(R.id.widget_btn_confirm_off,
                WidgetContract.clickConfirm(context, appWidgetId));
        return views;
    }

    /* ---------------------------------------------------------------------
       工具
       --------------------------------------------------------------------- */

    private static String powerLabel(Context context, String power) {
        if (WidgetStateParser.POWER_ON.equals(power)) {
            return context.getString(R.string.widget_power_on);
        }
        if (WidgetStateParser.POWER_OFF.equals(power)) {
            return context.getString(R.string.widget_power_off);
        }
        return context.getString(R.string.widget_power_unknown);
    }

    private static String formatTime(long timestamp) {
        if (timestamp <= 0) {
            return "--:--";
        }
        SimpleDateFormat format = new SimpleDateFormat("HH:mm", Locale.getDefault());
        return format.format(new Date(timestamp));
    }
}
