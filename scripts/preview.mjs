import { spawn } from 'node:child_process';
const children = [];
function run(cmd, args) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  children.push(child);
  return child;
}
await new Promise((resolve, reject) =>
  run('node_modules/.bin/vite', ['build']).on('exit', (code) =>
    code ? reject(new Error('Build failed')) : resolve(),
  ),
);
run('node', ['scripts/mock-gateway.mjs']);
run('node_modules/.bin/wrangler', [
  'dev',
  '--config',
  'wrangler.local.jsonc',
  '--ip',
  '127.0.0.1',
  '--port',
  '8787',
]);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit();
  });
