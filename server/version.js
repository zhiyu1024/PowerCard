/**
 * 应用元信息与默认路径。
 *
 * 这里集中解析项目根目录，避免其它模块各自使用 `../` 拼接导致相对路径歧义。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** server/ 目录的绝对路径 */
export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（server/ 的上一级） */
export const PROJECT_ROOT = path.resolve(SERVER_DIR, '..');

export const APP_NAME = 'powercard-remote';

/**
 * 版本号取自 package.json，读取失败时退回 1.0.0。
 * 用同步读取是因为它只在模块加载时执行一次，且 start.js 需要尽早可用。
 */
export const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '1.0.0';
  } catch {
    return '1.0.0';
  }
})();

/** 默认静态资源目录：<root>/public */
export const DEFAULT_PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

/** 默认配置文件：<root>/data/config.json（运行时生成，已 gitignore） */
export const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, 'data', 'config.json');

/** 用户代理标识，访问设备时携带 */
export const USER_AGENT = `${APP_NAME}/${APP_VERSION}`;
