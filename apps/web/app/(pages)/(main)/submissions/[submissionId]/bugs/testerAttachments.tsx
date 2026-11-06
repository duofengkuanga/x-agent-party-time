'use client';

import { useState } from 'react';
import { AttachmentLink, type StoredAttachment } from './attachments';

export function TesterAttachments({
  attachments,
}: {
  attachments: StoredAttachment[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
          <TesterImage key={current.id} attachment={current} />
          <div className="collab-tester-attachments__controls">
            {images.length > 1 ? (
              <button
                type="button"
                aria-label="上一张截图"
                disabled={index === 0}
                onClick={() => setSelectedId(images[index - 1]!.id)}
              >
                上一张
              </button>
            ) : null}
            <span aria-live="polite">
              {index + 1} / {images.length} · {current.originalName}
            </span>
            {images.length > 1 ? (
              <button
                type="button"
                aria-label="下一张截图"
                disabled={index === images.length - 1}
                onClick={() => setSelectedId(images[index + 1]!.id)}
              >
                下一张
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
    </div>
  );
}

function TesterImage({ attachment }: { attachment: StoredAttachment }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');
  return (
    <figure data-image-state={state} aria-busy={state === 'loading'}>
      {state === 'loading' ? <p role="status">正在加载截图…</p> : null}
      {state === 'error' ? (
        <p role="alert">截图加载失败，请刷新后重试。</p>
      ) : null}
      <img
        alt={attachment.originalName}
        src={`/api/submissions/attachments/${attachment.id}?preview=1`}
        onLoad={() => setState('loaded')}
        onError={() => setState('error')}
      />
    </figure>
  );
}
