/**
 * 设备状态解析器（docs/api-contract.md 第 5 节）。
 *
 * 解析策略（按优先级）：
 * 1. 手动字段路径（powerField / onlineField，支持 data.power、items.0.state）——最高优先级；
 * 2. JSON 自动识别：递归遍历对象（深度 ≤ 5），按候选键名 + 字段具体程度选择；
 * 3. 纯文本 / HTML：去标签、key=value 行、整体词元、关键词识别。
 *
 * 安全原则：
 * - 值无法映射为明确语义时一律忽略，不猜测；
 * - HTML 同时出现“开机”“关机”时不得猜测电源状态（页面上通常同时存在两个操作按钮）；
 * - “开机卡在线”这类文案不算电源状态（避免把设备名/标签误判为开机）。
 */

/** JSON 递归最大深度（根对象里的字段深度记为 1）。 */
const MAX_JSON_DEPTH = 5;

/**
 * 电源候选键名 → 优先级。
 * 3 = 语义明确的字段；1 = 泛化字段（state/status/switch），只有值能明确映射时才采用。
 */
const POWER_KEYS = new Map([
  ['power', 3],
  ['powerstate', 3],
  ['powerstatus', 3],
  ['pcpower', 3],
  ['pcstatus', 3],
  ['pcstate', 3],
  ['computerstatus', 3],
  ['onoff', 3],
  ['running', 2],
  ['state', 1],
  ['status', 1],
  ['switch', 1],
]);

/** 在线候选键名 → 优先级。 */
const ONLINE_KEYS = new Map([
  ['online', 3],
  ['onlinestatus', 3],
  ['cardonline', 3],
  ['isonline', 3],
  ['deviceonline', 3],
  ['connected', 3],
  ['connect', 2],
  ['link', 2],
  ['wifi', 2],
  ['networkstatus', 2],
]);

const POWER_ON_VALUES = new Set(['true', '1', 'on', 'open', '开机', '已开机', '运行', 'running', 'up', 'started']);
const POWER_OFF_VALUES = new Set(['false', '0', 'off', 'close', '关机', '已关机', '停止', 'stopped', 'down']);

// 在线映射按契约：true/1/"online"/"在线"/"connected"/"ok" 与 false/0/"offline"/"离线"/"disconnected"/"error"。
// 额外容忍字符串 "true"/"false"/"on"/"off"，部分开机卡会这样返回。
const ONLINE_ON_VALUES = new Set(['true', '1', 'on', 'online', '在线', 'connected', 'ok']);
const ONLINE_OFF_VALUES = new Set(['false', '0', 'off', 'offline', '离线', 'disconnected', 'error']);

/** 纯文本（非 key=value）整体匹配时使用的词表：不包含 1/0 这类有歧义的词元。 */
const POWER_TEXT_VALUES = new Map([
  ['on', 'on'],
  ['open', 'on'],
  ['开机', 'on'],
  ['已开机', 'on'],
  ['运行', 'on'],
  ['running', 'on'],
  ['up', 'on'],
  ['started', 'on'],
  ['off', 'off'],
  ['close', 'off'],
  ['关机', 'off'],
  ['已关机', 'off'],
  ['停止', 'off'],
  ['stopped', 'off'],
  ['down', 'off'],
]);

const ONLINE_TEXT_VALUES = new Map([
  ['online', true],
  ['在线', true],
  ['connected', true],
  ['ok', true],
  ['offline', false],
  ['离线', false],
  ['disconnected', false],
  ['error', false],
]);

const UNKNOWN_POWER_WARNING = '已连接，但无法识别电源状态；请在调试中指定字段或查看原始响应';
const POWER_UNKNOWN_LABEL = '状态未知';

/**
 * 键名归一化：小写，并去掉下划线、连字符与空白。
 * 例如 "Power State" / "power_state" / "power-state" 都归一化为 "powerstate"。
 * @param {unknown} key
 */
export function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[\s_\-]+/g, '');
}

