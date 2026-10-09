import { describe, expect, test } from 'bun:test';
import {
  normalizeProjectSettingsRoute,
  parseProjectSettingsRoute,
  projectSettingsPath,
} from './route-state';

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
      '/cooking/projects?project=owned&panel=engineering&engineering=engineering-one&mode=members&success=%E5%B7%B2%E4%BF%9D%E5%AD%98',
    );
  });

  test.each([
    ['未知项目', { projectId: 'missing', panel: 'engineering' }, {}],
    [
      '未知面板',
      { projectId: 'owned', panel: 'unknown', engineeringId: 'x' },
      {},
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
      { projectId: 'member', panel: 'collaboration' },
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
});
