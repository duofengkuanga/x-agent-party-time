import { startControlPlane } from './index.js';

const handle = await startControlPlane();
process.stdout.write(`Control Plane: ${handle.address()}\n`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await handle.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