/**
 * 把设备返回值映射为电源状态。
 * @param {unknown} value
 * @returns {'on' | 'off' | null} 无法明确映射时返回 null
 */
export function mapPowerValue(value) {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') {
    if (value === 1) return 'on';
    if (value === 0) return 'off';
    return null;
  }
  if (typeof value !== 'string') return null;
  const token = value.trim().toLowerCase();
  if (!token) return null;
  if (POWER_ON_VALUES.has(token)) return 'on';
  if (POWER_OFF_VALUES.has(token)) return 'off';
  return null;
}

/**
 * 把设备返回值映射为在线状态。
 * @param {unknown} value
 * @returns {boolean | null} 无法明确映射时返回 null
 */
export function mapOnlineValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== 'string') return null;
  const token = value.trim().toLowerCase();
  if (!token) return null;
  if (ONLINE_ON_VALUES.has(token)) return true;
  if (ONLINE_OFF_VALUES.has(token)) return false;
  return null;
}

/**
 * 解析点路径，支持数组下标：data.power、items.0.state。
 * @param {unknown} root
 * @param {string} dottedPath
 * @returns {unknown} 未命中返回 undefined（注意 JSON 里也可能存在 null 值）
 */
export function resolveFieldPath(root, dottedPath) {
  if (typeof dottedPath !== 'string' || !dottedPath.trim()) return undefined;
  const parts = dottedPath.trim().split('.');
  let current = root;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined;
      current = current[Number(part)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
      current = current[part];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * 判断对象是否像“API 响应信封”：同时存在 msg/message 与 data/result。
 * 这类响应里的 status/code 是接口状态码（0 表示成功），不是设备电源状态。
 * 真实设备示例：{"status":0,"msg":"OK","data":{"online":true,"power":"on"}}
 * 若把 status:0 当电源值，会把“接口调用成功”误读成“电脑已关机”。
 */
function looksLikeApiEnvelope(node) {
  const keys = new Set(Object.keys(node).map(normalizeKey));
  const hasMessage = keys.has('msg') || keys.has('message');
  const hasPayload = keys.has('data') || keys.has('result');
  return hasMessage && hasPayload;
}

/**
 * 广度优先遍历 JSON，收集命中候选键名的字段。
 * 广度优先保证浅层字段先入队；同一优先级下浅层字段优先。
 * @param {unknown} root
 */
function collectCandidates(root) {
  const candidates = [];
  const queue = [{ node: root, path: '', depth: 0 }];
  let order = 0;

  while (queue.length > 0) {
    const { node, path, depth } = queue.shift();
    if (node === null || typeof node !== 'object') continue;
    if (depth >= MAX_JSON_DEPTH) continue;

    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        queue.push({
          node: node[index],
          path: path ? `${path}.${index}` : String(index),
          depth: depth + 1,
        });
      }
      continue;
    }

    const envelope = looksLikeApiEnvelope(node);

    for (const [key, value] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      const normalized = normalizeKey(key);
      const powerPriority = POWER_KEYS.get(normalized);
      if (powerPriority !== undefined) {
        // 泛化键（state/status/switch）在 API 信封里大概率是接口状态码；
        // 只有字符串这类语义明确的值才采用，数字/布尔一律跳过。
        const ambiguousEnvelopeCode = envelope && powerPriority < 2 && typeof value !== 'string';
        if (!ambiguousEnvelopeCode) {
          candidates.push({ kind: 'power', path: childPath, value, priority: powerPriority, order: order++ });
        }
      }
      const onlinePriority = ONLINE_KEYS.get(normalized);
      if (onlinePriority !== undefined) {
        candidates.push({ kind: 'online', path: childPath, value, priority: onlinePriority, order: order++ });
      }
      if (value !== null && typeof value === 'object') {
        queue.push({ node: value, path: childPath, depth: depth + 1 });
      }
    }
  }

  return candidates;
}

