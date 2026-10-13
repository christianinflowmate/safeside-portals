# Using the proposal tool

For brokers. Everything below is done in the browser; nothing is typed at a
command line.

## Opening it

Once deployed, it is a URL — open it and sign in. Nothing to start, nothing to
leave running. The address is whatever `fly deploy` printed; see
`docs/deployment.md`.

### Running it locally instead

Only needed for development, or before the first deploy:

```bash
cd ~/safeside-proposals && npm run dev
```

Two things start: the API on port 3001 and the web app on **port 3000**. Open
<http://localhost:3000> once both have printed their startup lines. Leave that
terminal open — closing it stops the tool.

## Signing in

Accounts are made by invitation. There is no self-registration and no "forgot
password" link — if you are locked out, someone with access runs
`node scripts/set-password.mjs` for you.

## Inviting someone (admins)

**Team** in the top right, then **Invite someone**: their name and email, and
whether they should be an admin too. You get a link — copy it, or copy the
ready-made message with the link in it — and send it however you like.

They open it, choose their own password, and are signed straight in. Nobody else
ever knows the password, and nothing secret goes through WhatsApp or email.

- **The link works once** and **expires after 7 days.**
- **It is shown only once**, right after you make it. Lost it? Invite the same
  email again: that makes a new link and switches the old one off.
- **Withdraw** cancels a link that hasn't been used yet.
- Everyone sees only their own proposals, admins included.

A wrong password says so and nothing else. It never hints whether the email
exists.

**To change your own password**, click your name in the top right. You need your
current one. Changing it signs out every other browser you are signed in on,
which is the point of changing it.

## 1. Start a proposal

**New Proposal**, then add the carrier quotes for **one client**. Several at
once is the normal case — drag them onto the box or use **Choose files**.

- PDFs only. Anything else is turned away as you add it, named in an amber note
  so you know what did not go in.
- Add every quote you want considered, including ones for coverage the client
  may decline. You can leave lines out later; you cannot add a quote you never
  uploaded.
- The **client name** is only how you find the proposal again. The named insured
  that prints on the document is read from the quotes themselves.

**Upload and analyze** starts it.

## 2. It reads the documents

One file at a time, roughly a minute each, with a progress list showing which is
being read. You can leave the page and come back.

If a file cannot be read, it stops there and asks you what to do rather than
carrying on quietly. You get three choices:

- **Try again.** Most failures have nothing to do with the document — a dropped
  connection, a timeout, an account out of credit. If the reason looks temporary,
  this puts the file back in the queue. Only offered before you have gone through
  to review: once a draft exists, a file read afterwards could not be added to it
  without putting your edits at risk, so it says no rather than appearing to work.
- **Remove and continue** with the rest.
- **Start over** with different documents.

Uploaded quotes are never modified, renamed or overwritten.

## 3. Review — the part that matters

Everything the tool read, laid out and editable. Nothing generates until you
have been through it.

**Notes from extraction** (top, collapsed). Worth opening. This is where it
tells you what it was unsure about and why — a premium it had to assemble from
components, a date printed as "TBD", a fact sheet bundled into the quote that
had nothing to do with it. These are for you and never print.

**1. Customer information.** Anything it could not find says **Not found**
rather than sitting blank. Low-confidence values are flagged. Where two quotes
disagree — different effective dates, different descriptions of the business —
it shows both and asks you to pick. Correct anything that is wrong; your edit
wins from then on.

**2. Coverage.** One block per line of business, with the limits, deductibles,
endorsements and conditions as the carrier worded them. Untick a line to leave
it out of the proposal.

Where more than one carrier quoted the same coverage, it will not choose for
you — it lists the options with their prices and waits.

**3. Pricing.** Carrier premium, your fee, and what the client sees. The first
two columns are internal and never print. Set your fee per line; the client sees
one combined number.

**4. Premium page disclaimers.** These differ from proposal to proposal, so pick
the ones that apply. Ticking none is a valid choice and is remembered as one.

**5. Coverage recommendations.** Suggested where a coverage is missing. Edit the
list to suit the client.

**6. Additional notes.** Free text appended to the recommendations page, and the
policy terms block.

### It will not let you generate until

- every included line has a premium,
- every line quoted more than once has an option chosen,
- every disagreement between quotes has been settled,
- the named insured is filled in.

It lists exactly what is outstanding under the **Generate proposal** button.
This is enforced by the server, not just the screen, so there is no way round it.

## 4. Generate and send

**Generate proposal** builds the document — twenty seconds or so. You get a page
count, a preview of exactly what the client receives, and **Download PDF**.

**Back to edit** returns you to review. Changing anything and generating again
replaces the document.

## What the client never sees

Three things are built into the tool rather than left to whoever proofreads it:

- **No carrier information.** No carrier name, no carrier premium on its own, no
  commission, no underwriter, no rates. Every finished proposal is scanned
  against the carrier names found in the quotes, and generation fails outright if
  one appears.
- **One price.** Carrier premium and your fee are combined before the document is
  built, so nothing downstream can print them apart.
- **Nothing automatic.** There is no path from upload straight to a document. A
  person confirms first, every time.

## Coverage wording still in draft

Fifteen of the forty-one coverage write-ups are placeholder text awaiting
Safeside's own wording. They print with a visible **draft wording** mark so a
proposal carrying one cannot go out unnoticed.

Still draft: business owners policy, commercial auto, crime, cyber, employment
practices, errors & omissions, excess liability, flood, inland marine, liquor
liability, professional liability, umbrella.

Already in our own words: general liability, property, workers comp, disability
/ PFL.

## Deleting a proposal

**Delete** at the end of a row on the proposal list. It asks first, in the row.

It cannot be undone, and it takes the uploaded quotes and everything read out of
them with it. The original files on your own machine are untouched — the tool has
never modified them.

## Known limits

- One account. Everything belongs to whoever is signed in; there is no shared
  view and no second login until someone makes one.
- Admins can invite people from **Team**, but there is no screen yet to remove
  or disable an account once it exists — that is still a database change.
- The layout expects a desktop-width window.
