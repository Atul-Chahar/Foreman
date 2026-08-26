import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MCPClient, MCPTransportError } from '../mcp_clients/client.mjs';
import { RateLimiter } from '../mcp_clients/ratelimit.mjs';

// A minimal newline-delimited JSON-RPC MCP server for controlled testing.
const FIXTURE_SERVER = `
const state = { tools: 0 };
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '0.0.1' } });
    } else if (msg.method === 'tools/list') {
      reply(msg.id, { tools: [{ name: 'echo' }, { name: 'fail' }, { name: 'slow' }] });
    } else if (msg.method === 'tools/call') {
      if (msg.params.name === 'echo') {
        reply(msg.id, { content: [{ type: 'text', text: JSON.stringify({ echoed: msg.params.arguments }) }] });
      } else if (msg.params.name === 'fail') {
        reply(msg.id, { isError: true, content: [{ type: 'text', text: 'boom' }] });
      } else if (msg.params.name === 'slow') {
        setTimeout(() => reply(msg.id, { content: [{ type: 'text', text: 'late' }] }), 5000);
      }
    }
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
`;

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-mcpf-'));
  const file = path.join(dir, 'server.mjs');
  fs.writeFileSync(file, FIXTURE_SERVER);
  return file;
}

test('mcp client: handshake, tool call, and structured results over stdio', async () => {
  const client = new MCPClient({ command: process.execPath, args: [writeFixture()] });
  try {
    await client.connect();
    assert.equal(client.connected, true);
    const tools = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'echo'));
    const res = await client.callTool('echo', { hello: 'world' });
    assert.deepEqual(JSON.parse(res.content[0].text), { echoed: { hello: 'world' } });
  } finally {
    await client.close();
  }
});

test('mcp client: tool errors (isError) throw as tool failures, not transport errors', async () => {
  const client = new MCPClient({ command: process.execPath, args: [writeFixture()] });
  try {
    await client.connect();
    await assert.rejects(
      () => client.callTool('fail'),
      (e) => !e.code && /MCP tool fail failed: boom/.test(e.message),
    );
  } finally {
    await client.close();
  }
});

test('mcp client: spawn failure rejects instead of crashing the process', async () => {
  const client = new MCPClient({ command: '/nonexistent/definitely-not-here' });
  await assert.rejects(() => client.connect(), MCPTransportError);
  assert.equal(client.connected, false);
});

test('mcp client: server exit mid-call rejects pending RPCs with a transport error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-mcpx-'));
  const script = path.join(dir, 'die.mjs');
  fs.writeFileSync(script, 'setTimeout(() => process.exit(3), 100);\n');
  const client = new MCPClient({ command: process.execPath, args: [script] });
  // never completes the handshake before exit; connect must reject
  await assert.rejects(() => client.connect(), (e) => e.code === 'MCP_TRANSPORT');
});

test('mcp client: per-call timeout surfaces as a retryable transport error', async () => {
  const client = new MCPClient({
    command: process.execPath,
    args: [writeFixture()],
    callTimeoutMs: 120,
  });
  try {
    await client.connect();
    await assert.rejects(
      () => client.callTool('slow'),
      (e) => e.code === 'MCP_TRANSPORT' && /timed out/.test(e.message),
    );
  } finally {
    await client.close();
  }
});

test('rate limiter: transport failures are retried; tool errors are not', async () => {
  const rl = new RateLimiter({ capacity: 5, refillPerSec: 1000, maxAttempts: 3 });
  let transportTries = 0;
  const flakyTransport = async () => {
    transportTries++;
    if (transportTries < 3) {
      const e = new Error('stdin pipe broke');
      e.code = 'MCP_TRANSPORT';
      throw e;
    }
    return 'recovered';
  };
  assert.equal(await rl.run(flakyTransport), 'recovered');
  assert.equal(transportTries, 3);

  let hardTries = 0;
  await assert.rejects(
    () =>
      rl.run(async () => {
        hardTries++;
        throw new Error('tool failed permanently');
      }),
    /permanently/,
  );
  assert.equal(hardTries, 1, 'non-retryable errors must fail on first attempt');
});

test('rate limiter: backoff does not hold a concurrency slot', async () => {
  const rl = new RateLimiter({ capacity: 2, refillPerSec: 1000, maxAttempts: 3 });
  let peak = 0;
  let concurrent = 0;
  const op = async (attempt) => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 10));
    concurrent--;
    if (attempt < 2) {
      throw new Error('HTTP 429: rate limit');
    }
    return 'ok';
  };
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 6 }, () => rl.run(op)));
  assert.equal(results.every((r) => r === 'ok'), true);
  assert.ok(peak <= 2, `peak ${peak} exceeded capacity`);
  assert.ok(Date.now() - t0 < 8000, 'backoff outside the slot keeps throughput sane');
});
