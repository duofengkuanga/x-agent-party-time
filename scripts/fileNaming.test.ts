import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const conventionNames = new Set(['AGENTS.md', 'CONTEXT.md', 'README.md', 'SKILL.md']);
const fixedPaths = new Set([
  '.gitignore',
  '.prettierrc.json',
  'apps/web/app/not-found.tsx',
  'apps/web/next-env.d.ts',
  'apps/web/next.config.mjs',
  'scripts/install-xapt.sh',
]);

test('自定义文件名使用小驼峰，保留工具约定和已发布安装入口', () => {
  const paths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter((path) => path && existsSync(join(root, path)));
  const violations = paths.filter((path) => {
    const name = basename(path);
    return (
      !conventionNames.has(name) &&
      !fixedPaths.has(path) &&
      !/^[a-z][a-zA-Z0-9]*(?:\.(?:test|spec|d))?\.[a-z0-9]+$/u.test(name)
    );
  });
  expect(
    violations,
    '检查范围为 Git 管理及未忽略的新增文件；请将列出的文件改为小驼峰并同步引用，直到违规列表为空。',
  ).toEqual([]);
});
