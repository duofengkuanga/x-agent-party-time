import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedBrowserFixture } from './browser-fixture';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const webRoot = resolve(import.meta.dir, '..');
const chromeUse = process.env.CHROME_USE_BIN ?? 'chrome-use';
const home = await mkdtemp(join(tmpdir(), 'agent-party-time-browser-'));
const nextEnvPath = join(webRoot, 'next-env.d.ts');
const originalNextEnv = await readFile(nextEnvPath, 'utf8');
let nextDistDir: string | undefined;
let server: Bun.Subprocess | undefined;
let exitCode = 1;
try {
  const fixture = await seedBrowserFixture(home);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  nextDistDir = `.next-browser-${port}`;
  const templatePath = join(webRoot, 'tests/browser/cooking.yaml');
  const suitePath = join(home, 'cooking.browser.yaml');
  const template = await readFile(templatePath, 'utf8');
  const suite = selectBrowserCase(template, process.env.AGENT_PARTY_TIME_BROWSER_CASE)
    .replaceAll('__BASE_URL__', baseUrl)
    .replaceAll('__PROJECT_ID__', fixture.projectId)
    .replaceAll('__SUBMISSION_ID__', fixture.submissionId)
    .replaceAll('__DEVELOPER_USERNAME__', fixture.developerUsername)
    .replaceAll('__USERNAME__', fixture.username)
    .replaceAll('__PASSWORD__', fixture.password);
  await writeFile(suitePath, suite);
  server = Bun.spawn(
    [
      process.execPath,
      '--bun',
      'next',
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        AGENT_PARTY_TIME_HOME: home,
        AGENT_PARTY_TIME_NEXT_DIST_DIR: nextDistDir,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  await waitForServer(`${baseUrl}/login`, server);
  const browserSession = `agent-party-time-${port}`;
  const viewport = Bun.spawn(
    [chromeUse, '--session', browserSession, 'set', 'viewport', '1800', '900'],
    {
      cwd: repositoryRoot,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  if ((await viewport.exited) !== 0) throw new Error('无法准备桌面浏览器视口');
  const browser = Bun.spawn([chromeUse, '--session', browserSession, 'test', suitePath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      AGENT_BROWSER_SCREENSHOT_DIR: join(repositoryRoot, 'cu-test-artifacts'),
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  exitCode = await browser.exited;
} finally {
  if (server) {
    server.kill();
    await server.exited;
  }
  await writeFile(nextEnvPath, originalNextEnv);
  const cleanup = [rm(home, { recursive: true, force: true })];
  if (nextDistDir)
    cleanup.push(rm(join(webRoot, nextDistDir), { recursive: true, force: true }));
  await Promise.all(cleanup);
}

process.exit(exitCode);

function selectBrowserCase(template: string, name: string | undefined): string {
  if (!name) return template;
  const cases = template.indexOf('\ncases:\n');
  const start = template.indexOf(`\n  - name: ${name}\n`, cases);
  if (cases < 0 || start < 0) throw new Error(`浏览器用例不存在：${name}`);
  const end = template.indexOf('\n  - name: ', start + 1);
  return (
    template.slice(0, cases + '\ncases:\n'.length) +
    template.slice(start, end < 0 ? undefined : end)
  );
}

async function reservePort(): Promise<number> {
  const placeholder = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('reserved'),
  });
  const port = placeholder.port;
  await placeholder.stop();
  return port!;
}

async function waitForServer(url: string, server: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js 启动失败，退出码 ${server.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await Bun.sleep(250);
  }
  throw new Error(`等待 ${url} 启动超时`);
}
