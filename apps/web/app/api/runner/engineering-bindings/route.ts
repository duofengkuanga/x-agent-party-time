import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import {
  BindEngineeringCommandSchema,
  BindEngineeringResultSchema,
} from '@agent-party-time/shared/runner-local';
import {
  DEFAULTS,
  ENV_NAMES,
  LOCAL_PATHS,
  PROTOCOL_VERSION,
} from '@agent-party-time/shared/config';
import { AppErrorSchema } from '@agent-party-time/shared/error';
import { currentUser } from '@/lib/auth/server';
import {
  controlPlaneFailure,
  controlPlaneForUser,
} from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BrowserBindSchema = z.object({
  engineeringId: z.uuid(),
  repositoryPath: z.string().trim().min(1).max(4096),
});

export async function POST(request: Request) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const input = BrowserBindSchema.parse(await request.json());
    const controlPlane = controlPlaneForUser(user);
    const pairing = await controlPlane.createEngineeringBindingTicket(
      input.engineeringId,
    );
    const result = await callLocalAgent(
      BindEngineeringCommandSchema.parse({
        engineeringId: input.engineeringId,
        pairingTicket: pairing.ticket,
        repositoryPath: input.repositoryPath,
      }),
    );
    const binding = (
      await controlPlane.listEngineeringBindings(input.engineeringId)
    ).find((item) => item.id === result.binding.bindingId);
    if (!binding) throw new Error('中心未返回刚建立的绑定');
    return NextResponse.json({ binding });
  } catch (error) {
    if (error instanceof ZodError)
      return NextResponse.json(
        { error: '工程或本机目录格式不正确' },
        { status: 400 },
      );
    if (error instanceof RunnerUnavailableError)
      return NextResponse.json(
        { error: '无法连接本机 Agent，请先启动 partytime 服务' },
        { status: 503 },
      );
    if (error instanceof LocalAgentError)
      return NextResponse.json(
        { error: error.appError.message, code: error.appError.code },
        { status: error.appError.category === 'validation' ? 400 : 409 },
      );
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return NextResponse.json(
        { error: '未找到本机 Agent，请先启动 partytime 服务' },
        { status: 503 },
      );
    return controlPlaneFailure(error, '工程绑定失败');
  }
}

async function callLocalAgent(
  input: z.infer<typeof BindEngineeringCommandSchema>,
) {
  const homeDirectory = resolve(
    process.env[ENV_NAMES.home] ?? resolve(homedir(), LOCAL_PATHS.homeDirName),
  );
  const capabilityPath = resolve(
    process.env[ENV_NAMES.capabilityFile] ??
      resolve(homeDirectory, LOCAL_PATHS.serviceCapabilityFile),
  );
  const capability = (await readFile(capabilityPath, 'utf8')).trim();
  if (!capability) throw new RunnerUnavailableError();
  const requestId = randomUUID();
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
      body: JSON.stringify({
        apiVersion: PROTOCOL_VERSION,
        requestId,
        operation: 'engineering.bind',
        idempotencyKey: `web-engineering-bind:${input.engineeringId}:${randomUUID()}`,
        payload: input,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new RunnerUnavailableError();
  }
  const envelope = RunnerResponseEnvelopeSchema.parse(await response.json());
  if (envelope.requestId !== requestId) throw new RunnerUnavailableError();
  if (!envelope.ok) throw new LocalAgentError(envelope.error);
  return BindEngineeringResultSchema.parse(envelope.data);
}

class RunnerUnavailableError extends Error {}
class LocalAgentError extends Error {
  constructor(readonly appError: z.infer<typeof AppErrorSchema>) {
    super(appError.message);
  }
}

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
