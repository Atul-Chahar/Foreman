#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../harness/config.mjs';
import { TrueForgeBackend } from '../harness/subagents/backends.mjs';

export async function runTrueForgeSmoke(config = loadConfig()) {
  if (!config.trueforgeUrl) throw new Error('FOREMAN_TRUEFORGE_URL is required');
  const backend = new TrueForgeBackend({
    config,
    github: {},
    sandbox: {},
    authorize: async () => ({ allowed: false, reason: 'smoke test never materializes files' }),
  });
  const spec = {
    id: 'smoke-trueforge',
    title: 'TrueForge protocol smoke test',
    body_excerpt: 'Return one harmless in-memory file envelope. Do not call tools.',
    acceptance_criteria: ['respond with the required JSON file envelope'],
    touches: ['smoke.txt'],
    context_files: [],
    test_command: 'node --test',
  };
  const session = await backend._json('/api/v1/sessions', {
    method: 'POST',
    body: { agent: { spec: backend._agentSpec('implementer') } },
  });
  const sessionId = session.id ?? session.sessionId;
  if (!sessionId) {
    throw new Error(`TrueForge create-session response did not contain an id: ${preview(session)}`);
  }
  const turn = await backend._json(`/api/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    body: { input: [{ type: 'user.message', content: backend.buildPrompt(spec) }] },
  });
  const turnId = backend.turnIdFrom(turn);
  if (!turnId) throw new Error(`TrueForge create-turn response did not contain an id: ${preview(turn)}`);
  return backend.completionFromTurnResponse(sessionId, turnId, turn)
    ?? backend.awaitTurn(sessionId, turnId, { pollMs: 500, maxMs: 180_000 });
}

function preview(value) {
  const text = JSON.stringify(value);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runTrueForgeSmoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(`trueforge smoke failed: ${error.message}`);
      process.exitCode = 1;
    });
}
