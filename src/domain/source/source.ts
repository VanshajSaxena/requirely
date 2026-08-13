import { z } from 'zod';
import { SessionId, SourceId } from '../shared/ids.ts';
import { Timestamp } from '../shared/time.ts';

/**
 * Input modality is a mechanism, not an identity. Everything below this boundary
 * sees `normalizedText`; `kind` and `derivedBy` exist for provenance and for
 * deciding how to normalize, never to branch analysis logic.
 */
export const SourceKind = z.enum([
  'text',
  'document',
  'audio',
  'code',
  'conversation',
  'existing-requirements',
]);
export type SourceKind = z.infer<typeof SourceKind>;

/**
 * `pending` is the seam for asynchronous work. Transcribing an hour-long meeting
 * recording cannot happen inside a request, so a Source may exist before its
 * text does.
 */
export const SourceStatus = z.enum(['pending', 'normalized', 'failed']);
export type SourceStatus = z.infer<typeof SourceStatus>;

export const DerivedBy = z.enum(['none', 'transcription', 'extraction']);
export type DerivedBy = z.infer<typeof DerivedBy>;

/**
 * Speaker labels are carried here from the start. Diarization is what makes
 * "the client said X, the engineer said Y" expressible as provenance, and adding
 * the field later would mean re-transcribing everything already ingested.
 */
export const TranscriptSegment = z.object({
  text: z.string().min(1),
  startMs: z.number().int().nonnegative().nullable().default(null),
  endMs: z.number().int().nonnegative().nullable().default(null),
  speakerLabel: z.string().min(1).nullable().default(null),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

export const SourceOrigin = z.object({
  label: z.string().min(1),
  uri: z.string().min(1).nullable().default(null),
  mediaType: z.string().min(1).nullable().default(null),
  capturedAt: Timestamp.nullable().default(null),
});
export type SourceOrigin = z.infer<typeof SourceOrigin>;

export const Source = z.object({
  id: SourceId,
  sessionId: SessionId,
  kind: SourceKind,
  status: SourceStatus,
  derivedBy: DerivedBy.default('none'),
  origin: SourceOrigin,
  normalizedText: z.string().nullable().default(null),
  segments: z.array(TranscriptSegment).nullable().default(null),
  failureReason: z.string().min(1).nullable().default(null),
  ingestedAt: Timestamp,
});
export type Source = z.infer<typeof Source>;

/** Only normalized sources carry text the engine can analyze. */
export function isAnalyzable(source: Source): boolean {
  return source.status === 'normalized' && source.normalizedText !== null;
}
