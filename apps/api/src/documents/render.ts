/// <reference lib="dom" />
//
// The DOM lib is referenced for this file alone. The callbacks passed to
// page.evaluate() run inside Chromium, not in Node, so they legitimately use
// document and window — but adding "dom" to the whole API's tsconfig would make
// those globals appear available in server code where they are not.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assertNoCarrierLeaks, type ProposalDocumentModel } from '@safeside/shared';
import { renderProposalHtml } from './template.ts';

/**
 * Render a proposal to PDF.
 *
 * Two things happen before any bytes are produced:
 *
 *   1. The leak guard runs and is allowed to throw. Generation fails CLOSED — a
 *      document that might name a carrier is never released, and the error names
 *      the offending fields so the review screen can point at them.
 *
 *   2. The page is loaded from a file:// URL so bundled fonts resolve locally.
 *      A webfont fetched at render time means output that differs between
 *      machines, or a silent fallback nobody notices until a client has the PDF.
 */

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'templates');

export interface RenderOptions {
  /** Carrier names extraction recorded, for the leak scan. */
  carrierNames: string[];
}

export interface RenderedPdf {
  bytes: Uint8Array;
  pageCount: number;
}

export async function renderProposalPdf(
  model: ProposalDocumentModel,
  { carrierNames }: RenderOptions,
): Promise<RenderedPdf> {
  // Fail closed, before a browser is even launched.
  assertNoCarrierLeaks(model, { carrierNames });

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
  let scratch: string | undefined;

  try {
    const page = await browser.newPage();
    const assetBase = `${pathToFileURL(TEMPLATES).href}/`;

    /*
     * The page is written to a real file inside templates/ and opened with
     * goto(), NOT loaded with setContent().
     *
     * setContent() populates an about:blank document, and Chromium refuses to
     * load file:// subresources from a non-file origin — "Not allowed to load
     * local resource". The stylesheets and all ten bundled fonts then fail
     * silently: the document renders in Times New Roman with no layout, and the
     * only obvious symptom is that pagination stops working. Serving the page
     * from a file:// origin makes the relative asset paths same-origin.
     */
    scratch = join(TEMPLATES, `.render-${randomUUID()}.html`);
    const load = async (html: string) => {
      await writeFile(scratch!, html, 'utf8');
      await page.goto(pathToFileURL(scratch!).href, { waitUntil: 'load' });
      // Fonts must be ready before measuring, or metrics come from a fallback
      // face and every page number can be off by one.
      await page.evaluate(() => document.fonts.ready);
    };

    /*
     * Two passes.
     *
     * Table-of-contents page numbers depend on where each section lands, and
     * that is only knowable once the document has been laid out. So: render,
     * measure which page each section starts on, then render again with the real
     * numbers. Standard, and the step everyone forgets to budget for.
     */
    const measure = async (html: string) => {
      await load(html);
      return page.evaluate(() => {
        // Sheet height is the first .page's own height, since each fills one.
        const first = document.querySelector('.page');
        const pageHeight = first?.getBoundingClientRect().height ?? 1;
        /*
         * One .page, one sheet — so a page's number is simply its index.
         *
         * Long sections are chunked in the template precisely so this holds.
         * Deriving numbers from pixel offsets or accumulated heights was tried
         * twice and drifted both times; the sequence is the ground truth and
         * measuring it is what introduced the error.
         *
         * `overflowing` reports any page that would still spill, because that is
         * the one condition under which this assumption breaks.
         */
        const elements = [...document.querySelectorAll<HTMLElement>('.page')];
        const byKey: Record<string, number> = {};
        const overflowing: string[] = [];

        elements.forEach((el, i) => {
          const key = el.dataset.key ?? el.dataset.toc;
          if (key) byKey[key] = i + 1;
          if (el.getBoundingClientRect().height > pageHeight * 1.02) {
            overflowing.push(key ?? `page ${i + 1}`);
          }
        });

        return { byKey, total: elements.length, overflowing };
      });
    };

    const pages = await measure(renderProposalHtml(model, { assetBase }));

    // Numbering assumes one section per sheet. Say so loudly if that broke,
    // rather than shipping a document whose page numbers quietly drift.
    if (pages.overflowing.length > 0) {
      console.warn(
        `[render] ${pages.overflowing.length} section(s) overflow a sheet, so page ` +
        `numbers after them will be low: ${pages.overflowing.join(', ')}`,
      );
    }
    const finalHtml = renderProposalHtml(model, { assetBase, pages });

    const print = async (html: string) => {
      await load(html);
      return page.pdf({
        format: 'Letter',
        printBackground: true,
        // Page padding lives in the stylesheet so the cover can bleed to the edge.
        preferCSSPageSize: true,
      });
    };

    const bytes = await print(finalHtml);
    return { bytes: new Uint8Array(bytes), pageCount: countPdfPages(bytes) };
  } finally {
    // Always close: a leaked Chromium survives the request and eventually the
    // host runs out of memory.
    await browser.close();
    if (scratch) await rm(scratch, { force: true }).catch(() => {});
  }
}

/** Count sheets by scanning the PDF's page objects. */
function countPdfPages(pdf: Buffer): number {
  const text = pdf.toString('latin1');
  const counts = [...text.matchAll(/\/Type\s*\/Page[^s]/g)].length;
  return counts > 0 ? counts : 1;
}
