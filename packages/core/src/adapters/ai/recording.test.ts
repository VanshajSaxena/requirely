import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityError, OPERATION } from '../../domain/index.ts';
import { fakeStructuredGenerator } from './fake.ts';
import { recordingStructuredGenerator } from './recording.ts';

const MODEL = 'test-model-1';
const Shape = z.object({ value: z.string().min(1) });
const request = (input = 'hello') => ({
  operation: OPERATION.assess,
  instructions: 'be useful',
  input,
});

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const scratch = async (): Promise<string> => {
  dir = await mkdtemp(join(tmpdir(), 'requirely-cassettes-'));
  return dir;
};

describe('recordingStructuredGenerator', () => {
  it('calls through on a miss and replays without calling again', async () => {
    const cassetteDir = await scratch();
    const fake = fakeStructuredGenerator({ assess: [{ value: 'from the model' }] });
    const generator = recordingStructuredGenerator(fake, { cassetteDir, model: MODEL });

    const recorded = await generator.generate(Shape, request());
    const replayed = await generator.generate(Shape, request());

    expect(replayed.value).toEqual(recorded.value);
    // One script entry, two calls: the second never reached the inner generator.
    expect(fake.calls).toHaveLength(1);
  });

  it('does not replay one model\u2019s output for another', async () => {
    // The failure this pins is silent, which is why it is pinned. The key is a
    // hash of the request, and the model lives on the generator rather than in
    // the request \u2014 so before the model joined the key, recording a session on
    // a cheap model and re-running it on an expensive one replayed the cheap
    // model\u2019s answers, reported the cheap model in `usage`, and looked green.
    const cassetteDir = await scratch();
    const cheap = fakeStructuredGenerator({ assess: [{ value: 'from the cheap model' }] });
    const better = fakeStructuredGenerator({ assess: [{ value: 'from the better model' }] });

    await recordingStructuredGenerator(cheap, { cassetteDir, model: 'cheap-1' }).generate(
      Shape,
      request(),
    );
    const second = await recordingStructuredGenerator(better, {
      cassetteDir,
      model: 'better-1',
    }).generate(Shape, request());

    expect(second.value).toEqual({ value: 'from the better model' });
    // It actually called through rather than hitting the other model's cassette.
    expect(better.calls).toHaveLength(1);
  });

  it('preserves usage through a replay, so cost data survives', async () => {
    const cassetteDir = await scratch();
    const fake = fakeStructuredGenerator({ assess: [{ value: 'x' }] });
    const generator = recordingStructuredGenerator(fake, { cassetteDir, model: MODEL });

    const recorded = await generator.generate(Shape, request());
    const replayed = await generator.generate(Shape, request());

    expect(replayed.usage).toEqual(recorded.usage);
    expect(replayed.usage.operation).toBe('assess');
  });

  it('treats a changed prompt as a different recording', async () => {
    // The alternative — matching loosely — would replay output recorded against
    // a prompt that no longer exists, passing while testing nothing real.
    const cassetteDir = await scratch();
    const fake = fakeStructuredGenerator({ assess: [{ value: 'a' }, { value: 'b' }] });
    const generator = recordingStructuredGenerator(fake, { cassetteDir, model: MODEL });

    await generator.generate(Shape, request('first'));
    await generator.generate(Shape, request('second'));

    expect(fake.calls).toHaveLength(2);
  });

  it('fails loudly in replay mode rather than making a billable call', async () => {
    const cassetteDir = await scratch();
    const fake = fakeStructuredGenerator({ assess: [{ value: 'x' }] });
    const generator = recordingStructuredGenerator(fake, {
      cassetteDir,
      model: MODEL,
      mode: 'replay',
    });

    await expect(generator.generate(Shape, request())).rejects.toThrow(CapabilityError);
    expect(fake.calls).toHaveLength(0);
  });

  it('re-validates a replayed cassette against the current schema', async () => {
    const cassetteDir = await scratch();
    const fake = fakeStructuredGenerator({ assess: [{ value: 'x' }] });
    await recordingStructuredGenerator(fake, { cassetteDir, model: MODEL }).generate(
      Shape,
      request(),
    );

    // A schema that has since gained a field. The stale cassette must fail here
    // rather than flow through as though it were current.
    const Tightened = Shape.extend({ addedLater: z.string() });
    await expect(
      recordingStructuredGenerator(fake, { cassetteDir, model: MODEL, mode: 'replay' }).generate(
        Tightened,
        request(),
      ),
    ).rejects.toThrow();
  });

  it('writes a human-readable cassette, since these are reviewed in diffs', async () => {
    const cassetteDir = await scratch();
    const fake = fakeStructuredGenerator({ assess: [{ value: 'x' }] });
    await recordingStructuredGenerator(fake, { cassetteDir, model: MODEL }).generate(
      Shape,
      request(),
    );

    const files = await import('node:fs/promises').then((fs) => fs.readdir(cassetteDir));
    expect(files[0]).toMatch(/^assess-[0-9a-f]{16}\.json$/);

    const body = JSON.parse(await readFile(join(cassetteDir, files[0] ?? ''), 'utf8'));
    expect(body.operation).toBe('assess');
    expect(body.preview.input).toBe('hello');
    expect(body.value).toEqual({ value: 'x' });
  });
});
