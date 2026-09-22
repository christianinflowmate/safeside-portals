import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  CustomerFieldName, Premise, ProposalDetail, ReviewLine, ReviewLineOption, ReviewRecommendation,
} from '@safeside/shared';
import { redactCarrierTerms, schedulesForOwner, SCHEDULE_SPECS } from '@safeside/shared';
import { Button } from '../../components/ui/Button.tsx';
import { Card, CardBody, CardHeader, SectionHeading } from '../../components/ui/Card.tsx';
import { Badge } from '../../components/ui/Badge.tsx';
import { Input, Textarea, Field } from '../../components/ui/Input.tsx';
import { Toggle, Checkbox } from '../../components/ui/Toggle.tsx';
import { ErrorState, Loading, SaveIndicator } from '../../components/ui/States.tsx';
import { api, errorMessage } from '../../lib/api.ts';
import {
  CUSTOMER_FIELD_ORDER, CUSTOMER_FIELD_LABEL, MULTILINE_CUSTOMER_FIELDS,
  DATE_CUSTOMER_FIELDS, LOW_CONFIDENCE, DETAIL_KIND_LABEL, DETAIL_KIND_ORDER,
  formatMoney, parseMoney, lineTypeLabel,
} from '../../lib/format.ts';
import { cn } from '../../lib/cn.ts';
import { ScheduleEditor } from './ScheduleEditor.tsx';
import { useReview } from './useReview.ts';

/**
 * The review screen — where most of the work happens.
 *
 * Three parts on one scrollable page, in the order the brief sets out: customer
 * information, coverage selection, pricing. Then recommendations and notes, then
 * Generate.
 *
 * Everything autosaves. A broker spends real time on this page and the brief
 * requires edits survive a refresh, so nothing waits for a Save button that
 * someone will forget to press.
 */
