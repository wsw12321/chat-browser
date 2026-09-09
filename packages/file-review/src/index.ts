import { precheckFile, precheckBatch } from './preflight';
import {
  LIMITS,
  ReviewError,
  type ReviewedArtifact,
  type ReviewOptions,
  type ReviewProgress,
  type ReviewErrorCode,
} from './types';
export * from './types';
export { precheckBatch, precheckFile };
let queue: Promise<unknown> = Promise.resolve();
const stops = new Set<() => void>();
let pageEpoch = 0;
if (typeof window !== 'undefined')
  window.addEventListener('pagehide', () => {
    pageEpoch++;
    for (const stop of stops) stop();
    stops.clear();
  });
async function performReview(file: File, options: ReviewOptions): Promise<ReviewedArtifact> {
  if (options.signal?.aborted) throw new ReviewError('cancelled');
  precheckFile(file, options.features);
  if (typeof Worker === 'undefined') throw new ReviewError('document_unverifiable');
  const taskId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./review.worker.ts', import.meta.url), {
      type: 'module',
      name: 'local-file-review',
    });
    let settled = false,
      pageTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: ReviewError, result?: ReviewedArtifact) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pageTimer);
      options.signal?.removeEventListener('abort', abort);
      worker.terminate();
      stops.delete(abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(
      () => finish(new ReviewError('document_parse_timeout')),
      LIMITS.totalMs,
    );
    const abort = () => finish(new ReviewError('cancelled'));
    stops.add(abort);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    worker.onerror = () => finish(new ReviewError('document_parse_failed'));
    worker.onmessageerror = () => finish(new ReviewError('document_parse_failed'));
    worker.onmessage = (
      event: MessageEvent<{
        type: string;
        taskId: string;
        progress: ReviewProgress;
        result: ReviewedArtifact;
        code: ReviewErrorCode;
      }>,
    ) => {
      if (event.data.taskId !== taskId || settled) return;
      if (event.data.type === 'progress') options.onProgress?.(event.data.progress);
      else if (event.data.type === 'page-start') {
        clearTimeout(pageTimer);
        pageTimer = setTimeout(
          () => finish(new ReviewError('document_parse_timeout')),
          LIMITS.pdfPageMs,
        );
      } else if (event.data.type === 'page-end') clearTimeout(pageTimer);
      else if (event.data.type === 'result') finish(undefined, event.data.result);
      else if (event.data.type === 'error') finish(new ReviewError(event.data.code));
    };
    options.onProgress?.({ taskId, stage: 'prechecking' });
    // Reading is owned by the disposable worker too, so cancellation ends file I/O.
    worker.postMessage({ type: 'review', taskId, file, features: options.features ?? {} });
  });
}
/** A per-page FIFO plus an origin-wide Web Lock. The 15 s clock starts after queueing. */
export function reviewFile(file: File, options: ReviewOptions = {}): Promise<ReviewedArtifact> {
  const epoch = pageEpoch;
  const run = async () => {
    if (epoch !== pageEpoch || options.signal?.aborted) throw new ReviewError('cancelled');
    if (typeof navigator !== 'undefined' && navigator.locks) {
      try {
        return await navigator.locks.request(
          'chat-browser:file-review',
          { mode: 'exclusive', signal: options.signal },
          () => performReview(file, options),
        );
      } catch (error) {
        if (options.signal?.aborted) throw new ReviewError('cancelled');
        throw error;
      }
    }
    return performReview(file, options);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}
