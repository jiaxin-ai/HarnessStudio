import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Input { bytes: Uint8Array; maxPages: number; maxBodyChars: number }
interface ExtractionError extends Error { name: string; code?: string | number }

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function run({ bytes, maxPages, maxBodyChars }: Input) {
  // No PDF-provided remote font, image, attachment or action URL may be fetched from this worker.
  globalThis.fetch = async () => { throw failure('WEB_PDF_EXTERNAL_RESOURCE', 'External PDF resources are disabled.'); };
  // PDF.js 6 removed the old isEvalSupported switch. Disable dynamic code generation in this
  // worker as a second boundary; the parser interprets PDF functions and never runs actions.
  globalThis.eval = () => { throw failure('WEB_PDF_SCRIPT_DISABLED', 'PDF script evaluation is disabled.'); };
  const disabledFunction = function disabledPdfFunction() { throw failure('WEB_PDF_SCRIPT_DISABLED', 'PDF script evaluation is disabled.'); };
  Object.defineProperty(disabledFunction, 'prototype', { value: globalThis.Function.prototype });
  Object.setPrototypeOf(disabledFunction, globalThis.Function);
  globalThis.Function = disabledFunction as unknown as FunctionConstructor;
  const pdfPath = import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const packageRoot = dirname(dirname(dirname(fileURLToPath(pdfPath))));
  // PDF.js imports its rendering classes even for text-only parsing. Supply its official Node
  // polyfills inside this disposable worker; never change the application's main global object.
  if (!globalThis.DOMMatrix) {
    try {
      const canvas = createRequire(pdfPath)('@napi-rs/canvas');
      globalThis.DOMMatrix = canvas.DOMMatrix;
      globalThis.ImageData = canvas.ImageData;
      globalThis.Path2D = canvas.Path2D;
    } catch { throw failure('WEB_PDF_UNAVAILABLE', 'PDF text extraction requires the installed PDF.js Node support package.'); }
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: bytes, enableXfa: false, useWorkerFetch: false,
    disableAutoFetch: true, disableRange: true, disableStream: true,
    disableFontFace: true, useSystemFonts: false, isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false, useWasm: false, stopAtErrors: true,
    standardFontDataUrl: join(packageRoot, 'standard_fonts') + '/',
    cMapUrl: join(packageRoot, 'cmaps') + '/', cMapPacked: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const document = await task.promise;
    const totalPages = document.numPages;
    const pageLimit = Math.min(totalPages, maxPages);
    const chunks: string[] = [];
    let characters = 0;
    let parsedPages = 0;
    let nonWhitespace = false;
    let characterTruncated = false;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
      const page = await document.getPage(pageNumber);
      try {
        // Reading text content does not execute JavaScript/actions or render images.
        const text = await page.getTextContent({ disableNormalization: false });
        let body = '';
        for (const item of text.items) {
          if (!('str' in item)) continue;
          const remaining = maxBodyChars - characters - body.length;
          const segment = item.str + (item.hasEOL ? '\n' : ' ');
          if (segment.length > remaining) {
            body += segment.slice(0, Math.max(0, remaining));
            characterTruncated = true;
            break;
          }
          body += segment;
        }
        if (body.trim()) nonWhitespace = true;
        characters += body.length;
        parsedPages++;
        chunks.push(`[PDF page ${pageNumber}/${totalPages}]\n${body.trimEnd()}`);
        if (characterTruncated || characters >= maxBodyChars) {
          if (pageNumber < totalPages) characterTruncated = true;
          break;
        }
      } finally { page.cleanup(); }
    }
    if (!nonWhitespace) throw failure('WEB_PDF_NO_TEXT', 'No extractable PDF text was found in the inspected pages. This may be an image-only/scanned PDF; OCR or visual inspection is required.');
    const pageTruncated = totalPages > maxPages && parsedPages >= maxPages;
    const truncated = pageTruncated || characterTruncated;
    const notes = [
      '[PDF extraction note: Text layer only; reading order, tables, formulas and CAD drawings may be incomplete. Images and scanned pages were not interpreted; embedded actions were not executed.]',
      ...(pageTruncated ? [`[PDF truncated: Page limit reached; extracted ${parsedPages} of ${totalPages} pages (maxPages=${maxPages}).]`] : []),
      ...(characterTruncated ? [`[PDF truncated: Body character limit reached (maxBodyChars=${maxBodyChars}); later text/pages were omitted.]`] : []),
    ];
    return { content: notes.join('\n') + '\n\n' + chunks.join('\n\n'), truncated, pages: totalPages };
  } finally { await task.destroy(); }
}

if (parentPort) {
  void run(workerData as Input).then(result => parentPort!.postMessage({ result }), (raw: unknown) => {
    const error = raw as ExtractionError;
    const code = typeof error.code === 'string' ? error.code :
      error.name === 'PasswordException' ? 'WEB_PDF_PASSWORD' : error.name === 'InvalidPDFException' ? 'WEB_PDF_INVALID' : 'WEB_PDF_PARSE_ERROR';
    const message = code === 'WEB_PDF_PASSWORD' ? 'PDF is password-protected; provide an unencrypted document.' :
      code === 'WEB_PDF_INVALID' ? 'The response is not a valid readable PDF.' :
        code === 'WEB_PDF_NO_TEXT' || code === 'WEB_PDF_UNAVAILABLE' || code === 'WEB_PDF_EXTERNAL_RESOURCE' ? error.message : 'PDF text parsing failed.';
    parentPort!.postMessage({ error: { code, message } });
  });
}
