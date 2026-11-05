import { testDirectories } from '../testing/directories';
import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';

import { join, resolve } from 'node:path';
import { xaptPaths } from '../platform/paths';
import { bundleHash, SkillBundleManager, type XaptSkillName } from './manager';

const temporaryHome = testDirectories('xapt-skills-');

describe('SkillBundleManager', () => {
  test('Bundle Hash 不依赖文件顺序并区分内容', () => {
    const first = { path: 'SKILL.md', bytes: bytes('first') };
    const second = { path: 'agents/openai.yaml', bytes: bytes('second') };
    const unicode = { path: 'references/说明.md', bytes: bytes('third') };

    expect(bundleHash([first, second, unicode])).toBe(
      bundleHash([unicode, second, first]),
    );
    expect(bundleHash([first, second, unicode])).not.toBe(
      bundleHash([{ ...first, bytes: bytes('changed') }, second, unicode]),
    );
  });

  test('安装一个完整 generation 并通过单一命名空间软链接暴露', async () => {
    const home = await temporaryHome();
    const paths = xaptPaths(home);
    const revision = 'a'.repeat(40);
    const manager = new SkillBundleManager(
      paths,
      githubFixture(() => generation(revision)),
    );

    const result = await manager.update();

    expect(result).toEqual({
      installed: true,
      updated: true,
      sourceRevision: revision,
      warning: null,
    });
    const namespaceTarget = resolve(
      paths.userSkills,
      await readlink(paths.skillNamespaceLink),
    );
    expect(namespaceTarget).toBe(join(paths.skillGenerations, revision));
    const manifest = JSON.parse(
      await readFile(join(namespaceTarget, 'manifest.json'), 'utf8'),
    ) as { sourceRevision: string; skills: Record<string, string> };
    expect(manifest.sourceRevision).toBe(revision);
    expect(Object.keys(manifest.skills).sort()).toEqual([
      'XBugRepaire',
      'XHandoff',
      'XUpdate',
    ]);
    const repair = await manager.resolveCurrent('XBugRepaire');
    expect(repair.sourceRevision).toBe(revision);
    expect(repair.path).toBe(join(paths.skillBundles, repair.bundleHash));
  });

  test('同内容的新 Commit 复用 Bundle 并保存新的 sourceRevision', async () => {
    const home = await temporaryHome();
    const paths = xaptPaths(home);
    let revision = 'a'.repeat(40);
    const manager = new SkillBundleManager(
      paths,
      githubFixture(() => generation(revision)),
    );
    await manager.update();
    const before = await manager.resolveCurrent('XBugRepaire');

    revision = 'c'.repeat(40);
    await manager.update();
    const after = await manager.resolveCurrent('XBugRepaire');

    expect(after.bundleHash).toBe(before.bundleHash);
    expect(after.sourceRevision).toBe(revision);
    expect(await readlink(paths.skillNamespaceLink)).toContain(revision);
  });

  test('更新后当前解析使用新 Bundle，已有 Task 仍解析原 Bundle', async () => {
    const { paths, original, current, snapshot } = await updatedRepairBundle();
    const restarted = new SkillBundleManager(
      paths,
      githubFixture(() => snapshot),
    );
    const bound = await restarted.resolveBound(original);
    expect(current.bundleHash).not.toBe(original.bundleHash);
    expect(current.sourceRevision).toBe('c'.repeat(40));
    expect(bound).toEqual(original);
  });

  test('Skill 改名后新任务使用新名称，旧 Task 仍按原名称与 Hash 恢复', async () => {
    const paths = xaptPaths(await temporaryHome());
    const revision = 'd'.repeat(40);
    const generationPath = join(paths.skillGenerations, revision);
    const skills: Record<string, string> = {};
    await mkdir(generationPath, { recursive: true });
    for (const name of [
      'agent-party-time-repair-bug',
      'agent-party-time-integrate-update-batch',
    ]) {
      const files = [
        {
          path: 'SKILL.md',
          bytes: bytes(`---\nname: ${name}\ndescription: Historical task.\n---\n`),
        },
        {
          path: 'agents/openai.yaml',
          bytes: bytes('policy:\n  allow_implicit_invocation: false\n'),
        },
      ];
      const hash = bundleHash(files);
      skills[name] = hash;
      const bundle = join(paths.skillBundles, hash);
      await mkdir(join(bundle, 'agents'), { recursive: true });
      for (const file of files) await writeFile(join(bundle, file.path), file.bytes);
      await symlink(join('..', '..', 'bundles', hash), join(generationPath, name));
    }
    await writeFile(
      join(generationPath, 'manifest.json'),
      JSON.stringify({ sourceRevision: revision, skills }),
    );
    await mkdir(paths.userSkills, { recursive: true });
    await symlink(generationPath, paths.skillNamespaceLink);
    const manager = new SkillBundleManager(
      paths,
      githubFixture(() => generation('a'.repeat(40))),
    );
    const identity = {
      skillName: 'agent-party-time-repair-bug',
      bundleHash: skills['agent-party-time-repair-bug']!,
      sourceRevision: revision,
    };
    const original = await manager.resolveBound(identity);
    expect(await manager.initialize()).toMatchObject({
      installed: false,
      warning: expect.stringContaining('xapt skills update'),
    });
    await expect(manager.resolveCurrent('XBugRepaire')).rejects.toThrow(
      'xapt skills update',
    );
    await manager.update();
    expect((await manager.resolveCurrent('XBugRepaire')).skillName).toBe('XBugRepaire');
    expect((await manager.resolveCurrent('XUpdate')).skillName).toBe('XUpdate');
    expect(await manager.resolveBound(identity)).toEqual(original);
    await expect(
      manager.resolveBound({ ...identity, skillName: 'XBugRepaire' }),
    ).rejects.toThrow('不匹配');
    await expect(
      manager.resolveBound({ ...identity, skillName: '../outside' }),
    ).rejects.toThrow('关联无效');
  });

  test('原任务要求同代的 XHandoff，更新后缺失或损坏均明确拒绝', async () => {
    const home = await temporaryHome();
    const paths = xaptPaths(home);
    let snapshot = generation('a'.repeat(40));
    const manager = new SkillBundleManager(
      paths,
      githubFixture(() => snapshot),
    );
    await manager.update();
    const original = await manager.resolveCurrent('XUpdate');
    snapshot = generation('c'.repeat(40), {
      XHandoff: {
        'SKILL.md': skillMarkdown('XHandoff') + '\n# New',
        'agents/openai.yaml': openaiYaml('XHandoff'),
      },
    });
    await manager.update();
    expect((await manager.resolveCurrent('XUpdate')).handoffPath).not.toBe(
      original.handoffPath,
    );
    expect((await manager.resolveBound(original)).handoffPath).toBe(original.handoffPath);
    await writeFile(original.handoffPath!, 'wrong contents');
    await expect(manager.resolveBound(original)).rejects.toThrow('内容校验失败');
  });

  test('任一 Skill 无效时不切换当前 generation', async () => {
    const home = await temporaryHome();
    const paths = xaptPaths(home);
    let snapshot = generation('a'.repeat(40));
    const manager = new SkillBundleManager(
      paths,
      githubFixture(() => snapshot),
    );
    await manager.update();
    const previous = await readlink(paths.skillNamespaceLink);
    snapshot = generation('c'.repeat(40), {
      XUpdate: {
        'SKILL.md': 'invalid',
        'agents/openai.yaml': openaiYaml('XUpdate'),
      },
    });

    await expect(manager.update()).rejects.toThrow('frontmatter 无效');
    expect(await readlink(paths.skillNamespaceLink)).toBe(previous);
  });

  test('首次安装失败不阻止初始化，并保留用户冲突目录', async () => {
    const home = await temporaryHome();
    const paths = xaptPaths(home);
    await mkdir(paths.skillNamespaceLink, { recursive: true });
    await writeFile(join(paths.skillNamespaceLink, 'mine.txt'), 'keep');
    const manager = new SkillBundleManager(
      paths,
      githubFixture(() => generation('a'.repeat(40))),
    );

    const result = await manager.initialize();

    expect(result.installed).toBe(false);
    expect(result.warning).toContain('不由 xapt 管理');
    expect(await readFile(join(paths.skillNamespaceLink, 'mine.txt'), 'utf8')).toBe(
      'keep',
    );
  });

  test('GitHub 不可用时初始化返回可操作警告', async () => {
    const home = await temporaryHome();
    const manager = new SkillBundleManager(
      xaptPaths(home),
      (async () =>
        new Response('unavailable', {
          status: 503,
        })) as unknown as typeof fetch,
    );

    const result = await manager.initialize();

    expect(result).toMatchObject({ installed: false, updated: false });
    expect(result.warning).toContain('HTTP 503');
  });

  test('拒绝仓库 Skill 目录内的软链接', async () => {
    const home = await temporaryHome();
    const snapshot = generation('a'.repeat(40));
    snapshot.files['skills/XBugRepaire/link'] = {
      content: '../outside',
      mode: '120000',
    };
    const manager = new SkillBundleManager(
      xaptPaths(home),
      githubFixture(() => snapshot),
    );

    await expect(manager.update()).rejects.toThrow('文件类型无效');
  });

  test('恢复绑定时重新校验旧 Bundle 内容', async () => {
    const home = await temporaryHome();
    const paths = xaptPaths(home);
    const manager = new SkillBundleManager(
      paths,
      githubFixture(() => generation('a'.repeat(40))),
    );
    await manager.update();
    const current = await manager.resolveCurrent('XBugRepaire');
    await writeFile(join(current.path, 'SKILL.md'), 'tampered');

    await expect(manager.resolveBound(current)).rejects.toThrow('内容校验失败');
  });

  test('用户删除旧 Bundle 后恢复失败且不回退当前 Bundle', async () => {
    const { manager, original, current } = await updatedRepairBundle();
    await rm(original.path, { recursive: true });

    await expect(manager.resolveBound(original)).rejects.toThrow('规则包不存在');
    expect(await manager.resolveCurrent('XBugRepaire')).toEqual(current);
  });
});

