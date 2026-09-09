import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const CASES = ['text', 'image', 'pdf-text', 'docx-text', 'long', 'cancel', 'quota', 'abnormal'];
const SAFE_CODES = new Set([
  'unauthorized',
  'forbidden',
  'model_not_allowed',
  'policy_outdated',
  'invalid_request',
  'invalid_json',
  'invalid_image',
  'request_too_large',
  'insufficient_quota',
  'rate_limited',
  'edge_busy',
  'request_spool_busy',
  'upstream_reauthentication_required',
  'upstream_error',
  'upstream_timeout',
  'unsupported_response_item',
  'response_too_large',
  'response_incomplete',
  'stream_invalid',
  'interrupted',
  'cancelled',
  'configuration_error',
]);
const LIMITS = {
  json: 1024 * 1024,
  event: 4 * 1024 * 1024,
  response: 16 * 1024 * 1024,
  text: 512 * 1024,
  wallMs: 610_000,
};
const safeCode = (value) => (SAFE_CODES.has(value) ? value : 'upstream_error');
const safeId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
const bytes = (value) => Buffer.byteLength(value, 'utf8');
const question = (text, attachments = []) => ({
  role: 'user',
  content: [{ type: 'text', text }, ...attachments],
});
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
class AcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.code = safeCode(code);
  }
}

export function usage() {
  return 'Usage: node scripts/acceptance-gateway.mjs --run --cases=text,cancel\nRequired environment: WEBCHAT_ACCEPTANCE_ORIGIN (HTTPS origin), WEBCHAT_ACCEPTANCE_MODEL, WEBCHAT_ACCEPTANCE_KEY.\nCases: text,image,pdf-text,docx-text,long,cancel,quota,abnormal. Select explicitly; generation can consume quota.\nDefault/--help performs no network requests. Reports contain only approved metadata, never Key or message text.\nPDF/DOCX cases test normalized text only. Cancel still requires Gateway lease observation.\nQuota needs a dedicated insufficient-quota Key. Abnormal needs an operator-controlled upstream fault.\n';
}

async function boundedJson(response, maximum = LIMITS.json) {
  const reader = response.body?.getReader();
  if (!reader) throw new AcceptanceError('upstream_error');
  let total = 0,
    text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new AcceptanceError('response_too_large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof AcceptanceError) throw error;
    throw new AcceptanceError('upstream_error');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Bounded parser for the website's sanitized SSE dialect; payload text stays in process memory. */
async function receive(response, controller, cancelAfterText, startedAt) {
  const result = {
    state: 'interrupted',
    text: '',
    httpStatus: response.status,
    bytes: 0,
    firstEventMs: null,
    firstTextMs: null,
    requestId: safeId(response.headers.get('X-Webchat-Request-ID')),
    gatewayRequestId: safeId(response.headers.get('X-Gateway-Request-ID')),
    code: null,
    usage: null,
  };
  if (!response.ok) {
    const body = await boundedJson(response, 16 * 1024);
    result.code = safeCode(body?.error?.code);
    result.state = 'failed';
    return result;
  }
  if (
    !/^text\/event-stream(?:;|$)/i.test(response.headers.get('Content-Type') ?? '') ||
    !response.body
  )
    throw new AcceptanceError('stream_invalid');
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '',
    terminal = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        pending += decoder.decode();
        break;
      }
      result.bytes += value.byteLength;
      if (result.bytes > LIMITS.response) throw new AcceptanceError('response_too_large');
      pending += decoder.decode(value, { stream: true });
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(pending);
        if (!separator) {
          if (bytes(pending) > LIMITS.event) throw new AcceptanceError('response_too_large');
          break;
        }
        const frame = pending.slice(0, separator.index);
        pending = pending.slice(separator.index + separator[0].length);
        if (bytes(frame) + bytes(separator[0]) > LIMITS.event)
          throw new AcceptanceError('response_too_large');
        const lines = frame.split(/\r?\n/),
          data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data) continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw new AcceptanceError('stream_invalid');
        }
        result.firstEventMs ??= Math.round(performance.now() - startedAt);
        const eventName =
          lines
            .find((line) => line.startsWith('event:'))
            ?.slice(6)
            .trim() ?? event.type;
        if (eventName === 'webchat.error') {
          result.code = safeCode(event.error?.code);
          result.state = result.code === 'interrupted' ? 'interrupted' : 'failed';
          terminal = true;
          break;
        }
        if (
          (event.type === 'response.output_text.delta' ||
            event.type === 'response.refusal.delta') &&
          typeof event.delta === 'string' &&
          event.delta.length
        ) {
          result.firstTextMs ??= Math.round(performance.now() - startedAt);
          if (cancelAfterText) {
            controller.abort();
            result.state = 'cancelled';
            terminal = true;
            break;
          }
        }
        if (event.type === 'response.completed') {
          if (!Array.isArray(event.response?.output)) throw new AcceptanceError('stream_invalid');
          const content = [];
          for (const item of event.response.output) {
            if (item.type === 'reasoning') continue;
            if (item.type !== 'message' || !Array.isArray(item.content))
              throw new AcceptanceError('unsupported_response_item');
            for (const part of item.content) {
              if (!['output_text', 'refusal'].includes(part.type))
                throw new AcceptanceError('unsupported_response_item');
              const text = part.type === 'refusal' ? part.refusal : part.text;
              if (typeof text !== 'string') throw new AcceptanceError('stream_invalid');
              content.push(text);
            }
          }
          result.text = content.join('');
          if (bytes(result.text) > LIMITS.text) throw new AcceptanceError('response_too_large');
          const usage = {};
          for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
            const number = event.response.usage?.[key];
            if (Number.isSafeInteger(number) && number >= 0) usage[key] = number;
          }
          result.usage = Object.keys(usage).length ? usage : null;
          result.state = 'completed';
          terminal = true;
          break;
        }
      }
      if (terminal) break;
    }
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function redImage() {
  const table = Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type, data) => {
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length);
    output.write(type, 4, 4, 'ascii');
    data.copy(output, 8);
    let crc = 0xffffffff;
    for (const byte of output.subarray(4, -4)) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(16 * (16 * 4 + 1));
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      pixels[y * 65 + 1 + x * 4] = 255;
      pixels[y * 65 + 4 + x * 4] = 255;
    }
  return {
    type: 'image',
    mimeType: 'image/png',
    base64: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64'),
  };
}

