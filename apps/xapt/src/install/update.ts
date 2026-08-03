import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRunner, Clock } from '../platform/contracts';
import type { LocalFileSystem } from '../platform/files';
import type { XaptPaths } from '../platform/paths';
import { STATE_SCHEMA_VERSION } from '../state/schemas';
import type { LocalStateStore } from '../state/store';
import { compareVersions, type CodexPreflight } from '../daemon/codex';
import type { DaemonManager } from '../daemon/manager';

const ASSET_NAME = 'xapt-darwin-arm64.tar.gz';
const DEFAULT_REPOSITORY = 'duofengkuanga/x-agent-party-time';

export interface UpdateResult {
  updated: boolean;
  version: string;
  daemonRestarted: boolean;
}

export class UpdateManager {
  constructor(
    private readonly paths: XaptPaths,
    private readonly files: LocalFileSystem,
    private readonly state: LocalStateStore,
    private readonly daemon: Pick<DaemonManager, 'status' | 'stop' | 'start'>,
    private readonly codex: CodexPreflight,
    private readonly commands: CommandRunner,
    private readonly clock: Clock,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly repository = DEFAULT_REPOSITORY,
  ) {}

  async update(): Promise<UpdateResult> {
    const snapshot = await this.daemon.status();
    if (snapshot.service === 'UNRESPONSIVE')
      throw new UpdateError('DAEMON_UNRESPONSIVE', 'daemon 本机控制无响应');
    if (snapshot.activity === 'BUSY')
      throw new UpdateError('DAEMON_BUSY', 'daemon 正在处理任务');
    await this.state.preflight();
    const install = await this.state.loadInstall();
    const currentVersion = install?.currentVersion ?? snapshot.version;
    const release = await this.latestStableRelease();
    const comparison = compareVersions(release.version, currentVersion);
    if (comparison === 0)
      return {
        updated: false,
        version: currentVersion,
        daemonRestarted: false,
      };
    if (comparison < 0)
      throw new UpdateError('DOWNGRADE_REFUSED', '稳定 Release 低于本机版本');

    const target = await this.downloadAndVerify(release);
    const targetVersion = await this.inspectTarget(target);
    if (targetVersion.version !== release.version)
      throw new UpdateError(
        'ASSET_VERSION_MISMATCH',
        '资产版本与 Release 不一致',
      );
    const codex = await this.codex.check();
    if (compareVersions(codex.version, targetVersion.minimumCodexVersion) < 0)
      throw new UpdateError('CODEX_TOO_OLD', '当前 Codex 不满足新 xapt 要求');

    const wasRunning = snapshot.service === 'RUNNING';
    if (wasRunning) await this.daemon.stop(false);
    const previousVersion = currentVersion;
    let targetDaemonStarted = false;
    try {
      await this.switchCurrent(release.version);
      await this.state.saveInstall({
        schemaVersion: STATE_SCHEMA_VERSION,
        currentVersion: release.version,
        previousVersion,
        installedAt: install?.installedAt ?? this.clock.now().toISOString(),
        updatedAt: this.clock.now().toISOString(),
      });
      await this.state.preflight();
      await this.daemon.start();
      targetDaemonStarted = true;
      if (!wasRunning) {
        await this.daemon.stop(false);
        targetDaemonStarted = false;
      }
      await this.pruneOldVersions(release.version, previousVersion);
      return {
        updated: true,
        version: release.version,
        daemonRestarted: wasRunning,
      };
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (targetDaemonStarted)
        try {
          await this.daemon.stop(false);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      try {
        await this.switchCurrent(previousVersion);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (install)
        try {
          await this.state.saveInstall(install);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      if (wasRunning)
        try {
          await this.daemon.start();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      if (rollbackErrors.length)
        throw new UpdateError(
          'ROLLBACK_FAILED',
          '新版本健康检查失败，且旧版本未能完整恢复',
          new AggregateError([error, ...rollbackErrors]),
        );
      throw new UpdateError(
        'ROLLBACK_COMPLETED',
        '新版本健康检查失败，已回退',
        error,
      );
    }
  }

  private async latestStableRelease(): Promise<{
    tag: string;
    version: string;
    assetUrl: string;
    checksumUrl: string;
  }> {
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${this.repository}/releases/latest`,
      { headers: { accept: 'application/vnd.github+json' } },
    );
    if (!response.ok)
      throw new UpdateError('RELEASE_UNAVAILABLE', '无法读取稳定 Release');
    const value = (await response.json()) as {
      tag_name?: unknown;
      draft?: unknown;
      prerelease?: unknown;
      assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
    };
    if (value.draft || value.prerelease || typeof value.tag_name !== 'string')
      throw new UpdateError('UNSTABLE_RELEASE', 'Release 不是稳定版本');
    const version = value.tag_name.replace(/^v/u, '');
    if (!/^\d+\.\d+\.\d+$/u.test(version))
      throw new UpdateError('UNSTABLE_RELEASE', 'Release 版本格式无效');
    const asset = value.assets?.find(({ name }) => name === ASSET_NAME);
    const checksum = value.assets?.find(
      ({ name }) => name === `${ASSET_NAME}.sha256`,
    );
    if (
      typeof asset?.browser_download_url !== 'string' ||
      typeof checksum?.browser_download_url !== 'string'
    )
      throw new UpdateError('ASSET_MISSING', 'Release 资产或 checksum 缺失');
    return {
      tag: value.tag_name,
      version,
      assetUrl: asset.browser_download_url,
      checksumUrl: checksum.browser_download_url,
    };
  }

  private async downloadAndVerify(release: {
    version: string;
    assetUrl: string;
    checksumUrl: string;
  }): Promise<string> {
    const [assetResponse, checksumResponse] = await Promise.all([
      this.fetchImplementation(release.assetUrl),
      this.fetchImplementation(release.checksumUrl),
    ]);
    if (!assetResponse.ok || !checksumResponse.ok)
      throw new UpdateError('DOWNLOAD_FAILED', 'Release 下载失败');
    const bytes = new Uint8Array(await assetResponse.arrayBuffer());
    const checksumText = await checksumResponse.text();
    const match = checksumText.match(
      /^([a-f0-9]{64})\s+xapt-darwin-arm64\.tar\.gz\s*$/u,
    );
    if (!match) throw new UpdateError('CHECKSUM_INVALID', 'checksum 格式无效');
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== match[1])
      throw new UpdateError('CHECKSUM_MISMATCH', 'checksum 不匹配');

    const temporary = join(this.paths.updateCache, randomUUID());
    const archive = join(temporary, ASSET_NAME);
    const unpack = join(temporary, 'unpack');
    try {
      await this.files.ensureDirectory(temporary, 0o700);
      await this.files.writeAtomic(archive, bytes, 0o600);
      await this.files.ensureDirectory(unpack, 0o700);
      const extracted = await this.commands.run('/usr/bin/tar', [
        '-xzf',
        archive,
        '-C',
        unpack,
      ]);
      if (extracted.exitCode !== 0)
        throw new UpdateError('ARCHIVE_INVALID', 'Release 压缩包无法解压');
      const executable = join(unpack, 'xapt');
      const info = await this.files.info(executable);
      if (!info || info.type !== 'file')
        throw new UpdateError('ARCHIVE_INVALID', 'Release 缺少 xapt');
      await this.files.setMode(executable, 0o755);
      const signature = await this.commands.run('/usr/bin/codesign', [
        '--verify',
        '--strict',
        executable,
      ]);
      if (signature.exitCode !== 0)
        throw new UpdateError('SIGNATURE_INVALID', 'Release 签名校验失败');
      const targetDirectory = this.paths
        .versionExecutable(release.version)
        .replace(/\/xapt$/u, '');
      await mkdir(this.paths.versions, { recursive: true, mode: 0o700 });
      await this.files.remove(targetDirectory, { recursive: true });
      await rename(unpack, targetDirectory);
      return this.paths.versionExecutable(release.version);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async inspectTarget(path: string): Promise<{
    version: string;
    minimumCodexVersion: string;
  }> {
    const result = await this.commands.run(path, ['--version']);
    const match = result.stdout.match(
      /^xapt (\d+\.\d+\.\d+)\n最低 Codex 版本 (\d+\.\d+\.\d+)\s*$/u,
    );
    if (result.exitCode !== 0 || !match)
      throw new UpdateError('ASSET_INVALID', '新 xapt 无法执行版本预检');
    return { version: match[1]!, minimumCodexVersion: match[2]! };
  }

  private async switchCurrent(version: string): Promise<void> {
    const next = `${this.paths.currentLink}.${randomUUID()}.next`;
    await symlink(`versions/${version}`, next);
    await rename(next, this.paths.currentLink);
  }

  private async pruneOldVersions(
    currentVersion: string,
    previousVersion: string,
  ): Promise<void> {
    for (const version of await this.files.list(this.paths.versions)) {
      if (version === currentVersion || version === previousVersion) continue;
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) continue;
      await this.files.remove(
        this.paths.versionExecutable(version).replace(/\/xapt$/u, ''),
        { recursive: true },
      );
    }
  }
}

export class UpdateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(`${message}。下一步：请保持当前版本并稍后重试。`, { cause });
    this.name = 'UpdateError';
  }
}
