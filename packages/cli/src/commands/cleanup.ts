import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { HttpControlPlaneAdapter } from '@agent-party-time/control-plane-client';
import {
  CodexAppServerError,
  CodexAppServerExecutor,
  RunnerStateStore,
} from '@agent-party-time/local-service';
import { DEFAULTS, ENV_NAMES, LOCAL_PATHS } from '@agent-party-time/shared';
import { optionString, parseArgs } from '../args.js';
import type { Output } from '../output.js';

const CleanupResultSchema = z.object({
  success: z.boolean(),
  summary: z.string().trim().min(1).max(4_000),
});

interface CleanupDependencies {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
}

export async function runCleanupCommand(
  action: string,
  args: readonly string[],
  output: Output,
  dependencies: CleanupDependencies,
) {
  const parsed = parseArgs(args);
  const homeDirectory = resolve(
    optionString(parsed, 'home') ??
      dependencies.env[ENV_NAMES.home] ??
      resolve(homedir(), LOCAL_PATHS.homeDirName),
  );
  const stateStore = new RunnerStateStore(
    resolve(homeDirectory, LOCAL_PATHS.runnerStateFile),
  );
  const runner = await stateStore.identity();
  const controlPlane = new HttpControlPlaneAdapter({
    baseUrl:
      optionString(parsed, 'control-plane') ??
      dependencies.env[ENV_NAMES.controlPlaneUrl] ??
      DEFAULTS.controlPlaneUrl,
    fetch: dependencies.fetch,
  });

  if (action === 'list') {
    const targets = await controlPlane.listCleanupTargets(runner.runnerId);
    output.value(
      targets.map((target) => ({
        kind: target.kind,
        id: target.id,
        label: target.label,
        projectId: target.projectId,
        sessions: target.sessionIds.length,
      })),
    );
    return;
  }
  if (action !== 'run')
    throw new Error(
      '用法：partytime cleanup list | cleanup run --bug <id> | --deployment <id> --confirm <label>',
    );

  const bugId = optionString(parsed, 'bug');
  const deploymentId = optionString(parsed, 'deployment');
  if ((bugId ? 1 : 0) + (deploymentId ? 1 : 0) !== 1)
    throw new Error('cleanup run 必须且只能指定 --bug 或 --deployment');
  const kind = bugId ? 'bug' : 'deployment';
  const id = bugId ?? deploymentId!;
  const { target, prompt } = await controlPlane.getCleanupTarget({
    runnerId: runner.runnerId,
    kind,
    id,
  });

  output.value({
    action: 'cleanup',
    kind: target.kind,
    id: target.id,
    label: target.label,
    projectId: target.projectId,
    sessions: target.sessionIds.length,
  });
  const confirmation = optionString(parsed, 'confirm');
  if (confirmation !== target.label)
    throw new Error(
      `确认字符串不匹配；请重新执行并传入 --confirm "${target.label}"`,
    );

  const binding = (await stateStore.listBindings()).find(
    (item) => item.projectId === target.projectId,
  );
  if (!binding) throw new Error(`本机没有项目 ${target.projectId} 的绑定`);

  const executionId = randomUUID();
  const codexExecutable =
    optionString(parsed, 'codex') ??
    dependencies.env[ENV_NAMES.codexExecutable] ??
    'codex';
  const executor = new CodexAppServerExecutor({
    executable: codexExecutable,
  });
  const artifactsDirectory = resolve(
    homeDirectory,
    LOCAL_PATHS.repairAttemptsDir,
    `cleanup-${kind}-${target.id}`,
  );
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let sessionId: string | null = null;
  try {
    let summary: string;
    try {
      const execution = await executor.executeStructured(
        {
          executionId,
          repositoryPath: binding.repositoryPath,
          prompt: prompt.text.replaceAll(
            '{{REPOSITORY_PATH}}',
            binding.repositoryPath,
          ),
          outputSchema: prompt.outputSchema,
          resultSchema: CleanupResultSchema,
          artifactsDirectory,
        },
        controller.signal,
      );
      sessionId = execution.sessionId;
      if (!execution.result.success)
        throw new Error(`Codex 未完成清理：${execution.result.summary}`);
      for (const targetSessionId of target.sessionIds) {
        if (await stateStore.isSessionCleaned(targetSessionId)) continue;
        await deleteCodexSession(codexExecutable, targetSessionId);
        await stateStore.markSessionsCleaned([targetSessionId]);
      }
      summary = target.sessionIds.length
        ? `${execution.result.summary}；已确认 ${target.sessionIds.length} 个 Codex Session 已清理。`
        : execution.result.summary;
    } catch (error) {
      if (error instanceof CodexAppServerError) sessionId = error.sessionId;
      await controlPlane.finishCleanup(
        {
          runnerId: runner.runnerId,
          kind,
          id,
          success: false,
          summary: messageOf(error),
          sessionId,
        },
        `cleanup:${kind}:${id}:${executionId}`,
      );
      throw error;
    }
    const targetAfterCleanup = await controlPlane.finishCleanup(
      {
        runnerId: runner.runnerId,
        kind,
        id,
        success: true,
        summary,
        sessionId,
      },
      `cleanup:${kind}:${id}:${executionId}`,
    );
    output.value({
      success: true,
      summary,
      cleanedAt: targetAfterCleanup.cleanedAt,
      artifactsDirectory,
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

export async function deleteCodexSession(
  executable: string,
  sessionId: string,
) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, ['delete', '--force', sessionId], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) return resolvePromise();
      if (sessionAlreadyAbsent(stderr)) return resolvePromise();
      reject(
        new Error(
          `Codex Session ${sessionId} 删除失败（${signal ? `signal ${signal}` : `exit ${String(code)}`}）${stderr.trim() ? `：${stderr.trim()}` : ''}`,
        ),
      );
    });
  });
}

function sessionAlreadyAbsent(message: string) {
  return /(?:not[ -]?found|does not exist|no such (?:session|thread)|unknown (?:session|thread)|不存在|未找到)/i.test(
    message,
  );
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
