import { test, expect, type Page } from '@playwright/test';
import { docx, pdf } from '../../packages/file-review/test/fixture-builders';

async function openSettings(page: Page, panel: 'gateway' | 'local' = 'gateway') {
  const menu = page.getByRole('button', { name: '展开导航', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  if (panel === 'local')
    await page.getByRole('tab', { name: '档案、存储与备份', exact: true }).click();
}
async function connectGateway(page: Page, key = 'test-key') {
  await openSettings(page);
  await expect(page.getByLabel('Gateway URL', { exact: true })).toHaveValue(
    'http://127.0.0.1:8790',
  );
  await page.getByLabel('Gateway API Key', { exact: true }).fill(key);
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('模型', { exact: true })).toBeEnabled();
}
async function setup(page: Page, key = 'test-key') {
  await page.goto('/');
  await page.getByRole('button', { name: '创建本机档案', exact: true }).click();
  await connectGateway(page, key);
}
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: '输入问题' }).fill(text);
  await page.getByRole('button', { name: '预览并发送', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认本轮发送内容' })).toBeVisible();
  await page.getByRole('button', { name: '确认发送', exact: true }).click();
}
async function completed(page: Page, count = 1) {
  await expect(
    page.locator('.message.assistant .message-heading').filter({ hasText: '已完成' }),
  ).toHaveCount(count);
}
async function attach(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByLabel('选择附件', { exact: true }).setInputFiles({ name, mimeType, buffer });
}

test('custom Gateway URL is validated and retained when another connection fails or is cancelled', async ({
  page,
}) => {
  await setup(page);
  const destinations: { path: string; gateway: string | undefined }[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/models' || path === '/api/chat')
      destinations.push({ path, gateway: request.headers()['x-gateway-url'] });
  });
  await openSettings(page);
  const url = page.getByLabel('Gateway URL', { exact: true });
  await expect(url).toBeEditable();
  await url.fill('http://127.0.0.1:8790/v1/');
  await page.getByLabel('Gateway API Key', { exact: true }).fill('test-key');
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toHaveCount(0);
  expect(destinations).toContainEqual({ path: '/api/models', gateway: 'http://127.0.0.1:8790/v1' });

  await openSettings(page);
  await expect(url).toHaveValue('http://127.0.0.1:8790/v1');
  await url.fill('http://127.0.0.1:8790');
  await page.getByLabel('Gateway API Key', { exact: true }).fill('invalid-key');
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Key 无效');
  await expect(page.getByText('已连接 Gateway', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await send(page, '使用已验证的自定义 Gateway');
  await completed(page);

  await openSettings(page);
  await expect(url).toHaveValue('http://127.0.0.1:8790/v1');
  await url.fill('https://unused.example.com/v1');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await send(page, '取消修改后继续聊天');
  await completed(page, 2);
  expect(destinations.filter((request) => request.path === '/api/chat')).toEqual([
    { path: '/api/chat', gateway: 'http://127.0.0.1:8790/v1' },
    { path: '/api/chat', gateway: 'http://127.0.0.1:8790/v1' },
  ]);
});

test('two turns persist before network, reloading clears Key, shell works offline', async ({
  page,
  context,
}) => {
  await setup(page);
  let savedBeforeRequest = false;
  await page.route('**/api/chat', async (route) => {
    savedBeforeRequest = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('webchat-local');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const count = await new Promise<number>((resolve) => {
        const req = db.transaction('messages').objectStore('messages').count();
        req.onsuccess = () => resolve(req.result);
      });
      db.close();
      return count >= 2;
    });
    await route.continue();
  });
  await send(page, '第一轮：你好');
  await completed(page);
  expect(savedBeforeRequest).toBe(true);
  await send(page, '第二轮：继续解释');
  await completed(page, 2);
  await expect(page.locator('.markdown').last()).toContainText('第 2 轮问题');
  const databases = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('webchat-local');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const data = await Promise.all(
      [...db.objectStoreNames].map(
        (name) =>
          new Promise<unknown[]>((resolve) => {
            const req = db.transaction(name).objectStore(name).getAll();
            req.onsuccess = () => resolve(req.result);
          }),
      ),
    );
    db.close();
    return JSON.stringify(data);
  });
  expect(databases).not.toContain('test-key');
  await page.unroute('**/api/chat');
  await page.reload();
  await expect(page.getByLabel('模型', { exact: true })).toBeDisabled();
  await openSettings(page);
  await expect(page.getByText('未连接 Gateway', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Gateway API Key', { exact: true })).toHaveValue('');
  await page
    .getByRole('dialog', { name: '设置', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  await expect(page.getByText('离线 · 可查看历史', { exact: true })).toBeVisible();
});

test('attachment checking stays local and preview equals immutable transmitted document', async ({
  page,
}) => {
  await setup(page);
  let chatBody: unknown;
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/')) apiRequests.push(request.url());
    if (request.url().endsWith('/api/chat')) chatBody = request.postDataJSON();
  });
  const before = apiRequests.length;
  await attach(
    page,
    '材料.txt',
    'text/plain',
    Buffer.from('唯一资料：这段文字仅在明确发送后离开设备。\r\n第二行。'),
  );
  await expect(page.locator('.attachment-card')).toContainText('可发送');
  expect(apiRequests.length).toBe(before);
  await page.getByRole('button', { name: '查看实际发送版本', exact: true }).click();
  await expect(page.locator('.extraction-preview')).toHaveText(
    '唯一资料：这段文字仅在明确发送后离开设备。\n第二行。',
  );
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await send(page, '这份材料说什么？');
  await completed(page);
  expect(JSON.stringify(chatBody)).toContain(
    '唯一资料：这段文字仅在明确发送后离开设备。\\n第二行。',
  );
  expect(JSON.stringify(chatBody)).not.toContain('sourceSha256');
  await send(page, '依据同一份附件继续回答');
  await completed(page, 2);
  const current = chatBody as { messages: { content: { type: string; text?: string }[] }[] };
  expect(
    current.messages.flatMap((m) => m.content).filter((c) => c.type === 'document_text'),
  ).toHaveLength(1);
});

