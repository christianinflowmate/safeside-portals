import { mergeExtractions, ExtractionResultSchema, lineRank, type ExtractionSource } from '@safeside/shared';
import type { Db } from '../db/index.ts';

/**
 * Turn a proposal's extractions into an editable draft.
 *
 * The brief keeps extracted and confirmed values distinguishable: extraction
 * writes only to sp_extractions, and nothing the model produced is treated as
 * fact until a human has seen it. But the review screen also has to persist the
 * broker's edits so they survive a refresh, and merging every extraction on every
 * page load would discard those edits each time.
 *
 * So merged extraction data is materialised into sp_customers / sp_lines /
 * sp_line_options / sp_line_details ONCE, as a working draft. After that the
 * broker owns those rows. A later re-extraction appends to sp_extractions and
 * leaves the draft alone — which is the whole point of keeping the two apart.
 */

export interface MaterializeResult {
  created: boolean;
  lineCount: number;
  reason?: string;
}

export async function materializeProposal(db: Db, proposalId: string): Promise<MaterializeResult> {
  /*
   * Already materialised? Leave it alone — this is what stops a re-extraction
   * overwriting a broker's work.
   *
   * The check is deliberately NOT made here. Reading the count outside the
   * transaction that does the inserts is a check-then-act race, and it is a race
   * two real callers run: the worker materialises the moment the last extraction
   * lands, and the review screen can POST /materialize at the same instant. Both
   * saw zero lines, both inserted, and the proposal carried its coverage twice —
   * doubling the figure quoted to the client.
   *
   * It now happens inside the transaction, behind a lock on the proposal row.
   */

  // Latest successful extraction per file.
  const { rows: extractions } = await db.query<{
    file_id: string;
    original_filename: string;
    parsed: unknown;
  }>(
    `select distinct on (e.file_id)
            e.file_id, f.original_filename, e.parsed
       from sp_extractions e
       join sp_files f on f.id = e.file_id
      where e.proposal_id = $1 and e.status = 'succeeded' and e.parsed is not null
      order by e.file_id, e.started_at desc`,
    [proposalId],
  );

  const sources: ExtractionSource[] = [];
  for (const row of extractions) {
    const parsed = ExtractionResultSchema.safeParse(row.parsed);
    // A stored extraction that no longer validates means the schema moved under
    // it. Skip rather than crash the whole proposal — the others are still good.
    if (!parsed.success) continue;
    sources.push({ fileId: row.file_id, filename: row.original_filename, result: parsed.data });
  }

  if (sources.length === 0) return { created: false, lineCount: 0, reason: 'no usable extractions' };

  const merged = mergeExtractions(sources);

  let alreadyDone: MaterializeResult | null = null;

  await db.transaction(async (tx) => {
    /*
     * Lock the proposal first. A second caller blocks here until this transaction
     * commits, then sees the lines it created and bails out.
     */
    await tx.query(`select id from sp_proposals where id = $1 for update`, [proposalId]);

    const { rows: existing } = await tx.query<{ n: number }>(
      `select count(*)::int as n from sp_lines where proposal_id = $1`, [proposalId],
    );
    if (existing[0].n > 0) {
      alreadyDone = { created: false, lineCount: existing[0].n, reason: 'already materialised' };
      return;
    }

    // Customer block, with per-field provenance kept for the review screen's
    // flags and conflict pickers.
    const fieldMeta: Record<string, unknown> = {};
    const values: Record<string, string | null> = {};
    for (const [field, cell] of Object.entries(merged.customer)) {
      values[field] = cell.value;
      fieldMeta[field] = {
        found: cell.found,
        confidence: cell.confidence,
        source_file_id: cell.sourceFileId,
        conflicts: cell.conflicts.map((c) => ({
          value: c.value, file_id: c.fileId, filename: c.filename,
        })),
        edited: false,
      };
    }

    await tx.query(
      `insert into sp_customers (
         proposal_id, named_insured, dba, mailing_address, location_address,
         contact_name, contact_phone, contact_email, fein, entity_type,
         business_description, effective_date, expiration_date, field_meta)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               nullif($12,'')::date, nullif($13,'')::date, $14)
       on conflict (proposal_id) do nothing`,
      [
        proposalId, values.named_insured, values.dba, values.mailing_address,
        values.location_address, values.contact_name, values.contact_phone,
        values.contact_email, values.fein, values.entity_type,
        values.business_description, values.effective_date ?? '',
        values.expiration_date ?? '', JSON.stringify(fieldMeta),
      ],
    );

    /*
     * Sorted into Safeside's own presentation order rather than the order the
     * files happened to be uploaded in. Written to display_order, so a broker who
     * rearranges the lines later keeps their arrangement.
     */
    let order = 0;
    for (const line of [...merged.lines].sort((a, b) => lineRank(a.line_type) - lineRank(b.line_type))) {
      order += 10;
      const { rows: lineRows } = await tx.query<{ id: string }>(
        `insert into sp_lines (proposal_id, line_type, line_type_label, carrier_name,
                               carrier_premium, admitted, schedules, display_order,
                               premium_components)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb) returning id`,
        [proposalId, line.line_type, line.line_type_label, line.carrier_name, line.premium,
         line.admitted, JSON.stringify(line.schedules ?? {}), order,
         JSON.stringify(line.premium_components ?? [])],
      );
      const lineId = lineRows[0].id;

      let optionOrder = 0;
      for (const option of line.options) {
        optionOrder += 10;
        await tx.query(
          `insert into sp_line_options (line_id, label, carrier_premium, summary, display_order)
           values ($1,$2,$3,$4,$5)`,
          [
            lineId, option.label, option.premium,
            JSON.stringify({
              premium_components: option.premium_components,
              details: option.details,
              source_file_id: option.sourceFileId,
              source_filename: option.sourceFilename,
              from_separate_file: option.fromSeparateFile,
            }),
            optionOrder,
          ],
        );
      }

      let detailOrder = 0;
      for (const d of line.details) {
        detailOrder += 10;
        await tx.query(
          `insert into sp_line_details (line_id, kind, label, value, display_order, confident,
                                        section_hint)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          // section_hint is what tells a packaged policy's details apart. Dropping
          // it here is what silently lost the property deductible: the keyword
          // fallback cannot classify "Property Deductible", so it landed on the
          // liability page and was filtered out of the document.
          [lineId, d.kind, d.label, d.value, detailOrder, d.confidence >= 0.7,
           d.section_hint ?? null],
        );
      }
    }

    // Pre-select recommendations whose trigger coverage is absent, which is the
    // case a broker most often wants to raise.
    const present = new Set(merged.lines.map((l) => l.line_type));
    const { rows: recs } = await tx.query<{ id: string; suggest_when_line_absent: string | null }>(
      `select id, suggest_when_line_absent from sp_recommendations where is_active = true`,
    );
    let recOrder = 0;
    for (const r of recs) {
      if (!r.suggest_when_line_absent || present.has(r.suggest_when_line_absent as never)) continue;
      recOrder += 10;
      await tx.query(
        `insert into sp_proposal_recommendations (proposal_id, recommendation_id, display_order)
         values ($1,$2,$3) on conflict do nothing`,
        [proposalId, r.id, recOrder],
      );
    }

    // Name the proposal after the insured, if it is still the default.
    if (merged.customer.named_insured.value) {
      await tx.query(
        `update sp_proposals set client_name = $2
          where id = $1 and client_name in ('Untitled proposal', '')`,
        [proposalId, merged.customer.named_insured.value],
      );
    }
  });

  return alreadyDone ?? { created: true, lineCount: merged.lines.length };
}
