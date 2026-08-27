/**
 * 非路由模块用的日志。
 *
 * 路由里用 Fastify 挂在 request 上的 pino logger；但存储层、通知层这些
 * 不持有 request 的模块需要一个独立入口。这里按 LOG_LEVEL 过滤，
 * 对齐 Python 版 logging 的行为（LOG_LEVEL=warning 时 info 不输出）。
 */

const LEVELS: Record<string, number> = {
  silent: 100,
  fatal: 60,
  error: 50,
  warn: 40,
  warning: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

// 默认先按环境变量，buildApp 起来后会用 settings 里的值覆盖 ——
// 这样测试注入的 settings 也能真正静音，而不是被开发机的环境变量左右。
let current = LEVELS[(process.env["LOG_LEVEL"] ?? "info").trim().toLowerCase()] ?? 30;

export function setLogLevel(level: string): void {
  current = LEVELS[level.trim().toLowerCase()] ?? 30;
}

function threshold(): number {
  return current;
}

export const logger = {
  info(...args: unknown[]): void {
    if (threshold() <= 30) console.info(...args);
  },
  warn(...args: unknown[]): void {
    if (threshold() <= 40) console.warn(...args);
  },
  error(...args: unknown[]): void {
    if (threshold() <= 50) console.error(...args);
  },
};
