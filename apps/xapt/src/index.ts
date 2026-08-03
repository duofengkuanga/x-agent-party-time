import { runCli } from './cli/run';
import { createCliRuntime } from './bootstrap';

const result = await runCli(process.argv.slice(2), createCliRuntime(), (line) =>
  console.log(line),
);

if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exitCode = result.exitCode;
