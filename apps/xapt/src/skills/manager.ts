import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { XaptPaths } from '../platform/paths';

export const XAPT_SKILL_NAMES = [
  'agent-party-time-repair-bug',
  'agent-party-time-integrate-update-batch',
] as const;

export type XaptSkillName = (typeof XAPT_SKILL_NAMES)[number];

type SkillFile = {
  path: string;
  bytes: Uint8Array;
};

type DownloadedSkill = {
  name: XaptSkillName;
  files: SkillFile[];
};

type DownloadedGeneration = {
  sourceRevision: string;
  skills: DownloadedSkill[];
};

export type SkillIdentity = {
  skillName: XaptSkillName;
  bundleHash: string;
  sourceRevision: string;
};

export type ResolvedSkill = SkillIdentity & { path: string };

export type SkillInstallResult = {
  installed: boolean;
  updated: boolean;
  sourceRevision: string | null;
  warning: string | null;
};

type GenerationManifest = {
  sourceRevision: string;
  skills: Record<XaptSkillName, string>;
};

const DEFAULT_REPOSITORY = 'duofengkuanga/x-skills';
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export class SkillBundleManager {
  constructor(
    private readonly paths: XaptPaths,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly repository = DEFAULT_REPOSITORY,
  ) {}

  async initialize(): Promise<SkillInstallResult> {
    try {
      const current = await this.currentManifest();
      if (current) {
        for (const skillName of XAPT_SKILL_NAMES)
          await this.resolveBound({
            skillName,
            bundleHash: current.skills[skillName],
            sourceRevision: current.sourceRevision,
          });
        return {
          installed: true,
          updated: false,
          sourceRevision: current.sourceRevision,
          warning: null,
        };
      }
      return await this.update();
    } catch (error) {
      return {
        installed: false,
        updated: false,
        sourceRevision: null,
        warning: `规则包未安装：${safeMessage(error)}`,
      };
    }
  }

  async update(): Promise<SkillInstallResult> {
    const downloaded = await this.downloadGeneration();
    const hashes = Object.fromEntries(
      downloaded.skills.map((skill) => [skill.name, bundleHash(skill.files)]),
    ) as Record<XaptSkillName, string>;
    for (const skill of downloaded.skills)
      validateSkill(skill.name, skill.files);
    await mkdir(this.paths.skillBundles, { recursive: true, mode: 0o700 });
    await mkdir(this.paths.skillGenerations, {
      recursive: true,
      mode: 0o700,
    });
    for (const skill of downloaded.skills)
      await this.installBundle(skill.files, hashes[skill.name]);
    const manifest: GenerationManifest = {
      sourceRevision: downloaded.sourceRevision,
      skills: hashes,
    };
    const generation = await this.installGeneration(manifest);
    const current = await this.currentManifest();
    const updated =
      !current ||
      current.sourceRevision !== manifest.sourceRevision ||
      XAPT_SKILL_NAMES.some(
        (name) => current.skills[name] !== manifest.skills[name],
      );
    await this.switchNamespace(generation);
    return {
      installed: true,
      updated,
      sourceRevision: manifest.sourceRevision,
      warning: null,
    };
  }

  async resolveCurrent(skillName: XaptSkillName): Promise<ResolvedSkill> {
    const manifest = await this.currentManifest();
    if (!manifest) throw new SkillBundleError('规则包尚未安装');
    return await this.resolveBound({
      skillName,
      bundleHash: manifest.skills[skillName],
      sourceRevision: manifest.sourceRevision,
    });
  }

  async resolveBound(identity: SkillIdentity): Promise<ResolvedSkill> {
    if (
      !XAPT_SKILL_NAMES.includes(identity.skillName) ||
      !HASH_PATTERN.test(identity.bundleHash) ||
      !COMMIT_PATTERN.test(identity.sourceRevision)
    )
      throw new SkillBundleError('任务规则关联无效');
    const generation = join(
      this.paths.skillGenerations,
      identity.sourceRevision,
    );
    const manifest = await readManifest(join(generation, 'manifest.json'));
    if (manifest.skills[identity.skillName] !== identity.bundleHash)
      throw new SkillBundleError('任务规则关联与安装清单不匹配');
    await validateGenerationLinks(generation, manifest, this.paths);
    const path = join(this.paths.skillBundles, identity.bundleHash);
    const files = await readBundleFiles(path);
    if (bundleHash(files) !== identity.bundleHash)
      throw new SkillBundleError('规则包内容校验失败');
    validateSkill(identity.skillName, files);
    return { ...identity, path };
  }

  private async currentManifest(): Promise<GenerationManifest | null> {
    const entry = await info(this.paths.skillNamespaceLink);
    if (!entry) return null;
    if (!entry.isSymbolicLink())
      throw new SkillBundleError('规则包目录已存在，且不由 xapt 管理');
    const target = resolve(
      dirname(this.paths.skillNamespaceLink),
      await readlink(this.paths.skillNamespaceLink),
    );
    requireInside(this.paths.skillGenerations, target);
    const manifest = await readManifest(join(target, 'manifest.json'));
    await validateGenerationLinks(target, manifest, this.paths);
    return manifest;
  }

  private async downloadGeneration(): Promise<DownloadedGeneration> {
    const commit = await this.githubJson(
      `https://api.github.com/repos/${this.repository}/commits/main`,
    );
    const sourceRevision = recordString(commit, 'sha');
    const commitRecord = recordValue(commit, 'commit');
    const treeRecord = recordValue(commitRecord, 'tree');
    const treeSha = recordString(treeRecord, 'sha');
    if (!COMMIT_PATTERN.test(sourceRevision) || !COMMIT_PATTERN.test(treeSha))
      throw new SkillBundleError('规则包来源版本信息无效');
    const tree = await this.githubJson(
      `https://api.github.com/repos/${this.repository}/git/trees/${treeSha}?recursive=1`,
    );
    if (tree.truncated === true)
      throw new SkillBundleError('规则包来源文件列表不完整');
    const treeEntries = tree.tree;
    if (!Array.isArray(treeEntries))
      throw new SkillBundleError('规则包来源文件列表无效');
    const skills = await Promise.all(
      XAPT_SKILL_NAMES.map(async (name): Promise<DownloadedSkill> => {
        const prefix = `skills/${name}/`;
        const entries = treeEntries.filter(
          (entry): entry is Record<string, unknown> =>
            isRecord(entry) &&
            typeof entry.path === 'string' &&
            entry.path.startsWith(prefix),
        );
        if (entries.length === 0)
          throw new SkillBundleError(`规则包来源缺少 ${name}`);
        const files: SkillFile[] = [];
        for (const entry of entries) {
          const fullPath = recordString(entry, 'path');
          const path = fullPath.slice(prefix.length);
          requireSafeRelativePath(path);
          const type = recordString(entry, 'type');
          const mode = recordString(entry, 'mode');
          if (type === 'tree') continue;
          if (type !== 'blob' || mode === '120000')
            throw new SkillBundleError(`${name}/${path} 文件类型无效`);
          if (path.split('/').at(-1) === '.DS_Store') continue;
          const url = recordString(entry, 'url');
          if (!url.startsWith('https://api.github.com/'))
            throw new SkillBundleError(`${name}/${path} Blob URL 无效`);
          const blob = await this.githubJson(url);
          if (blob.encoding !== 'base64' || typeof blob.content !== 'string')
            throw new SkillBundleError(`${name}/${path} Blob 内容无效`);
          files.push({
            path,
            bytes: Buffer.from(blob.content.replace(/\s/gu, ''), 'base64'),
          });
        }
        return { name, files };
      }),
    );
    return { sourceRevision, skills };
  }

  private async githubJson(url: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImplementation(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'xapt',
      },
    });
    if (!response.ok)
      throw new SkillBundleError(
        `规则包来源请求失败（HTTP ${response.status}）`,
      );
    const value: unknown = await response.json();
    if (!isRecord(value)) throw new SkillBundleError('规则包来源响应无效');
    return value;
  }

  private async installBundle(files: SkillFile[], hash: string): Promise<void> {
    const destination = join(this.paths.skillBundles, hash);
    const existing = await info(destination);
    if (existing) {
      if (!existing.isDirectory())
        throw new SkillBundleError('规则包版本目录被未知文件占用');
      if (bundleHash(await readBundleFiles(destination)) !== hash)
        throw new SkillBundleError('已存在的规则包内容不一致');
      return;
    }
    const temporary = join(
      this.paths.skillBundles,
      `.${hash}.${randomUUID()}.tmp`,
    );
    try {
      await mkdir(temporary, { recursive: false, mode: 0o700 });
      for (const file of files) {
        const destinationPath = join(temporary, file.path);
        await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
        await writeFile(destinationPath, file.bytes, {
          flag: 'wx',
          mode: 0o600,
        });
      }
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async installGeneration(
    manifest: GenerationManifest,
  ): Promise<string> {
    const destination = join(
      this.paths.skillGenerations,
      manifest.sourceRevision,
    );
    const existing = await info(destination);
    if (existing) {
      if (!existing.isDirectory())
        throw new SkillBundleError('规则包版本目录被未知文件占用');
      const current = await readManifest(join(destination, 'manifest.json'));
      if (JSON.stringify(current) !== JSON.stringify(manifest))
        throw new SkillBundleError('已存在的规则包版本内容不一致');
      await validateGenerationLinks(destination, manifest, this.paths);
      return destination;
    }
    const temporary = join(
      this.paths.skillGenerations,
      `.${manifest.sourceRevision}.${randomUUID()}.tmp`,
    );
    try {
      await mkdir(temporary, { recursive: false, mode: 0o700 });
      await writeFile(
        join(temporary, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      for (const name of XAPT_SKILL_NAMES)
        await symlink(
          join('..', '..', 'bundles', manifest.skills[name]),
          join(temporary, name),
        );
      await rename(temporary, destination);
      return destination;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async switchNamespace(generation: string): Promise<void> {
    await mkdir(this.paths.userSkills, { recursive: true, mode: 0o700 });
    const current = await info(this.paths.skillNamespaceLink);
    if (current && !current.isSymbolicLink())
      throw new SkillBundleError('规则包目录已存在，xapt 不会覆盖');
    if (current) {
      const target = resolve(
        dirname(this.paths.skillNamespaceLink),
        await readlink(this.paths.skillNamespaceLink),
      );
      requireInside(this.paths.skillGenerations, target);
    }
    const temporary = `${this.paths.skillNamespaceLink}.${randomUUID()}.next`;
    try {
      await symlink(generation, temporary);
      await rename(temporary, this.paths.skillNamespaceLink);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export function bundleHash(files: SkillFile[]): string {
  const paths = new Set<string>();
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    requireSafeRelativePath(file.path);
    if (paths.has(file.path))
      throw new SkillBundleError(`规则包包含重复路径：${file.path}`);
    paths.add(file.path);
    const path = Buffer.from(file.path, 'utf8');
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(path.byteLength);
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(file.bytes.byteLength));
    hash.update(pathLength);
    hash.update(path);
    hash.update(contentLength);
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}

function validateSkill(name: XaptSkillName, files: SkillFile[]): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const skill = byPath.get('SKILL.md');
  const openai = byPath.get('agents/openai.yaml');
  if (!skill || !openai)
    throw new SkillBundleError(`${name} 缺少 SKILL.md 或 agents/openai.yaml`);
  const skillText = new TextDecoder().decode(skill.bytes);
  const frontmatter = skillText.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1];
  if (!frontmatter)
    throw new SkillBundleError(`${name} 的 SKILL.md frontmatter 无效`);
  if (!frontmatter.split('\n').includes(`name: ${name}`))
    throw new SkillBundleError(`${name} 的规则名称不匹配`);
  if (!/^description:\s*\S+/mu.test(frontmatter))
    throw new SkillBundleError(`${name} 缺少 description`);
  const openaiText = new TextDecoder().decode(openai.bytes);
  if (!/allow_implicit_invocation:\s*false/u.test(openaiText))
    throw new SkillBundleError(`${name} 必须禁止隐式调用`);
}

async function readBundleFiles(root: string): Promise<SkillFile[]> {
  const rootInfo = await info(root);
  if (!rootInfo?.isDirectory()) throw new SkillBundleError('规则包不存在');
  const result: SkillFile[] = [];
  await visit(root);
  return result;

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const entryInfo = await lstat(path);
      if (entryInfo.isSymbolicLink())
        throw new SkillBundleError('规则包不允许软链接');
      if (entryInfo.isDirectory()) await visit(path);
      else if (entryInfo.isFile()) {
        const relativePath = relative(root, path).split(sep).join('/');
        if (relativePath.split('/').at(-1) === '.DS_Store') continue;
        result.push({ path: relativePath, bytes: await readFile(path) });
      } else throw new SkillBundleError('规则包包含无效文件类型');
    }
  }
}

async function readManifest(path: string): Promise<GenerationManifest> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    !isRecord(value) ||
    !COMMIT_PATTERN.test(recordString(value, 'sourceRevision'))
  )
    throw new SkillBundleError('规则包版本清单无效');
  const skills = recordValue(value, 'skills');
  const result = Object.fromEntries(
    XAPT_SKILL_NAMES.map((name) => {
      const hash = recordString(skills, name);
      if (!HASH_PATTERN.test(hash))
        throw new SkillBundleError(`规则包版本的 ${name} 标识无效`);
      return [name, hash];
    }),
  ) as Record<XaptSkillName, string>;
  if (Object.keys(skills).length !== XAPT_SKILL_NAMES.length)
    throw new SkillBundleError('规则包版本清单包含未知规则');
  return { sourceRevision: value.sourceRevision as string, skills: result };
}

async function validateGenerationLinks(
  generation: string,
  manifest: GenerationManifest,
  paths: XaptPaths,
): Promise<void> {
  for (const name of XAPT_SKILL_NAMES) {
    const linkPath = join(generation, name);
    const link = await info(linkPath);
    if (!link?.isSymbolicLink())
      throw new SkillBundleError(`规则包版本缺少 ${name}`);
    const bundle = resolve(dirname(linkPath), await readlink(linkPath));
    if (bundle !== join(paths.skillBundles, manifest.skills[name]))
      throw new SkillBundleError(`规则包版本的 ${name} 映射无效`);
  }
}

function requireSafeRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new SkillBundleError(`规则包路径无效：${path}`);
}

function requireInside(root: string, path: string): void {
  const value = relative(resolve(root), resolve(path));
  if (value === '' || (!value.startsWith(`..${sep}`) && value !== '..')) return;
  throw new SkillBundleError('规则包目录不属于 xapt 管理');
}

async function info(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function recordValue(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const result = value[key];
  if (!isRecord(result)) throw new SkillBundleError(`缺少 ${key}`);
  return result;
}

function recordString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || result.length === 0)
    throw new SkillBundleError(`缺少 ${key}`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

export class SkillBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillBundleError';
  }
}
