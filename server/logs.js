/**
 * 内存环形请求日志（契约：最多 30 条，不落盘，最新的在前）。
 * 只记录真正发往设备的请求（以及演示模式下的模拟请求）。
 */
const DEFAULT_LIMIT = 30;
const PREVIEW_MAX_CHARS = 300;

/**
 * 生成 rawPreview：调试面板只需要一小段原始响应，避免日志体积过大。
 * @param {{body?: string} | null} raw
 */
function buildPreview(raw) {
  if (!raw || typeof raw.body !== 'string') return null;
  if (raw.body.length <= PREVIEW_MAX_CHARS) return raw.body;
  return `${raw.body.slice(0, PREVIEW_MAX_CHARS)}…`;
}

export class RequestLog {
  constructor(limit = DEFAULT_LIMIT) {
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
    this.items = [];
    this.sequence = 0;
  }

  /**
   * 追加一条日志。id 用“时间戳 + 单调序号”保证同一毫秒内不重复。
   * @param {object} entry
   * @param {'status'|'command'|'test'} entry.kind
   * @param {string|null} entry.url
   * @param {string} entry.method
   * @param {number|null} entry.httpStatus
   * @param {boolean} entry.ok
   * @param {number} entry.latencyMs
   * @param {{code: string, message: string} | null} [entry.error]
   * @param {{body?: string, contentType?: string, truncated?: boolean} | null} [entry.raw]
   * @param {Date} [entry.at]
   */
  add({ kind, url, method = 'GET', httpStatus = null, ok, latencyMs = 0, error = null, raw = null, at = new Date() }) {
    this.sequence += 1;
    const entry = {
      id: `l_${at.getTime()}_${this.sequence}`,
      at: at.toISOString(),
      kind,
      method,
      url: url ?? null,
      httpStatus: httpStatus ?? null,
      ok: Boolean(ok),
      latencyMs: Math.max(0, Math.round(latencyMs)),
      error: error ?? null,
      rawPreview: buildPreview(raw),
    };

    // 最新的在前
    this.items.unshift(entry);
    if (this.items.length > this.limit) {
      this.items.length = this.limit;
    }
    return entry;
  }

  /** 返回日志副本，避免调用方改动内部数组。 */
  list() {
    return this.items.map((item) => ({ ...item }));
  }
}
