import type { UserEnvironment } from '../platform/contracts';

export function macEnvironment(home = '/tmp/home'): UserEnvironment {
  return {
    homeDirectory: () => home,
    userId: () => 501,
    platform: () => 'darwin',
    architecture: () => 'arm64',
    isTerminal: () => false,
  };
}
