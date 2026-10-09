import type { ReactNode } from 'react';
import { formatDateTime } from './board-model';
import { AttachmentLink, type StoredAttachment } from './attachments';

export type ProgressHeading = {
  title: string;
  occurredAt: string;
  outcome?: string;
  summaryTitle?: string;
  content: ReactNode;
};

export function ProgressTimeline<T extends { id: string; kind: string }>({
  nodes,
  title,
  description,
  summaryOnly,
  update = false,
  children,
}: {
  nodes: T[];
  title: string;
  description: string;
  summaryOnly: boolean;
  update?: boolean;
  children: (node: T) => ProgressHeading;
}) {
  return (
    <section
      className={`collab-bug-detail-section collab-progress-timeline${update ? ' collab-update-batch-progress' : ''}`}
      data-summary-only={summaryOnly ? 'true' : undefined}
    >
      <header>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </header>
      <ol
        className={`collab-repair-timeline${update ? ' collab-update-timeline' : ''}`}
      >
        {nodes.map((node) => {
          const heading = children(node);
          return (
            <li data-node-kind={node.kind} key={node.id}>
              <span
                aria-hidden="true"
                className="collab-repair-timeline__mark"
                data-outcome={heading.outcome}
              />
              <article
                className={summaryOnly ? 'collab-progress-summary' : undefined}
              >
                <header>
                  <strong>
                    {summaryOnly
                      ? (heading.summaryTitle ?? heading.title)
                      : heading.title}
                  </strong>
                  <time>{formatDateTime(heading.occurredAt)}</time>
                </header>
                {summaryOnly ? null : heading.content}
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function ProgressAttachments({
  attachments,
}: {
  attachments: StoredAttachment[];
}) {
  if (!attachments.length) return null;
  return (
    <ul className="collab-attachments collab-bug-attachments">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          <AttachmentLink attachment={attachment} />
        </li>
      ))}
    </ul>
  );
}
