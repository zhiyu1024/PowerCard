/* ==========================================================================
   远程电脑控制 · 前端应用（原生 ES Module，无构建）
   契约见 docs/api-contract.md，视觉见 docs/design-spec.md
   ========================================================================== */

const DEFAULT_CONFIG = Object.freeze({
  statusUrl: "",
  powerOnUrl: "",
  powerOffUrl: "",
  rebootUrl: "",
  lanAddress: "",
  wanAddress: "",
  subnetMask: "",
  gateway: "",
  macAddress: "",
  pollIntervalSec: 10,
  requestTimeoutMs: 5000,
  confirmActions: true,
  powerField: "",
  onlineField: "",
});

const TEXT_FIELDS = [
  "statusUrl",
  "powerOnUrl",
  "powerOffUrl",
  "rebootUrl",
  "wanAddress",
  "lanAddress",
  "subnetMask",
  "gateway",
  "macAddress",
  "powerField",
  "onlineField",
];

const URL_FIELDS = ["statusUrl", "powerOnUrl", "powerOffUrl", "rebootUrl"];
const ADDRESS_FIELDS = ["wanAddress", "lanAddress", "subnetMask", "gateway"];
const ERROR_ID_MAP = { requestTimeoutMs: "requestTimeoutSec" };
const KIND_LABELS = { status: "状态", command: "指令", test: "测试" };
const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  config: { ...DEFAULT_CONFIG },
  configLoaded: false,
  mode: null,
  status: null,
  statusError: null,
  initialLoading: true,
  statusInFlight: null,
  refreshing: false,
  commandBusy: false,
  busyAction: null,
  pollTimer: null,
  lastFocus: null,
  restoreSettingsFocus: true,
  settingsClosing: false,
  confirmAction: null,
  confirmTrigger: null,
  confirmReturnFocus: null,
  restoreConfirmFocus: true,
  confirmClosing: false,
  saveBusy: false,
  testBusy: false,
  logsBusy: false,
  logs: null,
  formDirty: false,
  toastTimer: null,
};

const els = {};
let configLoadPromise = null;

/* --------------------------------------------------------------------------
   小工具
   -------------------------------------------------------------------------- */

function $(id) {
  return document.getElementById(id);
}

function setText(node, value) {
  if (!node) return;
  const text = value === null || value === undefined ? "" : String(value);
  if (node.textContent !== text) node.textContent = text;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatClock(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatLatency(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value)} ms`
    : "—";
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function createSvgIcon(id, className = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${id}`);
  svg.appendChild(use);
  return svg;
}

function elem(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function hostOf(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`http://${text}`).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
}

function isPrivateHost(host) {
  if (!host) return true;
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host)) return true;
  if (/\.(local|lan|home|internal)$/.test(host)) return true;
  return false;
}

function toOpenableUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    /* 继续尝试补全协议 */
  }
  if (text.includes("://") || /\s/.test(text)) return null;
  try {
    const url = new URL(`http://${text}`);
    if (url.hostname) return url.href;
  } catch {
    /* 无效地址 */
  }
  return null;
}

/* --------------------------------------------------------------------------
   接口请求
   -------------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.code = options.code || "UNKNOWN";
    this.httpStatus =
      typeof options.httpStatus === "number" ? options.httpStatus : null;
    this.fields =
      options.fields && typeof options.fields === "object"
        ? options.fields
        : null;
  }
}

async function apiRequest(path, options = {}) {
  const method = options.method || "GET";
  const timeoutMs =
    typeof options.timeoutMs === "number" ? options.timeoutMs : 12000;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  try {
    const response = await fetch(path, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      cache: "no-store",
      credentials: "same-origin",
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const error = data && data.error;
      throw new ApiError(
        (error && error.message) || `请求失败（HTTP ${response.status}）`,
        {
          code: (error && error.code) || "HTTP",
          httpStatus: response.status,
          fields: error && error.fields,
        }
      );
    }

    if (data === null) {
      throw new ApiError("服务返回了无法解析的内容", {
        code: "PARSE",
        httpStatus: response.status,
      });
    }

    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error && error.name === "AbortError") {
      throw new ApiError("请求超时，请检查网络或接口地址", { code: "TIMEOUT" });
    }
    throw new ApiError("无法连接，请检查网络或接口地址", { code: "NETWORK" });
  } finally {
    window.clearTimeout(timer);
  }
}

function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== "object") return config;

  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (key === "confirmActions") {
      config[key] = value === true || value === "true";
    } else if (key === "pollIntervalSec" || key === "requestTimeoutMs") {
      const number = Number(value);
      config[key] = Number.isFinite(number) ? number : DEFAULT_CONFIG[key];
    } else {
      config[key] = String(value);
    }
  }

  config.pollIntervalSec = clamp(
    Math.round(config.pollIntervalSec),
    5,
    300
  );
  config.requestTimeoutMs = clamp(
    Math.round(config.requestTimeoutMs),
    1000,
    30000
  );
  return config;
}

/* --------------------------------------------------------------------------
   启动
   -------------------------------------------------------------------------- */

