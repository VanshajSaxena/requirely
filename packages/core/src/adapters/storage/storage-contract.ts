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
      id: 'ses-1',
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
      id: 'src-1',
      sessionId: 'ses-1',
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
    const revisionId = `rev-${index + 1}`;
    const turnId = `trn-${index + 1}`;

    return TurnCommit.parse({
      session: fixtures.session({
        status: overrides.sessionStatus ?? 'awaiting-answers',
        currentRevisionId: revisionId,
        questionsAsked: 1,
      }),
      revision: {
        id: revisionId,
        sessionId: 'ses-1',
        revision: index,
        producedByTurnId: turnId,
        createdAt: AT,
        content: {
          product: { name: 'Requirely' },
          // One of each tier, so the JSONB round-trip covers both the settled
          // shape (which carries `settledBy` and `promotedFrom`) and the open one.
          decisions: [
            {
              id: 'dec-1',
              statement: 'Sign-in is SSO via Okta',
              kind: 'functional',
              dimension: 'core-behaviour',
              rationale: 'The only identity provider the org already runs.',
              promotedFrom: 'req-2',
              settledBy: 'src-1',
            },
          ],
          requirements: [
            {
              id: 'req-1',
              statement: 'Users sign in via SSO',
              kind: 'functional',
              dimension: 'core-behaviour',
              provenance: [{ sourceId: 'src-1', quote: 'We need SSO.' }],
            },
          ],
        },
      },
      turn: {
        id: turnId,
        sessionId: 'ses-1',
        index,
        trigger: 'initial',
        inputSourceIds: ['src-1'],
        inputAnswerIds: [],
        understandingBefore: index === 0 ? null : `rev-${index}`,
        understandingAfter: revisionId,
        verdict: {
          sufficient: false,
          rationale:
            'Not yet sufficient (1 settled, 1 still open): nothing settled yet for: acceptance.',
          settled: {
            decisions: 1,
            superseded: 0,
            open: 1,
            ratio: 0.5,
            dimensions: ['core-behaviour'],
          },
          coverage: [{ dimension: 'acceptance', score: 0.2, rationale: 'nothing stated' }],
          shortfalls: ['acceptance'],
          blockingItemIds: [],
          questionsAsked: 0,
          questionBudget: 12,
          budgetExhausted: false,
          turnsWithoutProgress: 0,
          stalled: false,
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
          id: `qst-${index + 1}`,
          sessionId: 'ses-1',
          turnId,
          dimension: 'acceptance',
          about: 'req-1',
          text: 'How would you know this worked?',
          rationale: 'Nothing states a success condition.',
          mode: 'single',
          // A recommendation with its reasoning, so the storage round-trip covers
          // the fields a UI would withhold rather than only the neutral ones.
          recommends: `opt-${index * 2 + 1}`,
          because: 'It measures the output rather than the process.',
          options: [
            {
              id: `opt-${index * 2 + 1}`,
              label: 'A buildable spec',
              commits: 'The document has to stand alone.',
              settles: ['req-1'],
            },
            {
              id: `opt-${index * 2 + 2}`,
              label: 'Fewer clarifications',
              elaboration: 'Measured.',
              commits: 'Success depends on the team, not the spec.',
            },
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

      it('round-trips a temperament that is not the default one', async () => {
        // **Every dial is deliberately off 0.5.** A round-trip on the default
        // vector would pass with the column dropped entirely, because the domain
        // schema fills the same numbers back in on read — the vacuous pass this
        // repo has already been bitten by once, when a renamed field left a test
        // parsing the old key into nothing.
        const temperament = {
          creativity: 0.9,
          assertiveness: 0.2,
          technicality: 0.15,
          thoroughness: 0.75,
          curiosity: 1,
        };
        const session = fixtures.session({ temperament });
        await stores.sessions.create(session);

        expect((await stores.sessions.findById(session.id))?.temperament).toEqual(temperament);
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

        expect(await stores.sources.findById(source.sessionId, source.id)).toEqual(source);
      });

      it('preserves a null segments array distinctly from an empty one', async () => {
        await stores.sources.add(fixtures.source({ id: 'src-1', segments: null }));
        await stores.sources.add(fixtures.source({ id: 'src-2', segments: [] }));

        expect(
          (await stores.sources.findById(fixtures.session().id, sourceId('src-1')))?.segments,
        ).toBeNull();
        expect(
          (await stores.sources.findById(fixtures.session().id, sourceId('src-2')))?.segments,
        ).toEqual([]);
      });

      it('removes a source, and removing a missing one is not an error', async () => {
        // The only caller is ingestion cleaning up a `pending` row whose
        // transcription failed, so idempotence matters: cleanup must not itself
        // throw and mask the real failure.
        await stores.sources.add(fixtures.source());
        await stores.sources.remove(fixtures.session().id, sourceId('src-1'));

        expect(await stores.sources.findById(fixtures.session().id, sourceId('src-1'))).toBeNull();
        await expect(
          stores.sources.remove(fixtures.session().id, sourceId('src-1')),
        ).resolves.toBeUndefined();
      });

      it('lists only the sources of the requested session', async () => {
        await stores.sessions.create(fixtures.session({ id: 'ses-2' }));
        await stores.sources.add(fixtures.source({ id: 'src-1' }));
        await stores.sources.add(fixtures.source({ id: 'src-2', sessionId: 'ses-2' }));

        const listed = await stores.sources.listBySession(fixtures.session().id);
        expect(listed.map((s) => s.id)).toEqual(['src-1']);
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
        expect(await stores.inquiry.findQuestion(questionId('qst-1'))).toEqual(question);
      });

      it('records the temperament the turn ran under', async () => {
        // The audit claim in `Turn.temperament`: a session whose dials were
        // changed later must not rewrite what earlier turns actually ran under.
        const temperament = {
          creativity: 0.9,
          assertiveness: 0.2,
          technicality: 0.15,
          thoroughness: 0.75,
          curiosity: 1,
        };
        const base = fixtures.commit();
        const commit = {
          ...base,
          session: { ...base.session, temperament },
          turn: { ...base.turn, temperament },
        };
        await stores.committer.commit(commit);

        const [turn] = await stores.sessions.listTurns(commit.session.id);
        expect(turn?.temperament).toEqual(temperament);
      });

      it('round-trips the understanding content through JSONB unchanged', async () => {
        const commit = fixtures.commit();
        await stores.committer.commit(commit);

        const stored = await stores.understanding.findById(commit.revision.id);
        expect(stored?.content).toEqual(commit.revision.content);
        // Provenance is the field most likely to be quietly dropped.
        expect(stored?.content.requirements[0]?.provenance).toEqual([
          { sourceId: 'src-1', quote: 'We need SSO.', note: null },
        ]);
      });

      it('rejects an internally inconsistent command before writing anything', async () => {
        const commit = fixtures.commit();
        const broken = {
          ...commit,
          turn: { ...commit.turn, understandingAfter: 'rev-999' },
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
          questions: [{ ...first.questions[0], id: 'qst-ghost' }],
        });

        await expect(stores.committer.commit(clashing)).rejects.toThrow();
        expect(await stores.inquiry.findQuestion(questionId('qst-ghost'))).toBeNull();
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

      it('lists sessions most recently touched first', async () => {
        // Ordered by activity, not creation: a long-running session must not
        // sink below one started after it and abandoned. This is also the query
        // the Phase 3a `text` → `timestamptz` correction was measured on.
        const older = fixtures.session({ id: 'ses-older', updatedAt: '2026-01-01T00:00:00.000Z' });
        const newer = fixtures.session({ id: 'ses-newer', updatedAt: '2026-06-01T00:00:00.000Z' });
        await stores.sessions.create(older);
        await stores.sessions.create(newer);

        const recent = await stores.sessions.listRecent(10);
        const ours = recent.filter((s) => s.id === 'ses-older' || s.id === 'ses-newer');
        expect(ours.map((s) => s.id)).toEqual(['ses-newer', 'ses-older']);
      });

      it('honours the limit', async () => {
        await stores.sessions.create(fixtures.session({ id: 'ses-2' }));
        expect(await stores.sessions.listRecent(1)).toHaveLength(1);
      });

      it('lists every question, answered or not', async () => {
        // `listUnansweredQuestions` exists to drive the *next* prompt and so
        // excludes exactly the set a projection needs: an answered question is
        // what a Decision's audit trail is made of.
        const sessionId = fixtures.session().id;
        await stores.committer.commit(
          TurnCommit.parse({
            ...fixtures.commit({ index: 1 }),
            questions: [],
            answers: [
              Answer.parse({
                id: 'ans-1',
                questionId: 'qst-1',
                selectedOptionIds: ['opt-1'],
                answeredAt: AT,
              }),
            ],
            turn: { ...fixtures.commit({ index: 1 }).turn, inputAnswerIds: ['ans-1'] },
          }),
        );

        expect(await stores.inquiry.listUnansweredQuestions(sessionId)).toHaveLength(0);
        const all = await stores.inquiry.listQuestions(sessionId);
        expect(all.map((question) => question.id)).toEqual(['qst-1']);
        // The reasoning fields survive the round-trip: they are what the trail
        // is rendered from, and they are the ones a UI may withhold.
        expect(all[0]?.recommends).toBe('opt-1');
        expect(all[0]?.because).toBe('It measures the output rather than the process.');
        expect(all[0]?.options[0]?.commits).toBe('The document has to stand alone.');
        expect(all[0]?.options[0]?.settles).toEqual(['req-1']);
      });

      it('reports a question as unanswered until an answer exists', async () => {
        expect(await stores.inquiry.listUnansweredQuestions(fixtures.session().id)).toHaveLength(1);

        const answer = Answer.parse({
          id: 'ans-1',
          questionId: 'qst-1',
          selectedOptionIds: ['opt-1'],
          answeredAt: AT,
        });
        await stores.committer.commit(
          TurnCommit.parse({
            ...fixtures.commit({ index: 1 }),
            questions: [],
            answers: [answer],
            turn: { ...fixtures.commit({ index: 1 }).turn, inputAnswerIds: ['ans-1'] },
          }),
        );

        expect(await stores.inquiry.listUnansweredQuestions(fixtures.session().id)).toEqual([]);
        expect(await stores.inquiry.findAnswer(answerId('ans-1'))).toEqual(answer);
      });

      it('lists answers belonging to the session', async () => {
        const answer = Answer.parse({
          id: 'ans-1',
          questionId: 'qst-1',
          customText: 'Something else entirely',
          answeredAt: AT,
        });
        await stores.committer.commit(
          TurnCommit.parse({
            ...fixtures.commit({ index: 1 }),
            questions: [],
            answers: [answer],
            turn: { ...fixtures.commit({ index: 1 }).turn, inputAnswerIds: ['ans-1'] },
          }),
        );

        const listed = await stores.inquiry.listAnswers(fixtures.session().id);
        expect(listed).toEqual([answer]);
      });

      it('reconstructs allowsCustom rather than trusting storage for an invariant', async () => {
        const question: Question | null = await stores.inquiry.findQuestion(questionId('qst-1'));
        expect(question?.allowsCustom).toBe(true);
      });
    });
  });
}
