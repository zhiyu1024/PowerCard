/**
 * 演示模式（demo）设备：不需要真实设备也能体验完整 UI。
 *
 * 契约要求：
 * - 四项接口 URL 全空时启用演示模式；
 * - 状态请求立即返回内存中的模拟状态（契约示例 latencyMs 为 0）；
 * - 指令延迟约 600ms 后改变模拟电源状态；重启模拟“先关机再开机”。
 * 状态只保存在内存中，服务重启后恢复初始的“已开机”。
 */
const DEFAULT_COMMAND_DELAY_MS = 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DemoDevice {
  constructor({ commandDelayMs = DEFAULT_COMMAND_DELAY_MS } = {}) {
    this.commandDelayMs = Number.isInteger(commandDelayMs) && commandDelayMs >= 0 ? commandDelayMs : DEFAULT_COMMAND_DELAY_MS;
    this.power = 'on';
    this.online = true;
  }

  /** 当前模拟状态快照。 */
  snapshot() {
    return { power: this.power, online: this.online };
  }

  /** 演示模式的状态原始响应，字段顺序与契约示例保持一致。 */
  statusRaw() {
    return JSON.stringify({ demo: true, online: this.online, power: this.power });
  }

  /**
   * 执行一次模拟指令。
   * @param {'on'|'off'|'reboot'} action
   * @returns {Promise<{latencyMs: number, power: 'on'|'off', online: boolean, rawBody: string}>}
   */
  async execute(action) {
    const startedAt = Date.now();

    if (action === 'reboot') {
      // 模拟重启：先关机，等待指令耗时后恢复开机
      this.power = 'off';
      await sleep(this.commandDelayMs);
      this.power = 'on';
    } else {
      await sleep(this.commandDelayMs);
      this.power = action === 'on' ? 'on' : 'off';
    }

    const rawBody = JSON.stringify({ demo: true, action, online: this.online, power: this.power });
    return {
      latencyMs: Date.now() - startedAt,
      power: this.power,
      online: this.online,
      rawBody,
    };
  }
}
