import {
  type Clock,
  type DocumentExtractor,
  ID_PREFIX,
  type SessionId,
  Source,
  SourceId,
  type SourceKind,
  type SourceRepository,
  type Transcriber,
} from '../domain/index.ts';
import { type Logger, silentLogger } from '../observability/logger.ts';
import { mediaTypeFor } from './media-type.ts';

/**
 * The one place a Source comes into existence.
 *
 * It owns the `SourceRepository`, which is what lets it assign the ordinal —
 * previously the caller's job, and nothing computed it. Every modality routes
 * through here and every modality leaves the same shape behind: a Source whose
 * `normalizedText` is all the engine ever reads. Nothing downstream learns that
 * a PDF or an audio file was involved.
 */

export interface IngestionDeps {
  readonly sources: SourceRepository;
  readonly clock: Clock;
  readonly extractor?: DocumentExtractor | undefined;
  readonly transcriber?: Transcriber | undefined;
  readonly logger?: Logger | undefined;
}

export interface IngestInput {
  readonly sessionId: SessionId;
  /** Shown to the user and to the model; usually a filename. */
  readonly label: string;
  /** Overrides extension-based detection when the caller already knows. */
  readonly mediaType?: string | undefined;
  readonly kind?: SourceKind | undefined;
}

export interface IngestTextInput extends IngestInput {
  readonly text: string;
}

export interface IngestBytesInput extends IngestInput {
  readonly bytes: Uint8Array;
}

export class IngestionError extends Error {
  readonly label: string;

  constructor(label: string, message: string, options?: { cause?: unknown }) {
    super(`could not ingest "${label}": ${message}`, options);
    this.name = 'IngestionError';
    this.label = label;
  }
}

export function createIngestionService(deps: IngestionDeps) {
  const logger = deps.logger ?? silentLogger;

  /**
   * Sources are assigned `src-1`, `src-2`, … within their session.
   *
   * `length + 1` rather than a stored counter: sources are append-only apart
   * from the pending-cleanup path, and that path can only ever delete the most
   * recent row before anything references it. A concurrent double-ingest lands
   * on the composite primary key, which is the right place to catch it.
   */
  const nextId = async (sessionId: SessionId): Promise<SourceId> => {
    const existing = await deps.sources.listBySession(sessionId);
    return SourceId.parse(`${ID_PREFIX.source}-${existing.length + 1}`);
  };

  const buildSource = (
    id: SourceId,
    input: IngestInput,
    fields: {
      kind: SourceKind;
      status: 'pending' | 'normalized';
      derivedBy: 'none' | 'extraction' | 'transcription';
      normalizedText: string | null;
      mediaType: string;
      segments?: unknown;
    },
  ): Source =>
    Source.parse({
      id,
      sessionId: input.sessionId,
      kind: input.kind ?? fields.kind,
      status: fields.status,
      derivedBy: fields.derivedBy,
      origin: { label: input.label, mediaType: fields.mediaType },
      normalizedText: fields.normalizedText,
      segments: fields.segments ?? null,
      ingestedAt: deps.clock.now(),
    });

  return {
    /** Text that is already text. The floor every other path builds up to. */
    async ingestText(input: IngestTextInput): Promise<Source> {
      const source = buildSource(await nextId(input.sessionId), input, {
        kind: 'text',
        status: 'normalized',
        derivedBy: 'none',
        normalizedText: input.text,
        mediaType: input.mediaType ?? 'text/plain',
      });
      await deps.sources.add(source);
      return source;
    },

    /**
     * A document. Extraction happens **before** anything is persisted, so a
     * corrupt PDF leaves no row behind — a failure has no durable trace.
     */
    async ingestDocument(input: IngestBytesInput): Promise<Source> {
      const mediaType = input.mediaType ?? mediaTypeFor(input.label);
      if (deps.extractor === undefined || !deps.extractor.supports(mediaType)) {
        throw new IngestionError(input.label, `no extractor handles "${mediaType}"`);
      }

      let text: string;
      try {
        ({ text } = await deps.extractor.extract(input.bytes, mediaType));
      } catch (error) {
        throw new IngestionError(input.label, describe(error), { cause: error });
      }

      if (text.trim().length === 0) {
        // A scanned PDF is images, not text. Storing an empty source would let
        // the engine spend a turn discovering it has nothing to read.
        throw new IngestionError(input.label, 'no extractable text (is it a scan?)');
      }

      const source = buildSource(await nextId(input.sessionId), input, {
        kind: 'document',
        status: 'normalized',
        derivedBy: 'extraction',
        normalizedText: text,
        mediaType,
      });
      await deps.sources.add(source);
      return source;
    },

    /**
     * Audio. Unlike a document, the Source is persisted as `pending` *before*
     * transcription starts, because transcription can take minutes and a caller
     * needs to see that something is in flight.
     *
     * On failure the pending row is deleted and the error rethrown: a `pending`
     * row is an in-flight marker, not a failure record, so a failed ingest still
     * leaves no durable trace. When transcription eventually moves to a job
     * queue, these are the same two states — only the runner changes.
     */
    async ingestAudio(input: IngestBytesInput): Promise<Source> {
      const mediaType = input.mediaType ?? mediaTypeFor(input.label);
      if (deps.transcriber === undefined) {
        throw new IngestionError(input.label, 'no transcriber is configured');
      }

      const id = await nextId(input.sessionId);
      const pending = buildSource(id, input, {
        kind: 'audio',
        status: 'pending',
        derivedBy: 'transcription',
        normalizedText: null,
        mediaType,
      });
      await deps.sources.add(pending);
      logger.info('transcription started', { source: id, label: input.label });

      try {
        const result = await deps.transcriber.transcribe({
          data: input.bytes,
          mediaType,
          filename: input.label,
        });

        const normalized = Source.parse({
          ...pending,
          status: 'normalized',
          normalizedText: result.text,
          segments: result.segments === null ? null : [...result.segments],
        });
        await deps.sources.save(normalized);
        logger.info('transcription finished', {
          source: id,
          durationMs: result.durationMs,
          segments: result.segments?.length ?? 0,
        });
        return normalized;
      } catch (error) {
        await deps.sources.remove(input.sessionId, id);
        logger.warn('transcription failed; pending source removed', {
          source: id,
          reason: describe(error),
        });
        throw new IngestionError(input.label, describe(error), { cause: error });
      }
    },
  };
}

export type IngestionService = ReturnType<typeof createIngestionService>;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
