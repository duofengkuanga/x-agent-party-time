import type { RepairValidationSchema } from '@/cooking/repair/contract';
import type { z } from 'zod';
import { validationLabel } from './board-model';

export function ValidationResults({
  items,
  title,
  emptyLabel,
  kind,
  statusLabel = validationLabel,
}: {
  items: z.infer<typeof RepairValidationSchema>[];
  title: string;
  emptyLabel: string;
  kind?: 'validation';
  statusLabel?: typeof validationLabel;
}) {
  return (
    <div className="collab-repair-validations" data-result-kind={kind}>
      <h4>{title}</h4>
      {items.length ? (
        <ul>
          {items.map((validation, index) => (
            <li
              data-validation-status={validation.status}
              key={`${validation.name}:${index}`}
            >
              <strong>{statusLabel(validation.status)}</strong>
              <span>{validation.name}</span>
              {validation.detail ? <small>{validation.detail}</small> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>{emptyLabel}</p>
      )}
    </div>
  );
}
