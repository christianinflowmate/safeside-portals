import { Router } from 'express';
import multer from 'multer';
import { hashToken, createSession, destroySession, destroyAllSessions, cookieOptions, SESSION_COOKIE } from '../auth/sessions.ts';
import { verifyPassword, hashPassword } from '../auth/passwords.ts';
import { checkLoginRateLimit, recordLoginAttempt } from '../auth/rate-limit.ts';
import {
  getOwnedProposal, assertOwnsProposal, listOwnedProposals, getOwnedFile,
  getOwnedLine, getOwnedDocument, updateOwnedProposal, NotFoundError,
} from '../db/scoped.ts';
import { loadProposalDetail } from '../proposals/detail.ts';
import { materializeProposal } from '../proposals/materialize.ts';
import { whyRetryRefused } from '../proposals/retry.ts';
import { enqueue } from '../jobs/queue.ts';
import { uploadPath, documentPath, sha256, UPLOADS_BUCKET, DOCUMENTS_BUCKET } from '../storage/index.ts';
import { handler, requireUser, currentUser, ValidationError, param } from './middleware.ts';
import { buildDocumentModel } from '../documents/build-model.ts';
import { renderProposalPdf } from '../documents/render.ts';
import type { ProposalListItem, ProposalDisplayStatus, ScheduleKind } from '@safeside/shared';
import { SCHEDULE_SPECS, cleanScheduleRows } from '@safeside/shared';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 20 },
  fileFilter: (_req, file, cb) => {
    // PDF only for v1. Rejecting here rather than at extraction means the broker
    // finds out while they are still on the upload screen.
    cb(null, file.mimetype === 'application/pdf');
  },
});

