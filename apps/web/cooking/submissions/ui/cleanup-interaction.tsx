'use client';

import { useState } from 'react';
import type { JsonValue } from '@agent-party-time/execution-contract';
import type { CleanupInteractionView } from '@/cooking/lifecycle/contract';

export function CleanupInteractionPanel({
  cleanupVersion,
  interaction,
  onResolve,
  pending,
}: {
  cleanupVersion: number;
  interaction: CleanupInteractionView;
  onResolve: (
    interactionId: string,
    expectedVersion: number,
    resolution: JsonValue,
  ) => void;
  pending: boolean;
}) {
  const questions = cleanupInteractionQuestions(interaction);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (!interaction.canResolve || !interaction.payload)
    return (
      <small className="collab-interaction-waiting">
        清理正在等待对应工程负责人处理。
      </small>
    );
  return (
    <div className="collab-interaction-card">
      <header>
        <span>待处理清理交互</span>
      </header>
      <h3>{cleanupInteractionTitle(interaction)}</h3>
      {interaction.kind === 'APPROVAL' ? (
        <>
          <dl>
            {cleanupInteractionDetails(interaction).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="collab-interaction-actions">
            <button
              disabled={pending}
              onClick={() =>
                onResolve(
                  interaction.id,
                  cleanupVersion,
                  declineCleanupResolution(interaction),
                )
              }
              type="button"
            >
              拒绝
            </button>
            <button
              disabled={pending}
              onClick={() =>
                onResolve(
                  interaction.id,
                  cleanupVersion,
                  acceptCleanupResolution(interaction),
                )
              }
              type="button"
            >
              本次会话允许
            </button>
          </div>
        </>
      ) : (
        <div className="collab-form">
          {questions.map((question) => (
            <label key={question.id}>
              <span>{question.header || question.question}</span>
              <small>{question.question}</small>
              <input
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                value={answers[question.id] ?? ''}
              />
            </label>
          ))}
          <button
            disabled={
              pending ||
              questions.length === 0 ||
              questions.some((question) => !answers[question.id]?.trim())
            }
            onClick={() =>
              onResolve(interaction.id, cleanupVersion, {
                answers: Object.fromEntries(
                  Object.entries(answers).map(([id, answer]) => [
                    id,
                    { answers: [answer.trim()] },
                  ]),
                ),
              })
            }
            type="button"
          >
            提交回答
          </button>
        </div>
      )}
    </div>
  );
}

function cleanupInteractionTitle(interaction: CleanupInteractionView): string {
  if (interaction.kind === 'USER_INPUT') return 'Codex 正在等待你的回答';
  return (
    {
      'item/commandExecution/requestApproval': 'Codex 请求执行清理命令',
      'item/fileChange/requestApproval': 'Codex 请求扩展文件写入范围',
      'item/permissions/requestApproval': 'Codex 请求权限',
    }[interaction.method ?? ''] ?? 'Codex 请求清理操作许可'
  );
}

function cleanupInteractionDetails(
  interaction: CleanupInteractionView,
): Array<[string, string]> {
  const payload = interactionRecord(interaction.payload);
  const values: Array<[string, unknown]> = [
    ['原因', payload.reason],
    ['命令', payload.command],
    ['权限', payload.permissions],
  ];
  return values.flatMap(([label, value]) =>
    value === null || value === undefined || value === ''
      ? []
      : [[label, typeof value === 'string' ? value : JSON.stringify(value)]],
  );
}

function cleanupInteractionQuestions(interaction: CleanupInteractionView) {
  const questions = interactionRecord(interaction.payload).questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((question) => {
    const value = interactionRecord(question);
    if (typeof value.id !== 'string' || typeof value.question !== 'string')
      return [];
    return [
      {
        id: value.id,
        question: value.question,
        header: typeof value.header === 'string' ? value.header : '',
      },
    ];
  });
}

function acceptCleanupResolution(
  interaction: CleanupInteractionView,
): JsonValue {
  if (interaction.method === 'item/permissions/requestApproval')
    return {
      permissions:
        (interactionRecord(interaction.payload).permissions as
          JsonValue | undefined) ?? {},
      scope: 'session',
    };
  return { decision: 'acceptForSession' };
}

function declineCleanupResolution(
  interaction: CleanupInteractionView,
): JsonValue {
  return interaction.method === 'item/permissions/requestApproval'
    ? { permissions: {}, scope: 'turn' }
    : { decision: 'decline' };
}

function interactionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
