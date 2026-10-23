import { z } from 'zod';

const SOURCE_RECEIPT_PREFIX = 'XAPT_OBSERVATION_V1 ';
const SourceActivityReceiptSchema = z.strictObject({
  version: z.literal(1),
  activityId: z.uuid(),
  activity: z.enum(['build', 'test', 'typecheck', 'lint', 'deploy']),
  status: z.enum(['succeeded', 'failed', 'interrupted']),
  durationMs: z.number().finite().nonnegative().optional(),
  // Opaque local scope identity, never a hash of private input or a claim of removability.
  workId: z.uuid().optional(),
});
export type SourceActivityReceipt = z.infer<typeof SourceActivityReceiptSchema>;

/** Called only on this command item's terminal protocol output, never chat text. */
export function extractSourceReceipts(output: unknown): {
  receipts: SourceActivityReceipt[];
  limited: boolean;
  invalid: boolean;
} {
  const receipts: SourceActivityReceipt[] = [];
  if (typeof output !== 'string') return { receipts, limited: false, invalid: false };
  let limited = output.length > 64 * 1024;
  let invalid = false;
  const lines = output.slice(-64 * 1024).split('\n');
  if (limited) lines.shift();
  for (const line of lines) {
    if (!line.startsWith(SOURCE_RECEIPT_PREFIX)) continue;
    if (line.length > 8192 || receipts.length >= 16) {
      limited = true;
      continue;
    }
    try {
      const parsed = SourceActivityReceiptSchema.safeParse(
        JSON.parse(line.slice(SOURCE_RECEIPT_PREFIX.length)),
      );
      if (parsed.success) receipts.push(parsed.data);
      else invalid = true;
    } catch {
      invalid = true;
    }
  }
  return { receipts, limited, invalid };
}
