import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ProposalDetail } from '@safeside/shared';

/**
 * The review screen's behaviour, not its markup.
 *
 * Each of these maps to a line in the brief's definition of done — the things a
 * broker relies on and that are invisible in a typecheck: that an unfound field
 * is flagged rather than quietly blank, that the price shown is the combined one,
 * and that Generate stays disabled with the reason on screen.
 *
 * All client details are invented.
 */

const api = vi.hoisted(() => ({
  getProposal: vi.fn(),
  updateCustomer: vi.fn(),
  updateLine: vi.fn(),
  selectRecommendations: vi.fn(),
  selectDisclaimers: vi.fn(),
  updateProposal: vi.fn(),
  generate: vi.fn(),
}));

vi.mock('../../lib/api.ts', () => ({
  api,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'error'),
  ApiRequestError: class extends Error {},
  UNAUTHORIZED_EVENT: 'safeside:unauthorized',
}));

const { ReviewScreen } = await import('./ReviewScreen.tsx');

function field(value: string | null, over: Partial<ProposalDetail['customer']['dba']> = {}) {
  return {
    value,
    found: value !== null,
    confidence: value === null ? 0 : 0.95,
    conflicts: [],
    edited: false,
    ...over,
  };
}

function detail(over: Partial<ProposalDetail> = {}): ProposalDetail {
  return {
    id: 'p1',
    client_name: 'Northgate Bakery LLC',
    status: 'draft',
    created_at: '2026-09-19T10:00:00.000Z',
    updated_at: '2026-09-19T10:00:00.000Z',
    confirmed_at: null,
    customer: {
      named_insured: field('Northgate Bakery LLC'),
      dba: field(null),
      mailing_address: field('1 Example Way, Springfield, NY 10001'),
      location_address: field('1 Example Way, Springfield, NY 10001'),
      contact_name: field(null),
      contact_phone: field(null),
      contact_email: field(null),
      fein: field(null),
      entity_type: field('LLC', { confidence: 0.55 }),
      business_description: field('Retail bakery'),
      effective_date: field('2026-10-01'),
      expiration_date: field('2027-10-01'),
    },
    lines: [{
      id: 'line-1',
      line_type: 'business_owners_policy',
      line_type_label: 'Businessowners Policy',
      section_titles: ['General Liability Coverage', 'Property Coverage'],
      included: true,
      carrier_name: 'Utica National',
      carrier_premium: 604.5,
      premium_components: [],
      broker_fee: 150,
      combined_price: 754.5,
      options: [],
      selected_option_id: null,
      details: [{ kind: 'limit', label: 'Each Occurrence', value: '$1,000,000', confidence: 0.95, section_hint: null }],
      admitted: 'admitted',
      schedules: null,
      confidence: 0.93,
      display_order: 10,
      components_unreconciled: false,
    }],
    recommendations: [{
      id: 'rec-1', label: 'Cyber Liability', body: 'Covers a data breach.',
      suggested: true, selected: false, body_override: null,
    }],
    recommendations_note: null,
    disclaimers: [
      {
        id: 'disc-1', label: 'Minimum Deposit',
        body: 'Minimum Deposit applies if the policy is rated by payroll or sales',
        selected: true,
      },
      {
        id: 'disc-2', label: 'Payroll audit',
        body: 'This policy is rated on estimated payroll and will be audited at policy expiration.',
        selected: false,
      },
    ],
    premises: [],
    terms_note: null,
    files: [{
      id: 'f1', original_filename: 'quote.pdf', size_bytes: 1024, page_count: 22,
      extraction_status: 'succeeded', error_text: null, created_at: '2026-09-19T10:00:00.000Z',
    }],
    notes: [],
    carrier_names: ['Utica National'],
    totals: { carrier_premium: 604.5, broker_fee: 150, combined: 754.5 },
    blocking_reasons: [],
    ...over,
  };
}

