import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

export function Card({ className, ...rest }: ComponentProps<'section'>) {
  return (
    <section
      className={cn('rounded-md border border-rule bg-white', className)}
      {...rest}
    />
  );
}

export interface CardHeaderProps extends Omit<ComponentProps<'header'>, 'title'> {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className,
  ...rest
}: CardHeaderProps) {
  return (
    <header
      className={cn(
        'flex items-start justify-between gap-4 border-b border-rule px-5 py-3',
        className,
      )}
      {...rest}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-navy">{title}</h2>
        {subtitle ? <div className="mt-0.5 text-xs text-ink-muted">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('px-5 py-4', className)} {...rest} />;
}

/** Numbered step heading used down the review page. */
export function SectionHeading({
  step,
  title,
  description,
}: {
  step: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-3 flex items-baseline gap-3">
      <span className="text-xs font-semibold text-gold-text">{step}</span>
      <div>
        <h2 className="text-base font-semibold text-navy">{title}</h2>
        {description ? <p className="text-xs text-ink-muted">{description}</p> : null}
      </div>
    </div>
  );
}