test('ordinary PDF uses patched isolated parser and requires extraction confirmation', async ({
  page,
}) => {
  await setup(page);
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') violations.push(message.text());
  });
  await attach(page, '普通文字.pdf', 'application/pdf', Buffer.from(pdf()));
  await expect(page.locator('.attachment-card')).toContainText('等待确认', { timeout: 20000 });
  await page.getByRole('button', { name: '查看并确认提取模式' }).click();
  await expect(page.locator('.extraction-preview')).toContainText('ordinary document');
  await expect(page.locator('.loss-warning')).toContainText('图表');
  await page.getByRole('button', { name: '我已检查预览，接受上述提取模式' }).click();
  await expect(page.locator('.attachment-card')).toContainText('可发送');
  await send(page, '概括文档');
  await completed(page);
  expect(violations.filter((v) => /content.security|refused to|unsafe-eval/i.test(v))).toEqual([]);
});

test('simple DOCX table is parsed locally and active PDF fails closed', async ({ page }) => {
  await setup(page);
  await attach(
    page,
    '表格.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    Buffer.from(
      docx(
        '<w:p><w:r><w:t>Project notes</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Alpha</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      ),
    ),
  );
  await expect(page.locator('.attachment-card')).toContainText('可发送', { timeout: 20000 });
  await page.getByRole('button', { name: '查看实际发送版本' }).click();
  await expect(page.locator('.extraction-preview')).toContainText('Alpha');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await attach(
    page,
    '主动动作.pdf',
    'application/pdf',
    Buffer.from(pdf({ catalog: '/OpenAction << /S /Launch /F (forbidden) >>' })),
  );
  await expect(page.locator('.attachment-card.rejected')).toContainText('主动内容');
  await page.getByRole('textbox', { name: '输入问题' }).fill('应该阻止发送');
  await expect(page.getByRole('button', { name: '预览并发送', exact: true })).toBeDisabled();
});

test('image normalized preview and follow-up retain one image', async ({ page }) => {
  await setup(page);
  await page.getByLabel('模型', { exact: true }).selectOption('mock-vision');
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 80;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#776099';
    ctx.fillRect(0, 0, 120, 80);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await attach(page, '小图.png', 'image/png', Buffer.from(bytes, 'base64'));
  await expect(page.locator('.attachment-card')).toContainText('等待确认');
  await page.getByRole('button', { name: '查看并确认提取模式' }).click();
  await expect(page.locator('.image-preview')).toBeVisible();
  await page.getByRole('button', { name: '我已检查预览，接受上述提取模式' }).click();
  await expect(page.locator('.attachment-card')).toContainText('可发送');
  await send(page, '描述图片');
  await completed(page);
  await send(page, '同一张图再说明一下');
  await completed(page, 2);
  await expect(page.locator('.markdown').last()).toContainText('上下文包含 1 张图片');
});

test('stop propagates cancellation, saves partial content, retry is explicit', async ({
  page,
  request,
}) => {
  await setup(page);
  const before = await (await request.get('http://127.0.0.1:8790/__state')).json();
  await send(page, '慢速测试');
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await expect(page.locator('.markdown')).toContainText('这是本地');
  await page.getByRole('button', { name: '停止生成' }).click();
  await expect(page.locator('.message.assistant .message-heading')).toContainText('已取消');
  await expect
    .poll(async () => (await (await request.get('http://127.0.0.1:8790/__state')).json()).cancelled)
    .toBeGreaterThan(before.cancelled);
  const after = await (await request.get('http://127.0.0.1:8790/__state')).json();
  await page.getByRole('button', { name: '手动重试' }).click();
  await expect(page.getByRole('textbox', { name: '输入问题' })).toHaveValue('慢速测试');
  expect((await (await request.get('http://127.0.0.1:8790/__state')).json()).generations).toBe(
    after.generations,
  );
});

