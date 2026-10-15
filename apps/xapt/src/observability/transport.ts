import {
  ObservationReceiptSchema,
  type ObservationBatch,
  type ObservationReceipt,
} from '@agent-party-time/execution-contract/observability';
import type { AuthenticatedRunnerSession } from '../agent/connection';

export interface ObservationTransport {
  send(
    session: AuthenticatedRunnerSession,
    batch: ObservationBatch,
    signal?: AbortSignal,
  ): Promise<ObservationReceipt>;
}

export class ObservationDeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super('耗时记录补报尚未被接受');
  }
}

export class ObservationHttpClient implements ObservationTransport {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async send(
    session: AuthenticatedRunnerSession,
    batch: ObservationBatch,
    signal?: AbortSignal,
  ): Promise<ObservationReceipt> {
    const response = await this.fetcher(
      new URL(
        `/api/runner/executions/${encodeURIComponent(batch.executionId)}/observations`,
        session.serverOrigin,
      ),
      {
        method: 'POST',
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${session.credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(batch),
      },
    );
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : null;
      throw new ObservationDeliveryError(
        response.status,
        seconds === null ? undefined : Math.min(seconds * 1000, 3_600_000),
      );
    }
    const receipt = ObservationReceiptSchema.parse(await response.json());
    if (receipt.batchId !== batch.batchId || receipt.digest !== batch.digest)
      throw new ObservationDeliveryError(409);
    return receipt;
  }
}
