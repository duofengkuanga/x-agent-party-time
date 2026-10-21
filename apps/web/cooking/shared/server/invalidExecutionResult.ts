import type { AppDatabase } from '@/platform/database';

export function markInvalidExecutionResult(
  db: AppDatabase,
  executionId: string,
  message: string,
): void {
  db.run(
    `UPDATE platform_execution
       SET state = 'FAILED', outcome_json = ? WHERE id = ?`,
    [
      JSON.stringify({
        kind: 'FAILED',
        failure: {
          code: 'CODEX_EXECUTION_FAILED',
          message,
          retryable: true,
        },
      }),
      executionId,
    ],
  );
}
