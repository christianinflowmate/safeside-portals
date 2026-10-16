import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';

/**
 * How to use the tool, for the people who log in from Safeside.
 *
 * It lives in the app rather than in a message or a PDF so it changes when the
 * app changes: a guide sent round once is out of date the first time a button is
 * renamed, and nobody can find it again anyway. Public on purpose, so someone
 * stuck at the sign-in screen can still read how to get in.
 *
 * Keep it free of facts that date — which coverage types are still in draft,
 * exact timings, a person's name in the body. Those change; this page should not
 * need to every time they do.
 */

const SUPPORT = 'Christian at Inflowmate';

interface Section {
  title: string;
  body: Array<string | string[]>;
}

const SECTIONS: Section[] = [
  {
    title: 'Getting in',
    body: [
      'You’ll get an invite link. Open it, choose your own password, and you’re in.',
      'If you were given a password instead, change it after your first sign-in: click your name at the top right.',
    ],
  },
  {
    title: '1. Start a proposal',
    body: [
      'Click New Proposal and type the client’s name, just so you can find it later. Drag in the carrier quote PDFs for that client, or use Choose files, then click Upload and analyze.',
      'PDFs only, up to 20 files. Upload quotes only, not old proposals.',
    ],
  },
  {
    title: '2. Let it read the quotes',
    body: [
      'It takes about a minute per quote. You can leave the page and come back.',
      'If a file fails, click Try again, or Remove and continue to go on without it. The files you upload are never changed.',
    ],
  },
  {
    title: '3. Check everything',
    body: [
      'Open the notes at the top first (click Show). That’s where it says what it wasn’t sure about. Then go down the page:',
      [
        'Customer information: fix anything wrong. “Not found” means it couldn’t find it. If two quotes don’t match, pick the right one.',
        'Coverage: untick anything the client isn’t taking. If two carriers quoted the same coverage, choose which one goes in.',
        'Pricing: put in your broker fee per line. The client only ever sees one total price.',
        'Disclaimers, recommendations and notes: tick or edit what applies.',
      ],
      'You don’t need to save, it does it for you.',
    ],
  },
  {
    title: '4. Generate',
    body: [
      'Click Generate proposal. If something is missing it lists it under the button. Fix it and click again.',
      'If it finds a carrier name it won’t generate. Click Remove all where it shows the names, then generate again.',
    ],
  },
  {
    title: '5. Download',
    body: [
      'Check the preview, it’s exactly what the client gets, then click Download PDF.',
      'To change something, click Back to edit and generate again.',
    ],
  },
  {
    title: 'Your login',
    body: [[
      'Don’t share your login. Everyone gets their own.',
      'Sign out (top right) if you’re on a shared computer.',
      'You’re signed out automatically after a while, so you may need to sign in again the next day.',
      'You only see your own proposals.',
    ]],
  },
  {
    title: 'A few things',
    body: [[
      'Carrier names, commissions, rates and the carrier’s own premium never appear in the proposal.',
      'Some coverage pages may show a “draft wording” mark. That means Safeside’s own wording for that coverage hasn’t been added yet.',
      'Delete on the proposal list can’t be undone.',
    ]],
  },
];

export function HelpScreen() {
  const { status } = useAuth();
  const signedIn = status === 'authenticated';

  return (
    <div className="min-h-screen bg-panel px-6 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-navy">How to use Safeside Proposals</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Here’s how to make a proposal with the tool.
            </p>
          </div>
          <Link
            to={signedIn ? '/' : '/login'}
            className="shrink-0 text-sm font-medium text-navy hover:underline"
          >
            {signedIn ? 'Back to proposals' : 'Sign in'}
          </Link>
        </div>

        <div className="flex flex-col gap-3">
          {SECTIONS.map((section) => (
            <section key={section.title} className="rounded-md border border-rule bg-white px-5 py-4">
              <h2 className="text-sm font-semibold text-navy">{section.title}</h2>
              <div className="mt-2 flex flex-col gap-2 text-sm leading-relaxed text-ink">
                {section.body.map((part, i) =>
                  Array.isArray(part) ? (
                    <ul key={i} className="list-disc space-y-1 pl-5">
                      {part.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  ) : (
                    <p key={i}>{part}</p>
                  ),
                )}
              </div>
            </section>
          ))}
        </div>

        <p className="mt-4 text-xs text-ink-muted">Questions? Message {SUPPORT}.</p>
      </div>
    </div>
  );
}
