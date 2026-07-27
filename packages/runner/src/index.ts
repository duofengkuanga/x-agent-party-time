import { runRunnerCli } from './cli';

try {
  await runRunnerCli(process.argv.slice(2));
} catch (error) {
  console.error(`错误：${error instanceof Error ? error.message : '未知错误'}`);
  process.exitCode = 1;
}
