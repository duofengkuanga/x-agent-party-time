import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const webRoot = join(import.meta.dir, '../../..');
const shellPath = join(import.meta.dir, 'cooking-shell.tsx');

describe('Cooking 页面框架', () => {
  test('Cooking layout 统一挂载共享框架', async () => {
    const layout = await readFile(
      join(webRoot, 'app/cooking/layout.tsx'),
      'utf8',
    );
    expect(layout).toContain('<CookingShell');
    expect(layout).toContain('<AccountInvitationNotifications');
    expect(layout).toContain('accountNotifications=');

    const pageImplementations = [
      'app/cooking/projects/page.tsx',
      'app/cooking/runners/page.tsx',
      'features/cooking/submissions/presentation/submission-workspace.tsx',
    ];
    for (const page of pageImplementations) {
      expect(await readFile(join(webRoot, page), 'utf8')).not.toContain(
        '<CookingShell',
      );
    }
  });

  test('collab-topbar 只允许在共享框架中定义', async () => {
    const definitions: string[] = [];
    for (const root of ['app', 'features']) {
      for (const path of await tsxFiles(join(webRoot, root))) {
        if (
          (await readFile(path, 'utf8')).includes('className="collab-topbar"')
        )
          definitions.push(relative(webRoot, path));
      }
    }
    expect(definitions).toEqual([relative(webRoot, shellPath)]);
  });
});

async function tsxFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await tsxFiles(path)));
    else if (entry.name.endsWith('.tsx')) files.push(path);
  }
  return files;
}
