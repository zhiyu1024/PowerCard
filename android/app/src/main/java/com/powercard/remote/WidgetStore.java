package com.powercard.remote;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 小组件状态持久化（普通 SharedPreferences，不含 URL/token 等敏感内容）。
 *
 * <ul>
 *   <li>全局：最近一次成功状态（电源/在线/时间）、最近一次失败（时间/简述）；</li>
 *   <li>按 appWidgetId：两段式确认的 pending 动作与过期时间、“已发送/发送失败”提示。</li>
 * </ul>
 */
final class WidgetStore {

    private static final String PREFS_NAME = "powercard_widget_state";

    private static final String KEY_POWER = "last_power";
    private static final String KEY_ONLINE = "last_online";
    private static final String KEY_ONLINE_INFERRED = "last_online_inferred";
    private static final String KEY_UPDATED_AT = "last_updated_at";
    private static final String KEY_ERROR_AT = "last_error_at";
    private static final String KEY_ERROR_MESSAGE = "last_error_message";

    private static final String KEY_ACTION_AT = "widget_%d_action_at";
    private static final String KEY_ACTION_MESSAGE = "widget_%d_action_message";
    private static final String KEY_PENDING_ACTION = "widget_%d_pending_action";
    private static final String KEY_PENDING_EXPIRES = "widget_%d_pending_expires";

    private final SharedPreferences preferences;

    WidgetStore(Context context) {
        this.preferences = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** 一次渲染需要的全部状态。 */
    static final class Status {
        final String power;
        final boolean online;
        final boolean onlineInferred;
        final long updatedAt;
        final long errorAt;
        final String errorMessage;
        final long actionAt;
        final String actionMessage;

        Status(String power, boolean online, boolean onlineInferred, long updatedAt,
               long errorAt, String errorMessage, long actionAt, String actionMessage) {
            this.power = power;
            this.online = online;
            this.onlineInferred = onlineInferred;
            this.updatedAt = updatedAt;
            this.errorAt = errorAt;
            this.errorMessage = errorMessage;
            this.actionAt = actionAt;
            this.actionMessage = actionMessage;
        }

        boolean hasSuccess() {
            return updatedAt > 0 && power != null;
        }

        /** 最近一次刷新是失败（且发生在最近一次成功之后）。 */
        boolean isErrorLatest() {
            return errorAt > updatedAt;
        }

        /** 指令结果提示仅在“还没被新的状态刷新覆盖”时短暂显示。 */
        boolean isActionFresh(long now, long windowMs) {
            return actionAt > updatedAt && now - actionAt < windowMs && actionMessage != null;
        }
    }

    Status loadStatus(int appWidgetId) {
        return new Status(
                preferences.getString(KEY_POWER, WidgetStateParser.POWER_UNKNOWN),
                preferences.getBoolean(KEY_ONLINE, true),
                preferences.getBoolean(KEY_ONLINE_INFERRED, true),
                preferences.getLong(KEY_UPDATED_AT, 0L),
                preferences.getLong(KEY_ERROR_AT, 0L),
                preferences.getString(KEY_ERROR_MESSAGE, null),
                preferences.getLong(actionKey(appWidgetId, KEY_ACTION_AT), 0L),
                preferences.getString(actionKey(appWidgetId, KEY_ACTION_MESSAGE), null));
    }

    void saveSuccess(String power, boolean online, boolean onlineInferred, long now) {
        preferences.edit()
                .putString(KEY_POWER, power)
                .putBoolean(KEY_ONLINE, online)
                .putBoolean(KEY_ONLINE_INFERRED, onlineInferred)
                .putLong(KEY_UPDATED_AT, now)
                .apply();
    }

    void saveFailure(String message, long now) {
        preferences.edit()
                .putLong(KEY_ERROR_AT, now)
                .putString(KEY_ERROR_MESSAGE, message)
                .apply();
    }

    void saveAction(int appWidgetId, String message, long now) {
        preferences.edit()
                .putLong(actionKey(appWidgetId, KEY_ACTION_AT), now)
                .putString(actionKey(appWidgetId, KEY_ACTION_MESSAGE), message)
                .apply();
    }

    /** 记录两段式确认；30 秒后由 {@link #getPendingAction(int)} 惰性清除。 */
    void setPending(int appWidgetId, String action, long now) {
        preferences.edit()
                .putString(actionKey(appWidgetId, KEY_PENDING_ACTION), action)
                .putLong(actionKey(appWidgetId, KEY_PENDING_EXPIRES), now + WidgetContract.PENDING_TTL_MS)
                .apply();
    }

    /** 返回未过期的 pending 动作（on/off）；过期或不存在返回 null 并清除。 */
    String getPendingAction(int appWidgetId) {
        String action = preferences.getString(actionKey(appWidgetId, KEY_PENDING_ACTION), null);
        if (action == null) {
            return null;
        }
        long expiresAt = preferences.getLong(actionKey(appWidgetId, KEY_PENDING_EXPIRES), 0L);
        if (expiresAt <= System.currentTimeMillis()
                || (!WidgetContract.ACTION_ON.equals(action) && !WidgetContract.ACTION_OFF.equals(action))) {
            clearPending(appWidgetId);
            return null;
        }
        return action;
    }

    void clearPending(int appWidgetId) {
        preferences.edit()
                .remove(actionKey(appWidgetId, KEY_PENDING_ACTION))
                .remove(actionKey(appWidgetId, KEY_PENDING_EXPIRES))
                .apply();
    }

    /** onDeleted：清理该实例的全部小组件数据。 */
    void clearWidget(int appWidgetId) {
        preferences.edit()
                .remove(actionKey(appWidgetId, KEY_PENDING_ACTION))
                .remove(actionKey(appWidgetId, KEY_PENDING_EXPIRES))
                .remove(actionKey(appWidgetId, KEY_ACTION_AT))
                .remove(actionKey(appWidgetId, KEY_ACTION_MESSAGE))
                .apply();
    }

    private static String actionKey(int appWidgetId, String template) {
        return String.format(java.util.Locale.ROOT, template, appWidgetId);
    }
}
