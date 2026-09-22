import { useEffect, useMemo, useRef, useState } from 'react';
import { SCHEDULE_SPECS, type ScheduleKind, type ScheduleSpec } from '@safeside/shared';

/**
 * One editable schedule table.
 *
 * Every schedule — Liability Classification, Subjects of Insurance, the workers
 * compensation rating basis, Individuals Included/Excluded, Premise Information
 * — is a list of flat rows of strings, so one component serves all of them and
 * SCHEDULE_SPECS supplies the columns. The same spec drives the printed table,
 * which is what keeps the two from drifting apart.
 *
 * These were read-only until now: whatever extraction found, printed verbatim.
 * That is wrong for anything a quote does not state. No carrier quote in the
 * sample corpus names which owners are excluded from workers compensation, yet
 * Safeside's own proposals carry that table, because the broker knows and the
 * document should say so.
 *
 * Values stay strings. An exposure prints as the carrier wrote it, commas and
 * currency sign and all; it is a label, never arithmetic.
 */

type Row = Record<string, string>;

export function ScheduleEditor({
  kind, rows, onSave, disabled,
}: {
  kind: ScheduleKind;
  /** Objects, or plain strings for a scalar schedule like States. */
  rows: Array<Record<string, unknown>> | string[];
  onSave: (rows: Array<Record<string, string | null>>) => void;
  disabled?: boolean;
}) {
  const spec: ScheduleSpec = SCHEDULE_SPECS[kind];

  const incoming = useMemo<Row[]>(() => {
    const list = (rows ?? []) as Array<unknown>;
    return list.map((r) => {
      // A scalar schedule arrives as bare strings; lift each into its column.
      if (spec.scalar) return { [spec.required]: String(r ?? '') };
      const obj = (r ?? {}) as Record<string, unknown>;
      return Object.fromEntries(
        spec.columns.map((c) => [c.key, obj[c.key] == null ? '' : String(obj[c.key])]),
      ) as Row;
    });
  }, [rows, spec]);

  const [draft, setDraft] = useState<Row[]>(incoming);
  /* While a cell has focus, a refetch must not pull the text out from under it. */
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(incoming);
  }, [incoming]);

  const blank = (): Row => Object.fromEntries(spec.columns.map((c) => [c.key, ''])) as Row;

  const commit = (next: Row[]) => {
    setDraft(next);
    onSave(next.map((r) => ({ ...r })));
  };

  /*
   * A new row is local until something is typed into it.
   *
   * Saving on Add would send a row whose required column is empty, the server
   * would drop it — correctly, that is what stops blank lines printing — and the
   * refetch would take the row away again. The button appeared to do nothing.
   * `editing` also guards the row against being replaced by that refetch.
   */
  const addRow = () => {
    editing.current = true;
    setDraft((cur) => [...cur, blank()]);
  };

  const setCell = (i: number, key: string, value: string) => {
    setDraft((cur) => cur.map((r, n) => (n === i ? { ...r, [key]: value } : r)));
  };

  const removeRow = (i: number) => commit(draft.filter((_, n) => n !== i));

  return (
    <div className="rounded-md border border-slate-200">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
        <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {spec.caption}
        </h5>
        <button
          type="button"
          disabled={disabled}
          className="rounded border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          onClick={addRow}
        >
          Add row
        </button>
      </div>

      {draft.length === 0 ? (
        <p className="px-3 py-3 text-xs text-slate-500">
          Nothing here. The quotes did not schedule this — add a row if it belongs
          in the proposal.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                {spec.columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className="px-2 py-1.5 text-left text-xs font-medium text-slate-500"
                  >
                    {c.label}
                  </th>
                ))}
                <th scope="col" className="w-8" aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {draft.map((row, i) => (
                <tr key={i} className="border-b border-slate-50 last:border-0">
                  {spec.columns.map((c) => (
                    <td key={c.key} className="px-1 py-1">
                      <input
                        type="text"
                        value={row[c.key] ?? ''}
                        aria-label={`${spec.caption} row ${i + 1} ${c.label}`}
                        disabled={disabled}
                        className="w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-sm text-slate-800 hover:border-slate-200 focus:border-navy focus:bg-white focus:outline-none disabled:opacity-60"
                        onFocus={() => { editing.current = true; }}
                        onChange={(e) => setCell(i, c.key, e.target.value)}
                        onBlur={() => {
                          editing.current = false;
                          commit(draft);
                        }}
                      />
                    </td>
                  ))}
                  <td className="px-1 py-1 align-middle">
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label={`Remove ${spec.caption} row ${i + 1}`}
                      className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                      onClick={() => removeRow(i)}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-400">
        A row with no {spec.columns.find((c) => c.key === spec.required)?.label.toLowerCase()} is
        dropped rather than printed blank.
      </p>
    </div>
  );
}
