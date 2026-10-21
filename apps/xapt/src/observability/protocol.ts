import { createHash, randomUUID } from 'node:crypto';
import {
  classifyCommand,
  ObservationEventSchema,
  type ObservationEvent,
} from '@agent-party-time/execution-contract/observability';
import type { ExecutionObservation } from './recorder';
import { extractSourceReceipts } from './sourceReceipts';
import type { CommandClassifier } from './commandContext';

export type CodexObservationNotice =
  | { type: 'spawn' }
  | { type: 'closing' }
  | { type: 'stderr' }
  | { type: 'exit'; code: number | null }
  | { type: 'send' | 'receive'; message: unknown };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function identity(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/u.test(text)
    ? text
    : undefined;
}

/** Discards source text before emitting any persisted event. */
export function protocolObserver(
  observation: ExecutionObservation,
  classifier?: CommandClassifier,
): (notice: CodexObservationNotice) => void {
  const connectionId = randomUUID();
  const requests = new Map<
    string,
    { method: string; correlation: NonNullable<ObservationEvent['correlation']> }
  >();
  const running = new Map<string, ObservationEvent['activity']>();
  const itemBoundaries = new Map<string, string>();
  const receiptIdentities = new Map<string, string>();
  let invocationId: string | undefined;
  const interactions = new Set<string>();
  let closing = false;
  let stderrObserved = false;
  return (notice) => {
    try {
      if (notice.type === 'spawn') {
        observation.record({
          name: 'phase.started',
          source: 'xapt',
          phase: 'startup',
          correlation: { connectionId, intervalId: 'app-server' },
        });
        return;
      }
      if (notice.type === 'exit') {
        observation.record({
          name: 'process.exited',
          source: 'xapt',
          correlation: { connectionId },
          status: notice.code === 0 ? 'succeeded' : 'interrupted',
        });
        if (closing)
          observation.record({
            name: 'phase.finished',
            source: 'xapt',
            phase: 'shutdown',
            correlation: { connectionId, intervalId: 'shutdown' },
            status: notice.code === 0 ? 'succeeded' : 'interrupted',
          });
        return;
      }
      if (notice.type === 'closing') {
        if (!closing)
          observation.record({
            name: 'phase.started',
            source: 'xapt',
            phase: 'shutdown',
            correlation: { connectionId, intervalId: 'shutdown' },
          });
        closing = true;
        return;
      }
      if (notice.type === 'stderr') {
        if (!stderrObserved)
          observation.record({
            name: 'activity.observed',
            source: 'xapt',
            reason: 'unrecognized',
          });
        stderrObserved = true;
        return;
      }
      const message = record(notice.message);
      const params = record(message.params);
      const method = typeof message.method === 'string' ? message.method : undefined;
      const requestId = identity(message.id);
      const sessionId = identity(params.threadId);
      const turnId = identity(params.turnId) ?? identity(record(params.turn).id);
      const correlation = { connectionId, sessionId, turnId };
      if (notice.type === 'send' && method && requestId) {
        requests.set(requestId, { method, correlation: { ...correlation, requestId } });
        observation.record({
          name: 'rpc.sent',
          source: 'xapt',
          correlation: { ...correlation, requestId },
        });
        if (method === 'turn/start') {
          invocationId = randomUUID();
          observation.record({
            name: 'phase.started',
            source: 'xapt',
            phase: 'turn',
            correlation: { ...correlation, intervalId: invocationId },
          });
        }
        return;
      }
      if (notice.type === 'receive' && !method && requestId) {
        const request = requests.get(requestId);
        if (!request) return;
        requests.delete(requestId);
        observation.record({
          name: 'rpc.settled',
          source: 'codex_protocol',
          correlation: request.correlation,
          status: message.error ? 'failed' : 'succeeded',
        });
        const result = record(message.result);
        if (request.method === 'initialize')
          observation.record({
            name: 'phase.finished',
            source: 'codex_protocol',
            phase: 'startup',
            correlation: { connectionId, intervalId: 'app-server' },
            status: message.error ? 'failed' : 'succeeded',
          });
        const thread = record(result.thread);
        const associatedSession = identity(thread.id);
        if (associatedSession)
          observation.record({
            name: 'session.associated',
            source: 'codex_protocol',
            correlation: { connectionId, sessionId: associatedSession },
          });
        const associatedTurn = identity(record(result.turn).id);
        if (associatedTurn)
          observation.record({
            name: 'turn.associated',
            source: 'codex_protocol',
            correlation: { ...request.correlation, turnId: associatedTurn },
          });
        const model = identity(result.model);
        const effort =
          typeof result.reasoningEffort === 'string'
            ? ObservationEventSchema.shape.configuration
                .unwrap()
                .safeParse({ effectiveEffort: result.reasoningEffort })
            : null;
        if (model || effort?.success)
          observation.record({
            name: 'configuration.observed',
            source: 'codex_protocol',
            configuration: {
              ...(model ? { effectiveModel: model } : {}),
              ...(effort?.success ? effort.data : {}),
            },
          });
        return;
      }
      if (notice.type === 'send' && !method && requestId && interactions.has(requestId)) {
        observation.record({
          name: 'interaction.responded',
          source: 'xapt',
          correlation: { connectionId, intervalId: requestId },
        });
        interactions.delete(requestId);
        return;
      }
      if (notice.type !== 'receive' || !method) return;
      if (method === 'thread/tokenUsage/updated') {
        const total = record(record(params.tokenUsage).total);
        const values: Record<string, unknown> = { scope: 'session', mode: 'cumulative' };
        for (const field of [
          'inputTokens',
          'cachedInputTokens',
          'cacheWriteInputTokens',
          'outputTokens',
          'reasoningOutputTokens',
        ])
          if (typeof total[field] === 'number') values[field] = total[field];
        const usage = ObservationEventSchema.shape.usage.unwrap().safeParse(values);
        if (
          usage.success &&
          (usage.data.inputTokens !== undefined || usage.data.outputTokens !== undefined)
        )
          observation.record({
            name: 'usage.observed',
            source: 'codex_protocol',
            correlation,
            usage: usage.data,
          });
        return;
      }
      if (
        requestId &&
        [
          'item/tool/requestUserInput',
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
          'item/permissions/requestApproval',
        ].includes(method)
      ) {
        interactions.add(requestId);
        observation.record({
          name: 'interaction.requested',
          source: 'codex_protocol',
          correlation: { connectionId, intervalId: requestId },
        });
        return;
      }
      if (method === 'turn/completed') {
        const turn = record(params.turn);
        const status =
          turn.status === 'completed'
            ? 'succeeded'
            : turn.status === 'failed'
              ? 'failed'
              : 'interrupted';
        observation.record({
          name: 'turn.terminal',
          source: 'codex_protocol',
          correlation,
          status,
        });
        if (invocationId)
          observation.record({
            name: 'phase.finished',
            source: 'codex_protocol',
            phase: 'turn',
            correlation: { connectionId, intervalId: invocationId },
            status,
          });
        return;
      }
      if (method !== 'item/started' && method !== 'item/completed') return;
      const item = record(params.item);
      const sourceItemId = identity(item.id);
      if (!sourceItemId) {
        observation.record({
          name: 'activity.observed',
          source: 'codex_protocol',
          correlation,
          reason: 'unrecognized',
        });
        return;
      }
      const type = item.type;
      const isTool = [
        'commandExecution',
        'command_execution',
        'fileChange',
        'file_change',
        'mcpToolCall',
        'dynamicToolCall',
      ].includes(String(type));
      const command = typeof item.command === 'string' ? item.command : '';
      const direct = command ? classifyCommand(command) : 'unknown';
      const resolved =
        command && classifier && typeof item.cwd === 'string'
          ? classifier.classify(
              command,
              typeof item.cwd === 'string' ? item.cwd : undefined,
            )
          : direct;
      const activity =
        type === 'fileChange' || type === 'file_change'
          ? 'edit'
          : type === 'agentMessage'
            ? 'message'
            : command
              ? resolved
              : (running.get(sourceItemId) ?? 'unknown');
      if (!isTool) {
        observation.record({
          name: 'activity.observed',
          source: 'codex_protocol',
          activity,
          correlation: { ...correlation, sourceItemId },
        });
        return;
      }
      const boundaryKey = JSON.stringify([turnId, sourceItemId, method]);
      // Ephemeral duplicate detection uses source fields, never mutable classification caches.
      // This digest is neither persisted nor uploaded.
      const signature = createHash('sha256')
        .update(
          JSON.stringify([
            item.type,
            item.status,
            item.exitCode,
            item.durationMs,
            typeof item.command === 'string' ? item.command.slice(0, 8192) : null,
            typeof item.cwd === 'string' ? item.cwd.slice(0, 8192) : null,
            type === 'commandExecution'
              ? extractSourceReceipts(item.aggregatedOutput).receipts
              : null,
          ]),
        )
        .digest('hex');
      const priorBoundary = itemBoundaries.get(boundaryKey);
      if (priorBoundary !== undefined) {
        if (priorBoundary !== signature)
          observation.record({
            name: 'gap',
            source: 'codex_protocol',
            reason: 'conflict',
            correlation: { ...correlation, sourceItemId },
          });
        return;
      }
      if (itemBoundaries.size >= 4096)
        itemBoundaries.delete(itemBoundaries.keys().next().value!);
      itemBoundaries.set(boundaryKey, signature);
      if (method === 'item/started') running.set(sourceItemId, activity);
      else running.delete(sourceItemId);
      const duration =
        typeof item.durationMs === 'number' &&
        Number.isFinite(item.durationMs) &&
        item.durationMs >= 0
          ? item.durationMs
          : undefined;
      observation.record({
        name: method === 'item/started' ? 'item.started' : 'item.finished',
        source: 'codex_protocol',
        activity,
        correlation: { ...correlation, sourceItemId },
        sourceDurationMs: duration,
        reason:
          direct === 'unknown' && resolved !== 'unknown'
            ? 'static_definition'
            : undefined,
        status:
          method === 'item/started'
            ? 'running'
            : item.status === 'failed' ||
                (typeof item.exitCode === 'number' && item.exitCode !== 0)
              ? 'failed'
              : item.status === 'completed'
                ? 'succeeded'
                : 'unknown',
      });
      if (method === 'item/completed') {
        if (type === 'commandExecution') {
          const extracted = extractSourceReceipts(item.aggregatedOutput);
          if (extracted.limited || extracted.invalid)
            observation.record({
              name: 'gap',
              source: 'codex_protocol',
              reason: extracted.limited ? 'budget' : 'unrecognized',
              correlation,
            });
          for (const receipt of extracted.receipts) {
            const key = receipt.activityId;
            const signature = JSON.stringify(receipt);
            if (receiptIdentities.has(key)) {
              if (receiptIdentities.get(key) !== signature)
                observation.record({
                  name: 'gap',
                  source: 'codex_protocol',
                  reason: 'conflict',
                  correlation,
                });
              continue;
            }
            if (receiptIdentities.size >= 4096) {
              observation.record({ name: 'gap', source: 'xapt', reason: 'budget' });
              break;
            }
            receiptIdentities.set(key, signature);
            observation.record({
              name: 'activity.observed',
              source: 'codex_protocol',
              activity: receipt.activity,
              reason: 'source_reported',
              status: receipt.status,
              sourceDurationMs: receipt.durationMs,
              workId: receipt.workId,
              correlation: {
                ...correlation,
                sourceItemId: receipt.activityId,
                parentIntervalId: sourceItemId,
              },
            });
          }
        }
        classifier?.invalidate();
      }
    } catch {
      observation.record({ name: 'gap', source: 'xapt', reason: 'unrecognized' });
    }
  };
}
