import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

type ServiceCommand = {
  label: string;
  script: string;
};

const commands: ServiceCommand[] = [
  { label: 'App', script: 'dev:app' },
  { label: 'Agent', script: 'dev:runner' },
];

const activeChildren = new Set<ChildProcess>();
let shuttingDown = false;
let finalExitCode = 0;

function stopAll(exitCode: number, signal: NodeJS.Signals = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  finalExitCode = exitCode;

  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  }

  finishIfStopped();
}

function finishIfStopped() {
  if (!shuttingDown || activeChildren.size > 0) return;
  process.exitCode = finalExitCode;
}

function seedDevelopmentUsers(): boolean {
  const result = spawnSync('bun', ['run', 'seed:app'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`[dev] 初始化开发用户失败：${result.error.message}`);
    process.exitCode = 1;
    return false;
  }
  if (result.status !== 0) {
    console.error(`[dev] 初始化开发用户失败（退出码 ${result.status ?? 1}）。`);
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

if (seedDevelopmentUsers()) {
  for (const command of commands) {
    const child = spawn('bun', ['run', command.script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    activeChildren.add(child);

    child.once('error', (error) => {
      console.error(`[dev] ${command.label} 启动失败：${error.message}`);
      stopAll(1);
    });

    child.once('close', (code, signal) => {
      activeChildren.delete(child);

      if (!shuttingDown) {
        const failed = code !== 0 || signal !== null;
        const outcome = signal ? `信号 ${signal}` : `退出码 ${code ?? 1}`;
        const writer = failed ? console.error : console.log;
        writer(
          `[dev] ${command.label} 已退出（${outcome}），正在停止其余进程。`,
        );
        stopAll(failed ? (code ?? 1) : 0);
        return;
      }

      finishIfStopped();
    });
  }

  console.log('[dev] 已启动 App 与 Agent；按 Ctrl+C 可统一停止。');
}

process.once('SIGINT', () => stopAll(0, 'SIGINT'));
process.once('SIGTERM', () => stopAll(0, 'SIGTERM'));
