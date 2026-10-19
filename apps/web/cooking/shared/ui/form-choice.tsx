'use client';

import { ChoiceSelect } from './choice-select';

export function FormChoice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="collab-choice-field">
      <span className="collab-choice-field__label">{label}</span>
      {options.length > 1 ? (
        <ChoiceSelect
          label={label}
          value={value}
          options={options}
          onChange={onChange}
        />
      ) : (
        <output aria-label={label} className="collab-form__value">
          {options.find((option) => option.value === value)?.label ??
            `暂无可用${label}`}
        </output>
      )}
    </div>
  );
}
