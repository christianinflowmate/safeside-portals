import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

const FIELD = cn(
  'w-full rounded border border-rule bg-white px-2.5 py-1.5 text-sm text-ink',
  'placeholder:text-ink-muted/70 focus:border-navy focus:outline-none',
  'disabled:bg-panel disabled:text-ink-muted',
);

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={cn(FIELD, 'h-9', className)} {...rest} />;
}

export function Textarea({ className, rows = 3, ...rest }: ComponentProps<'textarea'>) {
  return <textarea rows={rows} className={cn(FIELD, 'resize-y', className)} {...rest} />;
}

export interface FieldProps extends ComponentProps<'div'> {
  label: string;
  htmlFor?: string;
  hint?: string;
}

export function Field({ label, htmlFor, hint, children, className, ...rest }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)} {...rest}>
      <label
        htmlFor={htmlFor}
        className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}
