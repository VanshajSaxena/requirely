import { describe, expect, it } from 'vitest';
import {
  Answer,
  finalizeSession,
  Question,
  Session,
  SessionStateError,
  Source,
  UnderstandingRevision,
} from '../domain/index.ts';
import { fixedClock } from '../domain/testing/fakes.ts';
import { project } from './index.ts';

const AT = '2026-01-01T00:00:00.000Z';

const session = (overrides: Record<string, unknown> = {}) =>
  Session.parse({
    id: 'ses-1',
    title: 'Requirely',
    status: 'sufficient',
    questionBudget: 12,
    questionsAsked: 4,
    currentRevisionId: 'rev-1',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });

const source = (id: string, overrides: Record<string, unknown> = {}) =>
  Source.parse({
    id,
    sessionId: 'ses-1',
    kind: 'text',
    status: 'normalized',
    derivedBy: 'none',
    origin: { label: `${id} notes` },
    normalizedText: 'text',
    ingestedAt: AT,
    ...overrides,
  });

const revision = (content: Record<string, unknown>) =>
  UnderstandingRevision.parse({
    id: 'rev-1',
    sessionId: 'ses-1',
    revision: 2,
    createdAt: AT,
    content,
  });

/** A reasonably complete understanding, used by most assertions below. */
const FULL = {
  product: {
    name: 'Requirely',
    oneLiner: 'Gather software requirements faster.',
    problem: 'Specifying is slower than building.',
    purpose: 'Turn raw context into a buildable specification.',
    users: [{ label: 'Product managers', description: 'Write specs', needs: ['fewer rounds'] }],
  },
  // Settled — this is what the body of every document is built from.
  decisions: [
    {
      id: 'dec-1',
      statement: 'Users sign in via SSO',
      kind: 'functional',
      dimension: 'core-behaviour',
      rationale: 'Okta is already the org identity provider.',
      promotedFrom: 'req-9',
      settledBy: 'ans-1',
      provenance: [{ sourceId: 'src-1' }],
    },
    {
      id: 'dec-2',
      statement: 'p95 under 200ms',
      kind: 'non-functional',
      dimension: 'core-behaviour',
      rationale: 'Chosen over p99, which nobody measures today.',
      settledBy: 'src-1',
    },
    {
      id: 'dec-3',
      statement: 'Must run on-premise',
      kind: 'constraint',
      dimension: 'constraints',
      rationale: 'Regulatory; cloud was ruled out.',
      settledBy: 'src-1',
    },
    {
      id: 'dec-4',
      statement: 'Product managers and founders are the audience',
      kind: 'scope',
      dimension: 'users',
      rationale: 'Engineers were offered and not chosen.',
      promotedFrom: 'req-8',
      settledBy: 'ans-2',
    },
  ],
  // Still open — Appendix A, and the agent prompt's STOP section.
  requirements: [
    {
      id: 'req-3',
      statement: 'Nothing states how anyone would know this worked',
      kind: 'acceptance',
      dimension: 'acceptance',
      blocking: true,
    },
  ],
  constraints: [],
  assumptions: [
    {
      id: 'asm-1',
      statement: 'English only at launch',
      basis: 'no locale mentioned',
      risk: 'low',
      dimension: 'edge-cases',
    },
  ],
  contradictions: [
    {
      id: 'ctr-1',
      description: 'Retention stated as both 30 and 90 days',
      between: [{ sourceId: 'src-1' }, { sourceId: 'src-2' }],
      dimension: 'data',
    },
  ],
};

/**
 * The question that settled `dec-1`, with one option taken and two not.
 *
 * `ans-1` is what `FULL.decisions[0].settledBy` names, so this is the join the
 * whole step exists for: Decision → Answer → Question → Options.
 */
const QUESTION = Question.parse({
  id: 'qst-1',
  sessionId: 'ses-1',
  turnId: 'trn-1',
  dimension: 'core-behaviour',
  about: 'req-9',
  text: 'How should users sign in?',
  rationale: 'Sign-in shapes the whole auth surface and nothing states it.',
  mode: 'single',
  recommends: 'opt-2',
  because: 'Magic links avoid storing a password at all.',
  options: [
    {
      id: 'opt-1',
      label: 'SSO via Okta',
      commits: 'Every user needs an Okta account.',
      settles: ['req-9'],
    },
    {
      id: 'opt-2',
      label: 'Magic links',
      commits: 'No password to store, but every sign-in needs a working inbox.',
    },
    {
      id: 'opt-3',
      label: 'Password plus TOTP',
      commits: 'Full control, and a support burden for resets.',
    },
  ],
  askedAt: AT,
});

