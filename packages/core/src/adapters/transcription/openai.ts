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
import { type CallObserver, silentObserver } from '../../observability/calls.ts';

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
  /**
   * Reported as a call like any other, because it is one.
   *
   * `transcribe` is already an `Operation`, so audio ingestion needed no second
   * concept — and this is the slowest opaque wait in the product. An hour of
   * audio leaves `requirely add` silent for minutes with nothing to show it is
   * alive, which is exactly the complaint this port exists to answer.
   */
  readonly observer?: CallObserver | undefined;
}

export function openaiTranscriber(config: OpenAITranscriberConfig): Transcriber {
  const openai = createOpenAI({ apiKey: config.apiKey });
  const observer = config.observer ?? silentObserver;
  let calls = 0;

  return {
    async transcribe(audio: AudioInput): Promise<TranscriptionResult> {
      calls += 1;
      const callId = `transcribe-${calls}`;
      observer.observe({
        kind: 'call.start',
        callId,
        request: {
          operation: OPERATION.transcribe,
          provider: 'openai',
          model: config.model,
          // Audio goes as bytes, not as a schema-shaped request. `constrained`
          // is the nearest honest label: the provider owns the output shape.
          method: 'constrained',
          effort: 'medium',
          maxOutputTokens: null,
          instructions: '',
          // The bytes themselves are not printable and would be useless in a
          // log; their size is the thing that predicts how long this will take.
          input: `${audio.data.byteLength} bytes of ${audio.mediaType}`,
          schema: null,
          providerOptions: {},
        },
      });

      try {
        const result = await transcribe({
          model: openai.transcription(config.model),
          audio: audio.data,
        });

        const usage = Usage.parse({
          operation: OPERATION.transcribe,
          provider: 'openai',
          model: config.model,
          // Transcription is priced by audio duration, not tokens. Reporting
          // zero would read as free; the duration is on the result above and
          // a price table can use it when one exists.
          inputTokens: 0,
          outputTokens: 0,
          costMinorUnits: null,
        });

        observer.observe({
          kind: 'call.end',
          callId,
          response: {
            value: { characters: result.text.length, language: result.language ?? null },
            // The transcript is the *value*, not the model's literal reply — the
            // SDK already parsed a response envelope to get here.
            raw: null,
            usage,
            repairs: [],
            finishReason: null,
            warnings: [],
            providerMetadata: null,
          },
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
          usage,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        observer.observe({
          kind: 'call.fail',
          callId,
          retryable: false,
          reason: message,
          usage: null,
        });
        throw new CapabilityError(OPERATION.transcribe, 'openai', message, { cause: error });
      }
    },
  };
}