export function createRouter(): Router {
  const r = Router();

  /* --- auth ------------------------------------------------------------- */

  r.post('/auth/login', handler(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new ValidationError(['Email and password are required.']);
    }

    const ip = req.ip ?? null;

    // Checked before the password is verified, so a throttled attacker does not
    // even get to spend our CPU on Argon2.
    const limit = await checkLoginRateLimit(req.ctx.db, email, ip);
    if (!limit.allowed) {
      console.warn(`[auth] rate limit (${limit.reason}) for ${email.trim()} from ${ip ?? 'unknown'}`);
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      // Deliberately the same wording as a wrong password: saying "too many
      // attempts for this address" confirms the address exists.
      res.status(429).json({ error: 'Too many sign-in attempts. Try again shortly.' });
      return;
    }

    const { rows } = await req.ctx.db.query<{
      id: string; email: string; display_name: string; is_admin: boolean;
      password_hash: string; is_active: boolean;
    }>(`select * from sp_users where email = $1`, [email.trim()]);

    const user = rows[0];
    // Verify even when no user matched, against a throwaway hash, so response
    // time does not reveal whether an address is registered.
    const ok = user
      ? user.is_active && (await verifyPassword(user.password_hash, password))
      : await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', password);

    if (!user || !ok) {
      await recordLoginAttempt(req.ctx.db, email, ip, false);
      res.status(401).json({ error: 'Email or password is incorrect.' });
      return;
    }

    await recordLoginAttempt(req.ctx.db, email, ip, true);

    const { token, expiresAt } = await createSession(req.ctx.db, user.id, {
      userAgent: req.get('user-agent') ?? null,
      ip,
    });
    res.cookie(SESSION_COOKIE, token, cookieOptions(expiresAt));
    res.json({ id: user.id, email: user.email, display_name: user.display_name, is_admin: user.is_admin });
  }));

  /**
   * Change your own password.
   *
   * Until this existed the only way to change one was an admin running
   * scripts/set-password.mjs at a terminal, which makes every rotation someone
   * else's errand and is why passwords do not get rotated.
   *
   * The current password is required. A session cookie proves the browser was
   * once signed in; it does not prove the person at the keyboard now is the
   * owner, and an unattended laptop should not be enough to lock someone out of
   * their own account.
   */
  r.post('/auth/password', requireUser(), handler(async (req, res) => {
    const { current_password: currentPassword, new_password: newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      throw new ValidationError(['The current and new passwords are both required.']);
    }
    if (newPassword.length < 12) {
      throw new ValidationError(['The new password must be at least 12 characters.']);
    }
    if (newPassword === currentPassword) {
      throw new ValidationError(['The new password is the same as the current one.']);
    }

    const user = currentUser(req);
    const { rows } = await req.ctx.db.query<{ password_hash: string }>(
      `select password_hash from sp_users where id = $1`,
      [user.id],
    );
    if (!rows[0] || !(await verifyPassword(rows[0].password_hash, currentPassword))) {
      // Deliberately the same shape as a failed sign-in.
      res.status(401).json({ error: 'That is not your current password.' });
      return;
    }

    await req.ctx.db.query(`update sp_users set password_hash = $2 where id = $1`, [
      user.id,
      await hashPassword(newPassword),
    ]);

    /*
     * Every other session is ended.
     *
     * Someone changing a password because they believe it is known to somebody
     * else has not achieved anything if that somebody else stays signed in. The
     * browser doing the changing keeps its session, so the person does not log
     * themselves out mid-task.
     */
    await destroyAllSessions(req.ctx.db, user.id);
    const { token, expiresAt } = await createSession(req.ctx.db, user.id, {
      userAgent: req.get('user-agent') ?? null,
      ip: req.ip ?? null,
    });
    res.cookie(SESSION_COOKIE, token, cookieOptions(expiresAt));
    res.status(204).end();
  }));

  r.post('/auth/logout', handler(async (req, res) => {
    await destroySession(req.ctx.db, req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  }));

  r.get('/auth/me', requireUser(), handler(async (req, res) => {
    res.json(currentUser(req));
  }));

  /* --- proposals -------------------------------------------------------- */

  r.use(requireUser());

  r.get('/proposals', handler(async (req, res) => {
    const rows = await listOwnedProposals(req.ctx.db, currentUser(req).id);
    const items: ProposalListItem[] = rows.map((p) => {
      const r2 = p as Record<string, unknown>;
      const extracting = Number(r2.files_extracting);
      const failed = Number(r2.files_failed);
      const status = r2.status as 'draft' | 'generated';

      // Transient states are derived, not stored — see the query in scoped.ts.
      let display: ProposalDisplayStatus = status;
      if (extracting > 0) display = 'analyzing';
      else if (failed > 0 && status === 'draft') display = 'extraction_failed';

      return {
        id: r2.id as string,
        client_name: r2.client_name as string,
        status,
        display_status: display,
        created_at: new Date(r2.created_at as string).toISOString(),
        updated_at: new Date(r2.updated_at as string).toISOString(),
        file_count: Number(r2.file_count),
        files_extracting: extracting,
        files_failed: failed,
        latest_document_id: null,
      };
    });

    // Attach the newest document id per proposal for the download link.
    const { rows: docs } = await req.ctx.db.query<{ proposal_id: string; id: string }>(
      `select distinct on (proposal_id) proposal_id, id from sp_documents
        where proposal_id = any($1::uuid[]) order by proposal_id, generated_at desc`,
      [items.map((i) => i.id)],
    );
    const byProposal = new Map(docs.map((d) => [d.proposal_id, d.id]));
    for (const item of items) item.latest_document_id = byProposal.get(item.id) ?? null;

    res.json(items);
  }));

  r.post('/proposals', handler(async (req, res) => {
    const name = typeof req.body?.client_name === 'string' ? req.body.client_name.trim() : '';
    const { rows } = await req.ctx.db.query<{ id: string }>(
      `insert into sp_proposals (owner_user_id, client_name)
       values ($1, coalesce(nullif($2,''), 'Untitled proposal')) returning id`,
      [currentUser(req).id, name],
    );
    res.status(201).json({ id: rows[0].id });
  }));

  r.get('/proposals/:id', handler(async (req, res) => {
    res.json(await loadProposalDetail(req.ctx.db, currentUser(req).id, param(req, 'id')));
  }));

  r.patch('/proposals/:id', handler(async (req, res) => {
    const patch: Record<string, unknown> = {};
    for (const k of ['client_name', 'recommendations_note', 'terms_note'] as const) {
      if (k in (req.body ?? {})) patch[k] = req.body[k];
    }
    await updateOwnedProposal(req.ctx.db, currentUser(req).id, param(req, 'id'), patch);
    res.json(await loadProposalDetail(req.ctx.db, currentUser(req).id, param(req, 'id')));
  }));

  r.delete('/proposals/:id', handler(async (req, res) => {
    await assertOwnsProposal(req.ctx.db, currentUser(req).id, param(req, 'id'));
    await req.ctx.db.query(`delete from sp_proposals where id = $1`, [param(req, 'id')]);
    res.status(204).end();
  }));

  /* --- files ------------------------------------------------------------ */

  r.post('/proposals/:id/files', upload.array('files', 20), handler(async (req, res) => {
    const userId = currentUser(req).id;
    await assertOwnsProposal(req.ctx.db, userId, param(req, 'id'));

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw new ValidationError(['No PDF files were received.']);

    const created = [];
    for (const f of files) {
      const bytes = new Uint8Array(f.buffer);
      const path = uploadPath(param(req, 'id'), f.originalname);
      await req.ctx.storage.upload(UPLOADS_BUCKET, path, bytes, 'application/pdf');

      const { rows } = await req.ctx.db.query<{ id: string }>(
        `insert into sp_files (proposal_id, original_filename, storage_path, size_bytes,
                               mime_type, sha256, uploaded_by)
         values ($1,$2,$3,$4,'application/pdf',$5,$6) returning id`,
        [param(req, 'id'), f.originalname, path, bytes.byteLength, sha256(bytes), userId],
      );
      // Extraction runs in the worker, not here: a multi-file upload takes longer
      // than any sane HTTP timeout.
      await enqueue(req.ctx.db, 'extract_file', { file_id: rows[0].id });
      created.push({ id: rows[0].id, original_filename: f.originalname });
    }

    res.status(201).json({ files: created });
  }));

  r.delete('/proposals/:id/files/:fileId', handler(async (req, res) => {
    const file = await getOwnedFile(req.ctx.db, currentUser(req).id, param(req, 'fileId'));
    await req.ctx.db.query(`delete from sp_files where id = $1`, [param(req, 'fileId')]);
    // Storage removal is best-effort: an orphaned object is harmless, a failed
    // request the broker cannot retry is not.
    await req.ctx.storage.remove(UPLOADS_BUCKET, file.storage_path as string).catch(() => {});
    res.status(204).end();
  }));

  /**
   * Read a file again after it failed.
   *
   * A failure is often nothing to do with the document: an API account out of
   * credit, a dropped connection, a timeout. Before this, the only way past one
   * was to drop the file or start the proposal again and re-upload everything,
   * which made an outage lasting minutes cost a full re-run.
   *
   * Refused once the proposal has a draft, and that refusal is the point rather
   * than a limitation to route around. materializeProposal will not touch a
   * proposal that already has lines — that is what stops a re-extraction wiping
   * out a broker's edits — so a file read at this stage would succeed, be stored,
   * and never appear in the proposal. Silently doing nothing is worse than
   * saying no.
   */
  r.post('/proposals/:id/files/:fileId/retry', handler(async (req, res) => {
    const userId = currentUser(req).id;
    const proposalId = param(req, 'id');
    const file = await getOwnedFile(req.ctx.db, userId, param(req, 'fileId'));

    if (file.proposal_id !== proposalId) throw new NotFoundError('File not found');

    const { rows } = await req.ctx.db.query<{ n: number }>(
      `select count(*)::int as n from sp_lines where proposal_id = $1`,
      [proposalId],
    );
    const refused = whyRetryRefused(file as { extraction_status: string }, rows[0].n);
    if (refused) throw new ValidationError([refused]);

    await req.ctx.db.query(
      `update sp_files set extraction_status = 'pending', error_text = null where id = $1`,
      [file.id],
    );
    await enqueue(req.ctx.db, 'extract_file', { file_id: file.id });

    res.status(202).json({ id: file.id, extraction_status: 'pending' });
  }));

  r.get('/proposals/:id/status', handler(async (req, res) => {
    await assertOwnsProposal(req.ctx.db, currentUser(req).id, param(req, 'id'));
    const { rows } = await req.ctx.db.query<Record<string, unknown>>(
      `select id, original_filename, size_bytes, page_count, extraction_status, error_text, created_at
         from sp_files where proposal_id = $1 order by created_at`,
      [param(req, 'id')],
    );

    const files = rows.map((f) => ({
      id: f.id as string,
      original_filename: f.original_filename as string,
      size_bytes: Number(f.size_bytes),
      page_count: f.page_count === null ? null : Number(f.page_count),
      extraction_status: f.extraction_status as 'pending' | 'running' | 'succeeded' | 'failed',
      error_text: (f.error_text as string | null) ?? null,
      created_at: new Date(f.created_at as string).toISOString(),
    }));

    const running = files.find((f) => f.extraction_status === 'running');
    res.json({
      proposal_id: param(req, 'id'),
      files,
      total: files.length,
      completed: files.filter((f) => f.extraction_status === 'succeeded').length,
      failed: files.filter((f) => f.extraction_status === 'failed').length,
      done: files.length > 0 && !files.some((f) => ['pending', 'running'].includes(f.extraction_status)),
      current_filename: running?.original_filename ?? null,
    });
  }));

  /* --- review ----------------------------------------------------------- */

  r.patch('/proposals/:id/customer', handler(async (req, res) => {
    const userId = currentUser(req).id;
    await assertOwnsProposal(req.ctx.db, userId, param(req, 'id'));

    const ALLOWED = new Set([
      'named_insured', 'dba', 'mailing_address', 'location_address', 'contact_name',
      'contact_phone', 'contact_email', 'fein', 'entity_type', 'business_description',
      'effective_date', 'expiration_date',
    ]);
    const fields = (req.body?.fields ?? {}) as Record<string, string | null>;
    const entries = Object.entries(fields).filter(([k]) => ALLOWED.has(k));
    if (entries.length === 0) throw new ValidationError(['No editable fields were supplied.']);

    await req.ctx.db.query(
      `insert into sp_customers (proposal_id) values ($1) on conflict do nothing`,
      [param(req, 'id')],
    );

    for (const [field, value] of entries) {
      const cast = field.endsWith('_date') ? '::date' : '';
      await req.ctx.db.query(
        `update sp_customers
            set ${field} = nullif($2,'')${cast},
                -- Mark the field edited so a re-extraction knows a human owns it.
                field_meta = jsonb_set(
                  coalesce(field_meta,'{}'::jsonb),
                  array['${field}'],
                  coalesce(field_meta->'${field}','{}'::jsonb)
                    || jsonb_build_object('edited', true, 'found', true, 'confidence', 1, 'conflicts', '[]'::jsonb),
                  true)
          where proposal_id = $1`,
        [param(req, 'id'), value ?? ''],
      );
    }

    res.json(await loadProposalDetail(req.ctx.db, userId, param(req, 'id')));
  }));

  r.patch('/lines/:lineId', handler(async (req, res) => {
    const userId = currentUser(req).id;
    const line = await getOwnedLine(req.ctx.db, userId, param(req, 'lineId'));

    const sets: string[] = [];
    const params: unknown[] = [param(req, 'lineId')];
    const add = (sql: string, value: unknown) => { params.push(value); sets.push(`${sql} = $${params.length}`); };

    if ('included' in req.body) add('included', Boolean(req.body.included));
    if ('broker_fee' in req.body) {
      const fee = Number(req.body.broker_fee);
      if (!Number.isFinite(fee) || fee < 0) throw new ValidationError(['Broker fee must be zero or more.']);
      add('broker_fee', fee);
    }
    if ('carrier_premium' in req.body) {
      const p = req.body.carrier_premium === null ? null : Number(req.body.carrier_premium);
      if (p !== null && (!Number.isFinite(p) || p < 0)) throw new ValidationError(['Premium must be zero or more.']);
      add('carrier_premium', p);
    }
    if ('selected_option_id' in req.body) {
      const optionId = req.body.selected_option_id as string | null;
      if (optionId) {
        // The option must belong to this line — otherwise a known UUID would let
        // a caller attach another proposal's pricing.
        const { rows } = await req.ctx.db.query(
          `select 1 from sp_line_options where id = $1 and line_id = $2`, [optionId, line.id],
        );
        if (rows.length === 0) throw new NotFoundError('Option not found on this line');
      }
      add('selected_option_id', optionId);
    }
    if ('admitted' in req.body) {
      const a = req.body.admitted as string | null;
      // Constrained in the database too; checked here so the broker gets a
      // sentence back rather than a constraint-violation stack.
      if (a !== null && a !== 'admitted' && a !== 'non_admitted') {
        throw new ValidationError(["Admitted must be 'admitted', 'non_admitted', or null."]);
      }
      add('admitted', a);
    }
    if ('display_order' in req.body) add('display_order', Number(req.body.display_order));

    if (sets.length > 0) {
      await req.ctx.db.query(`update sp_lines set ${sets.join(', ')} where id = $1`, params);
    }

    res.json(await loadProposalDetail(req.ctx.db, userId, line.proposal_id as string));
  }));

  r.patch('/line-details/:detailId', handler(async (req, res) => {
    const userId = currentUser(req).id;
    const { rows } = await req.ctx.db.query<{ id: string; proposal_id: string }>(
      `select d.id, l.proposal_id
         from sp_line_details d
         join sp_lines l on l.id = d.line_id
         join sp_proposals p on p.id = l.proposal_id
        where d.id = $1 and p.owner_user_id = $2`,
      [param(req, 'detailId'), userId],
    );
    if (rows.length === 0) throw new NotFoundError('Detail not found');

    const sets: string[] = [];
    const params: unknown[] = [param(req, 'detailId')];
    if ('label' in req.body) { params.push(String(req.body.label)); sets.push(`label = $${params.length}`); }
    if ('value' in req.body) { params.push(req.body.value ?? null); sets.push(`value = $${params.length}`); }
    if (sets.length > 0) {
      await req.ctx.db.query(`update sp_line_details set ${sets.join(', ')} where id = $1`, params);
    }

    res.json(await loadProposalDetail(req.ctx.db, userId, rows[0].proposal_id));
  }));

  r.put('/proposals/:id/recommendations', handler(async (req, res) => {
    const userId = currentUser(req).id;
    await assertOwnsProposal(req.ctx.db, userId, param(req, 'id'));

    const selected = (req.body?.selected ?? []) as Array<{ recommendation_id: string; body_override?: string | null }>;
    await req.ctx.db.transaction(async (tx) => {
      await tx.query(`delete from sp_proposal_recommendations where proposal_id = $1`, [param(req, 'id')]);
      let order = 0;
      for (const s of selected) {
        order += 10;
        await tx.query(
          `insert into sp_proposal_recommendations (proposal_id, recommendation_id, body_override, display_order)
           values ($1,$2,$3,$4) on conflict do nothing`,
          [param(req, 'id'), s.recommendation_id, s.body_override ?? null, order],
        );
      }
    });

    res.json(await loadProposalDetail(req.ctx.db, userId, param(req, 'id')));
  }));

  /*
   * Premium-page disclaimers.
   *
   * Replace-all rather than a toggle per row: the order the broker arranges them
   * in is part of the selection, and reconstructing an order from a series of
   * toggles means the server guessing at intent it was never sent.
   */
  r.put('/proposals/:id/disclaimers', handler(async (req, res) => {
    const userId = currentUser(req).id;
    await assertOwnsProposal(req.ctx.db, userId, param(req, 'id'));

    const selected = (req.body?.selected ?? []) as string[];
    if (!Array.isArray(selected) || selected.some((id) => typeof id !== 'string')) {
      throw new ValidationError(['selected must be an array of disclaimer ids.']);
    }

    await req.ctx.db.transaction(async (tx) => {
      await tx.query(`delete from sp_proposal_disclaimers where proposal_id = $1`, [param(req, 'id')]);
      // Set whatever the selection contains, so that unticking everything is a
      // choice the next load respects rather than a state the default overrides.
      await tx.query(
        `update sp_proposals set disclaimers_chosen = true where id = $1`, [param(req, 'id')]);
      let order = 0;
      for (const id of selected) {
        order += 10;
        await tx.query(
          `insert into sp_proposal_disclaimers (proposal_id, disclaimer_id, display_order)
           values ($1,$2,$3) on conflict do nothing`,
          [param(req, 'id'), id, order],
        );
      }
    });

    res.json(await loadProposalDetail(req.ctx.db, userId, param(req, 'id')));
  }));

  /** Re-run the merge when extraction has finished but no draft exists yet. */
  r.post('/proposals/:id/materialize', handler(async (req, res) => {
    const userId = currentUser(req).id;
    await assertOwnsProposal(req.ctx.db, userId, param(req, 'id'));
    const result = await materializeProposal(req.ctx.db, param(req, 'id'));
    res.json(result);
  }));

  /**
   * Replace one of a line's schedules.
   *
   * Schedules were read-only: whatever extraction found, printed verbatim, with
   * no way to correct or add a row. That is wrong for the ones a quote does not
   * state. Workers compensation is the clear case — Safeside's own proposals
   * carry an "Individuals Included/Excluded" table naming which owners are out
   * of the policy, and no carrier quote in the sample corpus states it. The
   * broker knows it; the document could not say it.
   *
   * Whole-array replace rather than per-row edits: these tables are small, the
   * review screen holds all of them on screen at once, and a row has no id to
   * address it by.
   */
  r.put('/lines/:lineId/schedules/:kind', handler(async (req, res) => {
    const userId = currentUser(req).id;
    const line = await getOwnedLine(req.ctx.db, userId, param(req, 'lineId'));

    const kind = param(req, 'kind') as ScheduleKind;
    const spec = SCHEDULE_SPECS[kind];
    if (!spec || spec.owner === 'customer') {
      throw new ValidationError([`Unknown schedule "${kind}".`]);
    }

    const incoming = req.body?.rows;
    if (!Array.isArray(incoming)) throw new ValidationError(['rows must be an array.']);

    // Scalar schedules (states) are stored as plain strings, not objects.
    const cleaned = cleanScheduleRows(spec, incoming as Array<Record<string, unknown>>);
    const value = spec.scalar
      ? cleaned.map((r) => r[spec.required] as string)
      : cleaned;

    await req.ctx.db.query(
      `update sp_lines
          set schedules = jsonb_set(coalesce(schedules, '{}'::jsonb), array[$2], $3::jsonb, true)
        where id = $1`,
      [line.id, kind, JSON.stringify(value)],
    );

    res.json(await loadProposalDetail(req.ctx.db, userId, line.proposal_id as string));
  }));

  /**
   * Replace the insured's premise schedule.
   *
   * Premises belong to the business rather than to any one policy, so they live
   * on the customer. Until now the column was never written and the printed
   * table was read straight back out of the extraction JSON — correct on screen,
   * but nothing a broker could touch.
   */
  r.put('/proposals/:id/premises', handler(async (req, res) => {
    const userId = currentUser(req).id;
    await assertOwnsProposal(req.ctx.db, userId, param(req, 'id'));

    const incoming = req.body?.rows;
    if (!Array.isArray(incoming)) throw new ValidationError(['rows must be an array.']);
    const cleaned = cleanScheduleRows(
      SCHEDULE_SPECS.premises, incoming as Array<Record<string, unknown>>,
    );

    await req.ctx.db.query(
      `insert into sp_customers (proposal_id, premises) values ($1, $2::jsonb)
       on conflict (proposal_id) do update set premises = excluded.premises`,
      [param(req, 'id'), JSON.stringify(cleaned)],
    );

    res.json(await loadProposalDetail(req.ctx.db, userId, param(req, 'id')));
  }));

  /**
   * Edit one detail row.
   *
   * A LineDetail carries no id on the wire, so it is addressed by its position in
   * the line's `details` array — the same order the review screen renders.
   */
  r.patch('/lines/:lineId/details/:index', handler(async (req, res) => {
    const userId = currentUser(req).id;
    const line = await getOwnedLine(req.ctx.db, userId, param(req, 'lineId'));

    const index = Number(param(req, 'index'));
    if (!Number.isInteger(index) || index < 0) throw new ValidationError(['Invalid detail index.']);

    const { rows } = await req.ctx.db.query<{ id: string }>(
      `select id from sp_line_details where line_id = $1
        order by kind, display_order offset $2 limit 1`,
      [line.id, index],
    );
    if (rows.length === 0) throw new NotFoundError('Detail not found');

    const sets: string[] = [];
    const params: unknown[] = [rows[0].id];
    if ('label' in req.body) { params.push(String(req.body.label)); sets.push(`label = $${params.length}`); }
    if ('value' in req.body) { params.push(req.body.value ?? null); sets.push(`value = $${params.length}`); }
    if (sets.length > 0) {
      await req.ctx.db.query(`update sp_line_details set ${sets.join(', ')} where id = $1`, params);
    }

    res.json(await loadProposalDetail(req.ctx.db, userId, line.proposal_id as string));
  }));

  /* --- documents -------------------------------------------------------- */

  /**
   * Generate the proposal.
   *
   * Synchronous on purpose: a broker pressed the button and is waiting for the
   * PDF, so a job id and a spinner would be worse than the wait. There is also
   * deliberately no path from upload straight to a document — this route requires
   * a proposal that already passes every blocking check, which only happens after
   * a human has been through the review screen.
   */
  r.post('/proposals/:id/generate', handler(async (req, res) => {
    const userId = currentUser(req).id;
    const proposalId = param(req, 'id');
    const detail = await loadProposalDetail(req.ctx.db, userId, proposalId);

    if (detail.blocking_reasons.length > 0) {
      throw new ValidationError(detail.blocking_reasons);
    }

    const model = await buildDocumentModel(req.ctx.db, detail);
    // Throws CarrierLeakError, which the error handler turns into a 422 naming
    // the offending fields.
    const { bytes, pageCount } = await renderProposalPdf(model, { carrierNames: detail.carrier_names });

    const path = documentPath(proposalId);
    await req.ctx.storage.upload(DOCUMENTS_BUCKET, path, bytes, 'application/pdf');

    const { rows } = await req.ctx.db.query<{ id: string; generated_at: string }>(
      `insert into sp_documents (proposal_id, storage_path, page_count, sha256, generated_by)
       values ($1,$2,$3,$4,$5) returning id, generated_at`,
      [proposalId, path, pageCount, sha256(bytes), userId],
    );
    await req.ctx.db.query(
      `update sp_proposals set status = 'generated', confirmed_at = coalesce(confirmed_at, now()),
                               confirmed_by = coalesce(confirmed_by, $2)
        where id = $1`,
      [proposalId, userId],
    );

    res.status(201).json({
      id: rows[0].id,
      proposal_id: proposalId,
      page_count: pageCount,
      generated_at: new Date(rows[0].generated_at).toISOString(),
      download_url: `/api/documents/${rows[0].id}/download`,
    });
  }));

  /** The most recent document for a proposal, for the result screen. */
  r.get('/proposals/:id/document', handler(async (req, res) => {
    const proposalId = param(req, 'id');
    await assertOwnsProposal(req.ctx.db, currentUser(req).id, proposalId);

    const { rows } = await req.ctx.db.query<{ id: string; page_count: number | null; generated_at: string }>(
      `select id, page_count, generated_at from sp_documents
        where proposal_id = $1 order by generated_at desc limit 1`,
      [proposalId],
    );
    if (rows.length === 0) throw new NotFoundError('No proposal has been generated yet');

    res.json({
      id: rows[0].id,
      proposal_id: proposalId,
      page_count: rows[0].page_count,
      generated_at: new Date(rows[0].generated_at).toISOString(),
      download_url: `/api/documents/${rows[0].id}/download`,
    });
  }));

  r.get('/documents/:id/download', handler(async (req, res) => {
    const doc = await getOwnedDocument(req.ctx.db, currentUser(req).id, param(req, 'id'));
    const bytes = await req.ctx.storage.download(DOCUMENTS_BUCKET, doc.storage_path as string);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="proposal.pdf"`);
    res.end(Buffer.from(bytes));
  }));

  return r;
}

export { documentPath, DOCUMENTS_BUCKET };
