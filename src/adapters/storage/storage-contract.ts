import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Answer,
  AnswerId,
  type InquiryRepository,
  type Question,
  QuestionId,
  Session,
  type SessionRepository,
  Source,
  SourceId,
  type SourceRepository,
  type Turn,
  TurnCommit,
  type TurnCommitter,
  type UnderstandingRepository,
} from '../../domain/index.ts';

/**
 * One contract, two implementations.
 *
 * The in-memory adapter and the Postgres adapter are checked against this same
 * suite. Two implementations with separate tests drift — one grows an upsert
 * where the other has an insert, one sorts and the other doesn't — and the
 * divergence is discovered when a test that passed in memory fails in
 * production. One suite makes that impossible to miss.
 *
 * Not a `.test.ts` file, so vitest does not collect it directly; the two
 * adapter test files call `describeStorageContract` with their own setup.
 */

export interface StoresUnderTest {
  readonly sessions: SessionRepository;
  readonly sources: SourceRepository;
  readonly understanding: UnderstandingRepository;
  readonly inquiry: InquiryRepository;
  readonly committer: TurnCommitter;
}

export interface ContractHarness {
  readonly stores: StoresUnderTest;
  close?(): Promise<void>;
}

const AT = '2026-01-01T00:00:00.000Z';

// Lookups take branded ids; parsing here is the single point where a literal
// becomes a trusted identifier.
const sourceId = (value: string) => SourceId.parse(value);
const questionId = (value: string) => QuestionId.parse(value);
const answerId = (value: string) => AnswerId.parse(value);

export const fixtures = {
  session: (overrides: Record<string, unknown> = {}): Session =>
    Session.parse({
      id: 'ses_1',
      title: 'Requirely',
      status: 'gathering',
      questionBudget: 12,
      questionsAsked: 0,
      createdAt: AT,
      updatedAt: AT,
      ...overrides,
    }),

  source: (overrides: Record<string, unknown> = {}): Source =>
    Source.parse({
      id: 'src_1',
      sessionId: 'ses_1',
      kind: 'audio',
      status: 'normalized',
      derivedBy: 'transcription',
      origin: { label: 'kickoff.m4a', mediaType: 'audio/mp4' },
      normalizedText: 'We need SSO.',
      segments: [{ text: 'We need SSO.', startMs: 0, endMs: 1500, speakerLabel: 'Client' }],
      ingestedAt: AT,
      ...overrides,
    }),

  /** A complete, internally consistent turn — the checks in TurnCommit enforce that. */
  commit: (overrides: { index?: number; sessionStatus?: string } = {}): TurnCommit => {
    const index = overrides.index ?? 0;
    const revisionId = `rev_${index + 1}`;
    const turnId = `trn_${index + 1}`;

    return TurnCommit.parse({
      session: fixtures.session({
        status: overrides.sessionStatus ?? 'awaiting-answers',
        currentRevisionId: revisionId,
        questionsAsked: 1,
      }),
      revision: {
        id: revisionId,
        sessionId: 'ses_1',
        revision: index,
        producedByTurnId: turnId,
        createdAt: AT,
        content: {
          product: { name: 'Requirely' },
          requirements: [
            {
              id: 'req_1',
              statement: 'Users sign in via SSO',
              kind: 'functional',
              provenance: [{ sourceId: 'src_1', quote: 'We need SSO.' }],
            },
          ],
          gaps: [
            {
              id: 'gap_1',
              dimension: 'acceptance',
              topic: 'done criteria',
              description: 'unknown',
              blocking: false,
              impact: 'high',
            },
          ],
        },
      },
      turn: {
        id: turnId,
        sessionId: 'ses_1',
        index,
        trigger: 'initial',
        inputSourceIds: ['src_1'],
        inputAnswerIds: [],
        understandingBefore: index === 0 ? null : `rev_${index}`,
        understandingAfter: revisionId,
        verdict: {
          sufficient: false,
          rationale: 'Not yet sufficient: coverage below the 0.70 bar for: acceptance (0.20).',
          coverage: [{ dimension: 'acceptance', score: 0.2, rationale: 'nothing stated' }],
          shortfalls: ['acceptance'],
          blockingGapIds: [],
          questionsAsked: 0,
          questionBudget: 12,
          budgetExhausted: false,
        },
        usage: [
          {
            operation: 'analyze',
            provider: 'fake',
            model: 'fake-1',
            inputTokens: 100,
            outputTokens: 20,
          },
        ],
        startedAt: AT,
        completedAt: AT,
      },
      questions: [
        {
          id: `qst_${index + 1}`,
          sessionId: 'ses_1',
          turnId,
          gapId: 'gap_1',
          text: 'How would you know this worked?',
          mode: 'single',
          options: [
            { id: `opt_${index * 2 + 1}`, label: 'A buildable spec' },
            { id: `opt_${index * 2 + 2}`, label: 'Fewer clarifications', elaboration: 'Measured.' },
          ],
          askedAt: AT,
        },
      ],
      answers: [],
    });
  },
};

