// Copied into a disposable Engineering by the observability evaluation only.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const state = '.case';
mkdirSync(state, { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const log = (step: string, facts = {}) =>
  appendFileSync(join(state, 'trace.jsonl'), JSON.stringify({ step, ...facts }) + '\n');
const receipt = (activity: string, workId?: string, durationMs?: number) =>
  console.log(
    'XAPT_OBSERVATION_V1 ' +
      JSON.stringify({
        version: 1,
        activityId: randomUUID(),
        activity,
        status: 'succeeded',
        ...(workId ? { workId } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
      }),
  );
const input = () => {
  if (git('status', '--porcelain')) throw new Error('Uncommitted inputs');
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  return hash(
    JSON.stringify({
      files: files.map((path) => [path, hash(readFileSync(path))]),
      runtime: Bun.version,
      environment: JSON.parse(readFileSync('build-config.json', 'utf8')).environment,
    }),
  );
};
const check = () => {
  const started = performance.now();
  execFileSync(process.execPath, ['test', 'tests'], { stdio: 'inherit' });
  log('test');
  receipt('test', undefined, performance.now() - started);
};
const build = () => {
  const started = performance.now();
  const inputDigest = input();
  let scope = existsSync(join(state, 'scope.json'))
    ? JSON.parse(readFileSync(join(state, 'scope.json'), 'utf8'))
    : null;
  if (!scope || scope.inputDigest !== inputDigest)
    scope = { inputDigest, workId: randomUUID() };
  writeFileSync(join(state, 'scope.json'), JSON.stringify(scope));
  check();
  const result = awaitBuild();
  if (!result.success) throw new Error('Build failed');
  const bytes = readFileSync(join(state, 'artifact.js'));
  const manifest = {
    version: 1,
    artifactId: randomUUID(),
    workId: scope.workId,
    inputDigest,
    sourceCommit: git('rev-parse', 'HEAD'),
    digest: hash(bytes),
    tested: true,
  };
  const archive = join(state, manifest.artifactId + '.js');
  writeFileSync(archive, bytes, { flag: 'wx', mode: 0o400 });
  writeFileSync(join(state, 'manifest.json'), JSON.stringify(manifest));
  log('build', {
    artifactId: manifest.artifactId,
    digest: manifest.digest,
    workId: scope.workId,
  });
  receipt('build', scope.workId, performance.now() - started);
};
function awaitBuild() {
  // Use the real compiler with fixed, offline inputs and a bounded output.
  execFileSync(
    process.execPath,
    ['build', 'src/add.ts', '--target=node', '--outfile=' + join(state, 'artifact.js')],
    { stdio: 'inherit' },
  );
  return { success: true };
}
const deploy = () => {
  const started = performance.now();
  if (JSON.parse(readFileSync('build-config.json', 'utf8')).variant === 'baseline')
    build();
  const manifest = JSON.parse(readFileSync(join(state, 'manifest.json'), 'utf8'));
  if (
    typeof manifest.artifactId !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(manifest.artifactId)
  )
    throw new Error('Artifact identity invalid');
  const bytes = readFileSync(join(state, manifest.artifactId + '.js'));
  if (
    !manifest.tested ||
    manifest.inputDigest !== input() ||
    manifest.sourceCommit !== git('rev-parse', 'HEAD') ||
    hash(bytes) !== manifest.digest
  )
    throw new Error('Artifact binding invalid');
  if (
    git('ls-remote', 'origin', 'refs/heads/main').split(/\s/u)[0] !==
    manifest.sourceCommit
  )
    throw new Error('Push not confirmed');
  if (
    !existsSync(join(state, 'audit.json')) ||
    JSON.parse(readFileSync(join(state, 'audit.json'), 'utf8')).inputDigest !==
      manifest.inputDigest
  )
    throw new Error('Independent audit missing');
  const target = join(state, 'target');
  mkdirSync(target, { recursive: true });
  const targetReceipt = join(target, 'receipt.json');
  if (existsSync(targetReceipt)) {
    const previous = JSON.parse(readFileSync(targetReceipt, 'utf8'));
    if (
      previous.artifactId !== manifest.artifactId ||
      hash(readFileSync(join(target, 'artifact.js'))) !== manifest.digest
    )
      throw new Error('Target changed concurrently');
    log('deploy.already_applied', { artifactId: manifest.artifactId });
  } else {
    // Send the same bytes held and verified above; there is no re-packing or compiler fallback.
    writeFileSync(join(target, 'artifact.js'), bytes, { flag: 'wx', mode: 0o400 });
    writeFileSync(
      targetReceipt,
      JSON.stringify({
        artifactId: manifest.artifactId,
        digest: hash(readFileSync(join(target, 'artifact.js'))),
        sourceCommit: manifest.sourceCommit,
      }),
    );
    log('deploy', {
      artifactId: manifest.artifactId,
      digest: manifest.digest,
      pushed: true,
    });
  }
  if (existsSync(join(state, 'lose-response')))
    throw new Error('Synthetic response loss after target receipt');
  receipt('deploy', manifest.workId, performance.now() - started);
};
const mode = process.argv[2];
if (mode === 'test') check();
else if (mode === 'build') build();
else if (mode === 'audit') {
  writeFileSync(join(state, 'audit.json'), JSON.stringify({ inputDigest: input() }));
  log('audit');
} else if (mode === 'deploy') deploy();
else throw new Error('Expected test/build/audit/deploy');
