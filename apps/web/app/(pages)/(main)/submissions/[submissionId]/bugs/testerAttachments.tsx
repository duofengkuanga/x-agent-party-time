'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { AttachmentLink, type StoredAttachment } from './attachments';

export function TesterAttachments({
  attachments,
}: {
  attachments: StoredAttachment[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const zoomButton = useRef<HTMLButtonElement>(null);
  const images = attachments.filter((attachment) =>
    attachment.mediaType.startsWith('image/'),
  );
  const files = attachments.filter(
    (attachment) => !attachment.mediaType.startsWith('image/'),
  );
  const index = Math.max(
    0,
    images.findIndex((image) => image.id === selectedId),
  );
  const current = images[index];
  if (!attachments.length)
    return <p className="collab-tester-checklist__notice">未提供附件。</p>;
  return (
    <div className="collab-tester-attachments">
      {current ? (
        <section
          aria-label="缺陷截图"
          aria-roledescription="图片轮播"
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowLeft'
                ? index - 1
                : event.key === 'ArrowRight'
                  ? index + 1
                  : -1;
            if (next >= 0 && next < images.length) {
              event.preventDefault();
              setSelectedId(images[next]!.id);
            }
          }}
        >
          <div className="collab-tester-attachments__meta">
            <span aria-live="polite">
              {index + 1} / {images.length} · {current.originalName}
            </span>
          </div>
          <div className="collab-tester-attachments__viewer">
            {images.length > 1 ? (
              <button
                type="button"
                className="collab-tester-attachments__arrow"
                aria-label="上一张截图"
                disabled={index === 0}
                onClick={() => setSelectedId(images[index - 1]!.id)}
              >
                <svg
                  aria-hidden="true"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
            ) : null}
            <TesterImage
              key={current.id}
              attachment={current}
              onOpen={() => setExpanded(true)}
              buttonRef={zoomButton}
            />
            {images.length > 1 ? (
              <button
                type="button"
                className="collab-tester-attachments__arrow"
                aria-label="下一张截图"
                disabled={index === images.length - 1}
                onClick={() => setSelectedId(images[index + 1]!.id)}
              >
                <svg
                  aria-hidden="true"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      {files.length ? (
        <ul>
          {files.map((attachment) => (
            <li key={attachment.id}>
              <AttachmentLink attachment={attachment} />
            </li>
          ))}
        </ul>
      ) : null}
      {expanded && current ? (
        <TesterImageDialog
          images={images}
          index={index}
          onSelect={(next) => setSelectedId(images[next]!.id)}
          onClose={() => {
            setExpanded(false);
            window.requestAnimationFrame(() => zoomButton.current?.focus());
          }}
        />
      ) : null}
    </div>
  );
}

function TesterImage({
  attachment,
  onOpen,
  buttonRef,
}: {
  attachment: StoredAttachment;
  onOpen?: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const image = (
    <img
      alt={attachment.originalName}
      src={`/api/submissions/attachments/${attachment.id}?preview=1`}
      onLoad={() => setState('loaded')}
      onError={() => setState('error')}
    />
  );
  return (
    <figure data-image-state={state} aria-busy={state === 'loading'}>
      {state === 'loading' ? <p role="status">正在加载截图…</p> : null}
      {state === 'error' ? (
        <p role="alert">截图加载失败，请刷新后重试。</p>
      ) : null}
      {onOpen ? (
        <button
          type="button"
          className="collab-tester-attachments__zoom"
          aria-label={`放大截图 ${attachment.originalName}`}
          onClick={onOpen}
          ref={buttonRef}
        >
          {image}
        </button>
      ) : (
        image
      )}
    </figure>
  );
}

function TesterImageDialog({
  images,
  index,
  onSelect,
  onClose,
}: {
  images: StoredAttachment[];
  index: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const imageArea = useRef<HTMLDivElement>(null);
  const current = images[index]!;
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const selectImage = (next: number) => {
    if (next < 0 || next >= images.length) return;
    onSelect(next);
    imageArea.current?.scrollTo({ top: 0, left: 0 });
    imageArea.current?.focus({ preventScroll: true });
  };
  return (
    <dialog
      ref={dialog}
      className="collab-tester-image-dialog"
      aria-label="放大截图"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Tab') {
          const controls = event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [tabindex="0"]',
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          selectImage(index + (event.key === 'ArrowLeft' ? -1 : 1));
        }
      }}
    >
      <header>
        <strong>{current.originalName}</strong>
        <span aria-live="polite">
          {index + 1} / {images.length}
        </span>
        <button
          type="button"
          aria-label="关闭放大截图"
          onClick={onClose}
          autoFocus
        >
          ×
        </button>
      </header>
      <div className="collab-tester-image-dialog__body">
        <button
          type="button"
          className="collab-tester-image-dialog__arrow"
          aria-label="上一张放大截图"
          disabled={index === 0}
          onClick={() => selectImage(index - 1)}
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div
          className="collab-tester-image-dialog__image"
          aria-label="放大图片，可滚动查看"
          tabIndex={0}
          ref={imageArea}
        >
          <TesterImage key={current.id} attachment={current} />
        </div>
        <button
          type="button"
          className="collab-tester-image-dialog__arrow"
          aria-label="下一张放大截图"
          disabled={index === images.length - 1}
          onClick={() => selectImage(index + 1)}
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
    </dialog>
  );
}
