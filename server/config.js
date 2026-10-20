/**
 * 配置模型：默认值、字段校验、MAC 归一化、配置读取与原子持久化。
 *
 * 语义严格对齐 docs/api-contract.md 第 2 节：
 * - PUT /api/config 请求体是“完整配置对象”，缺失字段取默认值，未知字段忽略；
 * - 只有请求本身非法才返回 400，字段级错误放在 error.fields（中文）。
 *
 * 本模块不感知 HTTP，方便单元测试与复用。
 */
import { readFileSync, promises as fsp } from 'node:fs';
import path from 'node:path';

/** 配置字段顺序即 JSON 输出顺序，便于前端与测试稳定断言。 */
export const CONFIG_DEFAULTS = Object.freeze({
  statusUrl: '',
  powerOnUrl: '',
  powerOffUrl: '',
  rebootUrl: '',
  lanAddress: '',
  wanAddress: '',
  subnetMask: '',
  gateway: '',
  macAddress: '',
  pollIntervalSec: 10,
  requestTimeoutMs: 5000,
  confirmActions: true,
  powerField: '',
  onlineField: '',
});

/** 四个设备接口 URL，全部为空即演示模式。 */
export const URL_FIELDS = Object.freeze(['statusUrl', 'powerOnUrl', 'powerOffUrl', 'rebootUrl']);

/** 仅展示用的设备资料字段。 */
export const ADDRESS_FIELDS = Object.freeze(['lanAddress', 'wanAddress', 'subnetMask', 'gateway']);

const MAX_URL_LENGTH = 2048;
const MAX_ADDRESS_LENGTH = 255;
const POLL_MIN = 5;
const POLL_MAX = 300;
const TIMEOUT_MIN = 1000;
const TIMEOUT_MAX = 30000;

/** 判断是否是 null / undefined，二者都按“字段缺失”处理（取默认值）。 */
function isMissing(value) {
  return value === null || value === undefined;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * 校验并规整一个设备接口 URL。
 * @param {unknown} raw
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function validateHttpUrl(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'URL 必须是字符串' };
  }
  const value = raw.trim();
  if (!value) return { ok: true, value: '' };
  if (value.length > MAX_URL_LENGTH) {
    return { ok: false, error: `URL 长度不能超过 ${MAX_URL_LENGTH} 个字符` };
  }
  // 契约要求不允许 # 片段；直接检查原文，避免 new URL 对裸 # 的宽松处理。
  if (value.includes('#')) {
    return { ok: false, error: 'URL 不能包含 # 片段' };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'URL 格式不正确，请填写完整地址' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL 必须以 http:// 或 https:// 开头' };
  }
  return { ok: true, value };
}

/**
 * MAC 归一化：接受 AA:BB:CC:DD:EE:FF / AA-BB-... / aabb.ccdd.eeff / 12 位十六进制，
 * 统一输出大写冒号格式。空字符串合法；非法返回 null。
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeMac(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return '';
  // 去掉分隔符后必须恰好是 12 位十六进制，避免把任意字符串“猜”成 MAC。
  const compact = value.replace(/[:.\-]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(compact)) return null;
  return compact
    .toUpperCase()
    .replace(/(..)(?=.)/g, '$1:');
}

/**
 * 是否处于演示模式：四项接口 URL 全部为空。
 * @param {{statusUrl?: string, powerOnUrl?: string, powerOffUrl?: string, rebootUrl?: string}} config
 */
