import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbFromEnv, type Db } from './db/index.ts';
import { createStorageFromEnv, type Storage } from './storage/index.ts';
import { AnthropicExtractionProvider } from './extraction/anthropic.ts';
import { FakeExtractionProvider } from './extraction/fake.ts';
import type { ExtractionProvider } from './extraction/provider.ts';

/**
 * Application wiring.
 *
 * Every dependency is chosen from the environment with a working local fallback,
 * so `npm run dev` starts a functioning app with no credentials at all: Postgres
 * becomes PGlite, Supabase Storage becomes the filesystem, and Claude becomes the
 * offline fixture provider. That is what keeps the build unblocked while
 * credentials are still being sorted out.
 */

export interface AppContext {
  db: Db;
  storage: Storage;
  extractor: ExtractionProvider;
  drivers: { db: string; storage: string; extraction: string };
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'supabase', 'migrations');

function createExtractor(): ExtractionProvider {
  const provider = process.env.EXTRACTION_PROVIDER ?? 'fake';
  const key = process.env.ANTHROPIC_API_KEY;

  if (provider === 'anthropic') {
    if (!key) {
      // Falling back rather than crashing: an unset key should degrade to the
      // offline provider with a visible warning, not stop the server booting.
      console.warn('[extraction] EXTRACTION_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset — using the offline provider.');
      return new FakeExtractionProvider();
    }
    return new AnthropicExtractionProvider(key, process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5');
  }
  return new FakeExtractionProvider();
}

/**
 * Apply migrations when running on PGlite.
 *
 * Deliberately NOT done for Postgres: migrating a shared database as a side
 * effect of a process starting is how two deploys race each other. There,
 * `npm run db:migrate` is an explicit step.
 */
async function migrateLocal(db: Db): Promise<void> {
  if (!existsSync(MIGRATIONS)) return;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    } catch (err) {
      // Re-running an applied migration on a persisted PGlite directory throws
      // "already exists", which is expected and not an error worth surfacing.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) throw err;
    }
  }
}

export async function createContext(): Promise<AppContext> {
  const { db, driver: dbDriver } = await createDbFromEnv();
  if (dbDriver === 'pglite') await migrateLocal(db);

  const { storage, driver: storageDriver } = createStorageFromEnv();
  const extractor = createExtractor();

  return {
    db,
    storage,
    extractor,
    drivers: { db: dbDriver, storage: storageDriver, extraction: extractor.name },
  };
}
