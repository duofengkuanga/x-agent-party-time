'use client';

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { BugView } from '../contract';
import { formatBytes } from './board-model';

const ATTACHMENT_ACCEPT =
  'image/png,image/jpeg,image/webp,text/plain,application/json';

const ATTACHMENT_MEDIA_TYPES = new Set(ATTACHMENT_ACCEPT.split(','));

const IMAGE_ATTACHMENT_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const MAX_ATTACHMENT_FILES = 5;

export type StoredAttachment =
  BugView['report']['actualResultAttachments'][number];

type ImagePreview = { name: string; src: string };

export function AttachmentPicker({
  ariaLabel = '添加附件',
  existingAttachments = [],
  files,
  inputRef,
  keptExistingIds = [],
  onChange,
  onExistingChange,
}: {
  ariaLabel?: string;
  existingAttachments?: StoredAttachment[];
  files: File[];
  inputRef?: RefObject<HTMLInputElement | null>;
  keptExistingIds?: string[];
  onChange: (files: File[]) => void;
  onExistingChange?: (attachmentIds: string[]) => void;
}) {
  const fallbackInputRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const resolvedInputRef = inputRef ?? fallbackInputRef;
  const activeExisting = existingAttachments.filter((attachment) =>
    keptExistingIds.includes(attachment.id),
  );
  const removedExisting = existingAttachments.filter(
    (attachment) => !keptExistingIds.includes(attachment.id),
  );
  const availableNewFileSlots = Math.max(
    0,
    MAX_ATTACHMENT_FILES - activeExisting.length,
  );

  function addFiles(incoming: File[]) {
    const supported = incoming.filter((file) =>
      ATTACHMENT_MEDIA_TYPES.has(file.type),
    );
    if (incoming.length && !supported.length) {
      setNotice('仅支持 PNG、JPG、WEBP、TXT 和 JSON 文件。');
      return;
    }
    const next = [...files];
    for (const file of supported) {
      if (
        next.some(
          (existing) =>
            existing.name === file.name &&
            existing.size === file.size &&
            existing.type === file.type,
        )
      )
        continue;
      if (next.length === availableNewFileSlots) break;
      next.push(file);
    }
    setNotice(
      supported.length > next.length - files.length ||
        files.length + supported.length > availableNewFileSlots
        ? '最多添加 5 个附件，超出的文件没有加入。'
        : supported.length < incoming.length
          ? '部分文件格式不支持，已加入可用附件。'
          : null,
    );
    onChange(next);
  }

  function pasteFiles(event: ReactClipboardEvent<HTMLDivElement>) {
    const pasted = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!pasted.length) return;
    event.preventDefault();
    addFiles(pasted);
  }

  return (
    <div
      aria-label={ariaLabel}
      className="collab-attachment-picker"
      onPaste={pasteFiles}
      role="group"
      tabIndex={0}
    >
      <input
        accept={ATTACHMENT_ACCEPT}
        aria-hidden="true"
        className="collab-attachment-picker__input"
        multiple
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
        ref={resolvedInputRef}
        tabIndex={-1}
        type="file"
      />
      <div className="collab-attachment-picker__prompt">
        <span>
          <strong>粘贴附件</strong>
          <small>复制截图或文件后，在这里按 ⌘V / Ctrl+V</small>
        </span>
        <button onClick={() => resolvedInputRef.current?.click()} type="button">
          选择本地文件
        </button>
      </div>
      {activeExisting.length || files.length ? (
        <ul className="collab-attachment-picker__files">
          {activeExisting.map((attachment) => (
            <li data-source="existing" key={attachment.id}>
              <AttachmentLink attachment={attachment} />
              <button
                aria-label={`移除附件 ${attachment.originalName}`}
                onClick={() =>
                  onExistingChange?.(
                    keptExistingIds.filter((id) => id !== attachment.id),
                  )
                }
                type="button"
              >
                移除
              </button>
            </li>
          ))}
          {files.map((file, index) => (
            <li
              data-source="new"
              key={`${file.name}:${file.size}:${file.lastModified}:${index}`}
            >
              <PendingAttachmentLink file={file} />
              <button
                aria-label={`移除附件 ${file.name}`}
                onClick={() =>
                  onChange(files.filter((_, fileIndex) => fileIndex !== index))
                }
                type="button"
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <small className="collab-attachment-picker__empty">
          尚未添加附件 · 最多 5 个，单个不超过 10 MB
        </small>
      )}
      {removedExisting.length ? (
        <div className="collab-attachment-picker__removed">
          {removedExisting.map((attachment) => (
            <span key={attachment.id}>
              已移除「{attachment.originalName}」
              <button
                onClick={() => {
                  if (
                    activeExisting.length + files.length >=
                    MAX_ATTACHMENT_FILES
                  ) {
                    setNotice('最多保留 5 个附件，请先移除其他附件。');
                    return;
                  }
                  onExistingChange?.([...keptExistingIds, attachment.id]);
                }}
                type="button"
              >
                撤销
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {notice ? (
        <small className="collab-attachment-picker__notice" role="status">
          {notice}
        </small>
      ) : null}
    </div>
  );
}

function PendingAttachmentLink({ file }: { file: File }) {
  const image = IMAGE_ATTACHMENT_MEDIA_TYPES.has(file.type);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (!image) {
      setImageUrl(null);
      return;
    }
    const nextImageUrl = URL.createObjectURL(file);
    setImageUrl(nextImageUrl);
    return () => URL.revokeObjectURL(nextImageUrl);
  }, [file, image]);

  return (
    <>
      <span className="collab-attachment-file">
        {imageUrl ? (
          <button
            aria-label={`查看图片 ${file.name}`}
            className="collab-attachment-file__thumb"
            onClick={() => setPreview(true)}
            type="button"
          >
            <img alt="" src={imageUrl} />
          </button>
        ) : (
          <span aria-hidden="true" className="collab-attachment-file__kind">
            文件
          </span>
        )}
        <span className="collab-attachment-file__meta">
          {imageUrl ? (
            <button
              className="collab-attachment-file__name"
              onClick={() => setPreview(true)}
              title={file.name}
              type="button"
            >
              {file.name}
            </button>
          ) : (
            <strong title={file.name}>{file.name}</strong>
          )}
          <small>{formatBytes(file.size)} · 新添加</small>
        </span>
      </span>
      {preview && imageUrl ? (
        <ImagePreviewDialog
          name={file.name}
          onClose={() => setPreview(false)}
          src={imageUrl}
        />
      ) : null}
    </>
  );
}

function ImagePreviewDialog({
  name,
  onClose,
  src,
}: ImagePreview & { onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div
      aria-label={`查看图片 ${name}`}
      aria-modal="true"
      className="collab-image-preview"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <figure>
        <figcaption>
          <strong title={name}>{name}</strong>
          <span>
            <a download={name} href={src}>
              保存图片
            </a>
            <button onClick={onClose} ref={closeButtonRef} type="button">
              关闭
            </button>
          </span>
        </figcaption>
        <img alt={name} src={src} />
      </figure>
    </div>,
    document.body,
  );
}

export function AttachmentLink({
  attachment,
}: {
  attachment: StoredAttachment;
}) {
  const [preview, setPreview] = useState(false);
  const downloadUrl = `/api/cooking/attachments/${attachment.id}`;
  const imageUrl = `${downloadUrl}?preview=1`;
  const image = IMAGE_ATTACHMENT_MEDIA_TYPES.has(attachment.mediaType);

  return (
    <>
      <span className="collab-attachment-file">
        {image ? (
          <button
            aria-label={`查看图片 ${attachment.originalName}`}
            className="collab-attachment-file__thumb"
            onClick={() => setPreview(true)}
            type="button"
          >
            <img alt="" src={imageUrl} />
          </button>
        ) : (
          <span aria-hidden="true" className="collab-attachment-file__kind">
            文件
          </span>
        )}
        <span className="collab-attachment-file__meta">
          {image ? (
            <button
              className="collab-attachment-file__name"
              onClick={() => setPreview(true)}
              title={attachment.originalName}
              type="button"
            >
              {attachment.originalName}
            </button>
          ) : (
            <a href={downloadUrl} title={attachment.originalName}>
              {attachment.originalName}
            </a>
          )}
          <small>{formatBytes(attachment.sizeBytes)}</small>
        </span>
      </span>
      {preview ? (
        <ImagePreviewDialog
          name={attachment.originalName}
          onClose={() => setPreview(false)}
          src={imageUrl}
        />
      ) : null}
    </>
  );
}
