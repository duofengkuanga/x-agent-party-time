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

  test('非法 project、panel 与 engineering 回到最近可访问父级', () => {
    expect(
      normalizeProjectSettingsRoute(
        { projectId: 'missing', panel: 'engineering' },
        access,
      ),
    ).toEqual({});
    expect(
      normalizeProjectSettingsRoute(
        { projectId: 'owned', panel: 'unknown', engineeringId: 'x' },
        access,
      ),
    ).toEqual({});
    expect(
      normalizeProjectSettingsRoute(
        {
          projectId: 'owned',
          panel: 'engineering',
          engineeringId: 'missing',
          mode: 'members',
        },
        access,
      ),
    ).toEqual({ projectId: 'owned', panel: 'engineering' });
  });

  test('无权限 project panel、new engineering 与 mode 被规范化', () => {
    expect(
      normalizeProjectSettingsRoute(
        { projectId: 'member', panel: 'project' },
        access,
      ),
    ).toEqual({ projectId: 'member', panel: 'collaboration' });
    expect(
      normalizeProjectSettingsRoute(
        { projectId: 'member', panel: 'engineering', engineeringId: 'new' },
        access,
      ),
    ).toEqual({ projectId: 'member', panel: 'engineering' });
    expect(
      normalizeProjectSettingsRoute(
        {
          projectId: 'member',
          panel: 'engineering',
          engineeringId: 'engineering-one',
          mode: 'environments',
        },
        access,
      ),
    ).toEqual({
      projectId: 'member',
      panel: 'engineering',
      engineeringId: 'engineering-one',
    });
  });
});
