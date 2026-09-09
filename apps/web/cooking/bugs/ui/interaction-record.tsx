'use client';

import { useState } from 'react';
import type { JsonValue } from '@agent-party-time/execution-contract';
import type { CookingInteractionView } from '@/cooking/shared/contract';
import type { WorkspaceActionResult } from './board-model';
import { formatDateTime } from './board-model';
import { Detail } from './detail-fields';

export function CookingInteractionRecord({
  interaction,
  onResolve,
  pending,
  run,
}: {
  interaction: CookingInteractionView;
  onResolve: (resolution: JsonValue) => Promise<WorkspaceActionResult>;
  pending: boolean;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
}) {
  const [answers, setAnswers] = useState<
    Record<string, { selected: string; custom: string }>
  >({});
  const resolved = interaction.state === 'RESOLVED';
  if (!interaction.request)
    return (
      <article
        className="collab-interaction-record"
        data-state={interaction.state}
      >
        <strong>
          {resolved ? '工程负责人已处理 Codex 请求' : '等待工程负责人处理'}
        </strong>
        <p>技术参数仅向对应工程负责人展示。</p>
      </article>
    );
  if (interaction.kind === 'APPROVAL') {
    const request = interaction.request;
    return (
      <article
        className="collab-interaction-record"
        data-state={interaction.state}
      >
        <header>
          <strong>{request.title}</strong>
          <time>{formatDateTime(interaction.createdAt)}</time>
        </header>
        {request.purpose ? <p>{request.purpose}</p> : null}
        <dl className="collab-bug-detail-list">
          {request.command ? (
            <Detail label="命令摘要">
              <code>{request.command}</code>
            </Detail>
          ) : null}
          {request.permissions ? (
            <Detail label="权限摘要">
              <ul className="collab-permission-summary">
                {permissionSummary(request.permissions).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Detail>
          ) : null}
        </dl>
        {resolved ? (
          <p className="collab-interaction-resolution">
            实际决定：{approvalResolutionLabel(interaction.resolution)}
          </p>
        ) : interaction.canResolve ? (
          <div className="collab-interaction-actions">
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () => onResolve(approvalResolution(request, 'DECLINED')),
                  '已拒绝 Codex 请求。',
                )
              }
              type="button"
            >
              拒绝
            </button>
            <button
              data-primary="true"
              disabled={pending}
              onClick={() =>
                run(
                  () => onResolve(approvalResolution(request, 'ACCEPTED_ONCE')),
                  '已仅允许这一次。',
                )
              }
              type="button"
            >
              仅允许这一次
            </button>
            <button
              aria-describedby={`session-scope-${interaction.id}`}
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    onResolve(
                      approvalResolution(request, 'ACCEPTED_FOR_SESSION'),
                    ),
                  '已允许本次 Codex 会话。',
                )
              }
              type="button"
            >
              本次会话允许
            </button>
            <small id={`session-scope-${interaction.id}`}>
              仅对当前修复或更新会话后续同类请求生效。
            </small>
          </div>
        ) : null}
      </article>
    );
  }
  const answerValues = Object.fromEntries(
    interaction.request.questions.map((question) => {
      const draft = answers[question.id];
      return [
        question.id,
        draft?.selected === '__custom__' || draft?.selected === '__text__'
          ? draft.custom.trim()
          : (draft?.selected.trim() ?? ''),
      ];
    }),
  );
  return (
    <article
      className="collab-interaction-record"
      data-state={interaction.state}
    >
      <header>
        <strong>Codex 请求补充信息</strong>
        <time>{formatDateTime(interaction.createdAt)}</time>
      </header>
      {resolved ? (
        <dl className="collab-bug-detail-list">
          {interaction.request.questions.map((question) => (
            <Detail key={question.id} label={question.header}>
              {interaction.resolution?.answers[question.id]?.join('、') ??
                '未记录回答'}
            </Detail>
          ))}
        </dl>
      ) : interaction.canResolve ? (
        <div className="collab-interaction-questions">
          {interaction.request.questions.map((question) => (
            <fieldset key={question.id}>
              <legend>{question.header}</legend>
              <p>{question.question}</p>
              {question.options.map((option) => (
                <label key={option.value}>
                  <input
                    checked={answers[question.id]?.selected === option.value}
                    name={`question-${interaction.id}-${question.id}`}
                    onChange={() =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: {
                          selected: option.value,
                          custom: current[question.id]?.custom ?? '',
                        },
                      }))
                    }
                    type="radio"
                    value={option.value}
                  />
                  <span>{option.label}</span>
                  {option.description ? (
                    <small>{option.description}</small>
                  ) : null}
                </label>
              ))}
              {question.options.length ? (
                <label>
                  <input
                    checked={answers[question.id]?.selected === '__custom__'}
                    name={`question-${interaction.id}-${question.id}`}
                    onChange={() =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: {
                          selected: '__custom__',
                          custom: current[question.id]?.custom ?? '',
                        },
                      }))
                    }
                    type="radio"
                    value="__custom__"
                  />
                  <span>自定义回答</span>
                </label>
              ) : null}
              {question.options.length === 0 ||
              answers[question.id]?.selected === '__custom__' ? (
                <textarea
                  aria-label={`${question.header}的回答`}
                  maxLength={4_000}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: {
                        selected: question.options.length
                          ? '__custom__'
                          : '__text__',
                        custom: event.target.value,
                      },
                    }))
                  }
                  rows={3}
                  value={answers[question.id]?.custom ?? ''}
                />
              ) : null}
            </fieldset>
          ))}
          <button
            disabled={
              pending ||
              Object.values(answerValues).some((answer) => !answer.trim())
            }
            onClick={() =>
              run(
                () =>
                  onResolve({
                    answers: Object.fromEntries(
                      Object.entries(answerValues).map(([id, answer]) => [
                        id,
                        { answers: [answer] },
                      ]),
                    ),
                  }),
                '回答已提交给 Codex。',
                () => setAnswers({}),
              )
            }
            type="button"
          >
            统一提交回答
          </button>
        </div>
      ) : null}
    </article>
  );
}

