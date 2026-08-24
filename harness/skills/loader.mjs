// Skill loader. Skills are plain markdown files with a small frontmatter
// header — the interchange format every agent harness understands:
//
//   skills/<name>/SKILL.md
//   ---
//   name: implementer
//   description: one line
//   tags: role, competency
//   ---
//   ...instructions...
//
// The registry is built once at orchestrator startup. A missing, malformed,
// or duplicate skill fails loudly: a swarm dispatched with broken instructions
// is worse than a swarm that never starts.

import fs from 'node:fs';
import path from 'node:path';

export class SkillError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkillError';
  }
}

const REQUIRED_FIELDS = ['name', 'description'];
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSkill(file, source) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) {
    throw new SkillError(`${source}: missing frontmatter (expected '---' header with name and description)`);
  }
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([a-z_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (kv) meta[kv[1]] = kv[2];
  }
  for (const field of REQUIRED_FIELDS) {
    if (!meta[field]) throw new SkillError(`${source}: frontmatter is missing '${field}'`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(meta.name)) {
    throw new SkillError(`${source}: skill name '${meta.name}' must be kebab-case`);
  }
  const dirName = path.basename(path.dirname(file));
  if (meta.name !== dirName) {
    throw new SkillError(`${source}: skill name '${meta.name}' must match its directory '${dirName}'`);
  }
  const body = raw.slice(m[0].length).trim();
  if (body.length === 0) throw new SkillError(`${source}: skill has an empty body`);
  return {
    name: meta.name,
    description: meta.description,
    tags: meta.tags ? meta.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    body,
    file,
  };
}

/**
 * Load every skills/<name>/SKILL.md under `dir`.
 * @returns {Map<string, object>} registry keyed by skill name
 */
export function loadSkills(dir) {
  if (!fs.existsSync(dir)) {
    throw new SkillError(`skills directory not found: ${dir}`);
  }
  const registry = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) {
      throw new SkillError(`skills/${entry.name}: directory has no SKILL.md`);
    }
    const skill = parseSkill(file, `skills/${entry.name}/SKILL.md`);
    if (registry.has(skill.name)) {
      throw new SkillError(`duplicate skill name '${skill.name}'`);
    }
    registry.set(skill.name, skill);
  }
  if (registry.size === 0) throw new SkillError(`no skills found under ${dir}`);
  return registry;
}

function mustGet(registry, name, context) {
  const skill = registry.get(name);
  if (!skill) {
    const known = [...registry.keys()].sort().join(', ');
    throw new SkillError(`${context}: unknown skill '${name}' (known: ${known})`);
  }
  return skill;
}

/**
 * Assemble a subagent prompt: role skill + competency skills + the
 * structured task spec. Context-budget discipline is enforced here — the
 * prompt carries spec fields and context-file PATHS only. Never the repo
 * tree, never whole issue bodies, never unrelated skills.
 */
export function composePrompt({ role, spec, registry, extraSkills = [] }) {
  const parts = [];
  const seen = new Set();
  const include = (name, why) => {
    if (seen.has(name)) return;
    seen.add(name);
    parts.push(`# Skill: ${name} (${why})\n\n${mustGet(registry, name, `composePrompt(${why})`).body}`);
  };

  include(role, 'role');
  for (const name of extraSkills) include(name, 'competency');

  parts.push(specBlock(spec));
  return parts.join('\n\n---\n\n');
}

/** Render the spec as the final, data-only section of every prompt. */
export function specBlock(spec = {}) {
  const lines = ['# Task spec', ''];
  lines.push(`id: ${spec.id ?? '(none)'}`);
  if (spec.title) lines.push(`title: ${spec.title}`);
  if (spec.issue_number != null) lines.push(`issue: #${spec.issue_number}`);

  if (Array.isArray(spec.acceptance_criteria) && spec.acceptance_criteria.length) {
    lines.push('', 'acceptance_criteria:');
    for (const c of spec.acceptance_criteria) lines.push(`  - ${c}`);
  }
  if (Array.isArray(spec.touches) && spec.touches.length) {
    lines.push('', 'scope — only modify these files:');
    for (const f of spec.touches) lines.push(`  - ${f}`);
  }
  if (Array.isArray(spec.context_files) && spec.context_files.length) {
    lines.push('', 'context (read before writing):');
    for (const f of spec.context_files) lines.push(`  - ${f}`);
  }
  if (spec.test_command) lines.push('', `test_command: ${spec.test_command}`);
  if (Array.isArray(spec.conflicts_with) && spec.conflicts_with.length) {
    lines.push('', `in_flight_conflicts (do not touch): ${spec.conflicts_with.join(', ')}`);
  }
  if (spec.failure_output) {
    lines.push('', 'failure_output (what broke on main):', '```', tail(spec.failure_output, 4000), '```');
  }
  if (spec.culprit) {
    lines.push('', `culprit_merge: ${spec.culprit.id ?? '?'} — "${spec.culprit.title ?? ''}"`);
  }
  return lines.join('\n');
}

function tail(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `...${str.slice(-n)}` : str;
}
