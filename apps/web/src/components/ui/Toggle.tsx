import { cn } from '../../lib/cn.ts';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** When false the label is visually hidden but still read out. */
  showLabel?: boolean;
  disabled?: boolean;
  id?: string;
}

export function Toggle({
  checked,
  onChange,
  label,
  showLabel = true,
  disabled = false,
  id,
}: ToggleProps) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'inline-flex items-center gap-2 text-sm select-none',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={showLabel ? undefined : label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
          checked ? 'border-navy bg-navy' : 'border-rule bg-panel',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-all',
            checked ? 'left-[18px]' : 'left-0.5',
            checked ? '' : 'border border-rule',
          )}
        />
      </button>
      {showLabel ? <span className="text-ink">{label}</span> : null}
    </label>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  id?: string;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, id, disabled }: CheckboxProps) {
  return (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      className="mt-0.5 h-4 w-4 shrink-0 accent-[#262d40]"
    />
  );
}
