import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import {
  BindEngineeringCommandSchema,
  ERROR_CODES,
  LocalEngineeringBindingSchema,
  RepositoryUrlSchema,
  createAppError,
} from '@agent-party-time/shared';
import type { ControlPlanePort } from '@agent-party-time/control-plane-client';
import type { RunnerStateStore } from './runner-state-store.js';

export interface ResolvedEngineeringRepository {
  repositoryPath: string;
  repositoryUrl: string;
}

export interface LocalDirectoryResolver {
  resolve(path: string): Promise<ResolvedEngineeringRepository>;
}

const execFileAsync = promisify(execFile);

export class CanonicalDirectoryResolver implements LocalDirectoryResolver {
  async resolve(path: string) {
    try {
      const canonical = await realpath(path);
      if (!(await lstat(canonical)).isDirectory())
        throw new Error('not a directory');
      const rootResult = await execFileAsync('git', [
        '-C',
        canonical,
        'rev-parse',
        '--show-toplevel',
      ]);
      const repositoryPath = await realpath(String(rootResult.stdout).trim());
      const remoteResult = await execFileAsync('git', [
        '-C',
        repositoryPath,
        'config',
        '--get',
        'remote.origin.url',
      ]);
      const repositoryUrl = RepositoryUrlSchema.parse(
        String(remoteResult.stdout).trim(),
      );
      return { repositoryPath, repositoryUrl };
    } catch {
      throw createAppError({
        code: ERROR_CODES.engineeringBindingInvalid,
        category: 'validation',
        message: '工程绑定必须指向配置了 remote.origin.url 的本地 Git 仓库',
        retryable: false,
      });
    }
  }
}

export interface EngineeringBindingServiceOptions {
  controlPlane: ControlPlanePort;
  stateStore: RunnerStateStore;
  runner: { runnerId: string; runnerName: string };
  directories?: LocalDirectoryResolver;
  now?: () => Date;
}

export class EngineeringBindingService {
  private readonly directories: LocalDirectoryResolver;
  private readonly now: () => Date;

  constructor(private readonly options: EngineeringBindingServiceOptions) {
    this.directories = options.directories ?? new CanonicalDirectoryResolver();
    this.now = options.now ?? (() => new Date());
  }

  async bind(rawInput: unknown) {
    const input = BindEngineeringCommandSchema.parse(rawInput);
    const repository = await this.directories.resolve(input.repositoryPath);
    const centralBinding =
      await this.options.controlPlane.claimEngineeringBinding({
        ticket: input.pairingTicket,
        runnerId: this.options.runner.runnerId,
        runnerName: this.options.runner.runnerName,
        repositoryName: basename(repository.repositoryPath) || 'root',
        repositoryUrl: repository.repositoryUrl,
      });
    if (centralBinding.engineeringId !== input.engineeringId)
      throw createAppError({
        code: ERROR_CODES.engineeringBindingInvalid,
        category: 'validation',
        message: '绑定票据与目标工程不匹配',
        retryable: false,
      });
    const now = this.now().toISOString();
    const binding = await this.options.stateStore.saveEngineeringBinding(
      LocalEngineeringBindingSchema.parse({
        bindingId: centralBinding.id,
        engineeringId: centralBinding.engineeringId,
        developerUserId: centralBinding.developer.id,
        runnerId: centralBinding.runner.id,
        repositoryPath: repository.repositoryPath,
        createdAt: now,
        updatedAt: now,
      }),
    );
    return { binding };
  }

  async list() {
    return { items: await this.options.stateStore.listEngineeringBindings() };
  }
}