test('two tabs cannot generate concurrently in the same conversation', async ({
  page,
  context,
  request,
}) => {
  await setup(page);
  await send(page, '建立共享会话');
  await completed(page);
  const second = await context.newPage();
  await second.goto('/');
  await connectGateway(second);
  await second.getByRole('textbox', { name: '输入问题' }).fill('第二标签页');
  await second.getByRole('button', { name: '预览并发送' }).click();
  await expect(second.getByRole('dialog', { name: '确认本轮发送内容' })).toBeVisible();
  await send(page, '慢速测试');
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  await expect(page.locator('.markdown').last()).toContainText('这是本地');
  const before = await (await request.get('http://127.0.0.1:8790/__state')).json();
  await second.getByRole('button', { name: '确认发送', exact: true }).click();
  await expect(second.getByRole('status')).toContainText('另一标签页');
  expect((await (await request.get('http://127.0.0.1:8790/__state')).json()).generations).toBe(
    before.generations,
  );
  await page.getByRole('button', { name: '停止生成' }).click();
  await second.close();
});

test('backup round trip creates remapped history and keeps Key out of archive', async ({
  page,
}) => {
  await setup(page);
  await attach(page, '备份材料.txt', 'text/plain', Buffer.from('Backup document'));
  await expect(page.locator('.attachment-card')).toContainText('可发送');
  await send(page, '可恢复的对话');
  await completed(page);
  await openSettings(page, 'local');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出档案备份', exact: true }).click();
  const backup = await downloaded;
  const path = await backup.path();
  expect(path).toBeTruthy();
  const stream = await backup.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).not.toContain('test-key');
  await page.getByLabel('选择备份', { exact: true }).setInputFiles(path!);
  await expect(page.getByRole('status')).toContainText('备份已恢复', { timeout: 20000 });
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.conversation-row')).toHaveCount(2);
  await send(page, '恢复后继续');
  await completed(page, 2);
});

test('Markdown HTML and external images do not execute or fetch', async ({ page }) => {
  await setup(page);
  let remote = 0;
  page.on('request', (request) => {
    if (request.url().includes('attacker.invalid')) remote++;
  });
  const text =
    '<img src="x" onerror="window.pwned=true"> ![tracking](https://attacker.invalid/pixel) [bad](javascript:alert(1))';
  await send(page, text);
  await completed(page);
  expect(remote).toBe(0);
  expect(await page.evaluate(() => Object.hasOwn(window, 'pwned'))).toBe(false);
  await expect(page.locator('.markdown img')).toHaveCount(0);
});

test('mobile layout exposes drawer and usable composer', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await expect(page.getByRole('textbox', { name: '输入问题' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: '展开导航' }).click();
  await expect(page.getByRole('navigation', { name: '会话列表' })).toBeVisible();
  await page.getByRole('button', { name: '收起导航' }).click();
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
});

test('quota and abnormal end retain safe errors without automatic retry', async ({
  page,
  request,
}) => {
  await setup(page, 'quota-key');
  let calls = 0;
  page.on('request', (req) => {
    if (req.url().endsWith('/api/chat')) calls++;
  });
  await send(page, '额度不足测试');
  await expect(page.getByRole('status')).toContainText('额度不足');
  expect(calls).toBe(1);
  await expect(page.locator('.message.user')).toContainText('额度不足测试');
  await expect(page.locator('.message.assistant')).toContainText('生成失败');
  await connectGateway(page);
  await send(page, '异常结束');
  await expect(page.locator('.message.assistant .message-heading').last()).toContainText(
    '连接中断',
  );
  await expect(page.locator('.markdown').last()).toContainText('这是本地模拟回复');
  expect(calls).toBe(2);
  const response = await request.get('/api/nonexistent');
  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['cache-control']).toBe('no-store');
});

test('storage transaction failure prevents any generation request and preserves draft', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof original>) {
      if (this.name === 'messages' && (window as unknown as { failWrites?: boolean }).failWrites)
        throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await setup(page);
  let calls = 0;
  page.on('request', (req) => {
    if (req.url().endsWith('/api/chat')) calls++;
  });
  await page.evaluate(() => {
    (window as unknown as { failWrites: boolean }).failWrites = true;
  });
  await send(page, '保存失败时不能先发送');
  await expect(page.getByRole('status')).toContainText('存储空间不足');
  expect(calls).toBe(0);
  await expect(page.getByRole('textbox', { name: '输入问题' })).toHaveValue('保存失败时不能先发送');
});

