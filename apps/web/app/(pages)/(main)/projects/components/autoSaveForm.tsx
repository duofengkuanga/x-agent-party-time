'use client';

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import type { InteractiveActionResult } from '@/app/actions/actionTransport';
import { messageOf } from '../../components/actionError';
import {
  createAutoSaveQueue,
  type AutoSaveState,
  type AutoSaveValues,
} from './autoSaveQueue';

type SaveController = {
  hasChanges: () => boolean;
  flush: () => Promise<boolean>;
};
const SaveContext = createContext<Set<SaveController> | null>(null);

export function AutoSaveBoundary({ children }: { children: ReactNode }) {
  const [controllers] = useState(() => new Set<SaveController>());
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const destination = useRef<string | null>(null);
  const navigating = useRef(false);
  const router = useRouter();
  useEffect(() => {
    function beforeNavigate(event: MouseEvent) {
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>('a[href]')
          : null;
      if (
        !link ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        link.target === '_blank' ||
        link.hasAttribute('download')
      )
        return;
      setNavigationError(null);
      if (![...controllers].some((controller) => controller.hasChanges()))
        return;
      event.preventDefault();
      destination.current = link.href;
      if (navigating.current) return;
      navigating.current = true;
      void Promise.all([...controllers].map((controller) => controller.flush()))
        .then((results) => {
          const href = destination.current;
          if (href && results.every(Boolean)) {
            const url = new URL(href);
            if (url.origin === window.location.origin)
              router.push(url.pathname + url.search + url.hash, {
                scroll: false,
              });
            else window.location.assign(href);
          }
        })
        .catch((error) => {
          setNavigationError(messageOf(error, '暂时无法切换页面，请重试。'));
        })
        .finally(() => {
          navigating.current = false;
          destination.current = null;
        });
    }
    document.addEventListener('click', beforeNavigate, true);
    return () => document.removeEventListener('click', beforeNavigate, true);
  }, [controllers, router]);
  return (
    <SaveContext.Provider value={controllers}>
      {navigationError ? (
        <p className="project-navigation-error" role="alert">
          {navigationError}
        </p>
      ) : null}
      {children}
    </SaveContext.Provider>
  );
}

export function AutoSaveForm({
  children,
  className,
  save,
  version,
  onSaved,
  lockWhileSaving = false,
  flushOnUnmount = true,
}: {
  children: ReactNode;
  className?: string;
  save: (
    data: FormData,
  ) => Promise<InteractiveActionResult<{ version: number }>>;
  version?: number;
  onSaved?: () => void;
  lockWhileSaving?: boolean;
  flushOnUnmount?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const queue = useRef<ReturnType<typeof createAutoSaveQueue> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composing = useRef(false);
  const callbacks = useRef({ save, onSaved });
  callbacks.current = { save, onSaved };
  const [state, setState] = useState<AutoSaveState>({ phase: 'idle' });
  const controllers = useContext(SaveContext);

  function capture() {
    if (
      !form.current ||
      !queue.current ||
      composing.current ||
      form.current.querySelector('fieldset')?.disabled
    )
      return;
    const invalid = form.current.querySelector<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >(':invalid');
    queue.current.update(
      readValues(form.current),
      invalid ? '请填写完整且有效的内容，完成后会自动保存。' : undefined,
    );
  }

  useLayoutEffect(() => {
    if (!form.current) return;
    let mounted = true;
    const controller = createAutoSaveQueue({
      initial: readValues(form.current),
      version,
      save: (data) => callbacks.current.save(data),
      onState: (next) => {
        if (mounted) setState(next);
      },
      onSaved: () => {
        if (mounted) callbacks.current.onSaved?.();
      },
      describeError: (error) => messageOf(error, '保存失败，输入内容已保留。'),
    });
    queue.current = controller;
    const registered = {
      hasChanges: controller.hasChanges,
      flush: () => {
        capture();
        return controller.flush();
      },
    };
    controllers?.add(registered);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      capture();
      mounted = false;
      controllers?.delete(registered);
      if (flushOnUnmount) void controller.flush();
    };
    // The form is keyed by entity identity; changes to version must not reset a draft.
  }, [controllers]);

  function schedule(delay: number) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      capture();
      if (!composing.current) void queue.current?.flush();
    }, delay);
  }

  return (
    <form
      aria-busy={state.phase === 'saving'}
      className={`auto-save-form ${className ?? ''}`}
      data-save-state={state.phase}
      noValidate
      onBlur={() => schedule(0)}
      onChange={() => {
        capture();
        schedule(650);
      }}
      onCompositionStart={() => {
        composing.current = true;
        if (timer.current) clearTimeout(timer.current);
      }}
      onCompositionEnd={() => {
        composing.current = false;
        capture();
        schedule(650);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        capture();
        void queue.current?.flush();
      }}
      ref={form}
    >
      <fieldset
        className="auto-save-form__fields"
        disabled={lockWhileSaving && state.phase === 'saving'}
      >
        {children}
      </fieldset>
      <div
        className="auto-save-form__status"
        role={state.phase === 'error' ? 'alert' : 'status'}
      >
        {state.phase === 'saving'
          ? '正在保存…'
          : state.phase === 'saved'
            ? '已保存'
            : state.phase === 'waiting'
              ? '等待保存…'
              : state.phase === 'error'
                ? state.message
                : null}
        {state.phase === 'error' ? (
          <button
            onClick={() => {
              capture();
              void queue.current?.flush(true);
            }}
            type="button"
          >
            重试保存
          </button>
        ) : null}
      </div>
    </form>
  );
}

function readValues(form: HTMLFormElement): AutoSaveValues {
  const values: AutoSaveValues = {};
  for (const [name, value] of new FormData(form))
    if (
      typeof value === 'string' &&
      name !== 'mutationId' &&
      name !== 'expectedVersion' &&
      !name.startsWith('$ACTION')
    )
      values[name] = value;
  return values;
}