type ApprovalRequest = NonNullable<
  Extract<CookingInteractionView, { kind: 'APPROVAL' }>['request']
>;

function approvalResolution(
  request: ApprovalRequest,
  decision: 'DECLINED' | 'ACCEPTED_ONCE' | 'ACCEPTED_FOR_SESSION',
): JsonValue {
  if (request.type === 'PERMISSION')
    return decision === 'DECLINED'
      ? { permissions: {}, scope: 'turn' }
      : {
          permissions: request.permissions ?? {},
          scope: decision === 'ACCEPTED_ONCE' ? 'turn' : 'session',
        };
  return {
    decision:
      decision === 'DECLINED'
        ? 'decline'
        : decision === 'ACCEPTED_ONCE'
          ? 'accept'
          : 'acceptForSession',
  };
}

function approvalResolutionLabel(
  resolution: 'DECLINED' | 'ACCEPTED_ONCE' | 'ACCEPTED_FOR_SESSION' | null,
): string {
  return resolution
    ? {
        DECLINED: '已拒绝',
        ACCEPTED_ONCE: '仅允许这一次',
        ACCEPTED_FOR_SESSION: '本次会话允许',
      }[resolution]
    : '已由工程负责人处理';
}

function permissionSummary(value: JsonValue): string[] {
  const labels: Record<string, string> = {
    fileSystem: '文件系统',
    network: '网络访问',
    hosts: '目标主机',
    root: '作用范围',
    mode: '操作方式',
    enabled: '启用状态',
  };
  const values: Record<string, string> = {
    true: '已启用',
    false: '未启用',
    read: '读取',
    write: '写入',
  };
  const valueLabel = (item: JsonValue): string => {
    if (Array.isArray(item))
      return item.length ? item.map(valueLabel).join('、') : '无';
    if (item && typeof item === 'object')
      return Object.entries(item)
        .map(
          ([key, child]) => `${labels[key] ?? '权限项'} ${valueLabel(child)}`,
        )
        .join('；');
    return values[String(item)] ?? String(item);
  };
  const walk = (item: JsonValue, path: string[]): string[] => {
    if (Array.isArray(item))
      return [`${path.join(' / ')}：${valueLabel(item)}`];
    if (item && typeof item === 'object')
      return Object.entries(item).flatMap(([key, child]) =>
        walk(child, [...path, labels[key] ?? '权限项']),
      );
    return [`${path.join(' / ')}：${values[String(item)] ?? String(item)}`];
  };
  const items = walk(value, []);
  return items.length ? items : ['未提供可展示的权限范围'];
}
