import { expect, test } from 'bun:test';
import { verifyResultContent } from '../apps/xapt/src/execution/result-verification';
import {
  HandoffTextSchema,
  REPAIR_HANDOFF_TEXT_ASSERTION,
  UPDATE_HANDOFF_TEXT_ASSERTION,
} from '../apps/web/cooking/repair/handoff';

const routeNotes = [
  '拆分 /bigScreen 与 /bigScreen/map 的角色权限，沿用现有菜单过滤和新窗口打开机制。',
  '访问 `/bigScreen/map` 验证区县账号。',
  '/bigScreen/map',
  '访问 /api/users?active=true 和 /cooking/projects#current。',
  '访问 /users、/homePage 和 /data-center。',
  '参考 https://example.invalid/Users/example 和 //example.invalid/home/docs。',
];

test.each(routeNotes)('网页路由在服务端和本机交接校验中可通过：%s', (note) => {
  expect(HandoffTextSchema.safeParse(note).success).toBe(true);
  expect(() =>
    verifyResultContent([REPAIR_HANDOFF_TEXT_ASSERTION], {
      result: { handoff: { impact: [{ path: 'config/routes.js', note }] } },
    }),
  ).not.toThrow();
  expect(() =>
    verifyResultContent([UPDATE_HANDOFF_TEXT_ASSERTION], {
      result: { handoffUse: { adopted: [note] } },
    }),
  ).not.toThrow();
});

const localPaths = [
  '/Users/example/project',
  '使用 /home/example/project',
  '构建输出：/private/tmp/build',
  '读取 `/var/tmp/build`',
  '目录=/tmp/build',
  '挂载于 /Volumes/work/project',
  '/Applications/tool',
  '/Library/tool',
  '/opt/tool',
  '/usr/bin/tool',
  '/root/project',
  '/workspace/project',
  '/data/project',
  '/etc/config',
  '/bin/tool',
  '/sbin/tool',
  '/dev/null',
  '/proc/self/status',
  '/sys/kernel',
  '/run/tool',
  '/srv/project',
  '/mnt/work/project',
  '/media/work/project',
  '/System/Library/tool',
  '/Network/work/project',
  '/cores/dump',
  '用户目录 ~/project',
  String.raw`使用 C:\Users\example\project`,
  '使用 C:/Users/example/project',
];

test.each(localPaths)('本机路径在服务端和本机交接校验中仍被拒绝：%s', (note) => {
  expect(HandoffTextSchema.safeParse(note).success).toBe(false);
  expect(() =>
    verifyResultContent([REPAIR_HANDOFF_TEXT_ASSERTION], {
      result: { handoff: { impact: [{ path: 'config/routes.js', note }] } },
    }),
  ).toThrow('结构化结果不符合本机字符串约束');
  expect(() =>
    verifyResultContent([UPDATE_HANDOFF_TEXT_ASSERTION], {
      result: { handoffUse: { adopted: [note] } },
    }),
  ).toThrow('结构化结果不符合本机字符串约束');
});

test('网页路由文字中的凭据赋值仍被拒绝', () => {
  const note = '访问 /bigScreen，TOKEN=fixture-value';
  expect(HandoffTextSchema.safeParse(note).success).toBe(false);
  expect(() =>
    verifyResultContent([REPAIR_HANDOFF_TEXT_ASSERTION], {
      result: { handoff: { limitations: [note] } },
    }),
  ).toThrow('结构化结果不符合本机字符串约束');
});
