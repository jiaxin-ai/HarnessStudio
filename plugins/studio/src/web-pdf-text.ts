import { Worker } from 'node:worker_threads';
import { WebError } from '@deepseek-ai/dsh-web';

export interface PdfTextOptions {
  maxPages?: number;
  /** Limit extracted body characters; bounded page markers and notices are additional. */
  maxBodyChars?: number;
  timeoutMs?: number;
}
export interface PdfTextResult { content: string; truncated: boolean; pages: number }

function boundedInteger(value: number | undefined, fallback: number, upper: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > upper) {
    throw new WebError(`Invalid PDF ${name} limit.`, 'WEB_PDF_LIMIT_INVALID');
  }
  return resolved;
}

/** Isolate untrusted PDF parsing so timeout/cancellation can stop even synchronous work. */
export async function extractPdfText(bytes: Uint8Array, options: PdfTextOptions = {}, signal?: AbortSignal): Promise<PdfTextResult> {
  if (signal?.aborted) throw new WebError('PDF extraction aborted.', 'WEB_ABORTED');
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new WebError('PDF contains no data.', 'WEB_PDF_INVALID');
  if (bytes.byteLength > 32 * 1024 * 1024) throw new WebError('PDF exceeds the extraction byte limit.', 'WEB_PDF_TOO_LARGE');
  const limits = {
    maxPages: boundedInteger(options.maxPages, 80, 1000, 'page'),
    maxBodyChars: boundedInteger(options.maxBodyChars, 100000, 2000000, 'body character'),
  };
  const timeoutMs = boundedInteger(options.timeoutMs, 15000, 120000, 'timeout');
  // Transfer a private copy, never detach the caller's Buffer or typed array backing store.
  const data = Uint8Array.from(bytes);
  return await new Promise<PdfTextResult>((resolve, reject) => {
    const worker = new Worker(new URL('./web-pdf-worker.js', import.meta.url), {
      workerData: { bytes: data, ...limits }, transferList: [data.buffer], env: {}, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (result?: PdfTextResult, error?: WebError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Terminate after both success and failure: PDF internals can retain asynchronous handles.
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(undefined, new WebError('PDF extraction aborted.', 'WEB_ABORTED'));
    const timer = setTimeout(() => finish(undefined, new WebError('PDF extraction timed out.', 'WEB_FETCH_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once('message', (message: { result?: PdfTextResult; error?: { code: string; message: string } }) => {
      if (message.result) finish(message.result);
      else finish(undefined, new WebError(message.error?.message ?? 'PDF extraction failed.', message.error?.code ?? 'WEB_PDF_PARSE_ERROR'));
    });
    worker.once('error', (error: Error & { code?: string }) => finish(undefined, new WebError(
      error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'PDF parsing exceeded the memory limit.' : 'PDF extraction worker failed.',
      error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'WEB_PDF_RESOURCE_LIMIT' : 'WEB_PDF_PARSE_ERROR',
    )));
    worker.once('exit', () => { if (!settled) finish(undefined, new WebError('PDF extraction worker ended before returning text.', 'WEB_PDF_PARSE_ERROR')); });
  });
}