function renderReview() {
  return render(
    <MemoryRouter initialEntries={['/proposals/p1/review']}>
      <Routes>
        <Route path="/proposals/:id/review" element={<ReviewScreen />} />
        <Route path="/proposals/:id/result" element={<div>RESULT SCREEN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getProposal.mockResolvedValue(detail());
});

describe('review screen', () => {
  test('shows the client and the coverage lines', async () => {
    renderReview();
    expect(await screen.findByText('Northgate Bakery LLC')).toBeInTheDocument();
    // The line name appears twice by design — once as the card heading, once as
    // a row in the pricing table.
    expect(screen.getAllByText(/Business Owners Policy/i).length).toBe(2);
  });

  // "Fields the AI could not find are visibly flagged rather than silently blank."
  test('flags fields extraction could not find', async () => {
    renderReview();
    await screen.findByText('Northgate Bakery LLC');
    expect(screen.getAllByText(/Not found/i).length).toBeGreaterThanOrEqual(4);
  });

  test('flags a low-confidence field separately from a missing one', async () => {
    renderReview();
    await screen.findByText('Northgate Bakery LLC');
    expect(screen.getByText(/Low confidence/i)).toBeInTheDocument();
  });

  test('says when a packaged line prints as more than one section', async () => {
    renderReview();
    expect(await screen.findByText(/Prints as 2 sections/i)).toBeInTheDocument();
  });

  // "The displayed price is the combined figure."
  test('shows the combined price, labelled as what the client sees', async () => {
    renderReview();
    await screen.findByText('Northgate Bakery LLC');
    expect(screen.getAllByText(/Client sees/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\$754\.50/).length).toBeGreaterThan(0);
  });

  test('makes clear that carrier premium and fee are internal', async () => {
    renderReview();
    await screen.findByText('Northgate Bakery LLC');
    expect(screen.getAllByText(/Internal only/i).length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(/carrier and fee columns are internal/i),
    ).toBeInTheDocument();
  });

  // "Generate is blocked, with a readable reason, while anything required is missing."
  test('disables Generate and shows every blocking reason', async () => {
    api.getProposal.mockResolvedValue(detail({
      blocking_reasons: [
        'General Liability Coverage: choose one of 2 quoted options.',
        'Named insured is missing.',
      ],
    }));
    renderReview();

    const button = await screen.findByRole('button', { name: /Generate proposal/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/choose one of 2 quoted options/i)).toBeInTheDocument();
    expect(screen.getByText(/Named insured is missing/i)).toBeInTheDocument();
  });

  test('enables Generate when nothing is outstanding', async () => {
    renderReview();
    const button = await screen.findByRole('button', { name: /Generate proposal/i });
    expect(button).toBeEnabled();
  });

  // "A quote presenting two versions of a line surfaces both."
  test('renders an option picker with nothing pre-selected', async () => {
    api.getProposal.mockResolvedValue(detail({
      lines: [{
        ...detail().lines[0],
        carrier_premium: null,
        combined_price: null,
        selected_option_id: null,
        options: [
          { id: 'o1', label: '$1M / $2M', carrier_premium: 2400, premium_components: [], details: [], source_filename: 'utica.pdf', from_separate_file: true },
          { id: 'o2', label: '$2M / $4M', carrier_premium: 3100, premium_components: [], details: [], source_filename: 'amtrust.pdf', from_separate_file: true },
        ],
      }],
      blocking_reasons: ['General Liability Coverage: choose one of 2 quoted options.'],
    }));
    renderReview();

    await screen.findByText(/\$1M \/ \$2M/);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
  });

  test('words competing carrier quotes differently from one quote offering a choice', async () => {
    api.getProposal.mockResolvedValue(detail({
      lines: [{
        ...detail().lines[0],
        options: [
          { id: 'o1', label: 'A', carrier_premium: 1, premium_components: [], details: [], source_filename: 'a.pdf', from_separate_file: true },
          { id: 'o2', label: 'B', carrier_premium: 2, premium_components: [], details: [], source_filename: 'b.pdf', from_separate_file: true },
        ],
      }],
    }));
    renderReview();
    expect(await screen.findByText(/More than one carrier quoted this coverage/i)).toBeInTheDocument();
  });

  test('choosing an option sends the selection', async () => {
    const user = userEvent.setup();
    api.getProposal.mockResolvedValue(detail({
      lines: [{
        ...detail().lines[0],
        options: [
          { id: 'o1', label: '$1M / $2M', carrier_premium: 2400, premium_components: [], details: [], source_filename: null, from_separate_file: false },
          { id: 'o2', label: '$2M / $4M', carrier_premium: 3100, premium_components: [], details: [], source_filename: null, from_separate_file: false },
        ],
      }],
    }));
    api.updateLine.mockResolvedValue({});
    renderReview();

    await screen.findByText(/\$2M \/ \$4M/);
    await user.click(screen.getAllByRole('radio')[1]);

    await waitFor(() => {
      expect(api.updateLine).toHaveBeenCalledWith('line-1', { selected_option_id: 'o2' });
    });
  });

  test('editing a customer field saves on blur, not on every keystroke', async () => {
    const user = userEvent.setup();
    api.updateCustomer.mockResolvedValue({});
    renderReview();

    const input = await screen.findByLabelText(/Contact Name/i);
    await user.type(input, 'A. Baker');
    expect(api.updateCustomer).not.toHaveBeenCalled();

    await user.tab();
    await waitFor(() => {
      expect(api.updateCustomer).toHaveBeenCalledWith('p1', { fields: { contact_name: 'A. Baker' } });
    });
  });

  test('a recommendation for an absent coverage is marked as such', async () => {
    renderReview();
    expect(await screen.findByText(/Not currently covered/i)).toBeInTheDocument();
    expect(screen.getByText('Cyber Liability')).toBeInTheDocument();
  });

  test('unticking a line sends the change', async () => {
    const user = userEvent.setup();
    api.updateLine.mockResolvedValue({});
    renderReview();

    await screen.findAllByText(/Business Owners Policy/i);
    // The include control is a switch, not a checkbox — see components/ui/Toggle.
    await user.click(screen.getByRole('switch', { name: /Include/i }));

    await waitFor(() => {
      expect(api.updateLine).toHaveBeenCalledWith('line-1', { included: false });
    });
  });

  /*
   * The disclaimers are a broker choice, not standing copy: Safeside's own
   * proposals carry different ones, and it does not follow from the lines quoted.
   */
  test('the premium disclaimers are shown with the broker\'s current selection', async () => {
    renderReview();
    expect(await screen.findByText('Minimum Deposit')).toBeInTheDocument();
    const ticked = screen.getByRole('checkbox', { name: /Minimum Deposit/i });
    const unticked = screen.getByRole('checkbox', { name: /Payroll audit/i });
    expect(ticked).toBeChecked();
    expect(unticked).not.toBeChecked();
  });

  test('ticking a disclaimer sends the whole selection, in order', async () => {
    const user = userEvent.setup();
    api.selectDisclaimers.mockResolvedValue({});
    renderReview();

    await user.click(await screen.findByRole('checkbox', { name: /Payroll audit/i }));

    await waitFor(() => {
      expect(api.selectDisclaimers).toHaveBeenCalledWith('p1', { selected: ['disc-1', 'disc-2'] });
    });
  });

  test('admitted status is editable, and "not stated" is a real choice', async () => {
    const user = userEvent.setup();
    api.updateLine.mockResolvedValue({});
    renderReview();

    const select = await screen.findByLabelText(/Admitted status/i);
    expect(select).toHaveValue('admitted');

    // Null, not a guess: the column is dropped from the document entirely.
    await user.selectOptions(select, '');
    await waitFor(() => {
      expect(api.updateLine).toHaveBeenCalledWith('line-1', { admitted: null });
    });
  });

  // A 422 from the leak guard must point the broker at the offending field.
  test('a carrier leak on generate names the field', async () => {
    const user = userEvent.setup();
    const failure = Object.assign(new Error('Generation blocked: the document contains carrier information.'), {
      leakFindings: [{ term: 'Utica National', path: 'sections[0].endorsements[0].label', excerpt: '…' }],
    });
    api.generate.mockRejectedValue(failure);
    renderReview();

    await user.click(await screen.findByRole('button', { name: /Generate proposal/i }));

    expect(await screen.findByText(/contains carrier information/i)).toBeInTheDocument();
    expect(screen.getByText(/Utica National/)).toBeInTheDocument();
    expect(screen.getByText(/sections\[0\]\.endorsements\[0\]\.label/)).toBeInTheDocument();
  });

  test('a successful generate moves to the result screen', async () => {
    const user = userEvent.setup();
    api.generate.mockResolvedValue({ id: 'doc-1' });
    renderReview();

    await user.click(await screen.findByRole('button', { name: /Generate proposal/i }));
    expect(await screen.findByText('RESULT SCREEN')).toBeInTheDocument();
  });
});
