import { describe, expect, test } from 'bun:test';
import { parseExecutionInteractionResolution } from '@agent-party-time/execution-contract';

describe('Execution Interaction resolution contract', () => {
  test('命令审批严格支持拒绝、单次允许和会话允许', () => {
    for (const decision of ['decline', 'accept', 'acceptForSession'] as const)
      expect(
        parseExecutionInteractionResolution(
          'item/commandExecution/requestApproval',
          { command: 'bun test' },
          { decision },
        ),
      ).toEqual({ decision });
    expect(() =>
      parseExecutionInteractionResolution(
        'item/commandExecution/requestApproval',
        { command: 'bun test' },
        { decision: 'always' },
      ),
    ).toThrow();
  });

  test('权限审批区分 Turn 与 Session Scope 且拒绝额外权限', () => {
    const payload = {
      permissions: {
        fileSystem: { mode: 'write', root: '本机路径已隐藏' },
        network: {
          enabled: true,
          hosts: ['registry.npmjs.org', 'api.example.com'],
        },
      },
    };
    expect(
      parseExecutionInteractionResolution(
        'item/permissions/requestApproval',
        payload,
        {
          permissions: {
            fileSystem: { mode: 'write', root: '本机路径已隐藏' },
          },
          scope: 'turn',
        },
      ),
    ).toEqual({
      permissions: {
        fileSystem: { mode: 'write', root: '本机路径已隐藏' },
      },
      scope: 'turn',
    });
    expect(() =>
      parseExecutionInteractionResolution(
        'item/permissions/requestApproval',
        payload,
        {
          permissions: { shell: { unrestricted: true } },
          scope: 'session',
        },
      ),
    ).toThrow();
    expect(
      parseExecutionInteractionResolution(
        'item/permissions/requestApproval',
        payload,
        {
          permissions: {
            network: {
              hosts: ['registry.npmjs.org'],
            },
          },
          scope: 'turn',
        },
      ),
    ).toEqual({
      permissions: {
        network: {
          hosts: ['registry.npmjs.org'],
        },
      },
      scope: 'turn',
    });
    expect(() =>
      parseExecutionInteractionResolution(
        'item/permissions/requestApproval',
        payload,
        { permissions: {}, scope: 'session' },
      ),
    ).toThrow();
  });

  test('多个 questions 必须一次提交且不能夹带未知回答', () => {
    const payload = {
      questions: [
        { id: 'strategy', header: '策略', question: '采用哪个方案？' },
        { id: 'confirm', header: '确认', question: '是否继续？' },
      ],
    };
    expect(
      parseExecutionInteractionResolution(
        'item/tool/requestUserInput',
        payload,
        {
          answers: {
            strategy: { answers: ['稳妥方案'] },
            confirm: { answers: ['继续'] },
          },
        },
      ),
    ).toMatchObject({
      answers: {
        strategy: { answers: ['稳妥方案'] },
        confirm: { answers: ['继续'] },
      },
    });
    expect(() =>
      parseExecutionInteractionResolution(
        'item/tool/requestUserInput',
        payload,
        { answers: { strategy: { answers: ['稳妥方案'] } } },
      ),
    ).toThrow();
  });
});
