import type { Writable } from 'node:stream';
export class Output {
  constructor(
    private readonly stdout: Writable,
    private readonly stderr: Writable,
    private readonly jsonMode = false,
  ) {}
  json(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
  value(value: unknown): void {
    if (this.jsonMode) this.json(value);
    else if (Array.isArray(value))
      this.table(value as Record<string, unknown>[]);
    else this.stdout.write(`${this.format(value)}\n`);
  }
  success(message: string): void {
    if (this.jsonMode) this.json({ ok: true, message });
    else this.stdout.write(`${message}\n`);
  }
  warning(message: string): void {
    this.stderr.write(`警告：${message}\n`);
  }
  error(message: string): void {
    this.stderr.write(
      this.jsonMode
        ? `${JSON.stringify({ ok: false, error: message })}\n`
        : `错误：${message}\n`,
    );
  }
  table(rows: Record<string, unknown>[]): void {
    if (!rows.length) {
      this.stdout.write('（无结果）\n');
      return;
    }
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    this.stdout.write(`${columns.join('\t')}\n`);
    for (const row of rows)
      this.stdout.write(
        `${columns.map((column) => this.format(row[column])).join('\t')}\n`,
      );
  }
  private format(value: unknown): string {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
}
