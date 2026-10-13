-- 013_invites.sql
--
-- Invitations: an admin creates one, sends the person a link, and the person
-- chooses their own password.
--
-- Before this, adding someone meant an admin running a script and then sending
-- the new person a password over WhatsApp or email, where it stayed for good. An
-- invite link never carries a password, works once, and expires.
--
-- Only a SHA-256 of the token is stored, the same way sessions are. A leaked
-- database row cannot be turned back into a working link; the plain token exists
-- exactly once, in the response to whoever created it.

create table sp_invites (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,
  email         citext not null,
  display_name  text not null,
  is_admin      boolean not null default false,
  created_by    uuid not null references sp_users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  -- Set when the link is used. A used invite is kept rather than deleted so the
  -- list can still say who joined through it.
  used_at       timestamptz,
  used_by       uuid references sp_users(id) on delete set null,
  -- Set when an admin withdraws it before it is used.
  revoked_at    timestamptz
);

create index sp_invites_email_idx on sp_invites (email);
create index sp_invites_created_idx on sp_invites (created_at desc);

-- Same backstop as every other table: the API uses the service role key, which
-- bypasses RLS, so this only guarantees that no browser-side key can read it.
alter table sp_invites enable row level security;
alter table sp_invites force row level security;