export function isDemoConfig(config) {
  if (!config) return true;
  return URL_FIELDS.every((field) => {
    const value = config[field];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/**
 * 整数字段校验（允许 JSON 数字或纯数字字符串，均规整为 number）。
 * 校验失败写入 fields 并暂用默认值，最终由调用方返回 400。
 */
function normalizeInteger(raw, defaults, { min, max, message, key, fields }) {
  if (isMissing(raw)) return defaults;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(num) || num < min || num > max) {
    fields[key] = message;
    return defaults;
  }
  return num;
}

/**
 * 校验 /api/config PUT 的请求体。
 * @param {unknown} input 客户端提交的配置对象
 * @returns {{ok: true, config: object} | {ok: false, message: string, fields: Record<string, string>}}
 */
export function validateConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: '请求体必须为 JSON 对象', fields: {} };
  }

  const fields = {};
  const config = { ...CONFIG_DEFAULTS };
  const pick = (key) => (hasOwn(input, key) ? input[key] : undefined);

  // 1) 接口 URL
  for (const key of URL_FIELDS) {
    const raw = pick(key);
    if (isMissing(raw)) continue;
    const result = validateHttpUrl(raw);
    if (!result.ok) fields[key] = result.error;
    else config[key] = result.value;
  }

  // 2) 设备资料（后端只做 trim + 长度校验，空白字符由前端轻提示）
  for (const key of ADDRESS_FIELDS) {
    const raw = pick(key);
    if (isMissing(raw)) continue;
    if (typeof raw !== 'string') {
      fields[key] = '必须是字符串';
      continue;
    }
    const value = raw.trim();
    if (value.length > MAX_ADDRESS_LENGTH) {
      fields[key] = `长度不能超过 ${MAX_ADDRESS_LENGTH} 个字符`;
      continue;
    }
    config[key] = value;
  }

  // 3) MAC
  {
    const raw = pick('macAddress');
    if (!isMissing(raw)) {
      if (typeof raw !== 'string') {
        fields.macAddress = '必须是字符串';
      } else {
        const normalized = normalizeMac(raw);
        if (normalized === null) {
          fields.macAddress = 'MAC 地址格式不正确（示例 AA:BB:CC:DD:EE:FF）';
        } else {
          config.macAddress = normalized;
        }
      }
    }
  }

  // 4) 数字与开关
  config.pollIntervalSec = normalizeInteger(pick('pollIntervalSec'), CONFIG_DEFAULTS.pollIntervalSec, {
    min: POLL_MIN,
    max: POLL_MAX,
    message: `轮询间隔需为 ${POLL_MIN}–${POLL_MAX} 秒`,
    key: 'pollIntervalSec',
    fields,
  });
  config.requestTimeoutMs = normalizeInteger(pick('requestTimeoutMs'), CONFIG_DEFAULTS.requestTimeoutMs, {
    min: TIMEOUT_MIN,
    max: TIMEOUT_MAX,
    message: `请求超时需为 ${TIMEOUT_MIN}–${TIMEOUT_MAX} 毫秒`,
    key: 'requestTimeoutMs',
    fields,
  });

  {
    const raw = pick('confirmActions');
    if (!isMissing(raw)) {
      if (typeof raw === 'boolean') {
        config.confirmActions = raw;
      } else if (raw === 'true' || raw === 'false') {
        // 兼容偶尔把布尔值当字符串提交的客户端
        config.confirmActions = raw === 'true';
      } else {
        fields.confirmActions = '操作二次确认需为布尔值';
      }
    }
  }

  // 5) 手动状态字段路径（空 = 自动识别）
  for (const key of ['powerField', 'onlineField']) {
    const raw = pick(key);
    if (isMissing(raw)) continue;
    if (typeof raw !== 'string') {
      fields[key] = '字段路径必须是字符串';
      continue;
    }
    config[key] = raw.trim();
  }

  const count = Object.keys(fields).length;
  if (count > 0) {
    return { ok: false, message: `有 ${count} 项设置需要检查`, fields };
  }
  return { ok: true, config };
}

/**
 * 配置存储：启动时读取文件；保存时用“临时文件 + rename”保证原子性。
 * 配置文件损坏时退回默认配置（演示模式），而不是让服务启动失败。
 */
export class ConfigStore {
  /**
   * @param {string} configPath 配置文件绝对路径
   * @param {{warn?: (message: string) => void}} [options]
   */
  constructor(configPath, { warn } = {}) {
    if (!configPath) throw new Error('ConfigStore 需要 configPath');
    this.configPath = configPath;
    this.warn = typeof warn === 'function' ? warn : (message) => console.warn(`[powercard] ${message}`);
    this.config = { ...CONFIG_DEFAULTS };
  }

  /** 同步读取并校验配置文件；任何异常都降级为默认配置。 */
  load() {
    let text;
    try {
      text = readFileSync(this.configPath, 'utf8');
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.warn(`读取配置文件失败（${error.code || error.message}），已使用默认配置`);
      }
      this.config = { ...CONFIG_DEFAULTS };
      return this.config;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.warn('配置文件不是合法的 JSON，已使用默认配置');
      this.config = { ...CONFIG_DEFAULTS };
      return this.config;
    }

    const result = validateConfig(parsed);
    if (!result.ok) {
      this.warn(`配置文件校验未通过（${result.message}），已使用默认配置`);
      this.config = { ...CONFIG_DEFAULTS };
      return this.config;
    }

    this.config = result.config;
    return this.config;
  }

  /** 返回配置副本，调用方无法意外改动内部状态。 */
  get() {
    return { ...this.config };
  }

  /**
   * 原子保存配置：先写同目录临时文件，再 rename 覆盖。
   * @param {object} config 已经过 validateConfig 的配置
   */
  async save(config) {
    const dir = path.dirname(this.configPath);
    await fsp.mkdir(dir, { recursive: true });
    const tmpPath = `${this.configPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const content = `${JSON.stringify(config, null, 2)}\n`;
    try {
      await fsp.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
      // rename 在同一文件系统内是原子操作；Windows 下同名文件也会被替换。
      await fsp.rename(tmpPath, this.configPath);
    } catch (error) {
      try {
        await fsp.unlink(tmpPath);
      } catch {
        // 临时文件可能根本没写成功，忽略清理失败
      }
      throw error;
    }
    this.config = { ...config };
    return this.config;
  }
}
