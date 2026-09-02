import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { isAudio, isPlainText, mediaTypeFor } from '@requirely/core/server';
import type { CliRuntime } from '../compose.ts';
import { note } from '../render.ts';
import { requireSession } from './session.ts';

/**
 * Ingestion: `add <session> <path>`.
 *
 * The CLI's whole contribution here is *routing by media type* and reading a
 * file. Everything else — assigning the session-scoped ordinal, the
 * `pending → normalized` transition for audio, deleting a failed pending row —
 * lives in `createIngestionService`, which is the only place a `Source` comes
 * into existence.
 *
 * That division is why this file is short, and it is the point: a front door
 * that reimplemented any of it would be a second place for the ordinal to be
 * assigned.
 */

export async function addSource(
  runtime: CliRuntime,
  sessionId: string,
  path: string,
  options: { label?: string | undefined; mediaType?: string | undefined } = {},
): Promise<string[]> {
  const session = await requireSession(runtime, sessionId);

  // From the extension, overridable. Sniffing magic bytes is more robust, but a
  // `.pdf` that is secretly a ZIP is a user error worth surfacing rather than
  // silently correcting.
  const mediaType = options.mediaType ?? mediaTypeFor(path);
  const label = options.label ?? basename(path);

  if (isAudio(mediaType)) {
    const bytes = await readFile(path);
    const source = await runtime.ingestion.ingestAudio({
      sessionId: session.id,
      label,
      // `unpdf` rejects a Node `Buffer` even though it extends `Uint8Array`, so
      // a zero-copy view is what crosses the port.
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      mediaType,
    });
    return [`Added ${source.id} — ${label}`, note(`  transcribed from ${mediaType}`)];
  }

  if (isPlainText(mediaType)) {
    const text = await readFile(path, 'utf8');
    const source = await runtime.ingestion.ingestText({ sessionId: session.id, label, text });
    return [`Added ${source.id} — ${label}`, note(`  ${text.length} characters`)];
  }

  const bytes = await readFile(path);
  const source = await runtime.ingestion.ingestDocument({
    sessionId: session.id,
    label,
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    mediaType,
  });
  return [`Added ${source.id} — ${label}`, note(`  extracted from ${mediaType}`)];
}