/** 从候选里选择“最能明确映射”的电源字段：先看字段具体程度，再看浅层与出现顺序。 */
function pickPowerCandidate(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (candidate.kind !== 'power') continue;
    const mapped = mapPowerValue(candidate.value);
    if (!mapped) continue;
    if (!best || candidate.priority > best.priority || (candidate.priority === best.priority && candidate.order < best.order)) {
      best = { ...candidate, mapped };
    }
  }
  return best;
}

/** 与 pickPowerCandidate 同理，选择在线字段。 */
function pickOnlineCandidate(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (candidate.kind !== 'online') continue;
    const mapped = mapOnlineValue(candidate.value);
    if (mapped === null) continue;
    if (!best || candidate.priority > best.priority || (candidate.priority === best.priority && candidate.order < best.order)) {
      best = { ...candidate, mapped };
    }
  }
  return best;
}

const HTML_ENTITY_MAP = new Map([
  ['nbsp', ' '],
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** 解码常见 HTML 实体；`&amp;` 最后处理，避免二次解码。 */
function decodeEntities(text) {
  let output = text.replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
  output = output.replace(/&#(\d+);/g, (match, dec) => {
    const code = Number.parseInt(dec, 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
  output = output.replace(/&([a-z]+);/gi, (match, name) => {
    const key = String(name).toLowerCase();
    if (key === 'amp') return match; // 放到最后
    return HTML_ENTITY_MAP.get(key) ?? match;
  });
  output = output.replace(/&amp;/gi, '&');
  return output;
}

/** 去掉 HTML 标签，把块级换行保留为 \n，便于后续按行解析。 */
function stripHtmlTags(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|section|table|article|header|footer|button)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
}

/** 判断响应是否按 HTML 处理：content-type 或明显的 HTML 起始标签。 */
function looksLikeHtml(rawText, contentType) {
  if (/html/i.test(contentType)) return true;
  return /<\s*(!doctype|html|head|body|div|table|p|span|h[1-6]|button|section)\b/i.test(rawText);
}

/**
 * 纯文本 / HTML 解析。
 * 返回的 power/online 为 null 表示“无法明确识别”。
 */
function parseTextStatus(rawText, contentType) {
  const text = looksLikeHtml(rawText, contentType) ? decodeEntities(stripHtmlTags(rawText)) : decodeEntities(rawText);

  let power = null;
  let online = null;
  let powerPath = null;
  let onlinePath = null;

  // 1) 优先识别 key=value / key: value 行（例如 power=on、online: 1）
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 _\-.]{0,48})\s*[=:]\s*(.+?)\s*$/);
    if (!match) continue;
    const rawKey = match[1].trim();
    const rawValue = match[2]
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/[;,]$/, '')
      .trim();
    if (!rawValue) continue;
    const normalizedKey = normalizeKey(rawKey);

    if (power === null && POWER_KEYS.has(normalizedKey)) {
      const mapped = mapPowerValue(rawValue);
      if (mapped) {
        power = mapped;
        powerPath = rawKey;
      }
    }
    if (online === null && ONLINE_KEYS.has(normalizedKey)) {
      const mapped = mapOnlineValue(rawValue);
      if (mapped !== null) {
        online = mapped;
        onlinePath = rawKey;
      }
    }
  }

  // 2) 整体只有一个词元时直接映射（如响应体就是 "on" / "已开机"），
  //    但刻意不映射 "1"/"0"：整体文本里这两个值无法区分电源与在线。
  if (power === null) {
    const mapped = POWER_TEXT_VALUES.get(text.trim().toLowerCase());
    if (mapped) power = mapped;
  }
  if (online === null) {
    const mapped = ONLINE_TEXT_VALUES.get(text.trim().toLowerCase());
    if (mapped !== undefined) online = mapped;
  }

  // 3) 关键词兜底：同时出现开机/关机时视为不明确，绝不猜测。
  //    “开机卡”是设备名的一部分，用于排除“开机卡在线”这类文案的误判。
  if (power === null) {
    const hasOnKeyword = /已开机|开机(?!卡)|运行中|正在运行/.test(text);
    const hasOffKeyword = /已关机|关机(?!卡)/.test(text);
    if (hasOnKeyword && !hasOffKeyword) power = 'on';
    else if (!hasOnKeyword && hasOffKeyword) power = 'off';
  }

  if (online === null) {
    const hasOnlineKeyword = /在线/.test(text) || /\bonline\b/i.test(text);
    const hasOfflineKeyword = /离线/.test(text) || /\boffline\b/i.test(text);
    if (hasOnlineKeyword && !hasOfflineKeyword) online = true;
    else if (!hasOnlineKeyword && hasOfflineKeyword) online = false;
  }

  return { power, online, powerPath, onlinePath };
}

