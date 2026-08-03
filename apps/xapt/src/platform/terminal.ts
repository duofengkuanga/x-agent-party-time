import { createInterface } from 'node:readline/promises';
import type { ForceConfirmation } from './contracts';

export class TerminalForceConfirmation implements ForceConfirmation {
  async confirm(message: string): Promise<boolean> {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return (
        (await terminal.question(`${message}\n输入 STOP 确认：`)).trim() ===
        'STOP'
      );
    } finally {
      terminal.close();
    }
  }
}
