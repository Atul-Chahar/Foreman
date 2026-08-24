// Config loading. Precedence: process env > .env file > safe defaults.
// Defaults are chosen so a fresh clone with NO configuration runs fully
// gated — a judge must hit the approval gate without touching anything.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadDotEnv(file = path.join(ROOT, '.env')) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

export function loadConfig(env = process.env) {
  loadDotEnv();
  const bool = (v, dflt) => (v === undefined || v === '' ? dflt : String(v).toLowerCase() === 'true');
  const int = (v, dflt) => (v === undefined || v === '' ? dflt : parseInt(v, 10));

  return {
    root: ROOT,
    dataDir: path.join(ROOT, 'data'),
    evidenceDir: path.join(ROOT, 'evidence'),

    // target repo (Repo B)
    targetLocal: env.FOREMAN_TARGET_LOCAL || path.join(ROOT, 'demo-target'),
    targetGithub: env.FOREMAN_TARGET_GITHUB || '',

    // MCP: real stdio MCP server when configured, local-git adapter otherwise
    mcpCommand: env.FOREMAN_MCP_COMMAND || '',
    mcpArgs: env.FOREMAN_MCP_ARGS ? env.FOREMAN_MCP_ARGS.split(/\s+/).filter(Boolean) : [],

    // TrueForge backend
    trueforgeUrl: env.FOREMAN_TRUEFORGE_URL || '',
    trueforgeToken: env.FOREMAN_TRUEFORGE_TOKEN || '',

    // policy — T2 is not configurable anywhere; that is the point.
    t1Auto: bool(env.FOREMAN_T1_AUTO, false),

    // limits
    maxConcurrency: int(env.FOREMAN_MAX_CONCURRENCY, 8),
    agentTimeoutMs: int(env.FOREMAN_AGENT_TIMEOUT_MS, 300_000),
    maxRetries: int(env.FOREMAN_MAX_RETRIES, 2),
    mergeLockTimeoutMs: int(env.FOREMAN_MERGE_LOCK_TIMEOUT_MS, 120_000),

    // cost guard
    spendCapUsd: Number(env.FOREMAN_SPEND_CAP_USD || 25),
    costPerAgentRunUsd: Number(env.FOREMAN_COST_PER_AGENT_RUN_USD || 0.15),
  };
}
