import {
  type Clock,
  type IdGenerator,
  type SessionId,
  Source,
  SourceId,
  type SourceKind,
} from '../domain/index.ts';

/**
 * The simplest ingestion path: text that is already text.
 *
 * Its job is the same as every other ingestion path will have — produce a Source
 * whose `normalizedText` is what the engine reads. PDF, DOCX, code, and audio
 * (Phase 5) differ only in how they reach that field; nothing downstream will
 * learn that they existed. That is the "modality is a mechanism, not an
 * identity" rule made concrete.
 */

export interface IngestTextInput {
  readonly sessionId: SessionId;
  readonly label: string;
  readonly text: string;
  /** Defaults to plain text; pass `code`, `conversation`, etc. when known. */
  readonly kind?: SourceKind;
}

export interface IngestContext {
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export function ingestText(input: IngestTextInput, ctx: IngestContext): Source {
  return Source.parse({
    id: SourceId.parse(ctx.ids.next('source')),
    sessionId: input.sessionId,
    kind: input.kind ?? 'text',
    status: 'normalized',
    derivedBy: 'none',
    origin: { label: input.label, mediaType: 'text/plain' },
    normalizedText: input.text,
    ingestedAt: ctx.clock.now(),
  });
}
