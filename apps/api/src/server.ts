import express from 'express';
import cookieParser from 'cookie-parser';
import { createContext } from './context.ts';
import { createRouter } from './http/routes.ts';
import { attachContext, errorHandler } from './http/middleware.ts';
import { startWorker } from './jobs/worker.ts';

const PORT = Number(process.env.PORT ?? 3001);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

const ctx = await createContext();
const app = express();

app.disable('x-powered-by');
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
app.use(errorHandler());

const worker = startWorker({ db: ctx.db, storage: ctx.storage, extractor: ctx.extractor });

const server = app.listen(PORT, () => {
  console.log(`\n  Safeside Proposal Tool — API on http://localhost:${PORT}`);
  console.log(`  database   ${ctx.drivers.db}${ctx.drivers.db === 'pglite' ? '   (local — set DATABASE_URL for Supabase)' : ''}`);
  console.log(`  storage    ${ctx.drivers.storage}${ctx.drivers.storage === 'local' ? '  (local — set SUPABASE_SERVICE_ROLE_KEY for Supabase)' : ''}`);
  console.log(`  extraction ${ctx.drivers.extraction}${ctx.drivers.extraction === 'fake' ? '    (offline fixtures — set ANTHROPIC_API_KEY for real extraction)' : ''}\n`);
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
