package com.powercard.remote;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;

import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 小组件刷新/指令执行。
 *
 * <p>网络与解析都在单线程后台执行器里完成；provider 用 goAsync 延长广播生命周期，
 * 完成后调用 PendingResult.finish()。同一时刻只允许一次状态刷新、每个 widget 只允许
 * 一条指令在途，避免重复并发请求。</p>
 */
final class WidgetRefresher {

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor(new ThreadFactory() {
        private final AtomicInteger counter = new AtomicInteger(1);

        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "powercard-widget-" + counter.getAndIncrement());
            thread.setDaemon(true);
            return thread;
        }
    });

    private static final AtomicBoolean REFRESH_IN_FLIGHT = new AtomicBoolean(false);
    private static final Set<Integer> COMMAND_IN_FLIGHT =
            Collections.newSetFromMap(new ConcurrentHashMap<Integer, Boolean>());

    private WidgetRefresher() {
    }

    /* ---------------------------------------------------------------------
       广播入口
       --------------------------------------------------------------------- */

    static int[] currentWidgetIds(Context context) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            ComponentName provider = new ComponentName(context, PowerCardWidgetProvider.class);
            int[] ids = manager.getAppWidgetIds(provider);
            return ids == null ? new int[0] : ids;
        } catch (Throwable ignored) {
            return new int[0];
        }
    }

    /** App 内（NativeBridge.refreshWidgets）或配置保存后触发全量刷新。 */
    static void requestRefreshAll(Context context) {
        try {
            Intent intent = new Intent(context, PowerCardWidgetProvider.class);
            intent.setAction(WidgetContract.ACTION_REFRESH_ALL);
            context.sendBroadcast(intent);
        } catch (Throwable ignored) {
            // 广播失败不影响 App 主流程
        }
    }

    static void refreshAllAsync(Context context, int[] appWidgetIds, Runnable done) {
        final Context appContext = context.getApplicationContext();
        if (!REFRESH_IN_FLIGHT.compareAndSet(false, true)) {
            runDone(done);
            return;
        }
        final int[] ids = appWidgetIds == null || appWidgetIds.length == 0
                ? currentWidgetIds(appContext)
                : appWidgetIds;
        EXECUTOR.execute(() -> {
            try {
                refreshBlocking(appContext, ids);
            } catch (Throwable ignored) {
                // 后台刷新异常不外抛；下次刷新重试
            } finally {
                REFRESH_IN_FLIGHT.set(false);
                runDone(done);
            }
        });
    }

    static void refreshOneAsync(Context context, int appWidgetId, Runnable done) {
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            runDone(done);
            return;
        }
        refreshAllAsync(context, new int[]{appWidgetId}, done);
    }

    /* ---------------------------------------------------------------------
       两段式确认
       --------------------------------------------------------------------- */

    /** 第一次点击开机/关机：只切换为确认态，不发请求。 */
    static void enterConfirm(Context context, int appWidgetId, String action) {
        WidgetConfig config = WidgetConfig.fromJson(new SecureConfigStore(context).load());
        WidgetStore store = new WidgetStore(context);
        if (!config.hasStatusUrl()) {
            store.clearPending(appWidgetId);
            WidgetRenderer.render(context, appWidgetId);
            return;
        }
        store.setPending(appWidgetId, action, System.currentTimeMillis());
        WidgetRenderer.render(context, appWidgetId);
    }

    static void cancelConfirm(Context context, int appWidgetId) {
        new WidgetStore(context).clearPending(appWidgetId);
        WidgetRenderer.render(context, appWidgetId);
    }

    /** 第二次点击确认：读取 pending（可能已 30 秒过期）→ 发 GET → 显示已发送 → 延迟刷新。 */
    static void handleConfirmAsync(Context context, int appWidgetId, Runnable done) {
        final Context appContext = context.getApplicationContext();
        WidgetStore store = new WidgetStore(appContext);
        String pendingAction = store.getPendingAction(appWidgetId);
        if (pendingAction == null) {
            WidgetRenderer.render(appContext, appWidgetId);
            runDone(done);
            return;
        }
        store.clearPending(appWidgetId);
        executeCommandAsync(appContext, appWidgetId, pendingAction, done);
    }

    static void executeCommandAsync(Context context, int appWidgetId, String pendingAction, Runnable done) {
        final Context appContext = context.getApplicationContext();
        if (!COMMAND_IN_FLIGHT.add(appWidgetId)) {
            runDone(done);
            return;
        }
        EXECUTOR.execute(() -> {
            try {
                WidgetConfig config = WidgetConfig.fromJson(new SecureConfigStore(appContext).load());
                WidgetStore store = new WidgetStore(appContext);
                String url = config.commandUrl(pendingAction);
                long now = System.currentTimeMillis();
                if (url == null || url.trim().isEmpty()) {
                    store.saveAction(appWidgetId,
                            appContext.getString(R.string.widget_action_unconfigured), now);
                } else {
                    NativeHttpClient.HttpResult result = null;
                    try {
                        result = new NativeHttpClient().get(url, config.widgetTimeoutMs());
                    } catch (Throwable ignored) {
                        result = null;
                    }
                    boolean ok = result != null && result.ok;
                    store.saveAction(appWidgetId,
                            appContext.getString(ok ? R.string.widget_action_sent : R.string.widget_action_failed),
                            now);
                    if (ok) {
                        // 指令成功后安排一次非精确延迟刷新，把“已发送”更新为真实状态
                        scheduleDelayedRefresh(appContext, appWidgetId);
                    }
                }
                WidgetRenderer.render(appContext, appWidgetId);
            } catch (Throwable ignored) {
                // 指令失败已经通过渲染兜底；不崩溃
            } finally {
                COMMAND_IN_FLIGHT.remove(appWidgetId);
                runDone(done);
            }
        });
    }

    /* ---------------------------------------------------------------------
       延迟刷新闹钟（非精确）
       --------------------------------------------------------------------- */

    static void scheduleDelayedRefresh(Context context, int appWidgetId) {
        try {
            AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (alarms == null) {
                return;
            }
            PendingIntent pendingIntent = WidgetContract.delayedRefreshAlarm(context, appWidgetId);
            alarms.set(AlarmManager.RTC,
                    System.currentTimeMillis() + WidgetContract.DELAYED_REFRESH_MS,
                    pendingIntent);
        } catch (Throwable ignored) {
            // 闹钟不可用则依赖下次定时刷新
        }
    }

    static void cancelDelayedRefresh(Context context, int appWidgetId) {
        try {
            AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (alarms == null) {
                return;
            }
            alarms.cancel(WidgetContract.delayedRefreshAlarm(context, appWidgetId));
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    /* ---------------------------------------------------------------------
       实际刷新（后台线程）
       --------------------------------------------------------------------- */

    private static void refreshBlocking(Context context, int[] appWidgetIds) {
        if (appWidgetIds == null || appWidgetIds.length == 0) {
            return;
        }
        WidgetConfig config = WidgetConfig.fromJson(new SecureConfigStore(context).load());
        WidgetStore store = new WidgetStore(context);
        if (!config.hasStatusUrl()) {
            // 未配置：不请求、不显示假数据，直接渲染“未配置 · 打开 App 设置”
            for (int appWidgetId : appWidgetIds) {
                WidgetRenderer.render(context, appWidgetId);
            }
            return;
        }

        long now = System.currentTimeMillis();
        NativeHttpClient.HttpResult result = null;
        try {
            result = new NativeHttpClient().get(config.statusUrl, config.widgetTimeoutMs());
        } catch (Throwable ignored) {
            result = null;
        }
        if (result == null) {
            store.saveFailure(context.getString(R.string.widget_error_unknown), now);
        } else if (result.ok) {
            WidgetStateParser.Result parsed = WidgetStateParser.parse(
                    result.body, result.contentType, config.powerField, config.onlineField);
            store.saveSuccess(parsed.power, parsed.online, parsed.onlineInferred, now);
        } else {
            store.saveFailure(errorShort(context, result), now);
        }

        for (int appWidgetId : appWidgetIds) {
            WidgetRenderer.render(context, appWidgetId);
        }
    }

    private static String errorShort(Context context, NativeHttpClient.HttpResult result) {
        if (result == null || result.errorCode == null) {
            return context.getString(R.string.widget_error_unknown);
        }
        switch (result.errorCode) {
            case "TIMEOUT":
                return context.getString(R.string.widget_error_timeout);
            case "INVALID_URL":
                return context.getString(R.string.widget_error_invalid_url);
            case "HTTP":
                return result.status != null
                        ? context.getString(R.string.widget_error_http, result.status.intValue())
                        : context.getString(R.string.widget_error_unknown);
            case "NETWORK":
            default:
                return context.getString(R.string.widget_error_network);
        }
    }

    private static void runDone(Runnable done) {
        if (done != null) {
            try {
                done.run();
            } catch (Throwable ignored) {
                // PendingResult 已结束等情况忽略
            }
        }
    }
}
