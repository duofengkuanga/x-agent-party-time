export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: { stdin?: string; timeoutMs?: number },
  ): Promise<CommandResult>;
}

export interface Browser {
  open(url: URL): Promise<void>;
}

export interface ForceConfirmation {
  confirm(message: string): Promise<boolean>;
}

export interface LaunchAgent {
  register(plistPath: string): Promise<void>;
  start(label: string): Promise<void>;
  stop(label: string): Promise<void>;
  unregister(plistPath: string): Promise<void>;
}

export interface Keychain {
  save(account: string, credential: string): Promise<void>;
  read(account: string): Promise<string | null>;
  delete(account: string): Promise<void>;
}

export interface UserEnvironment {
  homeDirectory(): string;
  userId(): number;
  platform(): NodeJS.Platform;
  architecture(): string;
  isTerminal(): boolean;
}
