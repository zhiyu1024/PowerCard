package com.powercard.remote;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/**
 * 桌面小组件 provider（RemoteViews 实现）。
 *
 * <ul>
 *   <li>onUpdate / 手动刷新 / App 配置保存 / 指令后延迟刷新：后台发状态请求并渲染；</li>
 *   <li>开机/关机按钮：第一段只进入“确认开机？/确认关机？”态（每 appWidgetId 独立 pending）；</li>
 *   <li>确认按钮：第二段才发 GET，成功后显示“已发送”，再安排非精确延迟刷新；</li>
 *   <li>30 秒过期：在下一次渲染/点击时惰性检查并自动恢复，不依赖精确闹钟。</li>
 * </ul>
 */
public final class PowerCardWidgetProvider extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        // 广播执行窗口约 10s：goAsync + 后台线程，避免阻塞主线程
        final PendingResult pendingResult = goAsync();
        WidgetRefresher.refreshAllAsync(context, appWidgetIds, pendingResult::finish);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        // 先交给基类处理 APPWIDGET_UPDATE / APPWIDGET_DELETED 等标准广播
        super.onReceive(context, intent);
        if (intent == null) {
            return;
        }
        String action = intent.getAction();
        if (action == null) {
            return;
        }
        int appWidgetId = intent.getIntExtra(
                AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);

        switch (action) {
            case WidgetContract.ACTION_REFRESH_ALL: {
                PendingResult pendingResult = goAsync();
                WidgetRefresher.refreshAllAsync(context, null, pendingResult::finish);
                break;
            }
            case WidgetContract.ACTION_WIDGET_REFRESH: {
                if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
                    break;
                }
                PendingResult pendingResult = goAsync();
                WidgetRefresher.refreshOneAsync(context, appWidgetId, pendingResult::finish);
                break;
            }
            case WidgetContract.ACTION_DELAYED_REFRESH: {
                if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
                    break;
                }
                PendingResult pendingResult = goAsync();
                WidgetRefresher.refreshOneAsync(context, appWidgetId, pendingResult::finish);
                break;
            }
            case WidgetContract.ACTION_POWER_ON:
                if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
                    WidgetRefresher.enterConfirm(context, appWidgetId, WidgetContract.ACTION_ON);
                }
                break;
            case WidgetContract.ACTION_POWER_OFF:
                if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
                    WidgetRefresher.enterConfirm(context, appWidgetId, WidgetContract.ACTION_OFF);
                }
                break;
            case WidgetContract.ACTION_CANCEL:
                if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
                    WidgetRefresher.cancelConfirm(context, appWidgetId);
                }
                break;
            case WidgetContract.ACTION_CONFIRM: {
                if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
                    break;
                }
                PendingResult pendingResult = goAsync();
                WidgetRefresher.handleConfirmAsync(context, appWidgetId, pendingResult::finish);
                break;
            }
            default:
                break;
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager appWidgetManager,
                                          int appWidgetId, Bundle newOptions) {
        // 用户调整尺寸（4×2 ↔ 2×2）时按新尺寸重绘；不额外发网络请求
        WidgetRenderer.render(context, appWidgetId, newOptions);
    }

    @Override
    public void onDeleted(Context context, int[] appWidgetIds) {
        if (appWidgetIds == null) {
            return;
        }
        WidgetStore store = new WidgetStore(context);
        for (int appWidgetId : appWidgetIds) {
            store.clearWidget(appWidgetId);
            WidgetRefresher.cancelDelayedRefresh(context, appWidgetId);
        }
    }
}