const ANSWER = Answer.parse({
  id: 'ans-1',
  questionId: 'qst-1',
  selectedOptionIds: ['opt-1'],
  answeredAt: AT,
});

const input = (
  content: Record<string, unknown> = FULL,
  sessionOverrides = {},
  inquiry: { questions?: Question[]; answers?: Answer[] } = {},
) => ({
  session: session(sessionOverrides),
  revision: revision(content),
  sources: [source('src-1'), source('src-2')],
  questions: inquiry.questions ?? [QUESTION],
  answers: inquiry.answers ?? [ANSWER],
});

describe('labels — the Phase 3b payoff', () => {
  it('uses the stored id as the citation number, with no mapping table', () => {
    const srs = project('srs', input());

    expect(srs).toContain('**DEC-1**');
    expect(srs).toContain('**ASM-1**');
    expect(srs).toContain('**REQ-3**');
  });
});

describe('citations', () => {
  it('cites the source reference and never a quote', () => {
    // `Provenance.quote` is unverified (WEAKNESSES.md #1); rendering it in a
    // specification would make a fabrication look authoritative.
    const withQuote = {
      ...FULL,
      decisions: [
        { ...FULL.decisions[0], provenance: [{ sourceId: 'src-1', quote: 'we use Okta' }] },
      ],
    };
    const srs = project('srs', input(withQuote));

    expect(srs).toContain('[src-1]');
    expect(srs).not.toContain('we use Okta');
  });

  it('drops a citation naming a source that does not exist, rather than throwing', () => {
    const ghost = {
      ...FULL,
      decisions: [{ ...FULL.decisions[0], provenance: [{ sourceId: 'src-99' }] }],
    };

    const srs = project('srs', input(ghost));
    expect(srs).toContain('DEC-1');
    expect(srs).not.toContain('src-99');
  });
});

describe('SRS', () => {
  it('uses standard section numbering', () => {
    const srs = project('srs', input());

    expect(srs).toContain('## 1. Introduction');
    expect(srs).toContain('### 1.1 Purpose');
    expect(srs).toContain('## 2. Overall description');
    expect(srs).toContain('### 2.4 Constraints');
    expect(srs).toContain('## 3. Specific requirements');
    expect(srs).toContain('### 3.2 Non-functional requirements');
  });

  it('omits a section the understanding carries no data for', () => {
    // The whole reason for choosing "standard headings, empty sections omitted":
    // a thin understanding should be short, not a wall of TBD.
    const thin = {
      ...FULL,
      decisions: FULL.decisions.filter((d) => d.kind !== 'constraint'),
      assumptions: [],
      product: { name: 'X' },
    };
    const srs = project('srs', input(thin));

    expect(srs).not.toContain('2.4 Constraints');
    expect(srs).not.toContain('2.5 Assumptions');
    expect(srs).not.toContain('1.1 Purpose');
  });

  it('omits a parent heading when every child section is empty', () => {
    // Section 3 is built entirely from decisions, so an understanding that has
    // settled nothing renders no requirements chapter at all — the honest shape.
    const nothingSettled = { ...FULL, decisions: [] };
    expect(project('srs', input(nothingSettled))).not.toContain('3. Specific requirements');
  });

  it('names the revision it was generated from', () => {
    expect(project('srs', input())).toContain('revision 2');
  });
});

