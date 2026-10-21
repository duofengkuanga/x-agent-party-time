import { expect, test } from 'bun:test';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testDirectories } from '../testing/directories';
import { createCommandClassifier } from './commandContext';

const directory = testDirectories('xapt-command-context-');
test('从实际工作目录解析脚本，子包不套用根定义，变更后重新读取', async () => {
  const root = await realpath(await directory());
  const child = join(root, 'child');
  await mkdir(child);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { check: 'umi build' } }),
  );
  await writeFile(
    join(child, 'package.json'),
    JSON.stringify({ scripts: { check: 'tsc --noEmit' } }),
  );
  const classifier = createCommandClassifier(root);
  await classifier.ready;
  expect(classifier.classify('pnpm run check', root)).toBe('build');
  expect(classifier.classify('pnpm run check', child)).toBe('unknown');
  await classifier.ready;
  expect(classifier.classify('pnpm run check', child)).toBe('typecheck');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { check: 'eslint .' } }),
  );
  classifier.invalidate();
  await classifier.ready;
  expect(classifier.classify('pnpm run check', root)).toBe('lint');
  expect(classifier.classify('pnpm run check', '/outside')).toBe('unknown');
});

test('过多脚本、生命周期钩子、循环和符号链接均不证明单一构建', async () => {
  const root = await realpath(await directory());
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { build: 'umi build', prebuild: 'node setup.js' } }),
  );
  const classifier = createCommandClassifier(root);
  await classifier.ready;
  expect(classifier.classify('npm run build')).toBe('mixed');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { a: 'npm run b', b: 'npm run a' } }),
  );
  classifier.invalidate();
  await classifier.ready;
  expect(classifier.classify('npm run a')).toBe('unknown');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [i === 0 ? 'build' : `s${i}`, 'umi build']),
      ),
    }),
  );
  classifier.invalidate();
  await classifier.ready;
  expect(classifier.classify('npm run build')).toBe('unknown');
  const outside = await realpath(await directory());
  await writeFile(
    join(outside, 'package.json'),
    JSON.stringify({ scripts: { build: 'umi build' } }),
  );
  await symlink(outside, join(root, 'linked'));
  expect(classifier.classify('npm run build', join(root, 'linked'))).toBe('unknown');
  await classifier.ready;
  expect(classifier.classify('npm run build', join(root, 'linked'))).toBe('unknown');
});
