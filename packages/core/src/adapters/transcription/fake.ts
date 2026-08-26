import {
  type AudioInput,
  CapabilityError,
  type Transcriber,
  type TranscriptionResult,
  Usage,
} from '../../domain/index.ts';

/**
 * A scripted `Transcriber`, mirroring `adapters/ai/fake.ts`.
 *
 * Ingestion has a genuinely awkward property to test — the Source must be
 * observable as `pending` *while* transcription is still running — and a fake
 * that can be made to pause is the only way to assert that without a real
 * minutes-long call.
 */

export interface FakeTranscriberScript {
  readonly text?: string;
  readonly language?: string | null;
  readonly durationMs?: number | null;
  readonly segments?: readonly { text: string; startMs?: number; endMs?: number }[] | null;
  /** Awaited before returning — the hook that lets a test inspect `pending`. */
  readonly waitFor?: Promise<unknown>;
  /** When set, transcription rejects. Used to prove a failure leaves no row. */
  readonly failWith?: string;
}

export interface FakeTranscriber extends Transcriber {
  readonly calls: readonly AudioInput[];
  /**
   * Resolves when `transcribe` is entered.
   *
   * At that instant the pending Source is *provably* persisted, because
   * ingestion awaits `sources.add` before calling this. That makes "observe the
   * row mid-flight" a deterministic assertion rather than a guess about how many
   * microtask ticks to wait — which is the kind of test that passes today and
   * flakes the day an `await` is added upstream.
   */
  readonly started: Promise<void>;
}

export function fakeTranscriber(script: FakeTranscriberScript = {}): FakeTranscriber {
  const calls: AudioInput[] = [];
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });

  return {
    calls,
    started,
    async transcribe(audio: AudioInput): Promise<TranscriptionResult> {
      calls.push(audio);
      signalStarted();
      if (script.waitFor !== undefined) await script.waitFor;

      if (script.failWith !== undefined) {
        throw new CapabilityError('transcribe', 'fake', script.failWith, { retryable: false });
      }

      return {
        text: script.text ?? 'scripted transcript',
        language: script.language ?? 'en',
        durationMs: script.durationMs ?? 1_000,
        segments:
          script.segments === null || script.segments === undefined
            ? null
            : script.segments.map((segment) => ({
                text: segment.text,
                startMs: segment.startMs ?? null,
                endMs: segment.endMs ?? null,
                speakerLabel: null,
              })),
        usage: Usage.parse({
          operation: 'transcribe',
          provider: 'fake',
          model: 'fake-whisper',
          inputTokens: 0,
          outputTokens: 0,
        }),
      };
    },
  };
}
