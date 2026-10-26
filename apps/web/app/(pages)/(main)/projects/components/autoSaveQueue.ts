import type { InteractiveActionResult } from '@/app/actions/actionTransport';
import { createClientId } from '../../components/clientId';

export type AutoSaveValues = Record<string, string>;
export type AutoSaveState = {
  phase: 'idle' | 'waiting' | 'saving' | 'saved' | 'error';
  message?: string;
};

type SaveRequest = { data: FormData; key: string; values: AutoSaveValues };

export function createAutoSaveQueue(options: {
  initial: AutoSaveValues;
  version?: number;
  save: (data: FormData) => Promise<InteractiveActionResult<{ version: number }>>;
  onState: (state: AutoSaveState) => void;
  onSaved?: () => void;
  describeError: (error: unknown) => string;
}) {
  let latest = { ...options.initial };
  let savedKey = keyOf(latest);
  let version = options.version;
  let invalid: string | undefined;
  let running: Promise<boolean> | null = null;
  let failed: { request: SaveRequest; uncertain: boolean } | null = null;

  function hasChanges() {
    return running !== null || Boolean(failed?.uncertain) || keyOf(latest) !== savedKey;
  }

  function update(values: AutoSaveValues, validationMessage?: string) {
    latest = { ...values };
    invalid = validationMessage;
    if (failed && !failed.uncertain && keyOf(latest) !== failed.request.key)
      failed = null;
    if (!running && !failed)
      options.onState({ phase: keyOf(latest) === savedKey ? 'idle' : 'waiting' });
  }

  async function drain(retry: boolean): Promise<boolean> {
    if (failed && !retry) return false;
    let request = retry ? failed?.request : undefined;
    while (request || keyOf(latest) !== savedKey) {
      if (!request && invalid) {
        options.onState({ phase: 'error', message: invalid });
        return false;
      }
      if (!request) {
        const values = { ...latest };
        const data = new FormData();
        Object.entries(values).forEach(([name, value]) => data.set(name, value));
        data.set('mutationId', createClientId());
        if (version !== undefined) data.set('expectedVersion', String(version));
        request = { data, key: keyOf(values), values };
      }
      options.onState({ phase: 'saving' });
      const sending = request;
      try {
        const result = await options.save(request.data);
        if (!result.ok) {
          failed = { request, uncertain: false };
          options.onState({ phase: 'error', message: result.error.message });
          return false;
        }
        version = result.result.version;
        savedKey = request.key;
        failed = null;
        request = undefined;
      } catch (error) {
        failed = { request: sending, uncertain: true };
        options.onState({ phase: 'error', message: options.describeError(error) });
        return false;
      }
      options.onSaved?.();
    }
    options.onState({ phase: 'saved' });
    return true;
  }

  function flush(retry = false): Promise<boolean> {
    if (running) return running;
    if (!failed && keyOf(latest) === savedKey) return Promise.resolve(true);
    running = drain(retry)
      .catch((error) => {
        options.onState({ phase: 'error', message: options.describeError(error) });
        return false;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    update,
    flush,
    hasChanges,
  };
}

function keyOf(values: AutoSaveValues): string {
  return JSON.stringify(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
  );
}
