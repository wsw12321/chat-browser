/// <reference lib="webworker" />
import { reviewBytes, failure, LIMITS, ReviewError, type Features } from './core';
const worker = self as unknown as DedicatedWorkerGlobalScope;
let active = false;
worker.onmessage = async (
  event: MessageEvent<{ type: 'review'; taskId: string; file: File; features: Features }>,
) => {
  const { type, taskId, file, features } = event.data;
  if (type !== 'review' || active) return;
  active = true;
  const resources = new Set<() => void | Promise<void>>(),
    started = performance.now();
  try {
    const bytes = await file.arrayBuffer();
    const result = await reviewBytes(
      file,
      new Uint8Array(bytes),
      {
        resources,
        check() {
          if (performance.now() - started > LIMITS.totalMs)
            throw new ReviewError('document_parse_timeout');
        },
        progress(stage, completed, total) {
          worker.postMessage({
            type: 'progress',
            taskId,
            progress: { taskId, stage, completed, total },
          });
        },
        pageStarted(page) {
          worker.postMessage({ type: 'page-start', taskId, page });
        },
        pageFinished() {
          worker.postMessage({ type: 'page-end', taskId });
        },
      },
      features,
    );
    worker.postMessage({ type: 'result', taskId, result });
  } catch (error) {
    worker.postMessage({ type: 'error', taskId, code: failure(error).code });
  } finally {
    await Promise.allSettled([...resources].map((release) => Promise.resolve().then(release)));
    resources.clear();
    active = false;
  }
};
