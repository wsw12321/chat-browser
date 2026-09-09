import http from 'node:http';

// Local acceptance service only. Never route production traffic or genuine Keys here.
const port = Number(process.env.MOCK_GATEWAY_PORT ?? 8790);
const state = { modelQueries: 0, generations: 0, active: 0, cancelled: 0, completed: 0 };
const sendJson = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Gateway-Request-ID': `mock-${crypto.randomUUID()}`,
  });
  res.end(JSON.stringify(body));
};
const sendError = (res, status, code) =>
  sendJson(res, status, { error: { code, message: 'Synthetic gateway error' } });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/__state' && req.method === 'GET') return sendJson(res, 200, state);
  const authorization = req.headers.authorization;
  if (!['Bearer test-key', 'Bearer quota-key', 'Bearer busy-key'].includes(authorization))
    return sendError(res, 401, 'invalid_api_key');
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    state.modelQueries++;
    return sendJson(res, 200, {
      data: [{ id: 'mock-text' }, { id: 'mock-vision' }, { id: 'codex-auto-review' }],
    });
  }
  if (url.pathname !== '/v1/responses' || req.method !== 'POST')
    return sendError(res, 404, 'not_found');
  if (authorization === 'Bearer quota-key') return sendError(res, 429, 'insufficient_quota');
  if (authorization === 'Bearer busy-key') return sendError(res, 503, 'request_spool_busy');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > 4 * 1024 * 1024) return sendError(res, 413, 'request_too_large');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return sendError(res, 400, 'invalid_json');
  }
  if (
    body.stream !== true ||
    body.store !== false ||
    !Array.isArray(body.input) ||
    !['mock-text', 'mock-vision'].includes(body.model)
  )
    return sendError(res, 400, 'invalid_request');
  state.generations++;
  state.active++;
  const responseId = `resp_mock_${crypto.randomUUID()}`;
  const last = body.input.at(-1);
  const question =
    last?.content
      ?.filter((block) => block.type === 'input_text')
      .map((block) => block.text)
      .join('\n') ?? '';
  const historyUsers = body.input.filter((message) => message.role === 'user').length;
  const imageCount = body.input
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === 'input_image').length;
  const slow = /慢速测试|slow/i.test(question);
  const interrupted = /异常结束|interrupt/i.test(question);
  const tool = /工具测试|tool_test/i.test(question);
  const long = /长回复测试|long_test/i.test(question);
  const reply = long
    ? '这是用于验证长回复增量保存的模拟文字。\n'.repeat(400)
    : `这是本地模拟回复。\n\n已收到第 ${historyUsers} 轮问题${imageCount ? `，上下文包含 ${imageCount} 张图片` : ''}：${question.slice(0, 120)}\n\n此服务用于功能测试，不调用真实模型。`;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Gateway-Request-ID': `mock-${crypto.randomUUID()}`,
  });
  let stopped = false,
    natural = false,
    timer;
  res.on('close', () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    state.active--;
    if (!natural) state.cancelled++;
  });
  const emit = (type, fields) => {
    if (!stopped)
      res.write(`event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`);
  };
  emit('response.created', { response: { id: responseId } });
  const pieces = Array.from(reply).reduce((parts, char, i) => {
    if (i % 8 === 0) parts.push('');
    parts[parts.length - 1] += char;
    return parts;
  }, []);
  let index = 0;
  const step = () => {
    if (stopped) return;
    if (index < pieces.length) {
      emit('response.output_text.delta', {
        output_index: 0,
        content_index: 0,
        item_id: 'msg_mock',
        delta: pieces[index++],
      });
      timer = setTimeout(step, slow ? 700 : long ? 1 : 12);
      return;
    }
    if (tool)
      emit('response.output_item.added', {
        output_index: 1,
        item: { type: 'function_call', name: 'unsupported_synthetic_tool', arguments: '{}' },
      });
    else if (!interrupted) {
      emit('response.output_text.done', { output_index: 0, content_index: 0, text: reply });
      emit('response.completed', {
        response: {
          id: responseId,
          status: 'completed',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] },
          ],
          usage: {
            input_tokens: 32,
            output_tokens: pieces.length,
            total_tokens: 32 + pieces.length,
          },
        },
      });
    }
    natural = true;
    state.completed++;
    res.end();
  };
  timer = setTimeout(step, slow ? 700 : 12);
});
server.listen(port, '127.0.0.1', () =>
  process.stdout.write(`Mock Gateway listening at http://127.0.0.1:${port}; test Key: test-key\n`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
