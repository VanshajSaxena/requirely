/**
 * Media type from a filename extension.
 *
 * Extension-based rather than magic-byte sniffing, deliberately. Sniffing is
 * more robust, but a `.pdf` that is secretly a ZIP is a user error worth
 * surfacing rather than silently correcting — and every caller can override
 * with an explicit `mediaType` when it genuinely knows better.
 */

const BY_EXTENSION: Record<string, string> = {
  // documents
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // text
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  // audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

export const FALLBACK_MEDIA_TYPE = 'application/octet-stream';

export function mediaTypeFor(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXTENSION[extension] ?? FALLBACK_MEDIA_TYPE;
}

export const isAudio = (mediaType: string): boolean => mediaType.startsWith('audio/');

export const isPlainText = (mediaType: string): boolean =>
  mediaType === 'text/plain' || mediaType === 'text/markdown';
