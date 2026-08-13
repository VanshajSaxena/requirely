import type { Usage } from '../shared/usage.ts';
import type { TranscriptSegment } from '../source/source.ts';

export interface AudioInput {
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly filename?: string | undefined;
}

/**
 * `segments` is optional but declared from the outset.
 *
 * Whether a given provider diarizes is an adapter detail; whether the domain can
 * represent "the client said X, the engineer said Y" is not. Adding the field
 * later would mean re-transcribing every recording already ingested, so the
 * shape accommodates it now even though the first adapter will not populate it.
 */
export interface TranscriptionResult {
  readonly text: string;
  readonly language: string | null;
  readonly durationMs: number | null;
  readonly segments: readonly TranscriptSegment[] | null;
  readonly usage: Usage;
}

export interface Transcriber {
  transcribe(audio: AudioInput): Promise<TranscriptionResult>;
}
