import { extractText, getDocumentProxy } from 'unpdf';
import type { DocumentExtractor, ExtractedDocument } from '../../domain/index.ts';

/**
 * PDF text extraction via `unpdf`.
 *
 * `unpdf` is a serverless-friendly build of pdf.js — no native modules, no
 * worker files to locate, which is what makes it work identically under Node's
 * type-stripping and in a container.
 *
 * A PDF that is a **scan** contains images, not text, and extraction returns
 * effectively nothing. That is not this adapter's problem to solve; the
 * ingestion service rejects an empty extraction with a message naming the likely
 * cause, rather than storing a source the engine would waste a turn reading.
 */
export function pdfExtractor(): DocumentExtractor {
  return {
    supports: (mediaType) => mediaType === 'application/pdf',

    async extract(bytes: Uint8Array): Promise<ExtractedDocument> {
      // `unpdf` rejects a Node `Buffer` outright — *"Please provide binary data
      // as Uint8Array, rather than Buffer"* — even though `Buffer` extends
      // `Uint8Array` and therefore satisfies the port's type. Any caller using
      // `fs.readFile` hands us a Buffer, so normalizing here is the adapter
      // doing its job: absorbing the outside world's shapes.
      //
      // A view rather than a copy, so a 50MB PDF is not duplicated in memory.
      const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const document = await getDocumentProxy(view);
      const { text, totalPages } = await extractText(document, { mergePages: true });

      return {
        // `mergePages` yields a single string; the union type still admits an
        // array, so normalize rather than trust the overload.
        text: Array.isArray(text) ? text.join('\n\n') : text,
        pageCount: totalPages,
      };
    },
  };
}