test('policy changes stop send and require a fresh explicit action', async ({ page }) => {
  await setup(page);
  let calls = 0;
  page.on('request', (req) => {
    if (req.url().endsWith('/api/chat')) calls++;
  });
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.policyVersion = 'file-policy-v2';
    await route.fulfill({ json: body });
  });
  await page.getByRole('textbox', { name: '输入问题' }).fill('版本已变化');
  await page.getByRole('button', { name: '预览并发送' }).click();
  await expect(page.getByRole('status')).toContainText('策略已更新');
  expect(calls).toBe(0);
  await expect(page.getByRole('textbox', { name: '输入问题' })).toHaveValue('版本已变化');
});

test('50 local imports and removals leave no parser workers or unattached blobs', async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    const active = new Set<Worker>();
    (window as unknown as { reviewWorkers: Set<Worker> }).reviewWorkers = active;
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        active.add(this);
      }
      override terminate() {
        active.delete(this);
        super.terminate();
      }
    };
  });
  await setup(page);
  const started = Date.now();
  for (let index = 0; index < 50; index++) {
    await attach(page, `重复导入-${index}.txt`, 'text/plain', Buffer.from(`Local text ${index}`));
    await expect(page.locator('.attachment-card')).toContainText('可发送');
    await page.getByRole('button', { name: `移除 重复导入-${index}.txt`, exact: true }).click();
    await expect(page.locator('.attachment-card')).toHaveCount(0);
  }
  expect(
    await page.evaluate(
      () => (window as unknown as { reviewWorkers: Set<Worker> }).reviewWorkers.size,
    ),
  ).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const r = indexedDB.open('webchat-local');
          r.onsuccess = () => resolve(r.result);
        });
        const count = await new Promise<number>((resolve) => {
          const r = db.transaction('blobs').objectStore('blobs').count();
          r.onsuccess = () => resolve(r.result);
        });
        db.close();
        return count;
      }),
    )
    .toBe(0);
  await testInfo.attach('local-import-timing', {
    body: JSON.stringify({ iterations: 50, elapsedMs: Date.now() - started, activeWorkers: 0 }),
    contentType: 'application/json',
  });
});

test('a newer compatible database opens read-only and keeps export available', async ({ page }) => {
  await setup(page);
  await send(page, '较新数据库里的历史');
  await completed(page);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('webchat-local', 2);
      request.onupgradeneeded = () => request.result.createObjectStore('futureRecords');
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.reload();
  await expect(page.getByRole('status')).toContainText('只读模式');
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '输入问题' })).toBeDisabled();
  await openSettings(page, 'local');
  await expect(page.getByRole('button', { name: '导出档案备份' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '清除当前档案' })).toBeDisabled();
});

test('unavailable storage offers explicit temporary text chat with working follow-up', async ({
  page,
}) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
  await page.goto('/');
  await page.getByRole('button', { name: '进入临时文字聊天' }).click();
  await connectGateway(page);
  await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeDisabled();
  await send(page, '临时第一轮');
  await completed(page);
  await send(page, '临时第二轮');
  await completed(page, 2);
  await expect(page.locator('.markdown').last()).toContainText('第 2 轮问题');
});

test('refresh cancels the old stream and recovers only the abandoned run', async ({
  page,
  request,
}) => {
  test.setTimeout(40000);
  await setup(page);
  await send(page, '慢速测试');
  await expect(page.locator('.markdown')).toContainText('这是本地');
  const before = await (await request.get('http://127.0.0.1:8790/__state')).json();
  await page.reload();
  await expect(page.getByLabel('模型', { exact: true })).toBeDisabled();
  await expect(page.locator('.message.assistant .message-heading')).toContainText(
    /连接中断|已取消/,
    { timeout: 22000 },
  );
  expect((await (await request.get('http://127.0.0.1:8790/__state')).json()).generations).toBe(
    before.generations,
  );
});

test('stream persistence failure aborts generation and keeps downloadable memory output', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (
        this.name === 'messages' &&
        (window as unknown as { failStreamWrites?: boolean }).failStreamWrites
      )
        throw new DOMException('Synthetic streaming quota failure', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await setup(page);
  await send(page, '慢速测试');
  await expect(page.locator('.markdown')).toContainText('这是本地');
  const before = await (await request.get('http://127.0.0.1:8790/__state')).json();
  await page.evaluate(() => {
    (window as unknown as { failStreamWrites: boolean }).failStreamWrites = true;
  });
  await expect(page.locator('.unsaved')).toContainText('尚未可靠保存');
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0);
  await expect
    .poll(async () => (await (await request.get('http://127.0.0.1:8790/__state')).json()).cancelled)
    .toBeGreaterThan(before.cancelled);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出内存内容' }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('未保存的回复.txt');
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toContain('这是本地');
});
