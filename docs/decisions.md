# Decisions

Answers to questions the brief left open, recorded so they are not re-litigated or
quietly reversed. Each says who decided and on what evidence.

## Pricing

**Statutory fees are inside the one number.** NY Fire Fee, NYS Assessment,
Terrorism charges and similar are part of the line premium the broker fee is added
to. Confirmed by Yehuda, 2026-09-19.

**Payment plans are not shown to the client.** Carriers commonly quote
pay-monthly against pay-in-full-with-discount — a sample client's quote differs by $24 on
that basis alone. The proposal shows the annual figure only and says nothing about
payment terms. Confirmed by Yehuda, 2026-09-19.

Consequence for extraction: two prices for identical coverage are a payment plan,
not a coverage option, and must not be returned as options.

## Proposal scope

**One document covering all included lines**, as the brief describes — not one per
line. Evidence: of ten sample clients, several bundle two or three lines into one document
("BOP WC", "BOP WC DBL", "GL EO"). One client with separate GL and WC proposals
is the only counter-example.

## Layout source of truth

**The `Safe Secure Done` Word template.** Nine of the eleven sample proposals use
it. Its cover is a full-bleed photograph — blue sky, skyscrapers, the chrome
Safeside shield — with "COMMERCIAL INSURANCE PROPOSAL." in heavy white type, the
client block top right, and the Safeside logo and tagline along the bottom.

### CORRECTION, 2026-09-19

The two files named `*New Redesign*` are **AI-generated mockups**, not Safeside
output. They were initially mistaken for the current layout because they are the
only ones carrying the brief's design system, and several conclusions were drawn
from them that did not survive checking against the real template:

- **VOID: "the proposal prints the carrier name."** The mockup has a
  `CARRIER: <name>` field on its summary page. The real template names no carrier
  anywhere in 22 pages — the word "carrier" appears three times, all generic
  prose. The brief's hard rule is correct as written and needs no exception.
- **VOID: `QUOTE REFERENCE` field.** Mockup only.
- **VOID: the large `TOTAL ANNUAL PREMIUM` header block.** The real premium page
  is the breakdown table alone, with no headline total above it.
- **VOID: page geometry and palette taken from the mockup .docx.** Re-derive from
  the real template.

Confirmed against the real template and still standing:

- **BOP decomposes.** Real pages 6 and 7 are "Business General Liability
  Coverage" and "Business Property Coverage"; the breakdown table has one row,
  "Business Owner Property". One priced line, two coverage pages.
- **Prices appear once**, in the breakdown table, one row per priced line. The
  same three figures appear in both documents, so the mockup was built from the
  real one.
- **`Admitted / Non-Admitted` is a real column.** It describes the policy, not the
  carrier's identity, and does not name anyone.

Lesson for anything derived from a sample: check it is Safeside's own output
before building on it. A mockup that looks more polished than the real thing is
more likely to be generated than to be newer.

## Palette

**Two golds, non-interchangeable.** `#A8853F` for type, `#CEA963` for rules and
borders. Derived from the redesign document, where A8853F appears 81 times and is
always a text colour, and CEA963 appears 31 times and is always a border colour.

The brief names only `#CEA963` as "Gold". Taken literally that would put gold type
at roughly 2:1 contrast on white, which fails WCAG at any size and does not match
what Safeside actually ships. See `templates/tokens.css`.

## Coverage Recommendations

**Library plus free-text override.** Standard recommendations are seeded rows,
suggested when their trigger line is ABSENT from the proposal — no cyber line
found, so Cyber Liability surfaces. The broker ticks what applies, edits wording
inline, and can append free text.

Rationale: pure free text recreates the retyping this tool exists to remove; a
pure fixed library produces proposals that read like form letters, on the one page
where the broker's judgement is the point.

## Open

- **The option picker has no real-world example.** Zero of 18 sample carrier quotes
  present the same coverage twice at different terms. It is required by the
  definition of done, so it will be built against synthetic fixtures unless a real
  example turns up. Worth confirming with Yehuda where the requirement originated.
