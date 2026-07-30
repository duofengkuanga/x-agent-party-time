import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const sourcePath = join(import.meta.dir, 'submission-workspace.tsx');

describe('提测信息编辑', () => {
  test('零缺陷负责人通过输入框和统一保存按钮修改目标分支', async () => {
    const source = await readFile(sourcePath, 'utf8');

    expect(source).toContain(
      "item.availableActions.includes('EDIT_TARGET_BRANCH')",
    );
    expect(source).toContain('className="collab-table-input"');
    expect(source).toContain('targetBranches,');
    expect(source).toContain('保存提测信息');
    expect(source).not.toContain('onBlur=');
  });
});