function cacheElements() {
  const ids = [
    "subtitle",
    "settingsBtn",
    "main",
    "hero",
    "heroIcon",
    "heroTitle",
    "heroStatus",
    "heroStatusText",
    "heroMetaRow",
    "heroMeta",
    "demoBadge",
    "heroWarning",
    "powerOnBtn",
    "powerOnLabel",
    "powerOffBtn",
    "powerOffLabel",
    "rebootBtn",
    "rebootLabel",
    "refreshBtn",
    "confirmDialog",
    "confirmCard",
    "confirmIcon",
    "confirmIconUse",
    "confirmTitle",
    "confirmDesc",
    "confirmCancel",
    "confirmOk",
    "settingsDialog",
    "drawer",
    "settingsClose",
    "drawerBody",
    "drawerNotice",
    "settingsForm",
    "settingsCancel",
    "settingsSave",
    "statusUrl",
    "statusUrlError",
    "powerOnUrl",
    "powerOnUrlError",
    "powerOffUrl",
    "powerOffUrlError",
    "rebootUrl",
    "rebootUrlError",
    "wanAddress",
    "wanAddressOpen",
    "wanAddressError",
    "lanAddress",
    "lanAddressOpen",
    "lanAddressError",
    "subnetMask",
    "subnetMaskError",
    "gateway",
    "gatewayError",
    "macAddress",
    "macAddressError",
    "powerField",
    "powerFieldError",
    "onlineField",
    "onlineFieldError",
    "pollIntervalSec",
    "pollIntervalSecError",
    "requestTimeoutSec",
    "requestTimeoutSecError",
    "confirmActions",
    "confirmActionsError",
    "testBtn",
    "testResult",
    "rawDetails",
    "rawMeta",
    "copyRawBtn",
    "rawBody",
    "loadLogsBtn",
    "logsBox",
    "debugMode",
    "debugSource",
    "toast",
    "toastText",
  ];
  for (const id of ids) els[id] = $(id);
}

function init() {
  cacheElements();
  bindEvents();
  updateAddressLinks();
  renderAll();
  registerServiceWorker();
  void loadConfig();
  void refreshStatus({ initial: true });
}

function bindEvents() {
  els.settingsBtn.addEventListener("click", openSettings);
  els.settingsClose.addEventListener("click", () => closeSettings());
  els.settingsCancel.addEventListener("click", () => closeSettings());
  els.settingsDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSettings();
  });
  els.settingsDialog.addEventListener("click", (event) => {
    if (event.target === els.settingsDialog) closeSettings();
  });
  els.settingsDialog.addEventListener("keydown", trapFocus);
  els.settingsDialog.addEventListener("close", onSettingsClosed);

  els.settingsForm.addEventListener("submit", saveSettings);
  els.settingsForm.addEventListener("input", onFormChanged);
  els.settingsForm.addEventListener("change", onFormChanged);

  els.confirmCancel.addEventListener("click", () => closeConfirm());
  els.confirmOk.addEventListener("click", onConfirmAccepted);
  els.confirmDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeConfirm();
  });
  els.confirmDialog.addEventListener("click", (event) => {
    if (event.target === els.confirmDialog) closeConfirm();
  });
  els.confirmDialog.addEventListener("keydown", trapFocus);
  els.confirmDialog.addEventListener("close", onConfirmClosed);

  els.powerOnBtn.addEventListener("click", () =>
    requestAction("on", els.powerOnBtn)
  );
  els.powerOffBtn.addEventListener("click", () =>
    requestAction("off", els.powerOffBtn)
  );
  els.rebootBtn.addEventListener("click", () =>
    requestAction("reboot", els.rebootBtn)
  );
  els.refreshBtn.addEventListener("click", manualRefresh);

  els.testBtn.addEventListener("click", runTest);
  els.copyRawBtn.addEventListener("click", copyRawResponse);
  els.loadLogsBtn.addEventListener("click", loadLogs);

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("offline", () => {
    showToast("网络已断开，请检查连接", "error");
  });
  window.addEventListener("online", () => {
    showToast("网络已恢复");
    if (!document.hidden) void refreshStatus({});
  });
}

function registerServiceWorker() {
  if (window.__POWERCARD_NATIVE__) return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* Service Worker 注册失败时静默降级 */
    });
  });
}

/* --------------------------------------------------------------------------
   配置加载
   -------------------------------------------------------------------------- */

function loadConfig() {
  if (configLoadPromise) return configLoadPromise;
  configLoadPromise = (async () => {
    try {
      const data = await apiRequest("/api/config", { timeoutMs: 10000 });
      if (data && data.config) {
        state.config = normalizeConfig(data.config);
        state.configLoaded = true;
      }
      if (data && typeof data.mode === "string") state.mode = data.mode;
      renderAll();
      return data;
    } catch {
      state.configLoaded = false;
      return null;
    } finally {
      configLoadPromise = null;
    }
  })();
  return configLoadPromise;
}

/* --------------------------------------------------------------------------
   状态轮询与渲染
   -------------------------------------------------------------------------- */

function refreshStatus(options = {}) {
  const { force = false, manual = false, initial = false } = options;

  if (state.statusInFlight) {
    if (manual || force) {
      state.refreshing = true;
      renderControls();
      const current = state.statusInFlight;
      return current
        .then(() => {
          if (document.hidden) return null;
          return refreshStatus({ force: true });
        })
        .finally(() => {
          state.refreshing = false;
          renderControls();
        });
    }
    return state.statusInFlight;
  }

  if (initial) state.initialLoading = true;
  if (manual) state.refreshing = true;
  renderAll();

  const configTimeout = Number(state.config.requestTimeoutMs) || 5000;
  const timeoutMs = state.configLoaded
    ? Math.max(8000, configTimeout + 4000)
    : 40000;
  const url = `/api/status${force ? "?refresh=1" : ""}`;

  const promise = (async () => {
    try {
      const data = await apiRequest(url, { timeoutMs });
      state.status = data;
      state.statusError = null;
      if (data && typeof data.mode === "string") state.mode = data.mode;
      if (!state.configLoaded) void loadConfig();
      return data;
    } catch (error) {
      state.statusError =
        error instanceof ApiError
          ? error
          : new ApiError("状态获取失败", { code: "NETWORK" });
      return null;
    } finally {
      state.initialLoading = false;
      state.statusInFlight = null;
      state.refreshing = false;
      renderAll();
      schedulePoll();
    }
  })();

  state.statusInFlight = promise;
  return promise;
}