export function ReviewScreen() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const review = useReview(id);
  const { detail, loading, error, reload, saveState, saveError, commit } = review;

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [leakFindings, setLeakFindings] = useState<Array<{ term: string; path: string; excerpt: string }>>([]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setGenerateError(null);
    setLeakFindings([]);
    try {
      await api.generate(id);
      navigate(`/proposals/${id}/result`);
    } catch (cause) {
      setGenerateError(errorMessage(cause));
      // A 422 from the leak guard names the offending fields so the broker can
      // go straight to them rather than hunting through the document.
      const findings = (cause as { leakFindings?: typeof leakFindings }).leakFindings;
      if (findings?.length) setLeakFindings(findings);
    } finally {
      setGenerating(false);
    }
  }, [id, navigate]);

  if (loading && !detail) return <Loading label="Loading proposal…" />;
  if (error && !detail) return <ErrorState error={error} onRetry={reload} />;
  if (!detail) return null;

  const blocked = detail.blocking_reasons.length > 0;

  /*
   * The client's own identifiers. A carrier name that is part of the insured's
   * business name is not a leak, and the guard exempts it — so the review screen
   * has to pass the same thing or it would flag a label the guard allows.
   */
  const clientIdentity = [
    detail.client_name,
    detail.customer.named_insured.value,
    detail.customer.dba.value,
  ].filter(Boolean).join(' ');

  return (
    <div className="mx-auto max-w-5xl space-y-8 pb-32">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-navy">{detail.client_name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {detail.files.length} file{detail.files.length === 1 ? '' : 's'} ·{' '}
            {detail.lines.length} coverage line{detail.lines.length === 1 ? '' : 's'}
          </p>
        </div>
        <SaveIndicator state={saveState} error={saveError} />
      </header>

      {detail.notes.length > 0 && <ExtractionNotes detail={detail} />}

      <CarrierNames detail={detail} commit={commit} clientIdentity={clientIdentity} />

      <CustomerBlock detail={detail} commit={commit} clientIdentity={clientIdentity} />

      <section className="space-y-4">
        <SectionHeading
          step="2"
          title="Coverage"
          description="Untick a line to leave it out of the proposal."
        />
        {detail.lines.length === 0 ? (
          <Card><CardBody><p className="text-sm text-slate-500">
            No coverage lines were found. Check the uploaded files.
          </p></CardBody></Card>
        ) : (
          detail.lines.map((line) => (
            <CoverageCard
              key={line.id}
              line={line}
              commit={commit}
              carrierNames={detail.carrier_names}
              clientIdentity={clientIdentity}
              proposalId={detail.id}
              premises={detail.premises}
            />
          ))
        )}
      </section>

      <PricingSummary detail={detail} />

      <Disclaimers detail={detail} commit={commit} />

      <Recommendations detail={detail} commit={commit} />

      <Notes detail={detail} commit={commit} />

      <GenerateBar
        detail={detail}
        blocked={blocked}
        generating={generating}
        generateError={generateError}
        leakFindings={leakFindings}
        onGenerate={generate}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ExtractionNotes({ detail }: { detail: ProposalDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader
        title={`${detail.notes.length} note${detail.notes.length === 1 ? '' : 's'} from extraction`}
        actions={
          <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Show'}
          </Button>
        }
      />
      {open && (
        <CardBody>
          <ul className="space-y-2 text-sm text-slate-600">
            {detail.notes.map((n, i) => (
              <li key={i}>
                <span className="font-mono text-xs text-slate-400">{n.filename}</span>
                <br />
                {n.note}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-400">
            These are for you. They never appear in the client document.
          </p>
        </CardBody>
      )}
    </Card>
  );
}

/* --- Customer -------------------------------------------------------------- */

function CustomerBlock({
  detail, commit, clientIdentity,
}: {
  detail: ProposalDetail;
  commit: ReturnType<typeof useReview>['commit'];
  clientIdentity: string;
}) {
  const save = (field: CustomerFieldName, value: string) =>
    commit(() => api.updateCustomer(detail.id, { fields: { [field]: value || null } }));

  return (
    <section className="space-y-4">
      <SectionHeading
        step="1"
        title="Customer information"
        description="Anything the AI could not find is flagged rather than hidden."
      />
      <Card>
        <CardBody className="grid gap-5 sm:grid-cols-2">
          {CUSTOMER_FIELD_ORDER.map((field) => {
            const cell = detail.customer[field];
            return (
              <CustomerField
                key={field}
                field={field}
                value={cell.value ?? ''}
                found={cell.found}
                confidence={cell.confidence}
                conflicts={cell.conflicts}
                edited={cell.edited}
                onSave={(v) => save(field, v)}
                carrierNames={detail.carrier_names}
                clientIdentity={clientIdentity}
              />
            );
          })}
        </CardBody>
      </Card>
    </section>
  );
}

function CustomerField({
  field, value, found, confidence, conflicts, edited, onSave, carrierNames, clientIdentity,
}: {
  field: CustomerFieldName;
  value: string;
  found: boolean;
  confidence: number;
  conflicts: Array<{ value: string; filename: string }>;
  edited: boolean;
  onSave: (value: string) => void;
  carrierNames: string[];
  clientIdentity: string;
}) {
  const [draft, setDraft] = useState(value);
  // Accept a new server value only when this field is not being typed in, so a
  // refetch triggered by another edit cannot yank text out from under the cursor.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const multiline = MULTILINE_CUSTOMER_FIELDS.has(field);
  const isDate = DATE_CUSTOMER_FIELDS.has(field);
  const lowConfidence = found && confidence < LOW_CONFIDENCE;

  /*
   * Customer fields leak too. A property quote placed through an association
   * master policy put the programme's name straight into the business
   * description — "… as per Owners First Association Master Policy" — which the
   * guard stops, correctly and at the very end. Shown here instead, on the field
   * that carries it.
   */
  const leak = useMemo(
    () => redactCarrierTerms(draft, carrierNames, { clientIdentity }),
    [draft, carrierNames, clientIdentity],
  );

  const commitIfChanged = () => {
    focused.current = false;
    if (draft !== value) onSave(draft);
  };

  const props = {
    id: field,
    value: draft,
    onFocus: () => { focused.current = true; },
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commitIfChanged,
    'aria-invalid': lowConfidence || undefined,
  };

  return (
    <Field
      label={CUSTOMER_FIELD_LABEL[field]}
      htmlFor={field}
      className={multiline ? 'sm:col-span-2' : undefined}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2 empty:hidden">
        {!found && !edited && <Badge tone="amber">Not found</Badge>}
        {lowConfidence && !edited && <Badge tone="amber">Low confidence</Badge>}
        {edited && <Badge tone="neutral">Edited</Badge>}
      </div>
      {multiline
        ? <Textarea {...props} rows={2} />
        : <Input {...props} type={isDate ? 'date' : 'text'} />}

      {leak.removed.length > 0 && (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-red-700">
          <span>Names the carrier ({leak.removed.join(', ')}) — this blocks the document.</span>
          <button
            type="button"
            className="rounded border border-red-300 px-1.5 py-0.5 font-medium text-red-800 hover:bg-red-50"
            onClick={() => { setDraft(leak.text); focused.current = false; onSave(leak.text); }}
          >
            Remove it
          </button>
        </p>
      )}

      {conflicts.length > 0 && (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-900">
            Files disagree. Pick the correct value:
          </p>
          <div className="mt-2 space-y-1">
            {[{ value, filename: 'currently selected' }, ...conflicts].map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { setDraft(c.value); onSave(c.value); }}
                className="block w-full rounded border border-amber-200 bg-white px-2 py-1 text-left text-xs hover:border-amber-400"
              >
                <span className="font-medium">{c.value || '(empty)'}</span>
                <span className="ml-2 text-slate-400">{c.filename}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Field>
  );
}

/* --- Carrier names --------------------------------------------------------- */

/**
 * Every label naming a carrier, and one button to take them all out.
 *
 * One real quote carries fourteen of them across eight carriers,
 * because its endorsements are scoped per carrier — "Asbestos Exclusion –
 * Landmark American Insurance Company Only". Each one blocks the document, and
 * fixing them one at a time is the kind of friction that ends with someone
 * asking for the guard to be switched off.
 *
 * The per-label buttons stay: they are where a broker who wants to reword rather
 * than delete does it. This is for the common case of agreeing with all of them.
 */
function CarrierNames({
  detail, commit, clientIdentity,
}: {
  detail: ProposalDetail;
  commit: ReturnType<typeof useReview>['commit'];
  clientIdentity: string;
}) {
  const [working, setWorking] = useState(false);

  const found = useMemo(() => {
    const opts = { clientIdentity };
    const hits: Array<{ where: string; label: string; cleaned: string; terms: string[] }> = [];

    for (const [field, cell] of Object.entries(detail.customer)) {
      if (!cell.value) continue;
      const r = redactCarrierTerms(cell.value, detail.carrier_names, opts);
      if (r.removed.length) {
        hits.push({ where: `customer:${field}`, label: cell.value, cleaned: r.text, terms: r.removed });
      }
    }
    for (const line of detail.lines) {
      line.details.forEach((d, index) => {
        const r = redactCarrierTerms(d.label, detail.carrier_names, opts);
        if (r.removed.length) {
          hits.push({ where: `${line.id}:${index}`, label: d.label, cleaned: r.text, terms: r.removed });
        }
      });
    }
    return hits;
  }, [detail, clientIdentity]);

  if (found.length === 0) return null;

  const carriers = [...new Set(found.flatMap((f) => f.terms))];

  /*
   * One at a time, not in parallel. A detail is addressed by its position in the
   * line's array, and each save refetches the proposal — firing them together
   * would have later edits reading positions from a copy the earlier ones had
   * already replaced.
   */
  async function removeAll() {
    setWorking(true);
    try {
      for (const hit of found) {
        if (hit.where.startsWith('customer:')) {
          const field = hit.where.slice('customer:'.length);
          await commit(() => api.updateCustomer(detail.id, { fields: { [field]: hit.cleaned } }));
        } else {
          const [lineId, index] = hit.where.split(':');
          await commit(() => api.updateLineDetail(lineId, Number(index), { label: hit.cleaned }));
        }
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card className="border-red-200">
      <CardBody className="flex flex-col gap-3">
        <div>
          <p className="text-sm font-medium text-red-900">
            {found.length} {found.length === 1 ? 'entry names' : 'entries name'} a carrier, so the
            document will not generate.
          </p>
          <p className="mt-1 text-sm text-red-800">
            Carriers put their own name in the endorsements they write. Removing it leaves the form
            number and the rest of the title, which is what identifies the form against the policy.
          </p>
          <p className="mt-1 text-xs text-red-700">{carriers.join(' · ')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={working} onClick={() => void removeAll()}>
            {working ? 'Removing…' : `Remove all ${found.length}`}
          </Button>
          <span className="text-xs text-ink-muted">
            Or edit any of them individually below.
          </span>
        </div>
      </CardBody>
    </Card>
  );
}

/* --- Coverage -------------------------------------------------------------- */

/**
 * The editable tables for a line's coverage pages.
 *
 * Which ones appear follows the page the line prints on, which is what
 * schedulesForOwner answers — classifications belong to general liability,
 * subjects of insurance and premises to property, states and rating basis and
 * individuals to workers compensation.
 *
 * Empty tables are shown rather than hidden. The single most important one here
 * is Individuals Included/Excluded, and it is empty on every real quote we have
 * seen: no carrier states who is out of the workers compensation policy, so a
 * table that only appeared when extraction found something would never appear at
 * all, and the broker would have no way to add what they alone know.
 */
function Schedules({
  line, commit, proposalId, premises,
}: {
  line: ReviewLine;
  commit: ReturnType<typeof useReview>['commit'];
  proposalId: string;
  premises: Premise[];
}) {
  const schedules = (line.schedules ?? {}) as Record<string, unknown>;

  // A line can print on more than one page — a BOP is both liability and
  // property — so gather the schedules for every page it produces.
  const owners = new Set<'general_liability' | 'property' | 'workers_comp'>();
  for (const title of line.section_titles) {
    const t = title.toLowerCase();
    if (t.includes('liability') && !t.includes('employers')) owners.add('general_liability');
    if (t.includes('property')) owners.add('property');
    if (t.includes('workers')) owners.add('workers_comp');
  }
  if (owners.size === 0) return null;

  const specs = [...owners].flatMap((o) => schedulesForOwner(o));
  /*
   * Premises belong to the insured, not to a policy, so they are not returned
   * for any page — but they print at the head of the property page, and that is
   * where a broker looks for them. Added explicitly rather than by giving the
   * spec a page it does not really belong to.
   */
  if (owners.has('property')) specs.unshift(SCHEDULE_SPECS.premises);
  if (specs.length === 0) return null;

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        Schedules — these print as tables on the coverage page
      </h4>
      {specs.map((spec) => (
        <ScheduleEditor
          key={spec.kind}
          kind={spec.kind}
          rows={
            spec.kind === 'premises'
              ? (premises as unknown as Array<Record<string, unknown>>)
              : ((schedules[spec.kind] ?? []) as Array<Record<string, unknown>>)
          }
          onSave={(rows) =>
            void commit(() =>
              spec.kind === 'premises'
                ? api.putPremises(proposalId, rows)
                : api.putSchedule(line.id, spec.kind, rows))
          }
        />
      ))}
    </div>
  );
}


/**
 * A detail's label, editable in place.
 *
 * Carriers name their own endorsements after themselves — "NYCM BOP Enhancement
 * - NYC BP 113" is a real one — so the leak guard rightly refuses to put that on
 * a client's document. Until this was editable the guard named the offending
 * field and left the broker with no way to change it: the only escape was to
 * drop the whole coverage line. Blocking without a remedy is worse than not
 * blocking, so the label the guard complains about is the label you can fix.
 *
 * Commits on blur, like the money fields, so typing does not fire a request per
 * keystroke.
 */
function DetailLabel({
  lineId, index, label, commit, carrierNames, clientIdentity,
}: {
  lineId: string;
  index: number;
  label: string;
  commit: ReturnType<typeof useReview>['commit'];
  carrierNames: string[];
  clientIdentity: string;
}) {
  const [text, setText] = useState(label);
  const editing = useRef(false);

  // Take a value refetched from the server, unless the broker is mid-edit.
  useEffect(() => {
    if (!editing.current) setText(label);
  }, [label]);

  /*
   * Flag the carrier name here, on the label that carries it, rather than
   * leaving it to surface as a generation failure at the bottom of the page.
   * Same matching rules the guard uses, so what is offered here is exactly what
   * unblocks the document.
   */
  const leak = useMemo(
    () => redactCarrierTerms(label, carrierNames, { clientIdentity }),
    [label, carrierNames, clientIdentity],
  );

  const save = (next: string) => {
    if (next === label || next === '') return;
    void commit(() => api.updateLineDetail(lineId, index, { label: next }));
  };

  return (
    <div className="flex flex-col gap-1">
      <input
        type="text"
        value={text}
        aria-label="Detail label"
        className={cn(
          'w-full rounded border bg-transparent px-1 py-0.5 text-sm focus:bg-white focus:outline-none',
          leak.removed.length > 0
            ? 'border-red-300 text-red-900'
            : 'border-transparent text-slate-600 hover:border-slate-200 focus:border-navy',
        )}
        onFocus={() => { editing.current = true; }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          editing.current = false;
          const next = text.trim();
          if (next === '') { setText(label); return; }
          save(next);
        }}
      />

      {leak.removed.length > 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-red-700">
          <span>
            Names the carrier ({leak.removed.join(', ')}) — this blocks the document.
          </span>
          <button
            type="button"
            className="rounded border border-red-300 px-1.5 py-0.5 font-medium text-red-800 hover:bg-red-50"
            onClick={() => { setText(leak.text); save(leak.text); }}
          >
            Remove it
          </button>
        </p>
      ) : null}
    </div>
  );
}

function CoverageCard({
  line, commit, carrierNames, clientIdentity, proposalId, premises,
}: {
  line: ReviewLine;
  commit: ReturnType<typeof useReview>['commit'];
  carrierNames: string[];
  clientIdentity: string;
  proposalId: string;
  premises: Premise[];
}) {
  const setLine = (patch: Parameters<typeof api.updateLine>[1]) =>
    commit(() => api.updateLine(line.id, patch));

  const needsChoice = line.options.length > 1 && !line.selected_option_id;

  /*
   * Grouping reorders the details, but the API addresses one by its position in
   * the line's own `details` array — so the original index is carried along
   * rather than recovered from the group, which would be off by however many
   * kinds were reordered.
   */
  const grouped = useMemo(() => {
    type Row = { detail: (typeof line.details)[number]; index: number };
    const byKind = new Map<string, Row[]>();
    line.details.forEach((detail, index) => {
      const list = byKind.get(detail.kind) ?? [];
      list.push({ detail, index });
      byKind.set(detail.kind, list);
    });
    return DETAIL_KIND_ORDER
      .filter((k) => byKind.has(k))
      .map((k) => [k, byKind.get(k)!] as const);
  }, [line.details]);

  return (
    <Card className={line.included ? undefined : 'opacity-60'}>
      <CardHeader
        title={lineTypeLabel(line.line_type)}
        subtitle={
          line.section_titles.length > 1
            ? `Prints as ${line.section_titles.length} sections: ${line.section_titles.join(' and ')}`
            : line.section_titles[0]
        }
        actions={
          <span className="flex items-center gap-3">
            {needsChoice && <Badge tone="amber">Choose an option</Badge>}
            {line.components_unreconciled && <Badge tone="amber">Premium may be short</Badge>}
            <Toggle
              checked={line.included}
              onChange={(included) => setLine({ included })}
              label="Include"
            />
          </span>
        }
      />

      <CardBody className="space-y-5">
        {line.components_unreconciled && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="font-medium text-amber-900">
              The quote&rsquo;s own breakdown does not add up to this premium.
            </p>
            <p className="mt-1 text-amber-900">
              Its parts total{' '}
              {formatMoney(line.premium_components.reduce((n, c) => n + c.amount, 0))}, against a
              premium of {formatMoney(line.carrier_premium ?? 0)}. Carriers print a bare premium on
              one page and a total including taxes and fees on another; check which one the client
              is actually charged.
            </p>
            <ul className="mt-2 space-y-0.5 text-xs text-amber-900">
              {line.premium_components.map((c, i) => (
                <li key={i} className="flex justify-between gap-4">
                  <span>{c.label}{c.is_fee ? ' (fee)' : ''}</span>
                  <span className="font-mono">{formatMoney(c.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {line.options.length > 1 && (
          <OptionPicker
            options={line.options}
            selectedId={line.selected_option_id}
            onSelect={(optionId) => setLine({ selected_option_id: optionId })}
          />
        )}

        {grouped.map(([kind, details]) => (
          <div key={kind}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {DETAIL_KIND_LABEL[kind] ?? kind}
            </h4>
            <dl className="divide-y divide-slate-100 rounded-md border border-slate-200">
              {details.map(({ detail: d, index }) => (
                <div key={index} className="flex items-baseline justify-between gap-4 px-3 py-2 text-sm">
                  <dt className="min-w-0 flex-1 text-slate-600">
                    <DetailLabel
                      lineId={line.id}
                      index={index}
                      label={d.label}
                      commit={commit}
                      carrierNames={carrierNames}
                      clientIdentity={clientIdentity}
                    />
                  </dt>
                  <dd className="shrink-0 font-mono text-slate-900">{d.value ?? '—'}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}

        <Schedules line={line} commit={commit} proposalId={proposalId} premises={premises} />

        <Admitted line={line} onChange={setLine} />

        <Pricing line={line} onChange={setLine} />
      </CardBody>
    </Card>
  );
}

/**
 * Admitted or non-admitted, printed as a column on the premium page.
 *
 * Editable because quotes state it inconsistently — sometimes only as a
 * surplus-lines tax buried in the fee schedule — and because it is a claim about
 * guaranty-fund protection. "Not stated" is the honest default and drops the
 * column from the document entirely rather than printing a guess.
 */
function Admitted({
  line, onChange,
}: { line: ReviewLine; onChange: (patch: Parameters<typeof api.updateLine>[1]) => void }) {
  return (
    <Field
      label="Admitted status"
      htmlFor={`admitted-${line.id}`}
      hint="Prints on the premium table. Left out of the document when not stated."
      className="max-w-xs"
    >
      <select
        id={`admitted-${line.id}`}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        value={line.admitted ?? ''}
        onChange={(e) => onChange({ admitted: e.target.value || null })}
      >
        <option value="">Not stated</option>
        <option value="admitted">Admitted</option>
        <option value="non_admitted">Non Admitted</option>
      </select>
    </Field>
  );
}

/**
 * Where a quote presents the same coverage more than once, the broker picks.
 * Nothing is chosen for them, and generation stays blocked until they do.
 */
function OptionPicker({
  options, selectedId, onSelect,
}: {
  options: ReviewLineOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const competing = options.some((o) => o.from_separate_file);
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-900">
        {competing
          ? 'More than one carrier quoted this coverage. Choose one.'
          : 'This quote offers more than one version of this coverage. Choose one.'}
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.id}
            className={`flex cursor-pointer items-start gap-3 rounded-md border bg-white p-3 ${
              selectedId === o.id ? 'border-navy ring-1 ring-navy' : 'border-slate-200'
            }`}
          >
            <input
              type="radio"
              name={`option-${options[0]?.id}`}
              checked={selectedId === o.id}
              onChange={() => onSelect(o.id)}
              className="mt-1"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-slate-900">{o.label}</span>
              <span className="block font-mono text-sm text-slate-700">
                {formatMoney(o.carrier_premium)}
              </span>
              {o.source_filename && (
                <span className="mt-1 block truncate text-xs text-slate-400">
                  {o.source_filename}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Carrier premium and broker fee are internal. Only the combined figure ever
 * reaches the client, which is why it is the one shown emphasised.
 */
function Pricing({
  line, onChange,
}: { line: ReviewLine; onChange: (patch: { broker_fee?: number; carrier_premium?: number | null }) => void }) {
  const [fee, setFee] = useState(line.broker_fee === 0 ? '' : String(line.broker_fee));
  const [premium, setPremium] = useState(line.carrier_premium === null ? '' : String(line.carrier_premium));
  const editing = useRef(false);

  useEffect(() => {
    if (editing.current) return;
    setFee(line.broker_fee === 0 ? '' : String(line.broker_fee));
    setPremium(line.carrier_premium === null ? '' : String(line.carrier_premium));
  }, [line.broker_fee, line.carrier_premium]);

  const hasOptions = line.options.length > 0;

  return (
    <div className="grid gap-4 rounded-md bg-slate-50 p-4 sm:grid-cols-3">
      <Field label="Carrier premium" htmlFor={`premium-${line.id}`} hint="Internal only">
        <Input
          id={`premium-${line.id}`}
          inputMode="decimal"
          value={premium}
          disabled={hasOptions}
          placeholder={hasOptions ? 'From selected option' : '0.00'}
          onFocus={() => { editing.current = true; }}
          onChange={(e) => setPremium(e.target.value)}
          onBlur={() => {
            editing.current = false;
            const parsed = parseMoney(premium);
            if (parsed !== line.carrier_premium) onChange({ carrier_premium: parsed });
          }}
        />
      </Field>

      <Field label="Broker fee" htmlFor={`fee-${line.id}`} hint="Internal only">
        <Input
          id={`fee-${line.id}`}
          inputMode="decimal"
          value={fee}
          placeholder="0.00"
          onFocus={() => { editing.current = true; }}
          onChange={(e) => setFee(e.target.value)}
          onBlur={() => {
            editing.current = false;
            const parsed = parseMoney(fee) ?? 0;
            if (parsed !== line.broker_fee) onChange({ broker_fee: parsed });
          }}
        />
      </Field>

      <div>
        <span className="block text-sm font-medium text-slate-700">Client sees</span>
        <span className="mt-1 block font-mono text-lg font-semibold text-navy">
          {formatMoney(line.combined_price)}
        </span>
        <span className="mt-0.5 block text-xs text-slate-400">One combined figure</span>
      </div>
    </div>
  );
}

/* --- Pricing summary ------------------------------------------------------- */

function PricingSummary({ detail }: { detail: ProposalDetail }) {
  const included = detail.lines.filter((l) => l.included);
  return (
    <section className="space-y-4">
      <SectionHeading step="3" title="Pricing" />
      <Card>
        <CardBody>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="pb-2 font-medium">Line of business</th>
                <th className="pb-2 text-right font-medium">Carrier</th>
                <th className="pb-2 text-right font-medium">Fee</th>
                <th className="pb-2 text-right font-medium">Client sees</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {included.map((l) => (
                <tr key={l.id}>
                  <td className="py-2 text-slate-700">{lineTypeLabel(l.line_type)}</td>
                  <td className="py-2 text-right font-mono text-slate-500">{formatMoney(l.carrier_premium)}</td>
                  <td className="py-2 text-right font-mono text-slate-500">{formatMoney(l.broker_fee)}</td>
                  <td className="py-2 text-right font-mono font-medium text-slate-900">{formatMoney(l.combined_price)}</td>
                </tr>
              ))}
              {included.length === 0 && (
                <tr><td colSpan={4} className="py-4 text-center text-slate-400">No lines included.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-navy">
                <td className="pt-3 font-semibold text-navy">Total</td>
                <td className="pt-3 text-right font-mono text-slate-400">{formatMoney(detail.totals.carrier_premium)}</td>
                <td className="pt-3 text-right font-mono text-slate-400">{formatMoney(detail.totals.broker_fee)}</td>
                <td className="pt-3 text-right font-mono text-lg font-semibold text-navy">{formatMoney(detail.totals.combined)}</td>
              </tr>
            </tfoot>
          </table>
          <p className="mt-3 text-xs text-slate-400">
            The carrier and fee columns are internal. The proposal shows only the combined figure.
          </p>
        </CardBody>
      </Card>
    </section>
  );
}

/* --- Premium-page disclaimers ----------------------------------------------- */

/**
 * Which disclaimers print above the subjectivities.
 *
 * A picker rather than fixed copy because Safeside's own proposals disagree with
 * each other: one carries four clauses about payroll and audit, others carry a
 * single sentence about minimum deposit. It does not follow from the lines quoted
 * either, so it is the broker's call and the tool has no business guessing it.
 */
function Disclaimers({
  detail, commit,
}: { detail: ProposalDetail; commit: ReturnType<typeof useReview>['commit'] }) {
  const toggle = (id: string) => {
    const next = detail.disclaimers
      .filter((d) => (d.id === id ? !d.selected : d.selected))
      .map((d) => d.id);
    return commit(() => api.selectDisclaimers(detail.id, { selected: next }));
  };

  return (
    <section className="space-y-4">
      <SectionHeading
        step="4"
        title="Premium page disclaimers"
        description="Printed above the subjectivities. These differ from proposal to proposal — pick the ones that apply."
      />
      <Card>
        <CardBody className="space-y-3">
          {detail.disclaimers.map((d) => (
            <label
              key={d.id}
              className="flex items-start gap-3 rounded-md border border-slate-200 p-3"
            >
              <Checkbox
                id={`disc-${d.id}`}
                checked={d.selected}
                onChange={() => void toggle(d.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-slate-900">{d.label}</span>
                <span className="mt-1 block text-sm text-slate-600">{d.body}</span>
              </span>
            </label>
          ))}
        </CardBody>
      </Card>
    </section>
  );
}

/* --- Recommendations and notes --------------------------------------------- */

function Recommendations({
  detail, commit,
}: { detail: ProposalDetail; commit: ReturnType<typeof useReview>['commit'] }) {
  const toggle = (rec: ReviewRecommendation) => {
    const next = detail.recommendations
      .filter((r) => (r.id === rec.id ? !r.selected : r.selected))
      .map((r) => ({ recommendation_id: r.id, body_override: r.body_override }));
    return commit(() => api.selectRecommendations(detail.id, { selected: next }));
  };

  const suggested = detail.recommendations.filter((r) => r.suggested);
  const rest = detail.recommendations.filter((r) => !r.suggested);

  return (
    <section className="space-y-4">
      <SectionHeading
        step="5"
        title="Coverage recommendations"
        description="Suggested where a coverage is missing from this proposal."
      />
      <Card>
        <CardBody className="space-y-3">
          {[...suggested, ...rest].map((rec) => (
            <label
              key={rec.id}
              className={`flex items-start gap-3 rounded-md border p-3 ${
                rec.suggested ? 'border-amber-200 bg-amber-50/50' : 'border-slate-200'
              }`}
            >
              <Checkbox id={`rec-${rec.id}`} checked={rec.selected} onChange={() => void toggle(rec)} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  {rec.label}
                  {rec.suggested && <Badge tone="amber">Not currently covered</Badge>}
                </span>
                <span className="mt-1 block text-sm text-slate-600">
                  {rec.body_override ?? rec.body}
                </span>
              </span>
            </label>
          ))}
        </CardBody>
      </Card>
    </section>
  );
}

function Notes({
  detail, commit,
}: { detail: ProposalDetail; commit: ReturnType<typeof useReview>['commit'] }) {
  const [recs, setRecs] = useState(detail.recommendations_note ?? '');
  const [terms, setTerms] = useState(detail.terms_note ?? '');

  return (
    <section className="space-y-4">
      <SectionHeading step="6" title="Additional notes" />
      <Card>
        <CardBody className="space-y-5">
          <Field label="Extra recommendations" htmlFor="recs-note" hint="Appended to the recommendations page">
            <Textarea
              id="recs-note"
              value={recs}
              onChange={(e) => setRecs(e.target.value)}
              onBlur={() => {
                if (recs !== (detail.recommendations_note ?? '')) {
                  void commit(() => api.updateProposal(detail.id, { recommendations_note: recs || null }));
                }
              }}
            />
          </Field>
          <Field label="Policy terms & key conditions" htmlFor="terms-note">
            <Textarea
              id="terms-note"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              onBlur={() => {
                if (terms !== (detail.terms_note ?? '')) {
                  void commit(() => api.updateProposal(detail.id, { terms_note: terms || null }));
                }
              }}
            />
          </Field>
        </CardBody>
      </Card>
    </section>
  );
}

/* --- Generate -------------------------------------------------------------- */

function GenerateBar({
  detail, blocked, generating, generateError, leakFindings, onGenerate,
}: {
  detail: ProposalDetail;
  blocked: boolean;
  generating: boolean;
  generateError: string | null;
  leakFindings: Array<{ term: string; path: string; excerpt: string }>;
  onGenerate: () => void;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 border-t border-slate-200 bg-white/95 px-4 py-4 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          {blocked ? (
            <>
              <p className="text-sm font-medium text-slate-700">
                Before you can generate:
              </p>
              <ul className="mt-1 space-y-0.5 text-sm text-amber-700">
                {detail.blocking_reasons.map((r, i) => <li key={i}>· {r}</li>)}
              </ul>
            </>
          ) : (
            <p className="text-sm text-slate-500">
              Everything required is filled in. Total{' '}
              <span className="font-mono font-semibold text-navy">{formatMoney(detail.totals.combined)}</span>.
            </p>
          )}

          {generateError && (
            <p className="mt-2 text-sm text-red-700">{generateError}</p>
          )}
          {leakFindings.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-red-700">
              {leakFindings.map((f, i) => (
                <li key={i}>
                  <span className="font-medium">{f.term}</span> in <code>{f.path}</code>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Button onClick={onGenerate} disabled={blocked || generating}>
          {generating ? 'Generating…' : 'Generate proposal'}
        </Button>
      </div>
    </div>
  );
}
