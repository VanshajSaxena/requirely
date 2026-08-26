import mammoth from 'mammoth';
import type { DocumentExtractor, ExtractedDocument } from '../../domain/index.ts';

const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * DOCX text extraction via `mammoth`.
 *
 * `extractRawText` rather than `convertToHtml`: the engine reads
 * `normalizedText`, and HTML would be markup the model has to see past. Styling
 * carries no requirements.
 *
 * `pageCount` is null because a `.docx` has no pages until something lays it
 * out — pagination is a rendering property, not a document one. Null is the
 * honest answer; a guess would be worse.
 */
export function docxExtractor(): DocumentExtractor {
  return {
    supports: (mediaType) => mediaType === DOCX_MEDIA_TYPE,

    async extract(bytes: Uint8Array): Promise<ExtractedDocument> {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return { text: result.value, pageCount: null };
    },
  };
}