function clearPollTimer() {
  if (state.pollTimer !== null) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function schedulePoll() {
  clearPollTimer();
  if (document.hidden) return;
  const seconds = clamp(
    Math.round(Number(state.config.pollIntervalSec) || 10),
    5,
    300
  );
  state.pollTimer = window.setTimeout(async () => {
    state.pollTimer = null;
    if (document.hidden) return;
    await refreshStatus({});
  }, seconds * 1000);
}

function onVisibilityChange() {
  if (document.hidden) {
    clearPollTimer();
    return;
  }
  clearPollTimer();
  void refreshStatus({});
}

function manualRefresh() {
  if (state.refreshing) return;
  void refreshStatus({ force: true, manual: true });
}

function getView() {
  const demo =
    state.mode === "demo" || Boolean(state.status && state.status.mode === "demo");

  if (state.initialLoading && !state.status && !state.statusError) {
    return {
      phase: "loading",
      title: "正在连接…",
      loading: true,
      online: "checking",
      meta: "正在获取设备状态…",
      metaTone: "normal",
      demo: false,
      warning: null,
      canOperate: false,
    };
  }

  if (state.statusError) {
    const isTimeout = state.statusError.code === "TIMEOUT";
    return {
      phase: "error",
      title: "状态未知",
      loading: false,
      online: "offline",
      meta: `${isTimeout ? "请求服务超时" : "无法连接服务"} · 点击右上角检查设置`,
      metaTone: "error",
      demo,
      warning: null,
      canOperate: false,
    };
  }

  const status = state.status;
  if (!status) {
    return {
      phase: "loading",
      title: "正在连接…",
      loading: true,
      online: "checking",
      meta: "正在获取设备状态…",
      metaTone: "normal",
      demo,
      warning: null,
      canOperate: false,
    };
  }

  if (status.ok === false) {
    return {
      phase: "error",
      title: "状态未知",
      loading: false,
      online: "offline",
      meta: `${describeStatusError(status.error)} · 点击右上角检查设置`,
      metaTone: "error",
      demo,
      warning: null,
      canOperate: false,
    };
  }

  const online = status.online === true;
  const power =
    status.power === "on" ? "on" : status.power === "off" ? "off" : "unknown";
  let title = status.powerLabel;
  if (!title) {
    title =
      power === "on" ? "电脑已开机" : power === "off" ? "电脑已关机" : "状态未知";
  }

  let phase = "unknown";
  if (!online) phase = "offline";
  else if (power === "on") phase = "on";
  else if (power === "off") phase = "off";

  return {
    phase,
    title,
    loading: false,
    online: online ? "online" : "offline",
    meta: demo
      ? "模拟设备已连接"
      : `最后更新 ${formatClock(status.fetchedAt)} · ${formatLatency(
          status.latencyMs
        )}`,
    metaTone: "normal",
    demo,
    warning:
      typeof status.warning === "string" && status.warning
        ? status.warning
        : null,
    canOperate: online,
  };
}

function describeStatusError(error) {
  if (!error || typeof error !== "object") return "状态获取失败";
  switch (error.code) {
    case "TIMEOUT":
      return "连接超时";
    case "NETWORK":
      return "无法访问设备";
    case "HTTP":
      return error.message || "设备返回异常状态";
    case "CONFIG":
      return "尚未配置状态接口";
    case "INVALID_URL":
      return "状态接口地址无效";
    case "PARSE":
      return "无法解析设备响应";
    default:
      return error.message || "状态获取失败";
  }
}

function connectionKind() {
  const host = hostOf(state.config.statusUrl);
  if (!host) return "局域网直连";
  const wanHost = hostOf(state.config.wanAddress);
  if (wanHost && wanHost === host) return "公网连接";
  if (isPrivateHost(host)) return "局域网直连";
  return "公网连接";
}

function renderSubtitle() {
  let text = "正在连接设备…";
  if (state.mode === "demo") {
    text = "界面演示 · 尚未连接设备";
  } else if (state.mode === "live") {
    const seconds = state.config.pollIntervalSec;
    text = `${connectionKind()} · 每 ${seconds} 秒刷新`;
  } else if (state.statusError) {
    text = "服务未连接 · 请检查设置";
  }
  setText(els.subtitle, text);
}

function renderHero() {
  const view = getView();
  if (!els.hero) return;

  els.hero.dataset.state = view.phase;
  els.hero.setAttribute("aria-busy", view.loading ? "true" : "false");

  if (view.loading) {
    if (!els.heroTitle.querySelector(".skeleton-bar")) {
      els.heroTitle.replaceChildren(
        elem("span", "skeleton-bar"),
        elem("span", "sr-only", "正在连接…")
      );
    }
  } else {
    setText(els.heroTitle, view.title);
  }

  els.heroStatus.dataset.state = view.online;
  setText(
    els.heroStatusText,
    view.online === "online"
      ? "开机卡在线"
      : view.online === "checking"
        ? "正在检查…"
        : "开机卡离线"
  );

  setText(els.heroMeta, view.meta);
  els.heroMetaRow.classList.toggle("is-error", view.metaTone === "error");
  els.heroMetaRow.setAttribute(
    "aria-live",
    view.metaTone === "error" ? "polite" : "off"
  );
  els.demoBadge.hidden = !view.demo;
  els.heroWarning.hidden = !view.warning;
  setText(els.heroWarning, view.warning || "");
}

function renderControls() {
  const view = getView();
  const busy = state.commandBusy;
  const disabled = !view.canOperate || busy;

  setActionButton(els.powerOnBtn, els.powerOnLabel, "on", disabled, "开机");
  setActionButton(els.powerOffBtn, els.powerOffLabel, "off", disabled, "关机");
  setActionButton(els.rebootBtn, els.rebootLabel, "reboot", disabled, "重启");

  els.refreshBtn.disabled = state.refreshing;
  els.refreshBtn.classList.toggle("is-spinning", state.refreshing);
  els.refreshBtn.setAttribute("aria-busy", state.refreshing ? "true" : "false");
}

function setActionButton(button, labelNode, action, disabled, label) {
  if (!button || !labelNode) return;
  const actionBusy = state.commandBusy && state.busyAction === action;
  button.disabled = disabled;
  button.setAttribute("aria-busy", actionBusy ? "true" : "false");
  setText(labelNode, actionBusy ? "发送中…" : label);
}

function renderDebug() {
  if (!els.debugMode) return;
  let label = "未知";
  let tone = "unknown";
  if (state.mode === "demo") {
    label = "演示模式";
    tone = "demo";
  } else if (state.mode === "live") {
    label = "真实设备";
    tone = "live";
  }
  setText(els.debugMode, label);
  els.debugMode.dataset.tone = tone;

  const source =
    (state.status && state.status.sourceUrl) || state.config.statusUrl || "";
  setText(els.debugSource, source || "—");
}

function renderRaw() {
  if (!els.rawBody) return;
  const status = state.status;
  const raw = status && status.raw;
  const hasRaw = Boolean(raw && typeof raw.body === "string" && raw.body);
  setText(
    els.rawBody,
    hasRaw ? raw.body : "暂无原始响应，请先刷新状态。"
  );
  els.copyRawBtn.disabled = !hasRaw;

  if (hasRaw) {
    const parts = [];
    if (status.fetchedAt) parts.push(formatClock(status.fetchedAt));
    if (status.httpStatus !== null && status.httpStatus !== undefined) {
      parts.push(`HTTP ${status.httpStatus}`);
    }
    if (raw.contentType) parts.push(raw.contentType);
    if (raw.truncated) parts.push("已截断");
    setText(els.rawMeta, parts.join(" · "));
  } else {
    setText(els.rawMeta, "暂无数据");
  }
}

function renderAll() {
  renderSubtitle();
  renderHero();
  renderControls();
  renderDebug();
  if (els.settingsDialog && els.settingsDialog.open) renderRaw();
}

/* --------------------------------------------------------------------------
   指令
   -------------------------------------------------------------------------- */

function requestAction(action, trigger) {
  if (state.commandBusy) return;
  if (!getView().canOperate) {
    showToast("开机卡当前离线，无法发送指令", "error");
    return;
  }
  if (state.config.confirmActions) {
    state.confirmTrigger = trigger || document.activeElement;
    openConfirm(action);
    return;
  }
  void executeCommand(action, trigger);
}

async function executeCommand(action, trigger) {
  if (state.commandBusy) return;
  if (!getView().canOperate) {
    showToast("开机卡当前离线，无法发送指令", "error");
    return;
  }

  state.commandBusy = true;
  state.busyAction = action;
  renderControls();

  const focusTarget = trigger instanceof HTMLElement ? trigger : null;
  const timeoutMs =
    Math.max(8000, (Number(state.config.requestTimeoutMs) || 5000) + 5000);

  try {
    const data = await apiRequest("/api/command", {
      method: "POST",
      body: { action },
      timeoutMs,
    });
    if (data && typeof data.mode === "string") state.mode = data.mode;

    if (data && data.ok) {
      showToast(
        (data && data.message) || "指令已发送",
        "success"
      );
      window.setTimeout(() => {
        void refreshStatus({ force: true });
      }, 1500);
    } else {
      const message =
        (data && data.message) ||
        (data && data.error && data.error.message) ||
        "指令发送失败";
      showToast(message, "error");
    }
  } catch (error) {
    showToast((error && error.message) || "指令发送失败", "error");
  } finally {
    state.commandBusy = false;
    state.busyAction = null;
    renderControls();
    if (
      focusTarget &&
      !focusTarget.disabled &&
      document.activeElement === document.body
    ) {
      focusTarget.focus({ preventScroll: true });
    }
  }
}

/* --------------------------------------------------------------------------
   确认弹窗
   -------------------------------------------------------------------------- */

function openConfirm(action) {
  if (els.confirmDialog.open) return;
  state.confirmAction = action;
  const active = document.activeElement;
  state.confirmReturnFocus =
    active instanceof HTMLElement && active !== document.body
      ? active
      : state.confirmTrigger;

  const isOn = action === "on";
  const isOff = action === "off";
  setText(
    els.confirmTitle,
    isOn ? "确认开机？" : isOff ? "确认关机？" : "确认重启？"
  );
  setText(
    els.confirmDesc,
    isOn
      ? "指令将发送到开机卡，电脑会开始启动。"
      : isOff
        ? "指令将发送到开机卡，电脑会立即关机。"
        : "电脑将立即重启。"
  );
  els.confirmIcon.dataset.tone = isOn ? "success" : isOff ? "danger" : "dark";
  els.confirmIconUse.setAttribute("href", isOn || isOff ? "#i-power" : "#i-reboot");
  setText(els.confirmOk, isOn ? "确认开机" : isOff ? "确认关机" : "确认重启");
  els.confirmOk.className = `btn ${
    isOn ? "btn-primary" : isOff ? "btn-danger" : "btn-dark"
  }`;

  els.confirmDialog.showModal();
  syncModalClass();
  els.confirmCancel.focus();
}

function closeConfirm({ restoreFocus = true } = {}) {
  if (!els.confirmDialog.open || state.confirmClosing) return;
  state.confirmClosing = true;
  state.restoreConfirmFocus = restoreFocus;
  els.confirmDialog.classList.add("is-closing");
  els.confirmCard.classList.add("is-closing");
  const delay = prefersReducedMotion() ? 0 : 170;
  window.setTimeout(() => {
    if (els.confirmDialog.open) els.confirmDialog.close();
  }, delay);
}

function onConfirmAccepted() {
  const action = state.confirmAction;
  const trigger = state.confirmTrigger;
  state.restoreConfirmFocus = false;
  closeConfirm({ restoreFocus: false });
  if (action) void executeCommand(action, trigger);
}

function onConfirmClosed() {
  els.confirmDialog.classList.remove("is-closing");
  els.confirmCard.classList.remove("is-closing");
  state.confirmClosing = false;
  state.confirmAction = null;
  state.confirmTrigger = null;
  syncModalClass();
  rehomeToast();

  if (
    state.restoreConfirmFocus !== false &&
    state.confirmReturnFocus instanceof HTMLElement &&
    document.contains(state.confirmReturnFocus)
  ) {
    state.confirmReturnFocus.focus({ preventScroll: true });
  }
  state.restoreConfirmFocus = true;
  state.confirmReturnFocus = null;
}

/* --------------------------------------------------------------------------
   设置抽屉
   -------------------------------------------------------------------------- */

function openSettings() {
  if (els.settingsDialog.open) return;
  const active = document.activeElement;
  state.lastFocus =
    active instanceof HTMLElement && active !== document.body
      ? active
      : els.settingsBtn;
  state.formDirty = false;
  clearAllFieldErrors();
  hideDrawerNotice();
  populateSettingsForm();
  renderDebug();
  renderRaw();

  els.settingsDialog.showModal();
  syncModalClass();
  els.settingsBtn.setAttribute("aria-expanded", "true");
  els.settingsClose.focus();

  if (!state.configLoaded) {
    setDrawerNotice("正在读取当前设置…", "info");
    void loadConfig().then((data) => {
      if (!els.settingsDialog.open) return;
      if (!data) {
        setDrawerNotice("无法读取当前设置，可继续编辑并尝试保存。", "error");
        return;
      }
      if (state.formDirty) {
        setDrawerNotice("已读取服务器设置，但表单已有改动，未覆盖输入。", "info");
        return;
      }
      hideDrawerNotice();
      populateSettingsForm();
      renderDebug();
      renderRaw();
    });
  }
}

function closeSettings(options = {}) {
  const { restoreFocus = true } = options;
  if (!els.settingsDialog.open) return;
  if (state.saveBusy) return;
  if (state.settingsClosing) return;

  state.settingsClosing = true;
  state.restoreSettingsFocus = restoreFocus;
  els.drawer.classList.add("is-closing");
  els.settingsDialog.classList.add("is-closing");
  const delay = prefersReducedMotion() ? 0 : 210;
  window.setTimeout(() => {
    if (els.settingsDialog.open) els.settingsDialog.close();
  }, delay);
}

function onSettingsClosed() {
  els.drawer.classList.remove("is-closing");
  els.settingsDialog.classList.remove("is-closing");
  state.settingsClosing = false;
  els.settingsBtn.setAttribute("aria-expanded", "false");
  syncModalClass();
  rehomeToast();

  if (state.restoreSettingsFocus !== false) {
    const last = state.lastFocus;
    const target =
      last instanceof HTMLElement &&
      document.contains(last) &&
      !els.settingsDialog.contains(last)
        ? last
        : els.settingsBtn;
    target.focus({ preventScroll: true });
  }
  state.restoreSettingsFocus = true;
  state.lastFocus = null;
}

function populateSettingsForm() {
  for (const id of TEXT_FIELDS) {
    const input = els[id];
    if (input) input.value = state.config[id] || "";
  }

  ensureSelectOption(els.pollIntervalSec, state.config.pollIntervalSec);
  els.pollIntervalSec.value = String(state.config.pollIntervalSec);

  const timeoutSec = Number(
    (state.config.requestTimeoutMs / 1000).toFixed(2)
  );
  ensureSelectOption(els.requestTimeoutSec, timeoutSec);
  els.requestTimeoutSec.value = String(timeoutSec);

  els.confirmActions.checked = state.config.confirmActions !== false;
  updateAddressLinks();
}

function ensureSelectOption(select, value) {
  if (!select) return;
  const stringValue = String(value);
  const exists = Array.from(select.options).some(
    (option) => option.value === stringValue
  );
  if (!exists) {
    const option = document.createElement("option");
    option.value = stringValue;
    option.textContent = `${stringValue} 秒`;
    select.appendChild(option);
  }
}

function onFormChanged(event) {
  state.formDirty = true;
  const target = event.target;
  if (target && target.id) clearFieldError(target.id);
  updateAddressLinks();
}

function updateAddressLinks() {
  const pairs = [
    ["wanAddress", "wanAddressOpen"],
    ["lanAddress", "lanAddressOpen"],
  ];
  for (const [inputId, linkId] of pairs) {
    const input = els[inputId];
    const link = els[linkId];
    if (!input || !link) continue;
    const href = toOpenableUrl(input.value);
    if (href) {
      link.href = href;
      link.hidden = false;
    } else {
      link.hidden = true;
      link.removeAttribute("href");
    }
  }
}

function clearFieldError(id) {
  if (!id) return;
  const input = els[id];
  const error = els[`${id}Error`];
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  if (input) input.removeAttribute("aria-invalid");
}

function clearAllFieldErrors() {
  for (const id of Object.keys(els)) {
    if (id.endsWith("Error")) {
      const fieldId = id.slice(0, -"Error".length);
      clearFieldError(fieldId);
    }
  }
}

function setFieldError(id, message) {
  const input = els[id];
  const error = els[`${id}Error`];
  if (!input || !error) return;
  error.textContent = message;
  error.hidden = false;
  input.setAttribute("aria-invalid", "true");
}

function applyFieldErrors(fields) {
  clearAllFieldErrors();
  let firstInvalid = null;
  for (const [key, value] of Object.entries(fields)) {
    const inputId = ERROR_ID_MAP[key] || key;
    if (!els[inputId] || !els[`${inputId}Error`]) continue;
    setFieldError(inputId, String(value));
    if (!firstInvalid) firstInvalid = els[inputId];
  }
  if (firstInvalid) {
    firstInvalid.focus({ preventScroll: false });
    if (typeof firstInvalid.scrollIntoView === "function") {
      firstInvalid.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

function setDrawerNotice(message, tone = "info") {
  if (!els.drawerNotice) return;
  els.drawerNotice.textContent = message;
  els.drawerNotice.dataset.tone = tone;
  els.drawerNotice.hidden = false;
}

function hideDrawerNotice() {
  if (!els.drawerNotice) return;
  els.drawerNotice.hidden = true;
  els.drawerNotice.textContent = "";
  delete els.drawerNotice.dataset.tone;
}

/* --------------------------------------------------------------------------
   表单校验与保存
   -------------------------------------------------------------------------- */

function collectFormConfig() {
  const config = { ...state.config };
  for (const id of TEXT_FIELDS) {
    config[id] = els[id] ? String(els[id].value).trim() : "";
  }
  config.pollIntervalSec = clamp(
    Math.round(Number(els.pollIntervalSec.value) || 10),
    5,
    300
  );
  config.requestTimeoutMs = clamp(
    Math.round((Number(els.requestTimeoutSec.value) || 5) * 1000),
    1000,
    30000
  );
  config.confirmActions = els.confirmActions.checked;
  return config;
}

function validateUrl(value) {
  if (!value) return "";
  if (value.length > 2048) return "URL 不能超过 2048 个字符";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "URL 必须以 http:// 或 https:// 开头";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "URL 必须以 http:// 或 https:// 开头";
  }
  if (url.hash) return "URL 不能包含 # 片段";
  return "";
}

function validateAddress(value) {
  if (!value) return "";
  if (value.length > 255) return "不能超过 255 个字符";
  if (/\s/.test(value)) return "不能包含空格或换行";
  return "";
}

function validateMac(value) {
  if (!value) return "";
  const patterns = [
    /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i,
    /^[0-9a-f]{4}(\.[0-9a-f]{4}){2}$/i,
    /^[0-9a-f]{12}$/i,
  ];
  if (!patterns.some((pattern) => pattern.test(value))) {
    return "MAC 地址格式不正确，如 AA:BB:CC:DD:EE:FF";
  }
  return "";
}

function validateFormConfig(config) {
  const errors = {};
  for (const id of URL_FIELDS) {
    const message = validateUrl(config[id]);
    if (message) errors[id] = message;
  }
  for (const id of ADDRESS_FIELDS) {
    const message = validateAddress(config[id]);
    if (message) errors[id] = message;
  }
  const macMessage = validateMac(config.macAddress);
  if (macMessage) errors.macAddress = macMessage;
  if (config.powerField.length > 255) {
    errors.powerField = "字段路径不能超过 255 个字符";
  }
  if (config.onlineField.length > 255) {
    errors.onlineField = "字段路径不能超过 255 个字符";
  }
  return errors;
}

async function saveSettings(event) {
  event.preventDefault();
  if (state.saveBusy) return;

  hideDrawerNotice();
  const config = collectFormConfig();
  const errors = validateFormConfig(config);
  if (Object.keys(errors).length > 0) {
    applyFieldErrors(errors);
    showToast("请检查标红的设置项", "error");
    return;
  }

  state.saveBusy = true;
  setSaveState(true);

  try {
    const data = await apiRequest("/api/config", {
      method: "PUT",
      body: config,
      timeoutMs: 15000,
    });

    state.config =
      data && data.config ? normalizeConfig(data.config) : normalizeConfig(config);
    state.configLoaded = true;
    if (data && typeof data.mode === "string") state.mode = data.mode;

    state.saveBusy = false;
    setSaveState(false);
    renderAll();
    closeSettings();
    showToast("设置已保存并应用", "success");
    schedulePoll();
    void refreshStatus({ force: true });
  } catch (error) {
    const fields = error && error.fields;
    if (fields && typeof fields === "object" && Object.keys(fields).length) {
      const known = {};
      const extra = [];
      for (const [key, value] of Object.entries(fields)) {
        const inputId = ERROR_ID_MAP[key] || key;
        if (els[inputId] && els[`${inputId}Error`]) {
          known[inputId] = String(value);
        } else {
          extra.push(String(value));
        }
      }
      if (Object.keys(known).length) applyFieldErrors(known);
      setDrawerNotice(
        extra.length ? extra.join("；") : "有设置项需要检查，请查看标红提示。",
        "error"
      );
      showToast("有设置项需要检查", "error");
    } else {
      setDrawerNotice(
        (error && error.message) || "保存失败，请稍后再试。",
        "error"
      );
      showToast("保存失败，请稍后再试", "error");
    }
  } finally {
    if (state.saveBusy) {
      state.saveBusy = false;
      setSaveState(false);
    }
  }
}

function setSaveState(busy) {
  if (!els.settingsSave) return;
  els.settingsSave.disabled = busy;
  els.settingsSave.textContent = busy ? "保存中…" : "保存并应用";
  els.settingsSave.setAttribute("aria-busy", busy ? "true" : "false");
  els.settingsCancel.disabled = busy;
  els.settingsClose.disabled = busy;
}

/* --------------------------------------------------------------------------
   连接测试
   -------------------------------------------------------------------------- */

async function runTest() {
  if (state.testBusy) return;

  clearFieldError("statusUrl");
  const config = collectFormConfig();
  const urlError = validateUrl(config.statusUrl);
  if (urlError) {
    setFieldError("statusUrl", urlError);
    els.statusUrl.focus();
    return;
  }
  if (!config.statusUrl) {
    setFieldError("statusUrl", "请先填写状态查询 URL 再测试");
    els.statusUrl.focus();
    return;
  }

  state.testBusy = true;
  setTestState(true);
  renderTestLoading();

  try {
    const data = await apiRequest("/api/test", {
      method: "POST",
      body: {
        statusUrl: config.statusUrl,
        powerField: config.powerField,
        onlineField: config.onlineField,
        requestTimeoutMs: config.requestTimeoutMs,
      },
      timeoutMs: config.requestTimeoutMs + 5000,
    });
    renderTestResult(data);
  } catch (error) {
    renderTestFailure(error);
  } finally {
    state.testBusy = false;
    setTestState(false);
  }
}

function setTestState(busy) {
  if (!els.testBtn) return;
  els.testBtn.disabled = busy;
  els.testBtn.textContent = busy ? "测试中…" : "测试状态接口";
  els.testBtn.setAttribute("aria-busy", busy ? "true" : "false");
}

function renderTestLoading() {
  const root = els.testResult;
  root.hidden = false;
  root.dataset.tone = "loading";
  root.replaceChildren();
  const head = elem("div", "test-head");
  const spinner = elem("span", "spinner");
  head.appendChild(spinner);
  head.appendChild(elem("span", "", "正在测试状态接口…"));
  root.appendChild(head);
}

function renderTestResult(data) {
  const root = els.testResult;
  const ok = Boolean(data && data.ok === true);
  root.hidden = false;
  root.dataset.tone = ok ? "ok" : "error";
  root.replaceChildren();

  const head = elem("div", "test-head");
  const iconWrap = elem("span", "test-icon");
  iconWrap.appendChild(createSvgIcon(ok ? "i-check" : "i-alert"));
  head.appendChild(iconWrap);
  head.appendChild(elem("span", "", ok ? "接口可用" : "连接失败"));
  root.appendChild(head);

  const chips = elem("div", "test-chips");
  chips.appendChild(chip("在线", data.online ? "在线" : "离线", data.online ? "ok" : "error"));
  const powerText =
    data.power === "on"
      ? "已开机"
      : data.power === "off"
        ? "已关机"
        : "未知";
  chips.appendChild(
    chip("电源", powerText, data.power === "on" ? "ok" : data.power === "off" ? "" : "error")
  );
  chips.appendChild(
    chip(
      "耗时",
      typeof data.latencyMs === "number" ? `${Math.round(data.latencyMs)} ms` : "—"
    )
  );
  chips.appendChild(
    chip("HTTP", data.httpStatus === null || data.httpStatus === undefined ? "—" : String(data.httpStatus))
  );
  root.appendChild(chips);

  let noteText = "";
  let noteTone = "normal";
  if (!ok && data.error && data.error.message) {
    noteText = data.error.message;
    noteTone = "error";
  } else if (data.warning) {
    noteText = data.warning;
    noteTone = "warn";
  }
  if (noteText) {
    const note = elem("p", "test-note", noteText);
    if (noteTone === "error") note.dataset.tone = "error";
    root.appendChild(note);
  }

  if (data.raw && typeof data.raw.body === "string" && data.raw.body) {
    root.appendChild(buildRawDetails(data.raw, data.httpStatus, "查看测试原始响应"));
  }

  if (data.sourceUrl) {
    root.appendChild(elem("p", "test-source", data.sourceUrl));
  }
}

function renderTestFailure(error) {
  const root = els.testResult;
  root.hidden = false;
  root.dataset.tone = "error";
  root.replaceChildren();

  const head = elem("div", "test-head");
  const iconWrap = elem("span", "test-icon");
  iconWrap.appendChild(createSvgIcon("i-alert"));
  head.appendChild(iconWrap);
  head.appendChild(elem("span", "", "请求失败"));
  root.appendChild(head);
  root.appendChild(
    elem("p", "test-note", (error && error.message) || "连接测试失败")
  );
}

function chip(label, value, tone) {
  const span = elem("span", "chip");
  if (tone) span.dataset.tone = tone;
  span.appendChild(elem("span", "", label));
  span.appendChild(elem("b", "", value));
  return span;
}

function buildRawDetails(raw, httpStatus, summaryText) {
  const details = elem("details", "raw-details");
  details.appendChild(elem("summary", "", summaryText || "查看原始响应"));
  const panel = elem("div", "raw-panel");
  const toolbar = elem("div", "raw-toolbar");

  const metaParts = [];
  if (httpStatus !== null && httpStatus !== undefined) {
    metaParts.push(`HTTP ${httpStatus}`);
  }
  metaParts.push(raw.contentType || "未知类型");
  if (raw.truncated) metaParts.push("已截断");
  toolbar.appendChild(elem("span", "raw-meta", metaParts.join(" · ")));

  const copyButton = elem("button", "mini-btn", "复制");
  copyButton.type = "button";
  copyButton.addEventListener("click", () => copyText(raw.body));
  toolbar.appendChild(copyButton);
  panel.appendChild(toolbar);

  const pre = elem("pre", "raw-body", raw.body);
  pre.tabIndex = 0;
  panel.appendChild(pre);
  details.appendChild(panel);
  return details;
}

/* --------------------------------------------------------------------------
   原始响应 / 日志 / 复制
   -------------------------------------------------------------------------- */

async function copyRawResponse() {
  const raw = state.status && state.status.raw;
  if (!raw || !raw.body) return;
  await copyText(raw.body);
}

async function copyText(text) {
  const value = String(text === undefined || text === null ? "" : text);
  if (!value) return;
  try {
    if (
      window.PowerCardNative &&
      typeof window.PowerCardNative.copyText === "function"
    ) {
      window.PowerCardNative.copyText(value);
      showToast("已复制到剪贴板");
      return;
    }
  } catch {
    /* 原生剪贴板失败时走 Web 方案 */
  }
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      showToast("已复制到剪贴板");
      return;
    }
  } catch {
    /* 使用备用方案 */
  }
  if (fallbackCopy(value)) {
    showToast("已复制到剪贴板");
  } else {
    showToast("复制失败，请手动选择文本", "error");
  }
}

function fallbackCopy(text) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.className = "sr-only";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

async function loadLogs() {
  if (state.logsBusy) return;
  state.logsBusy = true;
  updateLogsButton();

  try {
    const data = await apiRequest("/api/logs", { timeoutMs: 10000 });
    state.logs = data && Array.isArray(data.logs) ? data.logs : [];
    renderLogs();
  } catch (error) {
    const root = els.logsBox;
    root.replaceChildren(
      elem(
        "p",
        "log-empty log-error",
        `日志加载失败：${(error && error.message) || "请稍后再试"}`
      )
    );
  } finally {
    state.logsBusy = false;
    updateLogsButton();
  }
}

function updateLogsButton() {
  if (!els.loadLogsBtn) return;
  els.loadLogsBtn.disabled = state.logsBusy;
  els.loadLogsBtn.textContent = state.logsBusy
    ? "加载中…"
    : state.logs
      ? "刷新最近请求"
      : "加载最近请求";
}

function renderLogs() {
  const root = els.logsBox;
  root.replaceChildren();
  const logs = Array.isArray(state.logs) ? state.logs : [];
  if (logs.length === 0) {
    root.appendChild(elem("p", "log-empty", "暂无请求记录。"));
    return;
  }
  for (const log of logs.slice(0, 30)) {
    root.appendChild(buildLogItem(log));
  }
}

function buildLogItem(log) {
  const item = elem("article", "log-item");
  const line = elem("div", "log-line");

  const kind = elem("span", "log-kind", KIND_LABELS[log.kind] || "请求");
  kind.dataset.kind = log.kind || "";
  line.appendChild(kind);
  line.appendChild(elem("span", "log-time", formatClock(log.at)));

  const http = elem(
    "span",
    "log-http",
    log.httpStatus !== null && log.httpStatus !== undefined
      ? `HTTP ${log.httpStatus}`
      : log.ok
        ? "成功"
        : "失败"
  );
  http.dataset.tone = log.ok ? "ok" : "error";
  line.appendChild(http);

  line.appendChild(
    elem(
      "span",
      "log-latency",
      typeof log.latencyMs === "number" ? `${Math.round(log.latencyMs)} ms` : "—"
    )
  );
  item.appendChild(line);

  item.appendChild(
    elem("p", "log-url", `${log.method || "GET"} ${log.url || "—"}`)
  );

  const errorText =
    typeof log.error === "string"
      ? log.error
      : log.error && typeof log.error === "object"
        ? log.error.message || log.error.code || ""
        : "";
  if (errorText) item.appendChild(elem("p", "log-error", errorText));
  if (log.rawPreview) item.title = String(log.rawPreview);

  return item;
}

/* --------------------------------------------------------------------------
   Toast
   -------------------------------------------------------------------------- */

function showToast(message, tone = "success") {
  if (!els.toast || !els.toastText) return;

  const openDialog = document.querySelector("dialog[open]");
  if (openDialog && els.toast.parentElement !== openDialog) {
    openDialog.appendChild(els.toast);
  } else if (!openDialog && els.toast.parentElement !== document.body) {
    document.body.appendChild(els.toast);
  }

  els.toast.dataset.tone = tone;
  setText(els.toastText, message);
  els.toast.classList.add("is-visible");

  if (state.toastTimer !== null) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("is-visible");
    state.toastTimer = null;
  }, 3000);
}

function rehomeToast() {
  if (els.toast.parentElement && els.toast.parentElement !== document.body) {
    document.body.appendChild(els.toast);
  }
}

/* --------------------------------------------------------------------------
   弹窗通用：焦点圈定 / 遮罩滚动锁
   -------------------------------------------------------------------------- */

function getFocusable(root) {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    'input:not([disabled]):not([type="hidden"])',
    "select:not([disabled])",
    "textarea:not([disabled])",
    "summary",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");
  return Array.from(root.querySelectorAll(selector)).filter(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.getClientRects().length > 0
  );
}

function trapFocus(event) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const focusables = getFocusable(dialog);
  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (!active || !dialog.contains(active)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function syncModalClass() {
  const anyOpen = document.querySelector("dialog[open]");
  document.documentElement.classList.toggle("is-modal-open", Boolean(anyOpen));
}

/* --------------------------------------------------------------------------
   初始化
   -------------------------------------------------------------------------- */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