/**
 * 解析一次成功的设备状态响应。
 *
 * @param {object} input
 * @param {string} input.text      设备返回的原始文本
 * @param {string} [input.contentType]
 * @param {string} [input.powerField]  手动电源字段路径，空 = 自动
 * @param {string} [input.onlineField] 手动在线字段路径，空 = 自动
 * @returns {{
 *   power: 'on'|'off'|'unknown',
 *   online: boolean,
 *   onlineInferred: boolean,
 *   mapping: {powerField: string|null, onlineField: string|null} | null,
 *   warning: string | null,
 * }}
 */
export function parseStatusResponse({ text = '', contentType = '', powerField = '', onlineField = '' } = {}) {
  const rawText = typeof text === 'string' ? text : String(text ?? '');
  const trimmed = rawText.trim();

  let power = 'unknown';
  let online = null;
  let powerPath = null;
  let onlinePath = null;

  // 只要 content-type 是 JSON，或响应体看起来像 JSON，就先尝试 JSON 解析；
  // 解析失败则退回文本解析（部分设备会返回非 JSON 的错误页）。
  let json = null;
  if (/json/i.test(contentType) || /^[\[{]/.test(trimmed)) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = null;
    }
  }

  if (json !== null && typeof json === 'object') {
    // 1) 手动字段优先
    if (typeof powerField === 'string' && powerField.trim()) {
      const manual = resolveFieldPath(json, powerField);
      const mapped = mapPowerValue(manual);
      if (mapped) {
        power = mapped;
        powerPath = powerField.trim();
      }
    }
    if (typeof onlineField === 'string' && onlineField.trim()) {
      const manual = resolveFieldPath(json, onlineField);
      const mapped = mapOnlineValue(manual);
      if (mapped !== null) {
        online = mapped;
        onlinePath = onlineField.trim();
      }
    }

    // 2) 自动识别（手动字段未命中或无法映射时兜底）
    const candidates = collectCandidates(json);
    if (power === 'unknown') {
      const picked = pickPowerCandidate(candidates);
      if (picked) {
        power = picked.mapped;
        powerPath = picked.path;
      }
    }
    if (online === null) {
      const picked = pickOnlineCandidate(candidates);
      if (picked) {
        online = picked.mapped;
        onlinePath = picked.path;
      }
    }
  } else {
    const parsedText = parseTextStatus(rawText, contentType);
    power = parsedText.power ?? 'unknown';
    online = parsedText.online;
    powerPath = parsedText.powerPath;
    onlinePath = parsedText.onlinePath;
  }

  // 契约：在线字段未解析到时，“能访问即在线”，并标记 onlineInferred。
  const onlineInferred = online === null;
  const resolvedOnline = onlineInferred ? true : online;

  const mapping = powerPath || onlinePath ? { powerField: powerPath ?? null, onlineField: onlinePath ?? null } : null;
  const warning = power === 'unknown' ? UNKNOWN_POWER_WARNING : null;

  return { power, online: resolvedOnline, onlineInferred, mapping, warning };
}

/** 把电源状态翻译为契约规定的中文文案。 */
export function powerLabel(power) {
  if (power === 'on') return '电脑已开机';
  if (power === 'off') return '电脑已关机';
  return POWER_UNKNOWN_LABEL;
}
