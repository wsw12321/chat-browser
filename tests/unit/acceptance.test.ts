import { describe, expect, it } from 'vitest';
import { inspectImage, strictBase64 } from '../../packages/contracts/src';

const scriptPath = '../../scripts/acceptance-gateway.mjs';
const { runAcceptance } = await import(scriptPath);
const environment = {
  WEBCHAT_ACCEPTANCE_ORIGIN: 'https://acceptance.example.test',
  WEBCHAT_ACCEPTANCE_MODEL: 'test-model',
  WEBCHAT_ACCEPTANCE_KEY: 'synthetic-secret-key',
};
const config = {
  schemaVersion: 1,
  policyVersion: 'file-policy-v1',
  features: { images: true, pdf: true, docx: true },
};
const complete = (text: string) =>
  new Response(
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } })}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
const fetcher =
  (generate: (init?: RequestInit) => Promise<Response> | Response): typeof fetch =>
  async (input, init) =>
    String(input).endsWith('/api/config')
      ? Response.json(config)
      : String(input).endsWith('/api/models')
        ? Response.json({ models: [{ id: 'test-model', images: true }] })
        : generate(init);

describe('opt-in real acceptance runner, with injected local mocks only', () => {
  it('performs no requests without --run or without valid HTTPS configuration', async () => {
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      throw new Error('must not run');
    };
    const output: string[] = [];
    expect(
      await runAcceptance({
        argv: [],
        environment,
        fetchImpl: request,
        emit: (line: string) => output.push(line),
      }),
    ).toBe(0);
    expect(
      await runAcceptance({
        argv: ['--run', '--cases=text'],
        environment: { ...environment, WEBCHAT_ACCEPTANCE_ORIGIN: 'http://localhost:8787' },
        fetchImpl: request,
        emit: (line: string) => output.push(line),
      }),
    ).toBe(2);
    expect(calls).toBe(0);
    expect(output.join('')).not.toContain(environment.WEBCHAT_ACCEPTANCE_KEY);
  });
  it('uses two explicit text requests, retains context in memory, and omits body/key from reports', async () => {
    const bodies: { messages: unknown[] }[] = [],
      reports: string[] = [];
    const code = await runAcceptance({
      argv: ['--run', '--cases=text'],
      environment,
      fetchImpl: fetcher(async (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return complete(bodies.length === 1 ? '已记住' : '松柏');
      }),
      emit: (line: string) => reports.push(line),
    });
    expect(code).toBe(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.messages).toHaveLength(3);
    const report = reports.join('');
    expect(report).toContain('passed');
    expect(report).not.toContain('松柏');
    expect(report).not.toContain('已记住');
    expect(report).not.toContain(environment.WEBCHAT_ACCEPTANCE_KEY);
  });
  it('generates a structurally valid synthetic PNG for the image-and-followup case', async () => {
    let calls = 0;
    const code = await runAcceptance({
      argv: ['--run', '--cases=image'],
      environment,
      fetchImpl: fetcher(async (init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        const image = body.messages[0].content.find(
          (block: { type: string }) => block.type === 'image',
        );
        expect(inspectImage(strictBase64(image.base64), image.mimeType)).toMatchObject({
          width: 16,
          height: 16,
        });
        return complete('红色');
      }),
      emit: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toBe(2);
  });
  it('observes client abort without claiming Gateway lease or billing completion', async () => {
    let aborted = false;
    const reports: string[] = [];
    const code = await runAcceptance({
      argv: ['--run', '--cases=cancel'],
      environment,
      fetchImpl: fetcher((init) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return new Response(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"private partial text"}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }),
      emit: (line: string) => reports.push(line),
    });
    expect(code).toBe(0);
    expect(aborted).toBe(true);
    expect(JSON.parse(reports[0]!)).toMatchObject({
      outcome: 'passed_client_abort_only',
      requiresGatewayLeaseObservation: true,
    });
    expect(reports.join('')).not.toContain('private partial text');
  });
  it('maps a dedicated quota failure and strips arbitrary upstream diagnostic text', async () => {
    const reports: string[] = [];
    const code = await runAcceptance({
      argv: ['--run', '--cases=quota'],
      environment,
      fetchImpl: fetcher(() =>
        Response.json(
          {
            error: {
              code: 'insufficient_quota',
              message: environment.WEBCHAT_ACCEPTANCE_KEY,
              stack: 'secret-stack',
            },
          },
          { status: 429 },
        ),
      ),
      emit: (line: string) => reports.push(line),
    });
    expect(code).toBe(0);
    expect(reports.join('')).toContain('insufficient_quota');
    expect(reports.join('')).not.toContain('secret-stack');
    expect(reports.join('')).not.toContain(environment.WEBCHAT_ACCEPTANCE_KEY);
  });
  it('sets redirect manual and never follows a different origin', async () => {
    let calls = 0;
    const reports: string[] = [];
    const code = await runAcceptance({
      argv: ['--run', '--cases=text'],
      environment,
      fetchImpl: async (_: unknown, init: RequestInit) => {
        calls++;
        expect(init.redirect).toBe('manual');
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://attacker.invalid' },
        });
      },
      emit: (line: string) => reports.push(line),
    });
    expect(code).toBe(2);
    expect(calls).toBe(1);
    expect(reports.join('')).not.toContain('attacker');
  });
});
