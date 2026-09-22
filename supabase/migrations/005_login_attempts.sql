-- 005_login_attempts.sql
--
-- Rate limiting for sign-in.
--
-- Argon2id makes each guess expensive, but expensive is not the same as limited:
-- nothing currently stops a thousand attempts against a known broker's address,
-- and this is a tool whose accounts hold client FEINs and premiums.
--
-- Attempts are recorded in the database rather than in process memory on purpose.
-- In-memory counters reset on every deploy and are not shared between instances,
-- so an attacker gets a fresh allowance each time the app restarts — which is
-- precisely when someone is most likely to be poking at it.

create table sp_login_attempts (
  id          uuid primary key default gen_random_uuid(),
  -- Recorded even when no such user exists: the limit has to apply to addresses
  -- that are being guessed at, not only to ones that turned out to be real.
  email       citext,
  ip          inet,
  succeeded   boolean not null,
  created_at  timestamptz not null default now()
);

-- Both lookups are "how many failures for this key since T", so the partial
-- index on failures keeps the successful rows out of the way.
create index sp_login_attempts_email_idx
  on sp_login_attempts (email, created_at desc) where not succeeded;

create index sp_login_attempts_ip_idx
  on sp_login_attempts (ip, created_at desc) where not succeeded;

create index sp_login_attempts_created_idx on sp_login_attempts (created_at);

alter table sp_login_attempts enable row level security;
alter table sp_login_attempts force row level security;
