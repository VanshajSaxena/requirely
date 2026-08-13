export interface ExtractedDocument {
  readonly text: string;
  readonly pageCount: number | null;
}

/**
 * Turns bytes into text at the ingestion boundary.
 *
 * `supports()` lets the ingestion layer route by media type without knowing
 * which library handles PDFs versus DOCX — the same shape the Transcriber has
 * for audio. Below this boundary nothing is document-shaped.
 */
export interface DocumentExtractor {
  supports(mediaType: string): boolean;
  extract(bytes: Uint8Array, mediaType: string): Promise<ExtractedDocument>;
}
