import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const bugBoardPath = new URL('./bug-board.tsx', import.meta.url);

describe('缺陷工程分组选择', () => {
  test('只按当前提测快照分组展示名称和稳定标识', async () => {
    const source = await readFile(bugBoardPath, 'utf8');
    expect(source).toContain("engineering.type === 'FRONTEND'");
    expect(source).toContain("engineering.type === 'BACKEND'");
    expect(source).toContain('<option value="">暂不确定</option>');
    expect(source).toContain('<optgroup label="前端">');
    expect(source).toContain('<optgroup label="后端">');
    expect(source).toContain(
      '{item.engineering.name}（{item.engineering.identifier}）',
    );
    expect(source).toContain('value={item.id}');
    expect(source).not.toContain('item.engineering.id}');
  });
});