describe('honesty appendices — rendered whenever there is something to admit', () => {
  it('renders still-open items even when the session reached `sufficient`', () => {
    // `sufficient` means every *required* dimension cleared the bar; items in
    // other dimensions can still be open, and hiding them would make the most
    // confident-looking document the least honest one.
    const srs = project('srs', input(FULL, { status: 'sufficient' }));

    expect(srs).toContain('Appendix A — Still open');
    expect(srs).toContain('how anyone would know this worked');
    expect(srs).toContain('blocking');
  });

  it('notes an exhausted budget in the header', () => {
    const srs = project('srs', input(FULL, { status: 'exhausted' }));
    expect(srs).toContain('budget was exhausted');
  });

  it('says something different when the loop stalled rather than ran out', () => {
    // The two early exits are actionable in opposite directions: one says raise
    // the budget, the other says the questions stopped landing and better input
    // is what is needed. Collapsing them into "incomplete" loses that.
    const srs = project('srs', input(FULL, { status: 'stalled' }));

    expect(srs).toContain('settled nothing new');
    expect(srs).toContain('better input, not more asking');
    expect(srs).not.toContain('budget was exhausted');
  });

  it('carries the same reason into the requirements document', () => {
    // Shared once in `appendices.ts` rather than written twice: two renderers
    // each growing their own version of the honesty is two places for it to
    // quietly diverge.
    const doc = project('requirements-doc', input(FULL, { status: 'stalled' }));
    expect(doc).toContain('settled nothing new');
  });

  it('renders unresolved contradictions and omits settled ones from that appendix', () => {
    const srs = project('srs', input());
    expect(srs).toContain('Appendix C — Unresolved contradictions');
    expect(srs).toContain('Retention stated as both 30 and 90 days');

    // A settled contradiction has been *promoted*, so it has left the array
    // entirely. There is no "resolved but still listed" state to test for —
    // deleting `Contradiction.resolution` is what removed it.
    const settled = { ...FULL, contradictions: [] };
    expect(project('srs', input(settled))).not.toContain('Appendix C');
  });

  it('lists sources with how they were derived', () => {
    const withAudio = {
      ...input(),
      sources: [source('src-1', { kind: 'audio', derivedBy: 'transcription' })],
    };

    const srs = project('srs', withAudio);
    expect(srs).toContain('Appendix B — Sources');
    expect(srs).toContain('audio, transcribed');
  });

  it('says plainly when nothing was captured', () => {
    const empty = project('srs', input({ product: {} }));
    expect(empty).toContain('Nothing has been captured yet');
  });
});

describe('requirements document', () => {
  it('groups by meaning and records what was asked', () => {
    const doc = project('requirements-doc', input());

    expect(doc).toContain('## The problem');
    expect(doc).toContain('## Who it serves');
    // Process provenance a reviewer wants and a builder does not.
    expect(doc).toContain('Appendix D — What was decided');
    expect(doc).toContain('settled by: ans-2');
  });

  it('frames assumptions as decisions someone should confirm', () => {
    expect(project('requirements-doc', input())).toContain('not stated by anyone');
  });

  it('renders the alternatives that were considered and not taken', () => {
    // The single most valuable thing an ADR provides, and the one Phase 6
    // recorded as unreachable: "why not X?" answered from a join rather than
    // from anything duplicated onto the Decision.
    const doc = project('requirements-doc', input());

    expect(doc).toContain('How should users sign in?');
    expect(doc).toContain('chose: SSO via Okta');
    expect(doc).toContain('considered and rejected: Magic links');
    expect(doc).toContain('every sign-in needs a working inbox');
    expect(doc).toContain('considered and rejected: Password plus TOTP');
  });

  it('records when its own recommendation was overridden', () => {
    // The most informative line in the trail: the product's judgement being
    // rejected is exactly what a reviewer should see, and what an anchoring
    // check counts.
    const doc = project('requirements-doc', input());
    expect(doc).toContain('we suggested Magic links; they chose otherwise');
  });

  it('names a source by its label rather than by its id', () => {
    // `settledBy` is an id, and an id is not an explanation.
    const doc = project('requirements-doc', input());
    expect(doc).toContain('settled by: src-1 notes (src-1)');
  });

  it('renders a custom answer as what it was, not as a missing selection', () => {
    // When someone writes their own answer the interesting fact is that none of
    // the offered options fitted — the rejected list is context for that.
    const doc = project(
      'requirements-doc',
      input(
        FULL,
        {},
        {
          answers: [
            Answer.parse({
              id: 'ans-1',
              questionId: 'qst-1',
              customText: 'We already run Entra ID, use that.',
              answeredAt: AT,
            }),
          ],
        },
      ),
    );

    expect(doc).toContain('answered in their own words: We already run Entra ID');
    expect(doc).toContain('considered and rejected: SSO via Okta');
  });

  it('drops a settledBy that names nothing rather than throwing', () => {
    // Same asymmetry the engine uses: an unknown reference in a delta must fail
    // the turn, but an unknown reference while rendering costs one absent
    // paragraph where throwing costs the whole document.
    const doc = project('requirements-doc', input(FULL, {}, { questions: [], answers: [] }));

    expect(doc).toContain('DEC-1');
    expect(doc).not.toContain('considered and rejected');
  });

  it('does not carry the process appendix into the SRS', () => {
    expect(project('srs', input())).not.toContain('What was decided, and what settled it');
  });
});

