'use client';

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
    <label>
      <span>{label}</span>
      {options.length > 1 ? (
        <select
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <output aria-label={label} className="collab-form__value">
          {options.find((option) => option.value === value)?.label ??
            `暂无可用${label}`}
        </output>
      )}
    </label>
  );
}
