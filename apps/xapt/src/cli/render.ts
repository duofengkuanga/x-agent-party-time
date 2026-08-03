import { MINIMUM_CODEX_VERSION, XAPT_VERSION } from '../version';

export const HELP_TEXT = `xapt — Agent Party Time 本机 Agent

用法：
  xapt daemon start
  xapt daemon connect <server-url>
  xapt daemon stop [--force]
  xapt daemon status
  xapt update
  xapt uninstall [--force]
  xapt --help
  xapt --version

下一步：运行 xapt daemon start 启动本机 daemon。`;

export function renderVersion(): string {
  return `xapt ${XAPT_VERSION}\n最低 Codex 版本 ${MINIMUM_CODEX_VERSION}`;
}

export function renderUsageError(message: string): string {
  return `错误：${message}。\n下一步：运行 xapt --help 查看可用命令。`;
}

export function renderNotImplemented(command: string): string {
  return `错误：${command} 尚未实现。\n下一步：请等待对应 xapt 实施 Ticket 完成。`;
}
