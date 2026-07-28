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
    expect(layout).toContain('if (!user) return children');

    const connectPage = await readFile(
      join(webRoot, 'app/cooking/agents/connect/page.tsx'),
      'utf8',
    );
    expect(connectPage).toContain(
      'redirect(`/login?next=${encodeURIComponent(returnPath)}`)',
    );

    const pageImplementations = [
      'app/cooking/projects/page.tsx',
      'app/cooking/agents/page.tsx',
      'app/cooking/agents/connect/page.tsx',
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

  test('Agent 是唯一用户路由与页面术语', async () => {
    const cookingSources = await Promise.all(
      [
        ...(await tsxFiles(join(webRoot, 'app/cooking'))),
        ...(await tsxFiles(join(webRoot, 'features/cooking/presentation'))),
      ].map((path) => readFile(path, 'utf8')),
    );
    expect(cookingSources.join('\n')).not.toContain('/cooking/runners');
    expect(
      await fileExists(join(webRoot, 'app/cooking/runners/page.tsx')),
    ).toBe(false);

    const agentPage = await readFile(
      join(webRoot, 'app/cooking/agents/page.tsx'),
      'utf8',
    );
    expect(agentPage).toContain('<h1>我的 Agent</h1>');
    expect(agentPage).toContain('绑定工程');
    expect(agentPage).toContain('需要处理');
    expect(agentPage).not.toContain('Runner 管理');
    expect(agentPage).not.toContain('Runner 标识');

    const shell = await readFile(shellPath, 'utf8');
    expect(shell).toContain('onClick={closeMenu}');
    expect(shell).toContain('我的项目');
    expect(shell).toContain('我的 Agent');

    const invitationNotifications = await readFile(
      join(
        webRoot,
        'features/cooking/projects/presentation/account-invitation-notifications.tsx',
      ),
      'utf8',
    );
    expect(invitationNotifications).toContain(
      'if (!invitations.length) return null',
    );
    expect(invitationNotifications).not.toContain('暂无待处理邀请');

    const connectPage = await readFile(
      join(webRoot, 'app/cooking/agents/connect/page.tsx'),
      'utf8',
    );
    expect(connectPage).toContain('<h1>连接 Agent</h1>');
    expect(connectPage).toContain('approval.fingerprint');
    expect(connectPage).toContain('name="approvalToken"');
    expect(connectPage).not.toContain('verifier');
    expect(connectPage).not.toContain('credential');
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
