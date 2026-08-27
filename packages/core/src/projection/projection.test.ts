import { describe, expect, it } from 'vitest';
import {
  finalizeSession,
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
  requirements: [
    {
      id: 'req-1',
      statement: 'Users sign in via SSO',
      kind: 'functional',
      priority: 'must',
      provenance: [{ sourceId: 'src-1' }],
    },
    { id: 'req-2', statement: 'p95 under 200ms', kind: 'non-functional' },
    { id: 'req-3', statement: 'A spec builds unaided', kind: 'acceptance' },
  ],
  constraints: [{ id: 'con-1', statement: 'Must run on-premise', category: 'technical' }],
  assumptions: [
    { id: 'asm-1', statement: 'English only at launch', basis: 'no locale mentioned', risk: 'low' },
  ],
  contradictions: [
    {
      id: 'ctr-1',
      description: 'Retention stated as both 30 and 90 days',
      between: [{ sourceId: 'src-1' }, { sourceId: 'src-2' }],
    },
  ],
  gaps: [
    {
      id: 'gap-3',
      dimension: 'acceptance',
      topic: 'done criteria',
      description: 'Nothing states how anyone would know this worked.',
      blocking: true,
      impact: 'high',
    },
  ],
  resolvedGaps: [
    {
      id: 'gap-1',
      dimension: 'users',
      topic: 'audience',
      description: 'unknown',
      blocking: false,
      impact: 'medium',
      resolution: 'Product managers and founders.',
    },
  ],
};

const input = (content: Record<string, unknown> = FULL, sessionOverrides = {}) => ({
  session: session(sessionOverrides),
  revision: revision(content),
  sources: [source('src-1'), source('src-2')],
});

describe('labels — the Phase 3b payoff', () => {
  it('uses the stored id as the citation number, with no mapping table', () => {
    const srs = project('srs', input());

    expect(srs).toContain('**REQ-1**');
    expect(srs).toContain('**CON-1**');
    expect(srs).toContain('**ASM-1**');
    expect(srs).toContain('**GAP-3**');
  });
});

describe('citations', () => {
  it('cites the source reference and never a quote', () => {
    // `Provenance.quote` is unverified (WEAKNESSES.md #1); rendering it in a
    // specification would make a fabrication look authoritative.
    const withQuote = {
      ...FULL,
      requirements: [
        {
          id: 'req-1',
          statement: 'Users sign in via SSO',
          kind: 'functional',
          provenance: [{ sourceId: 'src-1', quote: 'we use Okta' }],
        },
      ],
    };
    const srs = project('srs', input(withQuote));

    expect(srs).toContain('[src-1]');
    expect(srs).not.toContain('we use Okta');
  });

  it('drops a citation naming a source that does not exist, rather than throwing', () => {
    const ghost = {
      ...FULL,
      requirements: [
        {
          id: 'req-1',
          statement: 'Users sign in via SSO',
          kind: 'functional',
          provenance: [{ sourceId: 'src-99' }],
        },
      ],
    };

    const srs = project('srs', input(ghost));
    expect(srs).toContain('REQ-1');
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
    const thin = { ...FULL, constraints: [], assumptions: [], product: { name: 'X' } };
    const srs = project('srs', input(thin));

    expect(srs).not.toContain('2.4 Constraints');
    expect(srs).not.toContain('2.5 Assumptions');
    expect(srs).not.toContain('1.1 Purpose');
  });

  it('omits a parent heading when every child section is empty', () => {
    const noRequirements = { ...FULL, requirements: [] };
    expect(project('srs', input(noRequirements))).not.toContain('3. Specific requirements');
  });

  it('names the revision it was generated from', () => {
    expect(project('srs', input())).toContain('revision 2');
  });
});

describe('honesty appendices — rendered whenever there is something to admit', () => {
  it('renders open gaps even when the session reached `sufficient`', () => {
    // `sufficient` means every *required* dimension cleared the bar; gaps in
    // other dimensions can still be open, and hiding them would make the most
    // confident-looking document the least honest one.
    const srs = project('srs', input(FULL, { status: 'sufficient' }));

    expect(srs).toContain('Appendix A — Known gaps');
    expect(srs).toContain('done criteria');
    expect(srs).toContain('blocking');
  });

  it('notes an exhausted budget in the header', () => {
    const srs = project('srs', input(FULL, { status: 'exhausted' }));
    expect(srs).toContain('budget was exhausted');
  });

  it('renders unresolved contradictions and omits settled ones from that appendix', () => {
    const srs = project('srs', input());
    expect(srs).toContain('Appendix C — Unresolved contradictions');
    expect(srs).toContain('Retention stated as both 30 and 90 days');

    const settled = {
      ...FULL,
      contradictions: [{ ...FULL.contradictions[0], resolution: '30 days, confirmed' }],
    };
    expect(project('srs', input(settled))).not.toContain('Appendix C');
  });

  it('lists sources with how they were derived', () => {
    const withAudio = {
      session: session(),
      revision: revision(FULL),
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
    expect(doc).toContain('Appendix D — What was asked');
    expect(doc).toContain('Product managers and founders.');
  });

  it('frames assumptions as decisions someone should confirm', () => {
    expect(project('requirements-doc', input())).toContain('not stated by anyone');
  });

  it('does not carry the process appendix into the SRS', () => {
    expect(project('srs', input())).not.toContain('What was asked');
  });
});

describe('agent prompt', () => {
  it('instructs the agent to stop rather than guess at an open gap', () => {
    // The product's own thesis applied to its output: an agent guessing at an
    // unstated requirement is the failure Requirely exists to prevent.
    const prompt = project('agent-prompt', input());

    expect(prompt).toContain('STOP');
    expect(prompt).toContain('Do not guess');
    expect(prompt).toContain('done criteria');
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

  it('still warns against inventing requirements when nothing is outstanding', () => {
    const closed = { ...FULL, gaps: [], contradictions: [] };
    const prompt = project('agent-prompt', input(closed));

    expect(prompt).not.toContain('STOP');
    expect(prompt).toContain('that is a gap that was missed');
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

  it('finalizes an exhausted session too — the document just states its gaps', () => {
    expect(finalizeSession(session({ status: 'exhausted' }), 'srs', ctx).status).toBe('finalized');
  });

  it('refuses to finalize what was never assessed', () => {
    expect(() => finalizeSession(session({ status: 'gathering' }), 'srs', ctx)).toThrow(
      SessionStateError,
    );
  });
});
