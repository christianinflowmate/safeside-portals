import type { ReactNode } from 'react';
import type { ProposalDisplayStatus } from '@safeside/shared';
import { cn } from '../../lib/cn.ts';
import { DISPLAY_STATUS_LABEL } from '../../lib/format.ts';

export type BadgeTone = 'neutral' | 'navy' | 'gold' | 'amber' | 'red' | 'green';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-rule bg-panel text-ink-muted',
  navy: 'border-navy/25 bg-navy/5 text-navy',
  /* Gold is type and border only — never a fill. */
  gold: 'border-gold-rule bg-white text-gold-text',
  amber: 'border-amber-300 bg-amber-50 text-amber-800',
  red: 'border-red-300 bg-red-50 text-red-700',
  green: 'border-emerald-300 bg-emerald-50 text-emerald-700',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
        'text-[11px] font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<ProposalDisplayStatus, BadgeTone> = {
  draft: 'neutral',
  analyzing: 'navy',
  extraction_failed: 'red',
  generated: 'gold',
};

export function StatusBadge({ status }: { status: ProposalDisplayStatus }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
      {DISPLAY_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}
