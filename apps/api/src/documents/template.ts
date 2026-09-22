import type { ProposalDocumentModel, DocumentDetail, DocumentSection, DocumentTable } from '@safeside/shared';
import * as copy from './content.ts';
import type { CopyBlock } from './content.ts';

/**
 * The proposal template.
 *
 * Plain string building rather than a templating library: the structure is fixed,
 * the data is already the exact shape the page needs, and a dependency here would
 * buy nothing but another thing to keep current.
 *
 * Everything this function can read comes from ProposalDocumentModel, which holds
 * no carrier identity and no premium split. The template cannot leak what it
 * cannot reach.
 *
 * Page order follows Safeside's current 22-page template. Fixed pages whose real
 * copy is not yet available carry a visible PLACEHOLDER marker — inventing
 * plausible legal or regulatory text would be worse than an obvious gap.
 */

const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const longDate = (iso: string | null): string =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-US',
    { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

/** A fixed page whose real wording has not been supplied yet. */
function placeholder(what: string, why = ''): string {
  return `<div class="placeholder">
    <strong>PLACEHOLDER — supply real copy</strong>
    <p>${esc(what)}</p>
    ${why ? `<p class="fineprint">${esc(why)}</p>` : ''}
  </div>`;
}

/**
 * Render Safeside's standing copy.
 *
 * The blank token becomes a signature rule rather than literal braces: the real
 * document prints a figure in those places that this tool has no business
 * printing, so it is left for the signer.
 */
function withBlanks(text: string): string {
  return esc(text).split(copy.BLANK_TOKEN).join('<span class="blank"></span>');
}

function blocks(items: CopyBlock[]): string {
  return items.map((b) => {
    switch (b.kind) {
      case 'heading':
        return `<h3>${esc(b.text)}</h3>`;
      case 'paragraph':
        return `<p>${withBlanks(b.text)}</p>`;
      case 'bullets':
        return `<ul>${b.items.map((i) => `<li>${withBlanks(i)}</li>`).join('')}</ul>`;
      case 'clauses':
        return `<ol class="clauses">${b.items.map((i) =>
          `<li>${i.heading ? `<strong>${esc(i.heading)}</strong> ` : ''}${withBlanks(i.text)}</li>`).join('')}</ol>`;
      case 'defs':
        return `<dl class="defs">${b.items.map((i) =>
          `<dt>${esc(i.term)}</dt><dd>${withBlanks(i.text)}</dd>`).join('')}</dl>`;
      case 'placeholder':
        return placeholder(b.what, b.why);
    }
  }).join('');
}

/** A fixed page built from standing copy. */
function copyPage(
  key: string, title: string, items: CopyBlock[], extra = '', pages?: PageNumbers,
): string {
  return `<section class="page" data-key="${key}">
    ${runningHeader()}
    <h2>${esc(title)}</h2>
    ${blocks(items)}
    ${extra}
    ${pageFoot(pages?.byKey[key], pages?.total)}
  </section>`;
}

/**
 * A bordered table with a header band, matching Safeside's own coverage pages.
 * They use a two-column "Coverage | Limit" table with a tan header row; a
 * borderless list reads as a different document at a glance.
 */
function detailRows(items: DocumentDetail[], headings: [string, string] = ['Coverage', 'Limit']): string {
  if (items.length === 0) return '';
  return `<table class="detail">
    <thead><tr><th>${esc(headings[0])}</th><th class="num">${esc(headings[1])}</th></tr></thead>
    <tbody>${items
      .map((d) => `<tr><td>${esc(d.label)}</td><td class="num">${esc(d.value) || '—'}</td></tr>`)
      .join('')}</tbody>
  </table>`;
}

/**
 * The same bordered table for an arbitrary number of columns.
 *
 * The schedules — premises, classifications — need five, and giving detailRows a
 * variadic signature would make the two-column call sites, which are most of
 * them, read worse for no gain.
 */
function gridTable(headings: string[], rows: Array<Array<string | null>>): string {
  if (rows.length === 0) return '';
  return `<table class="detail grid">
    <thead><tr>${headings.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .map((r) => `<tr>${r.map((cell) => `<td>${esc(cell) || '—'}</td>`).join('')}</tr>`)
      .join('')}</tbody>
  </table>`;
}

/**
 * A one-column bordered table, for lists Safeside prints as table rows rather
 * than bullets — the subjectivities and the premium-page disclaimers.
 */
function listTable(heading: string, items: string[]): string {
  if (items.length === 0) return '';
  return `<table class="detail">
    <thead><tr><th>${esc(heading)}</th></tr></thead>
    <tbody>${items.map((t) => `<tr><td>${esc(t)}</td></tr>`).join('')}</tbody>
  </table>`;
}

/**
 * A bordered table with no header band, for the Named Insured page — a list of
 * the client's own particulars rather than a schedule of anything.
 */
function plainRows(items: DocumentDetail[]): string {
  if (items.length === 0) return '';
  return `<table class="detail plain">
    <tbody>${items
      .map((d) => `<tr><th scope="row">${esc(d.label)}</th><td>${esc(d.value) || '—'}</td></tr>`)
      .join('')}</tbody>
  </table>`;
}

/** A schedule with its caption, as it appears on a coverage page. */
function scheduleTable(t: DocumentTable): string {
  return `<p class="table-caption">${esc(t.caption)}</p>
    ${gridTable(t.headings, t.rows)}
    ${t.note ? `<p class="table-note">${esc(t.note)}</p>` : ''}`;
}

function sectionPage(section: DocumentSection, index: number, pages?: PageNumbers): string {
  const block = (caption: string, items: DocumentDetail[], headings: [string, string]) =>
    items.length ? `<p class="table-caption">${caption}</p>${detailRows(items, headings)}` : '';

  /*
   * Safeside puts States above the Employers Liability figures on a workers
   * compensation page, and Premise Information above Subjects of Insurance on a
   * property page. buildSections unshifts those, so the first table is the one
   * that heads the page and the rest follow the limits.
   */
  const [lead, ...rest] = section.tables;
  const leads = lead && (lead.caption === 'States' || lead.caption === 'Premise Information')
    ? [lead] : [];
  const after = leads.length ? rest : section.tables;

  return `<section class="page" data-toc="${esc(section.section_title)}" data-toc-index="${index}">
    ${runningHeader()}
    <h2>${esc(section.section_title)}</h2>
    ${leads.map(scheduleTable).join('')}
    ${block(section.limits_caption, section.limits, ['Coverage', 'Limit'])}
    ${block('Deductibles', section.deductibles, ['Coverage', 'Deductible'])}
    ${after.map(scheduleTable).join('')}
    ${block('Endorsements', section.endorsements, ['Endorsement', 'Status'])}
    ${block('Exclusions', section.exclusions, ['Exclusion', 'Detail'])}
    ${block('Conditions', section.conditions, ['Condition', 'Detail'])}
    ${pageFoot(pages?.byKey[section.section_title], pages?.total)}
  </section>`;
}

const runningHeader = () => `<div class="runhead">
  <img class="runhead-logo" src="assets/logo.png" alt="Safeside Insurance"/>
  <span class="runhead-tag">${esc(copy.RUNNING_HEADER)}</span>
</div>`;

/**
 * Page footer.
 *
 * Every page of Safeside's proposal carries the validity note and "N of M".
 * Numbers come from the measure pass — the same one that fills the table of
 * contents — because a sheet number is only knowable once the document is laid
 * out. Rendered in the HTML rather than through Chromium's footerTemplate, which
 * needs an @page margin and would put a white strip under the full-bleed cover.
 */
const pageFoot = (n?: number, total?: number) => `<div class="pagefoot">
  <span class="pagefoot-text">${esc(copy.FOOTER_DISCLAIMER)}</span>
  <span class="pagefoot-num">${n && total ? `${n} of ${total}` : ''}</span>
</div>`;

export interface PageNumbers {
  /** data-key (or section title) → the sheet it starts on. */
  byKey: Record<string, number>;
  total: number;
  /** Sections that still spill onto a second sheet, which breaks numbering. */
  overflowing?: string[];
}

export interface TemplateOptions {
  /** Absolute file:// base so bundled fonts and CSS resolve without a network. */
  assetBase: string;
  /**
   * Sheet numbers from the measure pass. Absent on the first pass, which is how
   * the measurement is taken in the first place.
   */
  pages?: PageNumbers;
}

export function renderProposalHtml(
  model: ProposalDocumentModel,
  { assetBase, pages }: TemplateOptions,
): string {
  const c = model.customer;
  const tocPages = pages?.byKey;

  /* --- contents ---------------------------------------------------------- */

  const contents: Array<{ title: string; key: string }> = [
    { title: 'Statement From Our CEO', key: 'ceo' },
    { title: model.premium_page_title, key: 'premium' },
    { title: 'Named Insured', key: 'insured' },
    ...model.sections.map((s, i) => ({ title: s.section_title, key: `${s.section_title}` })),
    ...[...new Set(model.coverage_descriptions.map((d) => d.group))].map((g) => ({
      title: `${g} Key Coverage Descriptions`, key: `descriptions:${g}`,
    })),
    ...(model.forms_and_exclusions.length ? [{ title: copy.TERMS_TITLE, key: 'forms' }] : []),
    { title: copy.TERMS_KEY_POINTS_TITLE, key: 'terms' },
    ...(model.recommendations.length || model.recommendations_note
      ? [{ title: 'Coverage Recommendations', key: 'recommendations' }] : []),
    { title: 'NY Regulation 194 & Minimum Earned', key: 'reg194' },
    { title: 'Payment Authorization', key: 'payment' },
    { title: 'Disclaimer & Notice of Acceptance', key: 'disclaimer' },
    { title: 'About Us', key: 'about' },
    { title: 'Our Team', key: 'team' },
    { title: 'Employee Directory', key: 'directory' },
  ];

  /*
   * Numbered 1..n, as Safeside's own contents page is. The number is rendered as
   * a span rather than left to the <ol> marker so it sits inside the row's
   * flexbox and lines up with the title column on a wrapped entry.
   */
  const tocRow = (item: { title: string; key: string }, i: number) => {
    const page = tocPages?.[item.key];
    return `<li><span class="toc-num">${i + 1}.</span>
      <span class="toc-title">${esc(item.title)}</span>
      <span class="toc-dots"></span>
      <span class="toc-page">${page ?? ''}</span></li>`;
  };

  /* --- pages ------------------------------------------------------------- */

  /*
   * Cover: Safeside's own photograph below, title and client above.
   *
   * Their cover is one flattened image with the title and the client's address
   * burned into it, so it cannot be reused per client. This uses that image
   * cropped below both (see templates/assets/README.md) and renders the type as
   * live text. The logo and tagline are already in the photograph.
   */
  const cover = `<section class="page cover">
    <div class="cover-head">
      <h1>${esc(copy.COVER_TITLE)}</h1>
      <div class="cover-client">
        <div class="cover-client-name">${esc(c.named_insured)}</div>
        ${c.dba ? `<div>dba ${esc(c.dba)}</div>` : ''}
        ${(c.mailing_address ?? '').split(/,\s*/).filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join('')}
      </div>
    </div>
    <img class="cover-art" src="assets/cover-art.jpg" alt=""/>
  </section>`;

  const toc = `<section class="page" data-key="contents">
    ${runningHeader()}
    <h2>Table of Contents</h2>
    <ol class="toc">${contents.map(tocRow).join('')}</ol>
    ${pageFoot(pages?.byKey['contents'], pages?.total)}
  </section>`;

  const ceo = copyPage('ceo', copy.CEO_STATEMENT_TITLE, copy.CEO_STATEMENT, `
    <div class="signoff">
      <p>${esc(copy.CEO_SIGNOFF.closing)}</p>
      <p class="signoff-name">${esc(copy.CEO_SIGNOFF.name)}</p>
      <p class="fineprint">${esc(copy.CEO_SIGNOFF.role)}</p>
    </div>`, pages);

  /*
   * The premium page.
   *
   * The Admitted column appears only when at least one line states it. A column
   * of em-dashes is worse than no column: it reads as data the broker failed to
   * fill in rather than as something the quotes never said.
   */
  const showAdmitted = model.priced_lines.some((l) => l.admitted);

  const premium = `<section class="page" data-key="premium">
    ${runningHeader()}
    <h2>${esc(model.premium_page_title)}</h2>
    <table class="premium">
      <thead><tr>
        <th>${esc(copy.PREMIUM_TABLE_HEADINGS.line)}</th>
        ${showAdmitted ? `<th>${esc(copy.PREMIUM_TABLE_HEADINGS.admitted)}</th>` : ''}
        <th class="num">${esc(copy.PREMIUM_TABLE_HEADINGS.price)}</th>
      </tr></thead>
      <tbody>
        ${model.priced_lines.map((l) => `<tr>
          <td>${esc(l.label)}</td>
          ${showAdmitted ? `<td>${esc(l.admitted) || '—'}</td>` : ''}
          <td class="num">${money(l.price)}</td>
        </tr>`).join('')}
      </tbody>
      ${/*
         * Safeside's own premium table has no total row. This keeps one.
         *
         * Their table is the only place the client sees the prices, and a client
         * reading three line items has to add them up to learn what they are
         * being asked to pay. Printing the figure they will actually be invoiced
         * is not a departure from the template worth preserving.
         */''}
      <tfoot><tr>
        <td>Total</td>
        ${showAdmitted ? '<td></td>' : ''}
        <td class="num">${money(model.total)}</td>
      </tr></tfoot>
    </table>
    <h3>Effective Term</h3>
    <p>${longDate(model.effective_date)} &ndash; ${longDate(model.expiration_date)}</p>
${/*
       * The table's own header band is the heading. An <h3> above it as well
       * printed the word twice.
       */''}
    ${listTable(copy.PREMIUM_DISCLAIMERS_HEADING, model.premium_disclaimers)}
    ${listTable(copy.SUBJECTIVITIES_HEADING, copy.SUBJECTIVITIES)}
    ${pageFoot(pages?.byKey['premium'], pages?.total)}
  </section>`;

  const insured = `<section class="page" data-key="insured">
    ${runningHeader()}
    <h2>Named Insured</h2>
    ${/* No column headings: this is the client's own particulars, and a
          "Coverage | Limit" band over their name and address reads as a
          template that was not finished. */''}
    ${plainRows([
      { label: 'Named Insured', value: c.named_insured },
      ...(c.dba ? [{ label: 'DBA', value: c.dba }] : []),
      { label: 'Mailing Address', value: c.mailing_address },
      { label: 'Location Address', value: c.location_address },
      ...(c.entity_type ? [{ label: 'Entity Type', value: c.entity_type }] : []),
      ...(c.business_description ? [{ label: 'Business', value: c.business_description }] : []),
      { label: 'Effective Date', value: `${longDate(model.effective_date)} – ${longDate(model.expiration_date)}` },
    ])}
    ${pageFoot(pages?.byKey['insured'], pages?.total)}
  </section>`;

  /**
   * Split a list across sheets.
   *
   * Page numbers are the section's index, which only holds while one section is
   * one sheet. A list long enough to spill takes its footer onto the next sheet
   * with it and every number afterwards drifts, so long lists are chunked rather
   * than left to overflow. The render logs a warning if anything still spills.
   */
  const chunk = <T,>(items: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  };

  const continued = (i: number) => (i > 0 ? ' (continued)' : '');
  const chunkKey = (base: string, i: number) => (i === 0 ? base : `${base}-${i}`);

  /*
   * One descriptions page per coverage, titled with it — "Property Key Coverage
   * Descriptions", "General Liability Key Coverage Descriptions". Safeside gives
   * each coverage its own page; running them together under one generic heading
   * and spilling into "(continued)" is what this replaces.
   *
   * A coverage with more descriptions than fit still chunks, so the page limit is
   * respected either way.
   *
   * Nine, not six. Six dated from the stacked layout, where a term sat above its
   * description; side by side the same entries take roughly half the height, and
   * general liability's seven — which Safeside fit on one page and we split over
   * two — now fit. The render measures every sheet and warns if one still spills,
   * so this number is checked rather than trusted.
   */
  const DESCRIPTIONS_PER_PAGE = 9;
  const descGroups: string[] = [];
  for (const group of [...new Set(model.coverage_descriptions.map((d) => d.group))]) {
    const items = model.coverage_descriptions.filter((d) => d.group === group);
    chunk(items, DESCRIPTIONS_PER_PAGE).forEach((page, i) => {
      const key = chunkKey(`descriptions:${group}`, i);
      descGroups.push(`<section class="page" data-key="${key}">
        ${runningHeader()}
        <h2>${esc(group)} Key Coverage Descriptions${continued(i)}</h2>
        ${page.map((d) =>
          `<div class="desc${d.is_draft ? ' desc-draft' : ''}"><h3>${esc(d.heading)}${d.is_draft ? '<span class="draft-tag">draft wording</span>' : ''}</h3><p>${esc(d.body)}</p></div>`).join('')}
        ${pageFoot(pages?.byKey[key], pages?.total)}
      </section>`);
    });
  }
  const descriptions = descGroups.join('\n');

  /*
   * Names only, in a compact list under the policy they belong to — Safeside fits
   * forty-odd of them on one sheet that way. A two-column bordered table with a
   * "Detail" column spread the same content over four.
   *
   * Paginated on a count that includes each group's heading, so a proposal with
   * several policies breaks in the right place.
   */
  /*
   * Counted in LINES, not entries, because a form name can wrap.
   *
   * Counting entries assumed every form took one line. They do not: "BP 15 91
   * EXCLUSION - PERFLUOROALKYL AND POLYFLUOROALKYL SUBSTANCES (PFAS)" runs to
   * two at 8pt in this column. One sample page holding 41 entries and another
   * page holding 44 both overflowed their sheet under a limit of 46, and an
   * overflowing page pushes every page number after it out by one — the render
   * warns about exactly this.
   *
   * Forty, measured rather than guessed: a rendered page of 44 entries spilled
   * and one of 41 did not, so the sheet holds about 42 lines once the heading,
   * caption and footer are paid for. Forty leaves a little room for a form name
   * longer than the estimate allows.
   */
  const FORMS_LINES_PER_PAGE = 40;
  const CHARS_PER_LINE = 78;
  const linesFor = (item: string) => Math.max(1, Math.ceil(item.length / CHARS_PER_LINE));

  const formPages: Array<Array<{ group: string; items: string[] }>> = [];
  let current: Array<{ group: string; items: string[] }> = [];
  let used = 0;
  for (const g of model.forms_and_exclusions) {
    let rest = g.items;
    while (rest.length > 0) {
      // Fill by height: take entries until the next one would not fit.
      const room = Math.max(1, FORMS_LINES_PER_PAGE - used - 1);   // -1 for the heading
      let budget = room;
      let n = 0;
      while (n < rest.length && (n === 0 || budget - linesFor(rest[n]) >= 0)) {
        budget -= linesFor(rest[n]);
        n += 1;
        if (budget <= 0) break;
      }
      const take = rest.slice(0, n);
      current.push({ group: g.group, items: take });
      used += take.reduce((sum, it) => sum + linesFor(it), 0) + 1;
      rest = rest.slice(n);
      if (used >= FORMS_LINES_PER_PAGE && (rest.length > 0 || g !== model.forms_and_exclusions.at(-1))) {
        formPages.push(current);
        current = [];
        used = 0;
      }
    }
  }
  if (current.length > 0) formPages.push(current);

  const forms = formPages
    .map((groups, i) => {
      const key = chunkKey('forms', i);
      return `<section class="page" data-key="${key}">
        ${runningHeader()}
        <h2>${esc(copy.TERMS_TITLE)}${continued(i)}</h2>
        <p class="table-caption">${esc(copy.FORMS_SUBHEAD)}</p>
        ${groups.map((g) => `<p class="forms-group">${esc(g.group)}:</p>
          <ul class="forms">${g.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>`).join('')}
        ${pageFoot(pages?.byKey[key], pages?.total)}
      </section>`;
    })
    .join('\n');

  /*
   * Always printed. TERMS_KEY_POINTS is Safeside's own standing copy — the
   * numbered clauses on named insured, renovation, cancellation — and their
   * proposals carry this page whatever else is in them. It was gated on the
   * broker's optional free-text note, so the clauses never appeared at all unless
   * someone happened to type something into an unrelated field.
   */
  const terms = `<section class="page" data-key="terms">
        ${runningHeader()}
        <h2>${esc(copy.TERMS_KEY_POINTS_TITLE)}</h2>
        ${blocks(copy.TERMS_KEY_POINTS)}
        ${model.terms_note
          ? `<p>${esc(model.terms_note).replace(/\n/g, '<br/>')}</p>` : ''}
        ${pageFoot(pages?.byKey['terms'], pages?.total)}
      </section>`;

  const recommendations = (model.recommendations.length || model.recommendations_note)
    ? `<section class="page recommendations" data-key="recommendations">
        ${runningHeader()}
        <h2>${esc(copy.RECOMMENDATIONS_TITLE)}</h2>
        <p>${esc(copy.RECOMMENDATIONS_INTRO)}</p>
        ${model.recommendations.map((r) =>
          `<div class="desc"><h3>${esc(r.label)}</h3><p>${esc(r.body)}</p></div>`).join('')}
        ${model.recommendations_note
          ? `<div class="desc"><p>${esc(model.recommendations_note).replace(/\n/g, '<br/>')}</p></div>`
          : ''}
        <h3>${esc(copy.RECOMMENDATIONS_ACK_TITLE)}</h3>
        <p class="fineprint">${esc(copy.RECOMMENDATIONS_ACK)}</p>
        ${pageFoot(pages?.byKey['recommendations'], pages?.total)}
      </section>`
    : '';



  const back = `<section class="page back">
    <div class="back-body">
      <span class="wordmark">SAFESIDE</span>
      <p>${esc(copy.BACK_PAGE.brand)}</p>
      ${copy.BACK_PAGE.address.map((l) => `<p>${esc(l)}</p>`).join('')}
      ${copy.BACK_PAGE.contact.map((c) => `<p>${esc(c.label)}: ${esc(c.value)}</p>`).join('')}
      <p class="fineprint">${esc(copy.FOOTER_DISCLAIMER)}</p>
    </div>
  </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Commercial Insurance Proposal</title>
<base href="${assetBase}"/>
<link rel="stylesheet" href="tokens.css"/>
<link rel="stylesheet" href="fonts.css"/>
<link rel="stylesheet" href="proposal.css"/>
</head>
<body>
${cover}
${toc}
${ceo}
${premium}
${insured}
${model.sections.map((s, i) => sectionPage(s, i, pages)).join('\n')}
${descriptions}
${forms}
${terms}
${recommendations}
${copyPage('reg194', copy.NY_REGULATION_TITLE, copy.NY_REGULATION, `<h3>${esc(copy.MINIMUM_EARNED_HEADING)}</h3>${blocks(copy.MINIMUM_EARNED)}`, pages)}
${copyPage('payment', copy.PAYMENT_AUTHORIZATION_TITLE, copy.PAYMENT_AUTHORIZATION, '', pages)}
${copyPage('disclaimer', copy.DISCLAIMER_TITLE, copy.DISCLAIMER, `<p class="fineprint">${esc(copy.DISCLAIMER_NOTICE)}</p>`, pages)}
${copyPage('about', copy.ABOUT_US_TITLE, copy.ABOUT_US, '', pages)}
${copyPage('team', copy.OUR_TEAM_TITLE, copy.OUR_TEAM, '', pages)}
${`<section class="page" data-key="directory">
  ${runningHeader()}
  <h2>${esc(copy.EMPLOYEE_DIRECTORY_TITLE)}</h2>
  <!-- Safeside's own directory, extracted from their proposals as a flattened
       image. Identical across every sample client, so it carries no client data. -->
  <img class="full-page-art" src="assets/employee-directory.jpg" alt="Safeside employee directory"/>
  ${pageFoot(pages?.byKey['directory'], pages?.total)}
</section>`}
${back}
</body>
</html>`;
}
