import type { DocumentExtractor, ExtractedDocument } from '../../domain/index.ts';
import { docxExtractor } from './docx.ts';
import { pdfExtractor } from './pdf.ts';

/**
 * One `DocumentExtractor` over several, routed by `supports()`.
 *
 * This is why the port carries `supports()` at all: the ingestion service asks
 * one question of one object and never learns that PDFs and DOCX are handled by
 * different libraries. Adding a format is adding an entry to the list — no
 * caller changes, no `switch` grows a case somewhere else.
 */
export function compositeExtractor(extractors: readonly DocumentExtractor[]): DocumentExtractor {
  return {
    supports: (mediaType) => extractors.some((e) => e.supports(mediaType)),

    async extract(bytes: Uint8Array, mediaType: string): Promise<ExtractedDocument> {
      const extractor = extractors.find((e) => e.supports(mediaType));
      if (extractor === undefined) {
        // Reachable only if a caller skipped `supports()`. Failing loudly beats
        // returning empty text, which downstream would read as "a scan".
        throw new Error(`no extractor supports "${mediaType}"`);
      }
      return extractor.extract(bytes, mediaType);
    },
  };
}

/** Everything this build can read. The composition root's default. */
export function defaultExtractor(): DocumentExtractor {
  return compositeExtractor([pdfExtractor(), docxExtractor()]);
}
