import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSkills, parseSkill, composePrompt, specBlock, SkillError } from '../skills/loader.mjs';
import { fileURLToPath } from 'node:url';

const REPO_SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

test('loader: loads the real skill pack with valid frontmatter', () => {
  const registry = loadSkills(REPO_SKILLS);
  for (const name of ['planner', 'implementer', 'reconciler', 'reviewer',
    'tdd-workflow', 'security-review', 'build-fix', 'search-first', 'context-budget']) {
    assert.ok(registry.has(name), `skill '${name}' must exist`);
    const s = registry.get(name);
    assert.ok(s.description.length > 10, `${name}: description too short`);
    assert.ok(s.body.length > 100, `${name}: body too short to be useful`);
  }
});

test('loader: missing skills directory fails loud', () => {
  assert.throws(() => loadSkills(path.join(os.tmpdir(), 'foreman-nope-xyz')), SkillError);
});

test('loader: malformed, mismatched, and duplicate skills are rejected', () => {
  const mk = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sk-'));
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'SKILL.md'), content);
    }
    return dir;
  };

  assert.throws(() => loadSkills(mk({ bad: 'no frontmatter here' })), /frontmatter/);
  assert.throws(() => loadSkills(mk({ mismatch: '---\nname: different\ndescription: x\n---\nbody' })), /must match its directory/);
  // name collisions are impossible while names must match their directory;
  // the collision surfaces as the directory-mismatch error either way
  assert.throws(() => loadSkills(mk({
    a: '---\nname: dup\ndescription: x\n---\nbody',
    b: '---\nname: dup\ndescription: x\n---\nbody',
  })), /must match its directory|duplicate skill name/);
  assert.throws(() => loadSkills(mk({ nodescription: '---\nname: nodescription\n---\nbody' })), /missing 'description'/);
});

test('parse: tags parse into a list, empty body is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sk4-'));
  const file = path.join(dir, 'sample', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nname: sample\ndescription: d\ntags: role, competency\n---\n\nuseful body text');
  const skill = parseSkill(file, 'test');
  assert.deepEqual(skill.tags, ['role', 'competency']);

  fs.writeFileSync(file, '---\nname: sample\ndescription: d\n---\n');
  assert.throws(() => parseSkill(file, 'test'), /empty body/);
});

test('composePrompt: role + extras + spec, never unrelated skills or repo trees', () => {
  const registry = loadSkills(REPO_SKILLS);
  const prompt = composePrompt({
    role: 'implementer',
    registry,
    extraSkills: ['tdd-workflow', 'search-first'],
    spec: {
      id: 'task-007',
      title: 'Add search endpoint',
      issue_number: 7,
      acceptance_criteria: ['GET /todos?q= returns filtered', 'empty q returns all'],
      touches: ['src/routes/todos.mjs'],
      context_files: ['src/routes/todos.mjs', 'src/db.mjs'],
      test_command: 'node --test test/todos.test.mjs',
      conflicts_with: ['task-003'],
      failure_output: 'AssertionError: expected 3 to equal 4',
      culprit: { id: 'task-005', title: 'evil semantics change' },
    },
  });

  assert.ok(prompt.includes('# Skill: implementer (role)'));
  assert.ok(prompt.includes('# Skill: tdd-workflow (competency)'));
  assert.ok(prompt.includes('# Skill: search-first (competency)'));
  assert.ok(prompt.includes('id: task-007'));
  assert.ok(prompt.includes('- GET /todos?q= returns filtered'));
  assert.ok(prompt.includes('- src/routes/todos.mjs'));
  assert.ok(prompt.includes('test_command: node --test test/todos.test.mjs'));
  assert.ok(prompt.includes('in_flight_conflicts'));
  assert.ok(prompt.includes('failure_output'));
  assert.ok(prompt.includes('culprit_merge: task-005'));

  // context-budget: unrelated skills and repo trees never leak in
  assert.ok(!prompt.includes('# Skill: planner'));
  assert.ok(!prompt.includes('# Skill: security-review'));
  assert.ok(!prompt.includes('node_modules'));
});

test('composePrompt: unknown role or extra skill throws', () => {
  const registry = loadSkills(REPO_SKILLS);
  assert.throws(() => composePrompt({ role: 'wizard', registry, spec: {} }), SkillError);
  assert.throws(() => composePrompt({ role: 'implementer', registry, extraSkills: ['nope'], spec: {} }), SkillError);
});

test('specBlock: handles minimal specs without crashing', () => {
  const block = specBlock({ id: 'fix-001' });
  assert.ok(block.includes('id: fix-001'));
  assert.ok(!block.includes('test_command'));
});
