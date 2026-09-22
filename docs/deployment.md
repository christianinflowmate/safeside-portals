# Deployment

One container, running one Node process that serves both the API and the built
web client. Postgres and file storage stay on Supabase, where they already are.

**Currently deployed on [Railway](https://railway.com).** Configuration for
[Fly.io](https://fly.io) is also committed, and both run the same `Dockerfile` —
the host is a config file, not a rebuild.

Nothing here was specified in the brief. What ruled hosts out was architecture,
not price: this process is not only a web server, it runs the extraction worker,
so anything that sleeps an idle service or runs functions per-request cannot host
it. That excludes Render's free tier and excludes Vercel and Netlify outright.
See **Why the machine never sleeps** below.

Railway came first for two practical reasons: its trial needs no card, and it
bills actual usage rather than reserved capacity. This app idles at a few hundred
megabytes and spikes only while Chromium renders, which those two models price
very differently.

---

## Why one service and not two

The API serves `apps/web/dist` itself. The alternative — a static host for the
client and a separate host for the API — costs a second URL, a CORS allowlist,
and a session cookie that has to travel cross-origin with `SameSite=None`.
Same-origin means the cookie stays `SameSite=Lax` and the CORS block in
`server.ts` is dead code in production, which is the point.

In development none of this applies: Vite serves the client on port 3000 and
proxies `/api` to the API on 3001, `apps/web/dist` does not exist, and the
static-serving block is skipped.

## Railway

### First deploy

```bash
npm install -g @railway/cli
railway login
```

If the browser says it succeeded but the terminal keeps waiting, the localhost
callback did not arrive. `railway login --browserless` prints a pairing code
instead and does not depend on the redirect.

```bash
cd ~/safeside-proposals
railway init --name safeside-proposals
railway add --service safeside-proposals
```

Set the secrets. `--stdin` keeps values out of the process list, where anything
on the machine could read them from `ps`:

```bash
printf '%s' '<value>' | railway variable set DATABASE_URL --stdin -s safeside-proposals
```

The five that matter: `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `SESSION_SECRET`. Generate a
**new** session secret for production rather than copying the local one:
`openssl rand -base64 48`.

The rest are not secret and go on the command line:

```bash
railway variable set -s safeside-proposals   NODE_ENV=production PORT=3001 EXTRACTION_PROVIDER=anthropic   ANTHROPIC_MODEL=claude-sonnet-5 SUPABASE_UPLOADS_BUCKET=sp-uploads   SUPABASE_DOCUMENTS_BUCKET=sp-documents SESSION_TTL_HOURS=12
```

`NODE_ENV=production` is not cosmetic — it turns on the secure-cookie flag and
the startup guard described below.

Then:

```bash
railway up --service safeside-proposals
railway domain --service safeside-proposals --port 3001
```

### Migrations

Railway has no release-command step in this configuration, so migrations are
run explicitly rather than on deploy:

```bash
DATABASE_URL='<production URL>' node scripts/migrate.mjs --status   # what would run
DATABASE_URL='<production URL>' node scripts/migrate.mjs            # apply
```

If production points at the Supabase project development already uses, the
migrations are usually applied already. Check `--status` rather than assuming.

### The same database

`DATABASE_URL` currently points at the Supabase project the dev machine also
uses. Deployed and local are therefore **one dataset** — same users, same
proposals, same uploaded quotes. That is convenient and is worth being deliberate
about: anything created while testing locally is visible in production, and
deleting a proposal deletes it in both.

### Day to day

```bash
railway up          # deploy the current working tree
railway logs        # runtime logs
railway logs --build
railway status
railway variable list -s safeside-proposals
```

### Note on config format

`railway.json` is deprecated in favour of `.railway/railway.ts`, and keeps
working until **2026-12-01**. `railway config migrate` converts it. Worth doing
before that date rather than discovering it during an outage.

---

## Fly.io

### Before the first deploy

1. **Install the CLI and sign in.**

   ```bash
   curl -L https://fly.io/install.sh | sh
   fly auth signup   # or: fly auth login
   ```

2. **A card on the Fly account.** There is no free tier that fits this. Expect
   roughly **$10–15/month** for one always-on `shared-cpu-1x` machine with 2GB
   of memory.

3. **The Supabase project already in use.** Nothing about the database changes.
   Take `DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the
   values already in `.env`.

### First deploy

```bash
fly launch --no-deploy
```

Answer **no** when it offers to create a Postgres database or a Redis — both are
already provided by Supabase. It will notice `fly.toml` and keep it; if the app
name `safeside-proposals` is taken, it will ask for another and rewrite that one
line.

Then set the secrets. These are the values that must never be in the repo:

```bash
fly secrets set \
  DATABASE_URL='...' \
  SUPABASE_URL='...' \
  SUPABASE_SERVICE_ROLE_KEY='...' \
  ANTHROPIC_API_KEY='...' \
  SESSION_SECRET="$(openssl rand -base64 48)"
```

Everything else — the model name, the bucket names, the session lifetime — is
non-secret and lives in `[env]` in `fly.toml`.

A note on shell history: a leading space before `fly secrets set` keeps the line
out of history in both bash and zsh, and the API key is worth that.

Then:

```bash
fly deploy
```

The deploy applies migrations first, in a temporary machine, via the
`release_command` in `fly.toml`. If a migration fails the deploy aborts and the
previous version keeps serving.

### Why 2GB and swap

Chromium renders every proposal **twice** — the second pass is what puts real
page numbers in the table of contents — with ten bundled fonts loaded. At 512MB
this does not fail cleanly; the browser is killed mid-document and the symptom
is a generation that simply never finishes. The 512MB of swap absorbs the spike.

If renders start failing after the document grows, raise `memory` in `fly.toml`
before looking anywhere else.

### Day to day

```bash
fly deploy            # deploy the current working tree
fly logs              # live logs
fly status            # machine state
fly ssh console       # a shell in the running container
fly secrets list      # secret NAMES only, never values
fly apps restart safeside-proposals
```

Unlike Railway above, migrations run automatically on deploy via the
`release_command` in `fly.toml`. To check what would run, without deploying:

```bash
DATABASE_URL='<the production URL>' node scripts/migrate.mjs --status
```

## Create the login account

There is no self-registration, so the first account is made by hand against the
production database. Run it from your own machine with the production
`DATABASE_URL`, because the script reads the password from a terminal with echo
off — it never appears in shell history, in the terminal, or in any log.

```bash
DATABASE_URL='<the production URL>' node scripts/create-user.mjs --admin
```

It asks for an email, a display name, and the password twice.

Use a real password. The tool is on the public internet behind nothing but this
one login, and every confidentiality guarantee in `docs/security.md` is downstream
of it. A guessed password is not a login failure, it is a client-data breach.

To change it later:

```bash
DATABASE_URL='<the production URL>' node scripts/set-password.mjs --email you@example.com
```

## Who can see what

Every proposal is scoped to the account that created it — enforced in
`apps/api/src/db/scoped.ts` on each query, not in the UI. With one account that
account sees everything, which is the intended arrangement for now.

`sp_users.is_admin` exists and is set by `--admin`, but currently gates nothing;
it is recorded for when it does. Adding a second account today would give that
person their own separate set of proposals, not a restricted view of yours, and
there is no screen for managing accounts — both are `scripts/create-user.mjs`
jobs.

## Why the machine never sleeps

`auto_stop_machines = 'off'` and `min_machines_running = 1`.

The process runs the extraction worker in-process (`startWorker` in
`server.ts`), polling for queued files and spending about a minute on each.
Fly decides a machine is idle from HTTP traffic — and a broker who starts an
upload and switches tabs generates none. The machine would stop with files
half-read, leaving them stuck in `running`.

This is the main reason for the monthly cost. It is not an optimisation to undo.

## Chromium in a container

Two defaults do not hold in a container, and both flags are set from the image
only — on a laptop the sandbox stays on:

- **`--no-sandbox`.** Chromium's sandbox needs kernel privileges a Fly machine
  does not grant. This is acceptable here and would not be for a browser pointed
  at the web: the process runs as an unprivileged user, and the only page it
  ever opens is a local file it just wrote itself.
- **`--disable-dev-shm-usage`.** `/dev/shm` is a few megabytes in a container,
  which a rendering browser exhausts and then crashes.

The renderer also **writes** into `templates/` — a scratch HTML file it opens
over `file://`, because Chromium will not load `file://` assets into a page made
with `setContent()`. That directory is chowned to the runtime user in the
Dockerfile. If it is ever made read-only, generation breaks.

## It refuses to start misconfigured

In production, a missing secret stops the deploy rather than degrading it.
`assertProductionDrivers` in `context.ts` refuses to boot if the process would
fall back to PGlite, to local disk storage, or to the offline fixture extractor.

Those fallbacks are silent by design, which is right on a laptop and dangerous
on a server: the container would look healthy, serve a login page, accept
uploads — and lose every proposal on the next restart. The fixture extractor is
worse, because it returns plausible coverage data for a document nobody read.

The failure shows up in `fly logs` naming exactly which values are missing.

## What this does not cover

- **No account-management screen.** Adding a colleague is a script.
- **No backups configured here.** Supabase's own backup settings are the whole
  story, and are worth checking rather than assuming.
- **No staging environment.** `fly deploy` goes to the one place there is.
- **Extraction depends on Anthropic credit.** An account at zero balance fails
  every upload with an HTTP 400 that now names the reason. Generating a proposal
  from an already-extracted one keeps working, because that path makes no API
  call at all.