export async function runAcceptance({
  argv = process.argv.slice(2),
  environment = process.env,
  fetchImpl = fetch,
  emit = (line) => process.stdout.write(line + '\n'),
} = {}) {
  if (argv.includes('--help') || !argv.includes('--run')) {
    emit(usage().trimEnd());
    return 0;
  }
  const casesArg = argv.find((value) => value.startsWith('--cases='));
  const selected = casesArg?.slice(8).split(',') ?? [];
  if (
    argv.some((value) => value !== '--run' && !value.startsWith('--cases=')) ||
    !selected.length ||
    selected.some((value) => !CASES.includes(value)) ||
    new Set(selected).size !== selected.length
  ) {
    emit(JSON.stringify({ status: 'setup_error', code: 'explicit_cases_required' }));
    return 2;
  }
  let origin;
  try {
    const url = new URL(environment.WEBCHAT_ACCEPTANCE_ORIGIN ?? '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    origin = url.origin;
  } catch {
    emit(JSON.stringify({ status: 'setup_error', code: 'https_origin_required' }));
    return 2;
  }
  const key = environment.WEBCHAT_ACCEPTANCE_KEY,
    model = environment.WEBCHAT_ACCEPTANCE_MODEL;
  if (
    !key ||
    !/^[A-Za-z0-9._~+\/-]{8,512}$/.test(key) ||
    !model ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model)
  ) {
    emit(JSON.stringify({ status: 'setup_error', code: 'acceptance_environment_missing' }));
    return 2;
  }
  let config;
  const get = async (path) => {
    const response = await fetchImpl(origin + path, {
      headers: path === '/api/models' ? { Authorization: `Bearer ${key}` } : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400)
      throw new AcceptanceError('upstream_error');
    if (!response.ok) {
      const body = await boundedJson(response, 16 * 1024);
      throw new AcceptanceError(safeCode(body?.error?.code));
    }
    return boundedJson(response);
  };
  try {
    config = await get('/api/config');
    if (
      config.schemaVersion !== 1 ||
      typeof config.policyVersion !== 'string' ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(config.policyVersion) ||
      !config.features
    )
      throw new AcceptanceError('configuration_error');
    const models = await get('/api/models');
    if (!Array.isArray(models.models) || !models.models.some((value) => value.id === model))
      throw new AcceptanceError('model_not_allowed');
    if (
      selected.includes('image') &&
      (!config.features.images || !models.models.find((value) => value.id === model)?.images)
    )
      throw new AcceptanceError('model_not_allowed');
  } catch (error) {
    emit(
      JSON.stringify({
        status: 'setup_error',
        code: error instanceof AcceptanceError ? error.code : 'upstream_error',
      }),
    );
    return 2;
  }
  const send = async (messages, cancelAfterText = false) => {
    const startedAt = performance.now(),
      controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), LIMITS.wallMs);
    try {
      const response = await fetchImpl(origin + '/api/chat', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Origin: origin,
        },
        redirect: 'manual',
        signal: controller.signal,
        body: JSON.stringify({
          schemaVersion: config.schemaVersion,
          policyVersion: config.policyVersion,
          clientRequestId: crypto.randomUUID(),
          model,
          messages,
        }),
      });
      if (response.status >= 300 && response.status < 400)
        throw new AcceptanceError('upstream_error');
      const result = await receive(response, controller, cancelAfterText, startedAt);
      return { ...result, elapsedMs: Math.round(performance.now() - startedAt) };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  let failed = false;
  for (const name of selected) {
    let outcome = 'failed',
      reason = null,
      rounds = [];
    try {
      if (
        (name === 'pdf-text' && !config.features.pdf) ||
        (name === 'docx-text' && !config.features.docx)
      )
        throw new AcceptanceError('configuration_error');
      if (name === 'text') {
        const first = question('记住识别词：松柏。只回复“已记住”。');
        const a = await send([first]);
        rounds.push(a);
        if (a.state !== 'completed') throw new AcceptanceError(a.code);
        const b = await send([
          first,
          assistant(a.text),
          question('上一轮识别词是什么？只回复识别词。'),
        ]);
        rounds.push(b);
        outcome = b.state === 'completed' && b.text.includes('松柏') ? 'passed' : 'failed';
      } else if (name === 'image') {
        const first = question('图片主要是什么颜色？只回答颜色。', [redImage()]);
        const a = await send([first]);
        rounds.push(a);
        if (a.state !== 'completed') throw new AcceptanceError(a.code);
        const b = await send([
          first,
          assistant(a.text),
          question('根据第一轮图片，确认它是否主要是红色。'),
        ]);
        rounds.push(b);
        outcome =
          b.state === 'completed' && /红|red/i.test(a.text) && /红|red/i.test(b.text)
            ? 'passed'
            : 'failed';
      } else if (name === 'pdf-text' || name === 'docx-text') {
        const pdf = name === 'pdf-text';
        const a = await send([
          question(
            pdf ? '附件中的验收编号是什么？只回复数字。' : '附件表格中青杯数量是多少？只回复数字。',
            [
              {
                type: 'document_text',
                name: pdf ? '验收说明.pdf' : '数量表.docx',
                text: pdf
                  ? '[第 1 页]\n项目代号：石榴。验收编号：4826。\n以上内容是专用的合成模型联调资料。'
                  : '项目\t数量\n青杯\t7\n白杯\t3\n',
              },
            ],
          ),
        ]);
        rounds.push(a);
        outcome =
          a.state === 'completed' && a.text.includes(pdf ? '4826' : '7') ? 'passed' : 'failed';
      } else if (name === 'quota') {
        const a = await send([question('只回复“验收”。')]);
        rounds.push(a);
        outcome = a.httpStatus === 429 && a.code === 'insufficient_quota' ? 'passed' : 'failed';
      } else {
        const a = await send(
          [question('请写出编号 1 到 200 的中文短句，每句 20 个汉字左右，逐行输出，不要省略。')],
          name === 'cancel',
        );
        rounds.push(a);
        outcome =
          name === 'cancel'
            ? a.state === 'cancelled' && a.firstTextMs !== null
              ? 'passed_client_abort_only'
              : 'failed'
            : name === 'abnormal'
              ? ['failed', 'interrupted'].includes(a.state)
                ? 'observed_abnormal_end'
                : 'failed'
              : a.state === 'completed' && bytes(a.text) >= 2000
                ? 'passed'
                : 'failed';
      }
    } catch (error) {
      reason = error instanceof AcceptanceError ? error.code : 'upstream_error';
    }
    if (outcome === 'failed') failed = true;
    const metadata = rounds.map(({ text, ...safe }) => ({ ...safe, outputTextBytes: bytes(text) }));
    emit(
      JSON.stringify({
        version: 1,
        recordedAt: new Date().toISOString(),
        case: name,
        model,
        policyVersion: config.policyVersion,
        outcome,
        reason,
        rounds: metadata,
        requiresBrowserParserAcceptance: ['pdf-text', 'docx-text'].includes(name),
        requiresGatewayLeaseObservation: name === 'cancel',
      }),
    );
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runAcceptance();
