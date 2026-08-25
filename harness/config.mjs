// Config loading. Precedence: process env > .env file > safe defaults.
// Defaults are chosen so a fresh clone with NO configuration runs fully
// gated — a judge must hit the approval gate without touching anything.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at <root>/harness/config.mjs — one level up is the repo root.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ dotenvFile?: string }} [opts] override the .env path (tests)
 */
export function loadConfig(env = process.env, opts = {}) {
  const fileVars = parseDotEnv(opts.dotenvFile ?? path.join(ROOT, '.env'));
  // Keep the historical side effect: values not already in the real process
  // environment are exported so child processes (MCP servers, agents)
  // inherit them. Precedence for THIS config: explicit `env` > .env file.
  for (const [key, value] of Object.entries(fileVars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const e = { ...fileVars, ...env };
  const bool = (v, dflt) => (v === undefined || v === '' ? dflt : String(v).toLowerCase() === 'true');
  const int = (v, dflt) => (v === undefined || v === '' ? dflt : parseInt(v, 10));

  return {
    root: ROOT,
    dataDir: path.join(ROOT, 'data'),
    evidenceDir: path.join(ROOT, 'evidence'),

    // target repo (Repo B)
    targetLocal: e.FOREMAN_TARGET_LOCAL || path.join(ROOT, 'demo-target'),
    targetGithub: e.FOREMAN_TARGET_GITHUB || '',

    // MCP: real stdio MCP server when configured, local-git adapter otherwise
    mcpCommand: e.FOREMAN_MCP_COMMAND || '',
    mcpArgs: e.FOREMAN_MCP_ARGS ? e.FOREMAN_MCP_ARGS.split(/\s+/).filter(Boolean) : [],

    // TrueForge backend
    trueforgeUrl: e.FOREMAN_TRUEFORGE_URL || '',
    trueforgeToken: e.FOREMAN_TRUEFORGE_TOKEN || '',
    trueforgeModel: e.FOREMAN_TRUEFORGE_MODEL || '',

    // policy — T2 is not configurable anywhere; that is the point.
    t1Auto: bool(e.FOREMAN_T1_AUTO, false),

    // limits
    maxConcurrency: int(e.FOREMAN_MAX_CONCURRENCY, 8),
    agentTimeoutMs: int(e.FOREMAN_AGENT_TIMEOUT_MS, 300_000),
    maxRetries: int(e.FOREMAN_MAX_RETRIES, 2),
    mergeLockTimeoutMs: int(e.FOREMAN_MERGE_LOCK_TIMEOUT_MS, 120_000),

    // cost guard
    spendCapUsd: Number(e.FOREMAN_SPEND_CAP_USD || 25),
    costPerAgentRunUsd: Number(e.FOREMAN_COST_PER_AGENT_RUN_USD || 0.15),
  };
}
