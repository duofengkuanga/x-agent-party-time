'use client';

export type LinkedOwnership = 'FRONTEND' | 'BACKEND' | 'BOTH';

const OPTIONS: Array<{ value: LinkedOwnership; label: string }> = [
  { value: 'FRONTEND', label: '前端' },
  { value: 'BACKEND', label: '后端' },
  { value: 'BOTH', label: '前端＋后端' },
];

export function LinkedOwnershipChoice({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (value: LinkedOwnership) => void;
  value: LinkedOwnership;
}) {
  return (
    <fieldset className="collab-linked-review-choice" disabled={disabled}>
      <legend>这次问题归属</legend>
      <div className="collab-linked-review-choice__options">
        {OPTIONS.map((option) => (
          <label key={option.value}>
            <input
              checked={value === option.value}
              name="ownership"
              onChange={() => onChange(option.value)}
              type="radio"
              value={option.value}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
