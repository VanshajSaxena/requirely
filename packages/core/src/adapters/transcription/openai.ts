import { createOpenAI } from '@ai-sdk/openai';
import { transcribe } from 'ai';
import {
  type AudioInput,
  CapabilityError,
  OPERATION,
  type Transcriber,
  type TranscriptionResult,
  Usage,
} from '../../domain/index.ts';

/**
 * Transcription via OpenAI Whisper, through the AI SDK's stable `transcribe()`.
 *
 * Whisper **does not diarize**, so `speakerLabel` is always null here. The field
 * exists on `TranscriptSegment` anyway, decided in Phase 1: whether a given
 * provider can attribute speech is an adapter detail, but whether the domain can
 * *represent* "the client said X, the engineer said Y" is not. Because the shape
 * already accommodates it, Deepgram drops in later without re-transcribing
 * anything already ingested.
 *
 * Large files are not chunked. Above the provider's size limit this fails with
 * the vendor's message rather than silently truncating a recording — losing the
 * back half of a meeting is worse than a clear error.
 */

export interface OpenAITranscriberConfig {
  readonly apiKey: string;
  readonly model: string;
}

export function openaiTranscriber(config: OpenAITranscriberConfig): Transcriber {
  const openai = createOpenAI({ apiKey: config.apiKey });

  return {
    async transcribe(audio: AudioInput): Promise<TranscriptionResult> {
      try {
        const result = await transcribe({
          model: openai.transcription(config.model),
          audio: audio.data,
        });

        return {
          text: result.text,
          language: result.language ?? null,
          durationMs:
            result.durationInSeconds === undefined
              ? null
              : Math.round(result.durationInSeconds * 1000),
          // The SDK reports seconds; the domain stores milliseconds, matching
          // every other duration in the system.
          segments:
            result.segments.length === 0
              ? null
              : result.segments.map((segment) => ({
                  text: segment.text,
                  startMs: Math.round(segment.startSecond * 1000),
                  endMs: Math.round(segment.endSecond * 1000),
                  speakerLabel: null,
                })),
          usage: Usage.parse({
            operation: OPERATION.transcribe,
            provider: 'openai',
            model: config.model,
            // Transcription is priced by audio duration, not tokens. Reporting
            // zero would read as free; the duration is on the result above and
            // a price table can use it when one exists.
            inputTokens: 0,
            outputTokens: 0,
            costMinorUnits: null,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CapabilityError(OPERATION.transcribe, 'openai', message, { cause: error });
      }
    },
  };
}
