import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const pagePath = join(import.meta.dir, 'page.tsx');
const controlsPath = join(import.meta.dir, 'project-settings-controls.tsx');

describe('项目与工程交互基线', () => {
  test('项目页不增加独立的返回提测入口', async () => {
    const page = await readFile(pagePath, 'utf8');
    expect(page).not.toContain('返回提测');
    expect(page).toContain('>提测</Link>');
  });

  test('新建项目恢复为显式展开，并继续提交新 Project 接口字段', async () => {
    const controls = await readFile(controlsPath, 'utf8');
    expect(controls).toContain('useState(false)');
    expect(controls).toContain("{showCreate ? '取消' : '新建项目'}");
    expect(controls).toContain('action={createProjectAction}');
    expect(controls).toContain('name="name"');
    expect(controls).not.toContain('name="slug"');
  });

  test('邀请和工程创建恢复到独立弹窗层级', async () => {
    const page = await readFile(pagePath, 'utf8');
    expect(page).toContain("panel === 'invitations'");
    expect(page).toContain('<InvitationDialog invitations={invitations} />');
    expect(page).toContain("engineeringId === 'new'");
    expect(page).toContain('<EngineeringCreateForm projectId={projectId} />');
    expect(page).toContain("mode === 'edit'");
  });
});
