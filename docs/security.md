# Security notes

## RLS is a backstop, not the control

Supabase RLS keys off `auth.uid()` from a Supabase-issued JWT. This app rolls its
own auth against `sp_users`, and the API connects with the **service role key**,
which bypasses RLS entirely.

So the deny-all policies in `001_initial_schema.sql` do one job: guarantee that the
anon and authenticated keys — including anything that ever leaks into the browser
bundle — can read nothing at all. They do **not** scope a user to their own
proposals.

Ownership is enforced in the API layer, in a single query helper that every
proposal read passes through. Adding a route that reaches around that helper is the
way this gets broken, so don't.

## Carrier leak prevention has two layers

The hard rule is that no carrier name, carrier premium, commission, underwriter or
rate reaches the client document.

**Layer 1 — field whitelist.** The document template can only read fields named in
`packages/shared/src/document-whitelist.ts`. A new column added upstream cannot
reach the output by being forgotten about; it has to be added deliberately.

**Layer 2 — output scan.** A whitelist cannot catch a carrier name embedded *inside*
a whitelisted value: a limit labelled "Travelers Form CG 20 10", an endorsement
titled with a carrier's product name. So extraction records every carrier name it
saw in `carrier_names_seen`, and the renderer scans the assembled document for
those strings before releasing a PDF.

One wrinkle found in testing: extraction correctly reports **Safeside's own name**
among the carrier names, because it appears in the quote's agency footer. The scan
must exclude the brokerage's own names, or every proposal fails its own check.
That allowlist lives with the guard, not in the prompt — keeping the model
over-inclusive is the safer failure direction.

## Invitations

New accounts come from single-use links, so no password is ever chosen by one
person and sent to another. The rules live in `apps/api/src/auth/invites.ts` and
are tested there:

- Only the SHA-256 of the token is stored, as with sessions. The working link
  exists once, in the response to the admin who made it.
- Accepting locks the invite row inside a transaction — two clicks at once make
  one account, not two.
- Links expire after 7 days; inviting the same address again withdraws the
  earlier link, so there is never more than one live door per address.
- An address that already has an account cannot be invited. Otherwise an invite
  would be a way to replace someone's password.
- Creating invites requires `is_admin`, checked on the server. It is the first
  thing that flag has ever gated.

## Secrets

`.env` is gitignored and `.env.example` carries key names with no values. Keys are
shared through 1Password. A key that has been pasted into a chat, an email or a
ticket should be treated as compromised and rotated.
