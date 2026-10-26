import { describe, expect, test } from 'bun:test';
import {
  normalizeProjectSettingsRoute,
  parseProjectSettingsRoute,
  projectSettingsPath,
} from './routeState';

const access = {
  projects: [
    { id: 'owned', owner: true },
    { id: 'member', owner: false },
  ],
  engineeringIds: ['engineering-one'],
};

describe('Project settings route state', () => {
  test('parse 与 format 使用唯一 query grammar', () => {
    const route = parseProjectSettingsRoute({
      project: 'owned',
      panel: 'engineering',
      engineering: 'engineering-one',
      mode: 'members',
      success: '已保存',
    });
    expect(projectSettingsPath(route)).toBe(
      '/projects?project=owned&panel=engineering&engineering=engineering-one&mode=members&success=%E5%B7%B2%E4%BF%9D%E5%AD%98',
    );
  });

  test.each([
    ['默认选中首个项目', {}, { projectId: 'owned' }],
    ['保留项目选择', { projectId: 'member' }, { projectId: 'member' }],
    ['未知项目', { projectId: 'missing', panel: 'engineering' }, { projectId: 'owned' }],
    [
      '未知面板',
      { projectId: 'owned', panel: 'unknown', engineeringId: 'x' },
      { projectId: 'owned' },
    ],
    [
      '未知工程',
      {
        projectId: 'owned',
        panel: 'engineering',
        engineeringId: 'missing',
        mode: 'members',
      },
      { projectId: 'owned', panel: 'engineering' },
    ],
    [
      '非所有者的项目面板',
      { projectId: 'member', panel: 'project' },
      { projectId: 'member' },
    ],
    [
      '非所有者新建工程',
      { projectId: 'member', panel: 'engineering', engineeringId: 'new' },
      { projectId: 'member', panel: 'engineering' },
    ],
    [
      '非所有者管理工程',
      {
        projectId: 'member',
        panel: 'engineering',
        engineeringId: 'engineering-one',
        mode: 'environments',
      },
      {
        projectId: 'member',
        panel: 'engineering',
        engineeringId: 'engineering-one',
      },
    ],
  ] as const)('%s 回到最近可访问父级', (_case, route, expected) => {
    expect(normalizeProjectSettingsRoute(route, access)).toEqual(expected);
  });

  test('无项目时保持空状态并保留反馈', () => {
    expect(
      normalizeProjectSettingsRoute(
        { projectId: 'missing', success: '项目已删除' },
        { projects: [] },
      ),
    ).toEqual({ success: '项目已删除' });
  });

  test('项目邀请不自动跳到工程', () => {
    expect(normalizeProjectSettingsRoute({ panel: 'invitations' }, access)).toEqual({
      panel: 'invitations',
    });
  });

  test('绑定进度保持当前工程和请求', () => {
    const route = {
      projectId: 'owned',
      panel: 'engineering',
      engineeringId: 'engineering-one',
      bindingRequestId: 'request-one',
    };
    expect(normalizeProjectSettingsRoute(route, access)).toEqual(route);
  });
});
