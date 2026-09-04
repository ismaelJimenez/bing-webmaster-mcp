import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));

const RPC = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'bin-test', version: '0' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

function runStdio(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      env: { ...process.env, BING_API_KEY: 'test-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(RPC.map((m) => JSON.stringify(m)).join('\n') + '\n');
  });
}

// npm installs `bin` entries as symlinks in node_modules/.bin, so argv[1]
// is the link while import.meta.url is the target. The server must still
// recognise itself as the main module.
test('bin launch through a symlink serves the tools over stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bwm-bin-'));
  const link = join(dir, 'bing-webmaster-mcp');
  symlinkSync(SERVER, link);
  const out = await runStdio(link);
  const messages = out.trim().split('\n').map((line) => JSON.parse(line));
  const list = messages.find((m) => m.id === 2);
  assert.ok(list, `no tools/list response; stdout was: ${JSON.stringify(out)}`);
  assert.equal(list.result.tools.length, 14);
});