export function describeStorageContract(name: string, setup: () => Promise<ContractHarness>): void {
  describe(`storage contract: ${name}`, () => {
    let harness: ContractHarness;
    let stores: StoresUnderTest;

    beforeEach(async () => {
      harness = await setup();
      stores = harness.stores;
    });

    afterAll(async () => {
      await harness?.close?.();
    });

    describe('sessions', () => {
      it('round-trips a session byte-identically', async () => {
        const session = fixtures.session();
        await stores.sessions.create(session);

        expect(await stores.sessions.findById(session.id)).toEqual(session);
      });

      it('returns null for an unknown id rather than throwing', async () => {
        expect(await stores.sessions.findById(fixtures.session().id)).toBeNull();
      });

      it('save overwrites an existing session', async () => {
        const session = fixtures.session();
        await stores.sessions.create(session);

        const updated = { ...session, status: 'sufficient' as const, questionsAsked: 4 };
        await stores.sessions.save(updated);

        expect(await stores.sessions.findById(session.id)).toEqual(updated);
      });

      it('save inserts when the session does not exist yet', async () => {
        // Both adapters upsert. Pinning it here is what stopped the Postgres
        // implementation from being an UPDATE while the in-memory one was a set.
        const session = fixtures.session();
        await stores.sessions.save(session);

        expect(await stores.sessions.findById(session.id)).toEqual(session);
      });

      it('preserves an explicitly null output target', async () => {
        const session = fixtures.session({ outputTarget: null, title: null });
        await stores.sessions.create(session);

        const found = await stores.sessions.findById(session.id);
        expect(found?.outputTarget).toBeNull();
        expect(found?.title).toBeNull();
      });
    });

    describe('sources', () => {
      beforeEach(async () => {
        await stores.sessions.create(fixtures.session());
      });

      it('round-trips a source including nested transcript segments', async () => {
        const source = fixtures.source();
        await stores.sources.add(source);

        expect(await stores.sources.findById(source.id)).toEqual(source);
      });

      it('preserves a null segments array distinctly from an empty one', async () => {
        await stores.sources.add(fixtures.source({ id: 'src_1', segments: null }));
        await stores.sources.add(fixtures.source({ id: 'src_2', segments: [] }));

        expect((await stores.sources.findById(sourceId('src_1')))?.segments).toBeNull();
        expect((await stores.sources.findById(sourceId('src_2')))?.segments).toEqual([]);
      });

      it('lists only the sources of the requested session', async () => {
        await stores.sessions.create(fixtures.session({ id: 'ses_2' }));
        await stores.sources.add(fixtures.source({ id: 'src_1' }));
        await stores.sources.add(fixtures.source({ id: 'src_2', sessionId: 'ses_2' }));

        const listed = await stores.sources.listBySession(fixtures.session().id);
        expect(listed.map((s) => s.id)).toEqual(['src_1']);
      });
    });

    describe('committing a turn', () => {
      beforeEach(async () => {
        await stores.sessions.create(fixtures.session());
        await stores.sources.add(fixtures.source());
      });

      it('writes revision, turn, questions and session together', async () => {
        const commit = fixtures.commit();
        await stores.committer.commit(commit);

        expect(await stores.understanding.findById(commit.revision.id)).toEqual(commit.revision);
        expect(await stores.sessions.findById(commit.session.id)).toEqual(commit.session);

        const turns = await stores.sessions.listTurns(commit.session.id);
        expect(turns).toEqual([commit.turn]);

        const question = commit.questions[0];
        expect(await stores.inquiry.findQuestion(questionId('qst_1'))).toEqual(question);
      });

      it('round-trips the understanding content through JSONB unchanged', async () => {
        const commit = fixtures.commit();
        await stores.committer.commit(commit);

        const stored = await stores.understanding.findById(commit.revision.id);
        expect(stored?.content).toEqual(commit.revision.content);
        // Provenance is the field most likely to be quietly dropped.
        expect(stored?.content.requirements[0]?.provenance).toEqual([
          { sourceId: 'src_1', quote: 'We need SSO.', note: null },
        ]);
      });

      it('rejects an internally inconsistent command before writing anything', async () => {
        const commit = fixtures.commit();
        const broken = {
          ...commit,
          turn: { ...commit.turn, understandingAfter: 'rev_999' },
        };

        await expect(stores.committer.commit(broken as TurnCommit)).rejects.toThrow();
        expect(await stores.understanding.findById(commit.revision.id)).toBeNull();
        expect(await stores.sessions.listTurns(commit.session.id)).toEqual([]);
      });

      it('leaves nothing behind when a commit fails partway', async () => {
        const first = fixtures.commit({ index: 0 });
        await stores.committer.commit(first);

        // Same revision id and turn id, but a new question. The unique keys
        // reject it — and the question must not survive the failure.
        const clashing = TurnCommit.parse({
          ...first,
          questions: [{ ...first.questions[0], id: 'qst_ghost' }],
        });

        await expect(stores.committer.commit(clashing)).rejects.toThrow();
        expect(await stores.inquiry.findQuestion(questionId('qst_ghost'))).toBeNull();
        expect(await stores.sessions.listTurns(first.session.id)).toHaveLength(1);
      });

      it('orders revisions and turns by their sequence, and finds the latest', async () => {
        await stores.committer.commit(fixtures.commit({ index: 0 }));
        await stores.committer.commit(fixtures.commit({ index: 1 }));

        const revisions = await stores.understanding.listBySession(fixtures.session().id);
        expect(revisions.map((r) => r.revision)).toEqual([0, 1]);
        expect((await stores.understanding.findLatest(fixtures.session().id))?.revision).toBe(1);

        const turns: readonly Turn[] = await stores.sessions.listTurns(fixtures.session().id);
        expect(turns.map((t) => t.index)).toEqual([0, 1]);
      });
    });

    describe('questions and answers', () => {
      beforeEach(async () => {
        await stores.sessions.create(fixtures.session());
        await stores.sources.add(fixtures.source());
        await stores.committer.commit(fixtures.commit());
      });

      it('reports a question as unanswered until an answer exists', async () => {
        expect(await stores.inquiry.listUnansweredQuestions(fixtures.session().id)).toHaveLength(1);

        const answer = Answer.parse({
          id: 'ans_1',
          questionId: 'qst_1',
          selectedOptionIds: ['opt_1'],
          answeredAt: AT,
        });
        await stores.committer.commit(
          TurnCommit.parse({
            ...fixtures.commit({ index: 1 }),
            questions: [],
            answers: [answer],
            turn: { ...fixtures.commit({ index: 1 }).turn, inputAnswerIds: ['ans_1'] },
          }),
        );

        expect(await stores.inquiry.listUnansweredQuestions(fixtures.session().id)).toEqual([]);
        expect(await stores.inquiry.findAnswer(answerId('ans_1'))).toEqual(answer);
      });

      it('lists answers belonging to the session', async () => {
        const answer = Answer.parse({
          id: 'ans_1',
          questionId: 'qst_1',
          customText: 'Something else entirely',
          answeredAt: AT,
        });
        await stores.committer.commit(
          TurnCommit.parse({
            ...fixtures.commit({ index: 1 }),
            questions: [],
            answers: [answer],
            turn: { ...fixtures.commit({ index: 1 }).turn, inputAnswerIds: ['ans_1'] },
          }),
        );

        const listed = await stores.inquiry.listAnswers(fixtures.session().id);
        expect(listed).toEqual([answer]);
      });

      it('reconstructs allowsCustom rather than trusting storage for an invariant', async () => {
        const question: Question | null = await stores.inquiry.findQuestion(questionId('qst_1'));
        expect(question?.allowsCustom).toBe(true);
      });
    });
  });
}
