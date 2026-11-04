import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeLocalFileSystem } from '../platform/files';
import { xaptPaths } from '../platform/paths';
import { LocalStateStore } from '../state/store';
import { testDirectories } from '../testing/directories';
import { maintainBuildCaches } from './buildCacheMaintenance';

const temporaryHome = testDirectories('xapt-build-cache-');

test('只维护已绑定且登记入口的仓库，逐仓库选择并核对声明的 Node', async () => {
  const home = await temporaryHome();
  const paths = xaptPaths(home);
  const files = new NodeLocalFileSystem();
  const state = new LocalStateStore(paths, files);
  await state.initialize();
  const repository = async (name: string, version: string) => {
    const cwd = join(home, name);
    await mkdir(join(cwd, 'scripts'), { recursive: true });
    const git = async (...args: string[]) => {
      const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      expect(await child.exited).toBe(0);
      return (await new Response(child.stdout).text()).trim();
    };
    await git('init', '-q');
    await git('config', 'user.name', 'xapt test');
    await git('config', 'user.email', 'xapt@example.invalid');
    await writeFile(join(cwd, '.nvmrc'), version);
    await writeFile(join(cwd, 'scripts', 'cache.js'), '// fake tool');
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        scripts: { 'build:cache:maintain': 'node scripts/cache.js --maintain' },
      }),
    );
    await git('add', '.');
    await git('commit', '-qm', 'register maintenance fixture');
    const revision = await git('rev-parse', 'HEAD');
    const bindingId = randomUUID();
    await state.bind(bindingId, cwd);
    return { cwd, bindingId, revision };
  };
  const nextCheckAt = Date.now() + 23 * 60 * 1000;
  for (const version of ['v24.123.45', 'v25.123.45']) {
    const bin = join(home, '.nvm', 'versions', 'node', version, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, 'node'),
      `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\n' '${version}'; exit; fi
[ "$1" = "scripts/cache.js" ] && [ "$2" = "--maintain" ] || exit 1
printf '%s\n' '${version}' >> checked
printf '%s\n' '{"nextCheckAt":${nextCheckAt},"failures":0,"issues":[]}'
`,
      { mode: 0o700 },
    );
  }
  const first = await repository('first', 'v24.123.45');
  const second = await repository('second', '25.123.45');
  const unrelated = await repository('unregistered', 'v24.123.45');
  const duplicate = randomUUID();
  await state.bind(duplicate, first.cwd);
  await files.writeAtomic(
    join(paths.state, 'buildCacheMaintenance.json'),
    JSON.stringify({
      entries: [
        { bindingId: first.bindingId, revision: first.revision },
        { bindingId: second.bindingId, revision: second.revision },
        { bindingId: duplicate, revision: first.revision },
      ],
    }),
    0o600,
  );

  const deadline = await maintainBuildCaches(
    paths,
    state,
    files,
    new AbortController().signal,
  );
  expect(deadline).toBe(nextCheckAt);
  expect(await readFile(join(first.cwd, 'checked'), 'utf8')).toBe('v24.123.45\n');
  expect(await readFile(join(second.cwd, 'checked'), 'utf8')).toBe('v25.123.45\n');
  await expect(readFile(join(unrelated.cwd, 'checked'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const firstNode = join(home, '.nvm', 'versions', 'node', 'v24.123.45', 'bin', 'node');
  await writeFile(
    firstNode,
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'v24.123.45\n'; exit; fi
(sleep 1; printf 'orphan' > unexpected) &
printf 'started' > running
wait
`,
  );
  const controller = new AbortController();
  const checking = maintainBuildCaches(paths, state, files, controller.signal);
  try {
    const deadline = Date.now() + 3_000;
    while (!(await files.info(join(first.cwd, 'running'))) && Date.now() < deadline)
      await Bun.sleep(20);
    expect(await files.info(join(first.cwd, 'running'))).not.toBeNull();
  } finally {
    controller.abort();
    await checking;
  }
  await Bun.sleep(1_100);
  expect(await files.info(join(first.cwd, 'unexpected'))).toBeNull();
}, 10_000);
