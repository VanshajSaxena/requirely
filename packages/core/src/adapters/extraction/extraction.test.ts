import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compositeExtractor, defaultExtractor } from './composite.ts';
import { docxExtractor } from './docx.ts';
import { pdfExtractor } from './pdf.ts';

/**
 * Extraction against **real files**, not mocks.
 *
 * Both fixtures are tiny and committed: a minimal PDF is hand-writable ASCII,
 * and a DOCX is a ZIP with one XML part. Mocking `unpdf` and `mammoth` here
 * would only assert that the mock returns what the mock was told to return —
 * the entire risk of this layer lives in whether the libraries are being called
 * correctly, which is exactly what a mock hides.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string) => readFile(join(FIXTURES, name));

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('pdfExtractor', () => {
  it('pulls text out of a real PDF', async () => {
    const result = await pdfExtractor().extract(await load('minimal.pdf'), PDF);

    expect(result.text).toContain('Requirely extracts this line.');
    expect(result.pageCount).toBe(1);
  });

  it('claims only PDFs', () => {
    expect(pdfExtractor().supports(PDF)).toBe(true);
    expect(pdfExtractor().supports(DOCX)).toBe(false);
  });
});

describe('docxExtractor', () => {
  it('pulls text out of a real DOCX', async () => {
    const result = await docxExtractor().extract(await load('minimal.docx'), DOCX);

    expect(result.text).toContain('Requirely extracts this paragraph.');
    // A .docx has no pages until something lays it out. Null is the honest
    // answer; a guess would be worse.
    expect(result.pageCount).toBeNull();
  });

  it('extracts raw text, not markup', async () => {
    const result = await docxExtractor().extract(await load('minimal.docx'), DOCX);
    expect(result.text).not.toContain('<w:');
  });
});

describe('compositeExtractor', () => {
  it('routes each media type to the library that handles it', async () => {
    const extractor = defaultExtractor();

    expect(extractor.supports(PDF)).toBe(true);
    expect(extractor.supports(DOCX)).toBe(true);
    expect(extractor.supports('text/csv')).toBe(false);

    const pdf = await extractor.extract(await load('minimal.pdf'), PDF);
    const docx = await extractor.extract(await load('minimal.docx'), DOCX);
    expect(pdf.text).toContain('this line');
    expect(docx.text).toContain('this paragraph');
  });

  it('fails loudly rather than returning empty text for an unsupported type', async () => {
    // Empty text would be read downstream as "a scan" — a wrong diagnosis.
    await expect(
      compositeExtractor([pdfExtractor()]).extract(new Uint8Array([1]), 'text/csv'),
    ).rejects.toThrow(/no extractor supports/);
  });
});
