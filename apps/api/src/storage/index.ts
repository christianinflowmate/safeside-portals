import { createHash, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * File storage.
 *
 * Uploaded carrier quotes are WRITE-ONCE. There is no update method here on
 * purpose: the brief requires uploaded files are never modified, renamed or
 * overwritten, and the easiest way to honour that is to give callers no way to.
 *
 * Paths embed a UUID rather than only the original filename, so two files named
 * Quote.pdf on one proposal cannot collide — which they do constantly, since
 * carrier portals name half their exports "Quote.pdf".
 */

export interface StoredFile {
  path: string;
  size: number;
  sha256: string;
}

export interface Storage {
  upload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<StoredFile>;
  download(bucket: string, path: string): Promise<Uint8Array>;
  remove(bucket: string, path: string): Promise<void>;
  /** Short-lived URL for the browser to fetch a generated PDF directly. */
  signedUrl(bucket: string, path: string, expiresInSeconds?: number): Promise<string>;
}

export function uploadPath(proposalId: string, originalFilename: string): string {
  const safe = originalFilename.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  return `${proposalId}/${randomUUID()}-${safe}`;
}

export function documentPath(proposalId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${proposalId}/proposal-${stamp}.pdf`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* -------------------------------------------------------------------------- */

export function createSupabaseStorage(url: string, serviceRoleKey: string): Storage {
  const client: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async upload(bucket, path, bytes, contentType) {
      const { error } = await client.storage.from(bucket).upload(path, bytes, {
        contentType,
        // Never overwrite. A colliding path is a bug worth surfacing, not
        // something to silently resolve by destroying the earlier file.
        upsert: false,
      });
      if (error) throw new Error(`Upload failed (${bucket}/${path}): ${error.message}`);
      return { path, size: bytes.byteLength, sha256: sha256(bytes) };
    },

    async download(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error || !data) throw new Error(`Download failed (${bucket}/${path}): ${error?.message}`);
      return new Uint8Array(await data.arrayBuffer());
    },

    async remove(bucket, path) {
      const { error } = await client.storage.from(bucket).remove([path]);
      if (error) throw new Error(`Remove failed (${bucket}/${path}): ${error.message}`);
    },

    async signedUrl(bucket, path, expiresInSeconds = 300) {
      const { data, error } = await client.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
      if (error || !data) throw new Error(`Signing failed (${bucket}/${path}): ${error?.message}`);
      return data.signedUrl;
    },
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Local filesystem storage, used when Supabase credentials are absent so the app
 * runs end to end before they exist. Same write-once contract.
 */
export function createLocalStorage(root: string): Storage {
  const fsp = import('node:fs/promises');
  const pathMod = import('node:path');

  const full = async (bucket: string, path: string) => {
    const { join } = await pathMod;
    return join(root, bucket, path);
  };

  return {
    async upload(bucket, path, bytes, _contentType) {
      const fs = await fsp;
      const { dirname } = await pathMod;
      const target = await full(bucket, path);
      await fs.mkdir(dirname(target), { recursive: true });
      // wx fails if the file exists, which is the write-once guarantee.
      await fs.writeFile(target, bytes, { flag: 'wx' });
      return { path, size: bytes.byteLength, sha256: sha256(bytes) };
    },
    async download(bucket, path) {
      const fs = await fsp;
      return new Uint8Array(await fs.readFile(await full(bucket, path)));
    },
    async remove(bucket, path) {
      const fs = await fsp;
      await fs.rm(await full(bucket, path), { force: true });
    },
    async signedUrl(bucket, path) {
      // No signing locally; the API streams these itself in development.
      return `/api/local-files/${bucket}/${encodeURIComponent(path)}`;
    },
  };
}

export function createStorageFromEnv(): { storage: Storage; driver: 'supabase' | 'local' } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    return { storage: createSupabaseStorage(url, key), driver: 'supabase' };
  }
  return { storage: createLocalStorage(process.env.LOCAL_STORAGE_DIR ?? './.storage'), driver: 'local' };
}

export const UPLOADS_BUCKET = process.env.SUPABASE_UPLOADS_BUCKET ?? 'sp-uploads';
export const DOCUMENTS_BUCKET = process.env.SUPABASE_DOCUMENTS_BUCKET ?? 'sp-documents';
