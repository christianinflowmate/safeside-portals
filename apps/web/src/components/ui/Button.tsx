import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'md' | 'sm';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-navy text-white border border-navy hover:bg-navy-deep',
  secondary: 'bg-white text-ink border border-rule hover:bg-panel',
  ghost: 'bg-transparent text-ink-muted border border-transparent hover:text-navy',
  danger: 'bg-white text-red-700 border border-red-300 hover:bg-red-50',
};

const SIZES: Record<Size, string> = {
  md: 'h-9 px-4 text-sm',
  sm: 'h-7 px-2.5 text-xs',
};

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: Variant;
  size?: Size;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
}