describe('agent prompt', () => {
  it('instructs the agent to stop rather than guess at something unsettled', () => {
    // The product's own thesis applied to its output: an agent guessing at an
    // unstated requirement is the failure Requirely exists to prevent.
    const prompt = project('agent-prompt', input());

    expect(prompt).toContain('STOP');
    expect(prompt).toContain('Do not guess');
    expect(prompt).toContain('how anyone would know this worked');
  });

  it('separates what to build from what to ask about', () => {
    // The settled/open split does more work for an agent than for a human: a
    // Decision is something to implement, an open item is something to raise.
    // One heading covering both is how a proposal gets built by mistake.
    const prompt = project('agent-prompt', input());
    const decided = prompt.indexOf('What was decided');
    const stop = prompt.indexOf('STOP');

    expect(decided).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(decided);
    expect(prompt.slice(decided, stop)).toContain('Users sign in via SSO');
    expect(prompt.slice(decided, stop)).not.toContain('how anyone would know this worked');
  });

  it('states assumptions as inherited decisions, not background', () => {
    const prompt = project('agent-prompt', input());
    expect(prompt).toContain('Assumptions made on your behalf');
    expect(prompt).toContain('decision you are inheriting');
  });

  it('drops citations, which an agent cannot follow', () => {
    const prompt = project('agent-prompt', input());
    expect(prompt).toContain('Users sign in via SSO');
    expect(prompt).not.toContain('[src-1]');
  });

  it('tells the agent what was rejected, because that is the solution space closing', () => {
    // A departure from "drop anything an agent cannot act on": a rejected option
    // is precisely actionable. An agent re-proposing magic links costs a review
    // cycle to rediscover something already written down.
    const prompt = project('agent-prompt', input());

    expect(prompt).toContain('Already considered and rejected');
    expect(prompt).toContain('Magic links');
    expect(prompt).toContain('Do not propose them again');
    // Compact: the closed door, not the deliberation around it.
    expect(prompt).not.toContain('we suggested');
  });

  it('omits that section entirely when nothing was rejected', () => {
    const prompt = project('agent-prompt', input(FULL, {}, { questions: [], answers: [] }));
    expect(prompt).not.toContain('Already considered and rejected');
  });

  it('still warns against inventing requirements when nothing is outstanding', () => {
    const closed = { ...FULL, requirements: [], assumptions: [], contradictions: [] };
    const prompt = project('agent-prompt', input(closed));

    expect(prompt).not.toContain('STOP');
    expect(prompt).toContain('that is something the gathering missed');
  });
});

describe('finalizeSession', () => {
  const ctx = { clock: fixedClock('2026-02-01T00:00:00.000Z') };

  it('records the target and marks the session finalized', () => {
    const finalized = finalizeSession(session({ status: 'sufficient' }), 'srs', ctx);

    expect(finalized.status).toBe('finalized');
    expect(finalized.outputTarget).toBe('srs');
    expect(finalized.updatedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('finalizes an exhausted session too — the document just states what is open', () => {
    expect(finalizeSession(session({ status: 'exhausted' }), 'srs', ctx).status).toBe('finalized');
  });

  it('finalizes a stalled session, which also carries a recorded verdict', () => {
    // The one rule `finalized` enforces is "you cannot finalize what you have
    // not assessed". A stalled session was assessed; it just stopped moving.
    expect(finalizeSession(session({ status: 'stalled' }), 'srs', ctx).status).toBe('finalized');
  });

  it('refuses to finalize what was never assessed', () => {
    expect(() => finalizeSession(session({ status: 'gathering' }), 'srs', ctx)).toThrow(
      SessionStateError,
    );
  });
});
