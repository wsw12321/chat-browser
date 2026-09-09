import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { reviewFile } from '../src/index';
import { LIMITS } from '../src/types';
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  send(type: string, extra: Record<string, unknown> = {}) {
    const task = this.postMessage.mock.calls[0]![0] as { taskId: string };
    this.onmessage?.({ data: { type, taskId: task.taskId, ...extra } } as MessageEvent);
  }
}
beforeEach(() => {
  vi.stubGlobal('navigator', {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});
describe('disposable worker host lifecycle', () => {
  it('cancellation physically terminates the worker during read/parse', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new AbortController(),
      promise = reviewFile(new File(['hello'], 'a.txt'), { signal: controller.signal });
    const assertion = expect(promise).rejects.toThrow('cancelled');
    await Promise.resolve();
    const worker = FakeWorker.instances[0]!;
    expect(worker.postMessage.mock.calls[0]![0]).toHaveProperty('file');
    controller.abort();
    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('independent page watchdog terminates a stuck parser at 15 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    const promise = reviewFile(new File(['hello'], 'a.txt'));
    const assertion = expect(promise).rejects.toThrow('document_parse_timeout');
    await vi.advanceTimersByTimeAsync(LIMITS.totalMs + 1);
    await assertion;
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
  it('a stuck PDF page is terminated at 2 seconds despite total remaining', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    const promise = reviewFile(new File(['%PDF-1.7'], 'a.pdf'));
    const assertion = expect(promise).rejects.toThrow('document_parse_timeout');
    await vi.advanceTimersByTimeAsync(0);
    const worker = FakeWorker.instances[0]!;
    worker.send('page-start');
    await vi.advanceTimersByTimeAsync(LIMITS.pdfPageMs + 1);
    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('queues at most one parser and ignores a foreign task result', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const one = reviewFile(new File(['one'], 'a.txt')),
      two = reviewFile(new File(['two'], 'b.txt'));
    await Promise.resolve();
    expect(FakeWorker.instances).toHaveLength(1);
    const first = FakeWorker.instances[0]!;
    first.onmessage?.({ data: { type: 'result', taskId: 'foreign', result: {} } } as MessageEvent);
    expect(first.terminate).not.toHaveBeenCalled();
    first.send('result', { result: { name: 'a.txt' } });
    await one;
    await Promise.resolve();
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1]!.send('result', { result: { name: 'b.txt' } });
    await two;
    expect(first.terminate).toHaveBeenCalledOnce();
  });
});
