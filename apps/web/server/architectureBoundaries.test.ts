import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const webRoot = resolve(import.meta.dir, '..');

async function sourceFiles(root: string) {
  const files: Array<{ path: string; source: string }> = [];
  for await (const path of new Bun.Glob('**/*.{ts,tsx}').scan({
    cwd: root,
    onlyFiles: true,
  }))
    files.push({
      path: resolve(root, path),
      source: await readFile(resolve(root, path), 'utf8'),
    });
  return files;
}

function imports(path: string, source: string) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const targets: string[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      targets.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      targets.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return targets.map((target) =>
    target.startsWith('@/')
      ? resolve(webRoot, target.slice(2))
      : target.startsWith('.')
        ? resolve(dirname(path), target)
        : target,
  );
}

const isTest = (path: string) => /\.test\.tsx?$/u.test(path);

test('Web 与 xapt 通过共享协议协作，不导入彼此内部实现', async () => {
  const violations: string[] = [];
  const xaptRoot = resolve(webRoot, '../xapt');
  for (const { path, source } of await sourceFiles(webRoot)) {
    if (path.includes('/.next')) continue;
    for (const target of imports(path, source))
      if (target.startsWith(xaptRoot + '/') || target.includes('/packages/runner/src'))
        violations.push(`${relative(webRoot, path)} → ${target}`);
  }
  for (const { path, source } of await sourceFiles(resolve(xaptRoot, 'src'))) {
    if (isTest(path)) continue;
    for (const target of imports(path, source))
      if (target.startsWith(webRoot + '/') || target.startsWith('@/'))
        violations.push(`${relative(xaptRoot, path)} → ${target}`);
  }
  expect(violations, '移除应用内部互相导入，改用共享协议后重跑本检查。').toEqual([]);
});

test('通用平台不依赖提测业务、Web 入口或运行时装配', async () => {
  const violations: string[] = [];
  for (const { path, source } of await sourceFiles(resolve(webRoot, 'server/platform'))) {
    if (isTest(path)) continue;
    for (const target of imports(path, source))
      if (
        ['server/submissions/', 'server/runtime/', 'app/', 'contracts/submissions/'].some(
          (prefix) => target.startsWith(resolve(webRoot, prefix) + '/'),
        )
      )
        violations.push(`${relative(webRoot, path)} → ${relative(webRoot, target)}`);
    if (
      /\b(?:test_submission|submission_(?:item|bug|repair|update|cleanup|verification|reopen|pending|external))\b/u.test(
        source,
      )
    )
      violations.push(`${relative(webRoot, path)} → 提测表查询应由提测模块提供`);
  }
  expect(violations, '把提测规则交给业务模块，通过 runtime 接入通用能力。').toEqual([]);
});

test('数据契约独立于服务端实现与页面入口', async () => {
  const violations: string[] = [];
  for (const { path, source } of await sourceFiles(resolve(webRoot, 'contracts'))) {
    if (isTest(path)) continue;
    for (const target of imports(path, source))
      if (
        [
          resolve(webRoot, 'server') + '/',
          resolve(webRoot, 'app') + '/',
          'node:',
          'bun:',
        ].some((prefix) => target.startsWith(prefix))
      )
        violations.push(`${relative(webRoot, path)} → ${target}`);
  }
  expect(violations).toEqual([]);
});

test('浏览器组件只通过 Actions 或 HTTP 调用服务端', async () => {
  const violations: string[] = [];
  for (const { path, source } of await sourceFiles(resolve(webRoot, 'app'))) {
    if (isTest(path) || !/^['"]use client['"];?/u.test(source)) continue;
    for (const target of imports(path, source))
      if (
        target.startsWith(resolve(webRoot, 'server') + '/') ||
        target === resolve(webRoot, 'app/auth') ||
        target.startsWith('node:') ||
        target.startsWith('bun:')
      )
        violations.push(`${relative(webRoot, path)} → ${target}`);
  }
  expect(violations).toEqual([]);
});

test('运行时只使用新 Schema，历史名称只存在于离线迁移与旧版 fixture', async () => {
  const violations: string[] = [];
  for (const area of ['app', 'server', 'contracts'])
    for (const { path, source } of await sourceFiles(resolve(webRoot, area))) {
      if (isTest(path)) continue;
      if (/\bcooking_|['"]cooking['"]|\/cooking(?:\/|['"`])/u.test(source))
        violations.push(relative(webRoot, path));
    }
  expect(violations).toEqual([]);
});
