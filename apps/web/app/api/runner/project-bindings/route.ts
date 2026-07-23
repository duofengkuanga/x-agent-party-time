import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import {
  DEFAULTS,
  ENV_NAMES,
  LOCAL_PATHS,
  PROTOCOL_VERSION,
} from '@agent-party-time/shared/config';
import { AppErrorSchema } from '@agent-party-time/shared/error';
import {
  BindProjectCommandSchema,
  BindProjectResultSchema,
} from '@agent-party-time/shared/runner-local';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const input = BindProjectCommandSchema.parse(await request.json());
    const homeDirectory = resolve(
      process.env[ENV_NAMES.home] ??
        resolve(homedir(), LOCAL_PATHS.homeDirName),
    );
    const capabilityPath = resolve(
      process.env[ENV_NAMES.capabilityFile] ??
        resolve(homeDirectory, LOCAL_PATHS.serviceCapabilityFile),
    );
    const capability = (await readFile(capabilityPath, 'utf8')).trim();
    if (!capability) throw new RunnerUnavailableError();

    const requestId = randomUUID();
    const envelope = {
      apiVersion: PROTOCOL_VERSION,
      requestId,
      operation: 'project.bind',
      idempotencyKey: `web-project-bind:${input.project}:${randomUUID()}`,
      payload: input,
    };
    const serverUrl =
      process.env[ENV_NAMES.serverUrl] ??
      `http://${DEFAULTS.localApiHost}:${DEFAULTS.localApiPort}`;
    let response: Response;
    try {
      response = await fetch(`${serverUrl}/api`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${capability}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(envelope),
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new RunnerUnavailableError();
    }

    const result = RunnerResponseEnvelopeSchema.parse(await response.json());
    if (result.requestId !== requestId)
      return NextResponse.json(
        { error: 'Agent 返回了无法识别的响应' },
        { status: 502 },
      );
    if (!result.ok)
      return NextResponse.json(
        { error: result.error.message, code: result.error.code },
        { status: statusForCategory(result.error.category) },
      );

    return NextResponse.json(BindProjectResultSchema.parse(result.data));
  } catch (error) {
    if (error instanceof ZodError)
      return NextResponse.json(
        { error: '仓库路径或基准分支格式不正确' },
        { status: 400 },
      );
    if (error instanceof RunnerUnavailableError)
      return NextResponse.json(
        { error: '无法连接本机 Agent，请先启动 partytime 服务' },
        { status: 503 },
      );
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return NextResponse.json(
        { error: '未找到本机 Agent，请先启动 partytime 服务' },
        { status: 503 },
      );
    return NextResponse.json({ error: '项目绑定失败' }, { status: 500 });
  }
}

class RunnerUnavailableError extends Error {}

const RunnerResponseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    requestId: z.string().min(1),
    data: z.json(),
  }),
  z.object({
    ok: z.literal(false),
    requestId: z.string().min(1),
    error: AppErrorSchema,
  }),
]);

function statusForCategory(category: string) {
  if (category === 'validation') return 400;
  if (category === 'not_found') return 404;
  if (category === 'conflict') return 409;
  if (category === 'authentication' || category === 'permission') return 403;
  return 503;
}
