import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const children = [];
function run(command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  children.push(child);
  return child;
}
if (!existsSync('dist/index.html'))
  await new Promise((resolve, reject) =>
    run('pnpm', ['build']).on('exit', (code) =>
      code ? reject(new Error('Build failed')) : resolve(),
    ),
  );
if (process.argv.includes('--mock')) run('node', ['scripts/mock-gateway.mjs']);
run('pnpm', [
  'exec',
  'wrangler',
  'dev',
  '--config',
  'wrangler.local.jsonc',
  '--ip',
  '127.0.0.1',
  '--port',
  '8787',
  '--var',
  'PUBLIC_ORIGIN:http://127.0.0.1:5173',
]);
run('pnpm', ['exec', 'vite']);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit();
  });
