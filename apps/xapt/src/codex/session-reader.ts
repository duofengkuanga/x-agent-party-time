import type { CompletedCodexTurn } from './contract';
import { CodexAppServerError } from './errors';
import {
  asRecord,
  latestAgentMessage,
  optionalString,
  parseStructuredResult,
  safeMessage,
} from './wire-values';

export async function readCompletedTurn(
  sessionId: string,
  request: (method: string, params: unknown) => Promise<unknown>,
): Promise<CompletedCodexTurn> {
  try {
    const response = asRecord(
      await request('thread/read', {
        threadId: sessionId,
        includeTurns: true,
      }),
    );
    const thread = asRecord(response.thread);
    const turns = Array.isArray(thread.turns)
      ? thread.turns.map(asRecord)
      : Array.isArray(response.turns)
        ? response.turns.map(asRecord)
        : [];
    const turn = turns.at(-1);
    const turnId = turn ? optionalString(turn.id) : null;
    if (!turn || !turnId)
      throw new CodexAppServerError(
        'Codex 会话没有可确认的最新轮次，请在原会话完成后再同步',
        sessionId,
      );
    const status = optionalString(turn.status);
    if (status !== 'completed')
      throw new CodexAppServerError(latestTurnStatusMessage(status), sessionId);
    const message = latestAgentMessage(turn.items);
    if (typeof message !== 'string')
      throw new CodexAppServerError(
        'Codex 会话的最新轮次未返回结果',
        sessionId,
      );
    const result = parseStructuredResult(message);
    if (result === undefined)
      throw new CodexAppServerError(
        'Codex 会话的最新轮次未返回可识别的结果，请在原会话处理后再同步',
        sessionId,
      );
    return { turnId, result };
  } catch (error) {
    if (error instanceof CodexAppServerError && error.sessionId === sessionId)
      throw error;
    throw new CodexAppServerError(readSessionFailureMessage(error), sessionId);
  }
}

function latestTurnStatusMessage(status: string | null): string {
  if (status === 'inProgress' || status === 'interrupted')
    return 'Codex 会话的最新一轮尚未完成或暂无法确认，请完成后再同步';
  if (status === 'failed')
    return 'Codex 会话的最新一轮已失败，请在原会话处理后再同步';
  return 'Codex 会话的最新一轮状态无法确认，请完成后再同步';
}

function readSessionFailureMessage(error: unknown): string {
  const message = safeMessage(error);
  if (/not found|unknown thread|does not exist|不存在|找不到/iu.test(message))
    return 'Codex 会话不可用，请确认原会话仍可读取后再同步';
  return '无法读取 Codex 会话，请确认 Agent 在线且原会话可读后再同步';
}
