import { describe, expect, it } from 'vitest';
import { inMemoryStores } from '../adapters/storage/memory.ts';
import { fakeTranscriber } from '../adapters/transcription/fake.ts';
import { type DocumentExtractor, SessionId, SourceId } from '../domain/index.ts';
import { fixedClock } from '../domain/testing/fakes.ts';
import { createIngestionService, IngestionError } from './service.ts';

const sessionId = SessionId.parse('ses-1');
const bytes = new Uint8Array([1, 2, 3]);

const extractorReturning = (text: string): DocumentExtractor => ({
  supports: (mediaType) => mediaType === 'application/pdf',
  extract: async () => ({ text, pageCount: 1 }),
});

const throwingExtractor = (message: string): DocumentExtractor => ({
  supports: () => true,
  extract: async () => {
    throw new Error(message);
  },
});

type ServiceDeps = Parameters<typeof createIngestionService>[0];

const harness = (overrides: Partial<ServiceDeps> = {}) => {
  const stores = inMemoryStores();
  const service = createIngestionService({
    sources: stores.sources,
    clock: fixedClock('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });
  return { stores, service };
};

describe('ordinals — the gap this service closes', () => {
  it('assigns src-1, src-2, … without the caller supplying anything', async () => {
    const { service } = harness();

    const first = await service.ingestText({ sessionId, label: 'a.md', text: 'one' });
    const second = await service.ingestText({ sessionId, label: 'b.md', text: 'two' });

    expect(first.id).toBe('src-1');
    expect(second.id).toBe('src-2');
  });

  it('counts per session, so two sessions both start at src-1', async () => {
    const { service } = harness();
    const other = SessionId.parse('ses-2');

    await service.ingestText({ sessionId, label: 'a.md', text: 'one' });
    const elsewhere = await service.ingestText({ sessionId: other, label: 'b.md', text: 'two' });

    expect(elsewhere.id).toBe('src-1');
  });
});

describe('documents', () => {
  it('extracts before persisting, and stores only the text', async () => {
    const { service, stores } = harness({ extractor: extractorReturning('Extracted body') });

    const source = await service.ingestDocument({ sessionId, label: 'spec.pdf', bytes });

    expect(source.normalizedText).toBe('Extracted body');
    expect(source.kind).toBe('document');
    expect(source.derivedBy).toBe('extraction');
    expect(source.origin.mediaType).toBe('application/pdf');
    expect(await stores.sources.listBySession(sessionId)).toHaveLength(1);
  });

  it('leaves no row behind when extraction fails', async () => {
    const { service, stores } = harness({ extractor: throwingExtractor('encrypted') });

    await expect(service.ingestDocument({ sessionId, label: 'locked.pdf', bytes })).rejects.toThrow(
      IngestionError,
    );
    expect(await stores.sources.listBySession(sessionId)).toEqual([]);
  });

  it('rejects a document that yielded no text rather than storing an empty source', async () => {
    // A scanned PDF is images. Storing it would spend a turn discovering that.
    const { service, stores } = harness({ extractor: extractorReturning('   \n  ') });

    await expect(service.ingestDocument({ sessionId, label: 'scan.pdf', bytes })).rejects.toThrow(
      /is it a scan/,
    );
    expect(await stores.sources.listBySession(sessionId)).toEqual([]);
  });

  it('refuses a media type no extractor handles', async () => {
    const { service } = harness({ extractor: extractorReturning('x') });

    await expect(service.ingestDocument({ sessionId, label: 'sheet.xlsx', bytes })).rejects.toThrow(
      /no extractor handles/,
    );
  });
});

describe('audio — the pending seam', () => {
  it('persists the source as pending *while* transcription is still running', async () => {
    // The whole point of the chosen design: the in-flight state is real and
    // observable, so moving transcription to a job queue later changes the
    // runner, not the model.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const transcriber = fakeTranscriber({ text: 'we need SSO', waitFor: blocked });
    const { service, stores } = harness({ transcriber });

    const inFlight = service.ingestAudio({ sessionId, label: 'kickoff.m4a', bytes });
    // Deterministic: transcription has begun, so the pending row is written.
    await transcriber.started;

    const midway = await stores.sources.findById(sessionId, SourceId.parse('src-1'));
    expect(midway?.status).toBe('pending');
    expect(midway?.normalizedText).toBeNull();

    release();
    const finished = await inFlight;
    expect(finished.status).toBe('normalized');
    expect(finished.normalizedText).toBe('we need SSO');
    expect(finished.derivedBy).toBe('transcription');
  });

  it('carries diarized segments through when a provider supplies them', async () => {
    const { service } = harness({
      transcriber: fakeTranscriber({
        text: 'hello',
        segments: [{ text: 'hello', startMs: 0, endMs: 900 }],
      }),
    });

    const source = await service.ingestAudio({ sessionId, label: 'a.mp3', bytes });
    expect(source.segments).toEqual([
      { text: 'hello', startMs: 0, endMs: 900, speakerLabel: null },
    ]);
  });

  it('deletes the pending row when transcription fails, leaving no trace', async () => {
    // A pending row is an in-flight marker, not a failure record.
    const { service, stores } = harness({
      transcriber: fakeTranscriber({ failWith: 'unsupported codec' }),
    });

    await expect(service.ingestAudio({ sessionId, label: 'bad.wav', bytes })).rejects.toThrow(
      IngestionError,
    );
    expect(await stores.sources.listBySession(sessionId)).toEqual([]);
  });

  it('reuses the ordinal after a failed ingest, which is safe because nothing could cite it', async () => {
    const failing = harness({ transcriber: fakeTranscriber({ failWith: 'boom' }) });
    await expect(
      failing.service.ingestAudio({ sessionId, label: 'bad.wav', bytes }),
    ).rejects.toThrow();

    const next = await failing.service.ingestText({ sessionId, label: 'notes.md', text: 'ok' });
    expect(next.id).toBe('src-1');
  });

  it('refuses audio when no transcriber is configured', async () => {
    const { service } = harness();
    await expect(service.ingestAudio({ sessionId, label: 'a.mp3', bytes })).rejects.toThrow(
      /no transcriber/,
    );
  });
});