async function updatedRepairBundle() {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  let snapshot = generation('a'.repeat(40));
  const manager = new SkillBundleManager(
    paths,
    githubFixture(() => snapshot),
  );
  await manager.update();
  const original = await manager.resolveCurrent('XBugRepaire');
  snapshot = generation('c'.repeat(40), {
    XBugRepaire: {
      'SKILL.md': `${skillMarkdown('XBugRepaire')}\nUpdated.\n`,
      'agents/openai.yaml': openaiYaml('XBugRepaire'),
    },
  });
  await manager.update();
  const current = await manager.resolveCurrent('XBugRepaire');
  return { paths, manager, original, current, snapshot };
}

type FixtureFile = { content: string; mode: string };
type FixtureGeneration = {
  revision: string;
  treeSha: string;
  files: Record<string, FixtureFile>;
};

function generation(
  revision: string,
  overrides: Partial<Record<XaptSkillName, Record<string, string>>> = {},
): FixtureGeneration {
  const files: Record<string, FixtureFile> = {};
  for (const name of ['XBugRepaire', 'XUpdate', 'XHandoff'] as const) {
    const values = overrides[name] ?? {
      'SKILL.md': skillMarkdown(name),
      'agents/openai.yaml': openaiYaml(name),
    };
    for (const [path, content] of Object.entries(values))
      files[`skills/${name}/${path}`] = { content, mode: '100644' };
  }
  return { revision, treeSha: 'b'.repeat(40), files };
}

function githubFixture(current: () => FixtureGeneration): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const snapshot = current();
    if (url.endsWith('/commits/main'))
      return Response.json({
        sha: snapshot.revision,
        commit: { tree: { sha: snapshot.treeSha } },
      });
    if (url.includes('/git/trees/'))
      return Response.json({
        truncated: false,
        tree: Object.entries(snapshot.files).map(([path, file], index) => ({
          path,
          mode: file.mode,
          type: 'blob',
          url: `https://api.github.com/blob/${index}`,
        })),
      });
    if (url.includes('/blob/')) {
      const index = Number(url.slice(url.lastIndexOf('/') + 1));
      const file = Object.values(snapshot.files)[index];
      if (!file) return new Response('not found', { status: 404 });
      return Response.json({
        encoding: 'base64',
        content: Buffer.from(file.content).toString('base64'),
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function skillMarkdown(name: XaptSkillName): string {
  return `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# Test\n`;
}

function openaiYaml(name: XaptSkillName): string {
  return `interface:\n  display_name: "${name}"\n  short_description: "Explicit test skill description"\n  default_prompt: "Use $${name}."\npolicy:\n  allow_implicit_invocation: false\n`;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
