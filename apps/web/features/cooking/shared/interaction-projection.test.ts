import { describe, expect, test } from 'bun:test';
import {
  projectCookingInteraction,
  type CookingInteractionRow,
} from './interaction-projection';

const now = '2026-07-29T08:00:00.000Z';

describe('projectCookingInteraction', () => {
  test('完整保留 questions、options、说明和内部 value', () => {
    const projected = projectCookingInteraction(
      row({
        kind: 'USER_INPUT',
        method: 'item/tool/requestUserInput',
        payload_json: JSON.stringify({
          questions: [
            {
              id: 'strategy',
              header: '处理策略',
              question: '采用哪个方案？',
              options: [
                {
                  value: 'safe_path',
                  label: '稳妥方案',
                  description: '先补回归测试再修改',
                },
              ],
            },
          ],
        }),
      }),
      true,
    );
    expect(projected).toMatchObject({
      kind: 'USER_INPUT',
      request: {
        questions: [
          {
            id: 'strategy',
            header: '处理策略',
            question: '采用哪个方案？',
            options: [
              {
                value: 'safe_path',
                label: '稳妥方案',
                description: '先补回归测试再修改',
              },
            ],
          },
        ],
      },
    });
  });

  test('解决后投影实际决定，其他成员只看到安全只读状态', () => {
    const source = row({
      state: 'RESOLVED',
      resolution_json: JSON.stringify({ decision: 'accept' }),
      resolved_at: '2026-07-29T08:01:00.000Z',
    });
    expect(projectCookingInteraction(source, true)).toMatchObject({
      kind: 'APPROVAL',
      state: 'RESOLVED',
      resolution: 'ACCEPTED_ONCE',
      canResolve: false,
    });
    expect(projectCookingInteraction(source, false)).toMatchObject({
      state: 'RESOLVED',
      request: null,
      resolution: null,
      canResolve: false,
    });
  });

  test('选择题只读记录使用用户可见标签而不是内部 value', () => {
    const projected = projectCookingInteraction(
      row({
        kind: 'USER_INPUT',
        method: 'item/tool/requestUserInput',
        state: 'RESOLVED',
        payload_json: JSON.stringify({
          questions: [
            {
              id: 'strategy',
              header: '处理策略',
              question: '采用哪个方案？',
              options: [
                {
                  value: 'safe_path',
                  label: '稳妥方案',
                  description: '先补回归测试再修改',
                },
              ],
            },
          ],
        }),
        resolution_json: JSON.stringify({
          answers: { strategy: { answers: ['safe_path'] } },
        }),
        resolved_at: '2026-07-29T08:01:00.000Z',
      }),
      true,
    );
    expect(projected).toMatchObject({
      resolution: { answers: { strategy: ['稳妥方案'] } },
    });
    expect(JSON.stringify(projected)).not.toContain(
      '"answers":{"strategy":["safe_path"]}',
    );
  });
});

function row(
  values: Partial<CookingInteractionRow> = {},
): CookingInteractionRow {
  return {
    id: '00000000-0000-4000-8000-000000000901',
    execution_id: '00000000-0000-4000-8000-000000000902',
    kind: 'APPROVAL',
    method: 'item/commandExecution/requestApproval',
    payload_json: JSON.stringify({
      command: 'bun test',
      reason: '运行定向测试',
    }),
    state: 'PENDING',
    resolution_json: null,
    created_at: now,
    resolved_at: null,
    ...values,
  };
}
