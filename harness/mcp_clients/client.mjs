// A real MCP client: JSON-RPC 2.0 over stdio. Speaks the Model Context
// Protocol handshake (initialize -> initialized -> tools/call), so Foreman
// can drive any stdio MCP server — the GitHub MCP server in production, or
// the LocalGit adapter (same tool surface, real git) for offline runs.
//
// See harness/mcp_clients/github.mjs for the tool surface Foreman uses.

import { spawn } from 'node:child_process';

/** Transport-level failure (spawn, exit, timeout). Retryable by the rate
 *  limiter; distinct from tool errors (isError), which are never retried. */
export class MCPTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MCPTransportError';
    this.code = 'MCP_TRANSPORT';
  }
}

export class MCPClient {
  /**
   * @param {object} opts
   * @param {string} opts.command executable to launch (the MCP server)
   * @param {string[]} [opts.args]
   * @param {Record<string,string>} [opts.env] extra env for the server process
   * @param {number} [opts.callTimeoutMs] per tools/call timeout
   * @param {number} [opts.initTimeoutMs] budget for the initialize handshake
   */
  constructor({ command, args = [], env = {}, callTimeoutMs = 60_000, initTimeoutMs = 15_000 }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.callTimeoutMs = callTimeoutMs;
    this.initTimeoutMs = initTimeoutMs;
    this._seq = 0;
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this._buffer = '';
    this._proc = null;
  }

  get connected() {
    return this._proc !== null && this._proc.exitCode === null;
  }

  async connect() {
    let proc;
    try {
      proc = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.env },
      });
    } catch (err) {
      throw new MCPTransportError(`MCP server spawn failed: ${err.message}`);
    }
    // Registered before anything else: a spawn failure emits 'error' and an
    // unhandled one would crash the whole harness process.
    proc.on('error', (err) => {
      this._rejectAll(new MCPTransportError(`MCP server failed: ${err.message}`));
    });
    this._proc = proc;
    proc.stdout.on('data', (d) => this._onStdout(d));
    proc.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`));
    proc.on('exit', (code) => {
      this._proc = null;
      this._rejectAll(new MCPTransportError(`MCP server exited (${code})`));
    });

    try {
      const result = await this._rpc(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'foreman', version: '0.1.0' },
        },
        this.initTimeoutMs,
      );
      this._notify('notifications/initialized');
      return result;
    } catch (err) {
      // failed handshake — never leak the child process
      await this.close();
      this._proc = null;
      throw err;
    }
  }

  async listTools() {
    const res = await this._rpc('tools/list', {});
    return res.tools ?? [];
  }

  /**
   * Call a tool. Resolves with { content: [{type:'text', text}], isError }.
   * Throws on transport failure, timeout, or protocol error.
   */
  async callTool(name, args = {}) {
    const res = await this._rpc('tools/call', { name, arguments: args });
    if (res.isError) {
      const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
      throw new Error(`MCP tool ${name} failed: ${text}`);
    }
    return res;
  }

  async close() {
    if (!this._proc) return;
    this._proc.stdin.end();
    await new Promise((r) => {
      if (this._proc.exitCode !== null) return r();
      const t = setTimeout(() => {
        this._proc?.kill();
        r();
      }, 2000);
      this._proc.on('exit', () => { clearTimeout(t); r(); });
    });
    this._proc = null;
  }

  // ── transport ─────────────────────────────────────────────────────────────

  _onStdout(chunk) {
    this._buffer += chunk.toString('utf8');
    let nl;
    while ((nl = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, nl).trim();
      this._buffer = this._buffer.slice(nl + 1);
      if (!line) continue;
      try {
        this._onMessage(JSON.parse(line));
      } catch {
        // non-JSON noise on stdout is ignored, never fatal
      }
    }
  }

  _onMessage(msg) {
    if (msg.id === undefined || msg.id === null) return; // notification
    const p = this._pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this._pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }

  _rejectAll(err) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  _rpc(method, params, timeoutMs = this.callTimeoutMs) {
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new MCPTransportError('MCP server not connected'));
      const timer = setTimeout(
        () => {
          this._pending.delete(id);
          reject(new MCPTransportError(`MCP ${method} timed out after ${timeoutMs}ms`));
        },
        timeoutMs,
      );
      this._pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  _notify(method, params = {}) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  _send(msg) {
    this._proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }
}
