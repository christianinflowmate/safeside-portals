/**
 * Database access.
 *
 * Two drivers behind one interface. `pg` talks to Supabase; PGlite is real
 * Postgres compiled to WebAssembly, running in-process with no install and no
 * network. Tests and local development use PGlite, which is why none of this
 * work is blocked on a Supabase password.
 *
 * The interface is deliberately thin — parameterised query, transaction, close.
 * There is no query builder and no ORM. The schema is small, the queries are
 * hand-written and reviewable, and the one thing that genuinely needs enforcing
 * (ownership) is enforced explicitly in scoped.ts rather than hidden behind
 * abstraction.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /**
   * Run a multi-statement script with no parameters — migrations and seeds.
   *
   * Separate from `query` because parameterised queries go through the extended
   * protocol, which accepts exactly one statement. Passing a migration file to
   * `query` fails with "cannot insert multiple commands into a prepared
   * statement", so the distinction is enforced by the interface rather than left
   * to be rediscovered.
   */
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` inside a transaction, committing on return and rolling back on
   * throw. Nested calls are NOT supported — pass the handle down instead.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Postgres (Supabase)                                                         */
/* -------------------------------------------------------------------------- */

export async function createPostgresDb(connectionString: string): Promise<Db> {
  const { default: pg } = await import('pg');

  /*
   * Hand back `date` columns as the strings they are.
   *
   * By default node-postgres turns a `date` into a JS Date at LOCAL midnight.
   * A Date is an instant, a `date` is a calendar day, and converting between
   * them needs a timezone that this column does not have. Anything that then
   * reads it back in UTC — .toISOString() — lands on the previous day for every
   * machine east of Greenwich.
   *
   * That is not hypothetical: on a host set to Asia/Manila (UTC+8), an
   * effective date stored as 2026-08-12 was served to the review screen, and
   * printed on the client proposal, as 2026-08-11. A policy shown starting a day
   * before it does is a material error on a document a client relies on, and it
   * is invisible to anyone developing in UTC or the Americas.
   *
   * 1082 is `date`. Timestamps are left alone: those genuinely are instants.
   */
  pg.types.setTypeParser(1082, (value: string) => value);

  const pool = new pg.Pool({
    connectionString,
    // Supabase terminates TLS with a certificate this client does not carry in
    // its trust store. The connection is still encrypted.
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,

    /*
     * Every wait has a deadline, because one without a deadline froze the tool.
     *
     * A pooled connection to the session pooler can go half-open — the socket
     * survives, the peer is gone, and a query on it never returns and never
     * errors. HTTP requests carried on, since each got a different connection,
     * but the job worker awaits one query at a time: it claimed the dead one and
     * stopped for twenty minutes without a single line in the log. An upload sat
     * at "Waiting for the next file…" forever, and nothing anywhere said why.
     *
     * connectionTimeoutMillis bounds waiting for a connection; query_timeout
     * bounds waiting for a reply on one. Both are generous — Supabase over this
     * pooler answers a trivial query in well over a second — but finite, which is
     * the whole point. A timeout surfaces as an error the worker can log, retry
     * and move past.
     */
    connectionTimeoutMillis: 15_000,
    query_timeout: 60_000,
  });

  /*
   * A pool with no 'error' listener takes the whole process down.
   *
   * node-postgres emits 'error' on the POOL when a connection sitting idle in it
   * dies — the far end closed it, a NAT table forgot it, the network blipped. In
   * Node an unhandled 'error' event is a fatal exception, so a dropped idle
   * connection killed the API outright. It did: "Error: read EADDRNOTAVAIL" after
   * 2,548 uses of the pool, with no request in flight.
   *
   * There is nothing to recover here — an idle client is by definition not
   * serving anyone, and the pool discards it and opens another on the next query.
   * The event only needs to be observed rather than thrown. It is logged because
   * a burst of these is worth seeing, and unreachable in PGlite, which has no
   * pool and no sockets, so no test would have caught this.
   */
  pool.on('error', (err) => {
    console.warn(`[db] idle pooled connection dropped (${(err as NodeJS.ErrnoException).code ?? err.message}); the pool will replace it`);
  });

  const wrap = (runner: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }): Db => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await runner.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async exec(sql: string) { await runner.query(sql); },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      throw new Error('transaction() must be called on the pool, not inside one');
    },
    async close() { /* connections are returned by the caller */ },
  });

  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async exec(sql: string) {
      // No params, so node-pg uses the simple query protocol, which accepts
      // multiple statements in one round trip.
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn(wrap(client));
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* PGlite (local and test)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param dataDir omit for an ephemeral in-memory database, which is what tests
 *                want — each run starts from a known empty state.
 */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');

  const pg = await PGlite.create(dataDir, { extensions: { citext, pgcrypto } });

  /*
   * PGlite has exactly one connection, and no pool to hide that behind.
   *
   * This matters because the app is genuinely concurrent: the background worker
   * polls for jobs on a timer while HTTP requests are served. Without
   * serialisation, a worker query issued while a request is inside `begin`
   * executes as part of that transaction, and two overlapping `begin`s deadlock
   * the connection outright — the server stops answering anything, including
   * health checks.
   *
   * So every operation queues behind the last. Throughput is irrelevant at this
   * scale; correctness is not. The `pg` driver needs none of this because a pool
   * hands each caller its own connection.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    // Keep the chain alive after a rejection, or one failed query wedges
    // everything queued behind it.
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  /** Runs on the raw handle — callers must already hold the queue. */
  const unlocked: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await pg.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(sql: string) { await pg.exec(sql); },
    async transaction<T>(): Promise<T> {
      throw new Error('Nested transactions are not supported — pass the handle down.');
    },
    async close() { /* the owner closes */ },
  };

  return {
    query: (sql, params) => serialize(() => unlocked.query(sql, params)),
    exec: (sql) => serialize(() => unlocked.exec(sql)),

    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // The whole transaction occupies one slot, so nothing can interleave
      // between begin and commit.
      return serialize(async () => {
        await pg.exec('begin');
        try {
          const result = await fn(unlocked);
          await pg.exec('commit');
          return result;
        } catch (err) {
          await pg.exec('rollback').catch(() => {});
          throw err;
        }
      });
    },

    close: () => serialize(() => pg.close()),
  };
}

/**
 * Pick a driver from the environment. DATABASE_URL wins when present; otherwise
 * fall back to PGlite so the app runs before Supabase credentials exist.
 */
export async function createDbFromEnv(): Promise<{ db: Db; driver: 'postgres' | 'pglite' }> {
  const url = process.env.DATABASE_URL;
  if (url && url.trim() !== '') {
    return { db: await createPostgresDb(url), driver: 'postgres' };
  }
  const dataDir = process.env.PGLITE_DATA_DIR ?? './.pglite';
  return { db: await createPgliteDb(dataDir), driver: 'pglite' };
}
