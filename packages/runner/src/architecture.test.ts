import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('Runner 与 execution-contract 不依赖 Cooking 或业务任务分支', async () => {
  const roots = [
    join(import.meta.dir),
    join(import.meta.dir, '..', '..', 'execution-contract', 'src'),
  ];
  const sources = (
    await Promise.all(roots.map((root) => sourceFiles(root)))
  ).flat();
  const text = (
    await Promise.all(sources.map((path) => readFile(path, 'utf8')))
  ).join('\n');

  expect(text).not.toMatch(/from\s+['"][^'"]*cooking[^'"]*['"]/iu);
  expect(text).not.toMatch(/\b(?:Bug|Submission|Repair|Verification|CI_CD)\b/u);
});

test('Runner 进程执行边界只允许 Codex App Server', async () => {
  const source = await readFile(
    join(import.meta.dir, 'codex-app-server.ts'),
    'utf8',
  );
  expect(source).toContain("private readonly executable = 'codex'");
  expect(source).toContain("this.spawnProcess(this.executable, ['app-server']");
  expect(source).not.toMatch(
    /spawn(?:Sync)?\s*\(\s*['"](?:git|bun|npm|pnpm|yarn|sh|bash|zsh|docker|kubectl)['"]/u,
  );
});

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      result.push(path);
  }
  return result;
}
