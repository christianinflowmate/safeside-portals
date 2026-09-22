import express from 'express';
import cookieParser from 'cookie-parser';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createContext } from './context.ts';
import { createRouter } from './http/routes.ts';
import { attachContext, errorHandler } from './http/middleware.ts';
import { startWorker } from './jobs/worker.ts';

const PORT = Number(process.env.PORT ?? 3001);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

const ctx = await createContext();
const app = express();

app.disable('x-powered-by');
// Behind Fly's proxy the client address and protocol arrive in X-Forwarded-*.
// Without this, every request looks like it came from the proxy over plain HTTP.
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

/**
 * CORS for the Vite dev server only.
 *
 * Credentials are allowed, so the origin must be echoed from an allowlist rather
 * than reflected — `Access-Control-Allow-Origin: *` with credentials is both
 * rejected by browsers and the wrong instinct. In production the app is served
 * same-origin and none of this applies.
 */
app.use((req, res, next) => {
  if (req.headers.origin === WEB_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', WEB_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

app.use(attachContext(ctx));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, drivers: ctx.drivers });
});

app.use('/api', createRouter());

/**
 * The built web app, served from the same origin as the API.
 *
 * In development Vite serves the client on port 3000 and proxies /api to here,
 * so this directory does not exist and the whole block is skipped. In a deployed
 * container the two are one service on one origin — which is what lets the
 * session cookie stay SameSite=Lax with no CORS involved at all.
 *
 * Mounted after the API router, so nothing static can shadow /api.
 */
const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const webBuilt = existsSync(join(WEB_DIST, 'index.html'));

if (webBuilt) {
  // Asset filenames carry a content hash, so they can be cached forever.
  app.use('/assets', express.static(join(WEB_DIST, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(WEB_DIST, { index: false }));

  /*
   * Client-side routing: a reload on /proposals/<id> must return the app, not a
   * 404. Written as plain middleware rather than a '*' route because Express 5
   * rejects an unnamed wildcard path.
   *
   * index.html is never cached. It names the hashed asset files, so a stale copy
   * points at bundles a deploy has already removed.
   */
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(WEB_DIST, 'index.html'));
  });
}

app.use(errorHandler());

const worker = startWorker({ db: ctx.db, storage: ctx.storage, extractor: ctx.extractor });

const server = app.listen(PORT, () => {
  console.log(`\n  Safeside Proposal Tool — API on http://localhost:${PORT}`);
  console.log(`  database   ${ctx.drivers.db}${ctx.drivers.db === 'pglite' ? '   (local — set DATABASE_URL for Supabase)' : ''}`);
  console.log(`  storage    ${ctx.drivers.storage}${ctx.drivers.storage === 'local' ? '  (local — set SUPABASE_SERVICE_ROLE_KEY for Supabase)' : ''}`);
  console.log(`  extraction ${ctx.drivers.extraction}${ctx.drivers.extraction === 'fake' ? '    (offline fixtures — set ANTHROPIC_API_KEY for real extraction)' : ''}`);
  console.log(`  web        ${webBuilt ? 'served from this process' : 'not built — Vite serves it in development'}\n`);
});

async function shutdown(signal: string) {
  console.log(`\n${signal} — shutting down.`);
  // Stop taking work before closing the database, or an in-flight job writes to
  // a closed connection and its file is left stuck in 'running'.
  await worker.stop();
  server.close();
  await ctx.db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
