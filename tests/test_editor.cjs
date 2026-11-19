'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const catalogModule = require('../src/catalog-data.js');
const { parseNrbf, serializeNrbf } = require('../src/nrbf-codec.js');
const {
  createDemoNrbfBytes,
  readState,
  applyPreset,
  applyState,
  validateState,
  diffStates,
  formatGameDate,
  computeCombatStats,
  PRESETS,
} = require('../src/editor-core.js');

const catalog = catalogModule.CATALOG ?? catalogModule.catalog ?? catalogModule;
const fixtureDirectory = '/tmp/jhl_real_saves_ro';

function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function students(state) {
  return state.students ?? state.student ?? state.playerSchool?.students ??
    state.playerSchool?.student;
}

function school(state) {
  return state.school ?? state.playerSchool ?? state;
}

function values(state) {
  return {
    money: school(state).money,
    jhMoney: school(state).jhMoney,
    food: school(state).food,
    str: students(state)[0].attr.str,
  };
}

function editState(state) {
  const edited = structuredClone(state);
  const before = values(state);
  for (const key of Object.keys(before)) {
    assert.ok(Number.isFinite(before[key]), `Expected numeric ${key}`);
  }
  school(edited).money += 137;
  school(edited).jhMoney += 29;
  school(edited).food += 11;
  const attr = students(edited)[0].attr;
  attr.str += attr.str > 1 ? -1 : 1;
  return edited;
}

function reparse(graph, state) {
  const updated = applyState(graph, state);
  return parseNrbf(serializeNrbf(updated ?? graph));
}

function presetEntries() {
  if (Array.isArray(PRESETS)) {
    return PRESETS.map((preset) => typeof preset === 'string' ? preset : preset.id);
  }
  return Object.keys(PRESETS);
}

function validationErrors(result) {
  if (Array.isArray(result)) return result;
  if (typeof result === 'boolean') return result ? [] : ['invalid'];
  assert.ok(Array.isArray(result.errors), 'Expected validation errors');
  return result.errors;
}

function rawMembers(node) {
  if (Array.isArray(node?.members)) {
    return Object.fromEntries(node.members.map(m => [m.name, m.value]));
  }
  return node?.members ?? node?.fields ?? node;
}

function findGameData(graph) {
  const queue = [graph];
  const visited = new Set();
  for (const object of queue) {
    if (!object || typeof object !== 'object' || visited.has(object)) continue;
    if (ArrayBuffer.isView(object)) continue;
    visited.add(object);
    const members = rawMembers(object);
    if (members.playerSchool !== undefined && members.schoolGameDataList !== undefined) {
      return members;
    }
    queue.push(...(object instanceof Map ? object.values() : Object.values(object)));
  }
  assert.fail('Expected PlayerGameData with both school fields in the parsed save');
}

function resolveNode(graph, node) {
  if (!node || typeof node !== 'object') return node;
  const id = node.refId ?? node.idRef;
  if (id === undefined) return node;
  const objects = graph.objects ?? graph.objectMap;
  const target = objects instanceof Map ? objects.get(id) : objects?.[id];
  assert.ok(target, `Expected object referenced by NRBF ID ${id}`);
  return target;
}

function listEntries(graph, node) {
  const list = rawMembers(resolveNode(graph, node));
  if (Array.isArray(list)) return list;
  const items = resolveNode(graph, list._items ?? list.items ?? list.values);
  const entries = Array.isArray(items) ? items : items?.values ?? items?.items;
  assert.ok(Array.isArray(entries), 'Expected a decoded NRBF list');
  return entries.slice(0, list._size ?? entries.length);
}

function scalar(node) {
  return node && typeof node === 'object' && 'value' in node ? node.value : node;
}

function rawSchoolValues(graph, node) {
  const data = rawMembers(resolveNode(graph, node));
  const first = listEntries(graph, data.students ?? data.student ?? data.studentList)[0];
  const attr = rawMembers(resolveNode(graph, rawMembers(resolveNode(graph, first)).attr));
  return {
    money: scalar(data.money),
    jhMoney: scalar(data.jhMoney),
    food: scalar(data.food),
    str: scalar(attr._str ?? attr.str),
  };
}

test('all 15 catalog categories contain localized entries', () => {
  const categories = Object.entries(catalog);
  assert.equal(categories.length, 15);
  for (const [name, entries] of categories) {
    assert.ok(entries && typeof entries === 'object', name);
    assert.ok(Object.keys(entries).length > 0, `${name} is empty`);
  }
  const text = JSON.stringify(catalog);
  assert.doesNotMatch(text, /\p{Script=Han}/u);
  assert.doesNotMatch(text, /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u);
  assert.doesNotMatch(text, /(?:https?:\/\/|ftp:\/\/|www\.)/iu);
});

test('demo decodes as PlayerGameData and every preset persists through serialization', () => {
  const bytes = createDemoNrbfBytes();
  const graph = parseNrbf(bytes);
  const state = readState(graph);
  const members = findGameData(graph);
  assert.ok(members.playerSchool);
  assert.match(JSON.stringify(state), /유운영/u);
  assert.equal(students(state).length, 2);

  const presets = presetEntries();
  assert.equal(presets.length, 6);
  assert.equal(new Set(presets).size, 6);
  for (const id of presets) {
    const freshGraph = parseNrbf(bytes);
    const original = readState(freshGraph);
    const candidate = structuredClone(original);
    const expected = applyPreset(candidate, id) ?? candidate;
    assert.notDeepEqual(expected, original, `Preset ${id} made no change`);
    assert.deepEqual(readState(reparse(freshGraph, expected)), expected, id);
  }

  const explicit = editState(state);
  assert.deepEqual(values(readState(reparse(graph, explicit))), values(explicit));
});

test('state validation, changes, game date and combat formulas', () => {
  const original = readState(parseNrbf(createDemoNrbfBytes()));
  assert.deepEqual(validationErrors(validateState(original)), []);
  const edited = editState(original);
  assert.deepEqual(validationErrors(validateState(edited)), []);
  const invalid = structuredClone(original);
  school(invalid).money = 'invalid';
  assert.ok(validationErrors(validateState(invalid)).length > 0);

  const unchanged = diffStates(original, structuredClone(original));
  const changes = diffStates(original, edited);
  assert.notDeepEqual(changes, unchanged);
  for (const field of ['money', 'jhMoney', 'food', 'str']) {
    assert.match(JSON.stringify(changes), new RegExp(field, 'i'));
  }

  const date = formatGameDate({ year: 12, month: 3, day: 9 });
  assert.equal(typeof date, 'string');
  assert.match(date, /12\D+0?3\D+0?9(?:\D|$)/u);

  for (const [str, agi] of [[13, 7], [7, 13]]) {
    const vit = 8;
    const stats = computeCombatStats({ str, agi, vit });
    assert.equal(stats.hpMax ?? stats.maxHp ?? stats.hp, vit * 417);
    assert.ok(Math.abs((stats.attack ?? stats.atk) - Math.max(str, agi) * 11.4) < 1e-9);
    assert.equal(stats.dzMax, 200);
  }
});

test('real saves retain their bytes and persist edits in both school records', (t) => {
  if (!fs.existsSync(fixtureDirectory)) {
    t.skip(`Fixture directory unavailable: ${fixtureDirectory}`);
    return;
  }
  const fixtures = fs.readdirSync(fixtureDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.sav$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (fixtures.length === 0) {
    t.skip('No real .sav fixtures');
    return;
  }

  let editedCount = 0;
  for (const name of fixtures) {
    const bytes = fs.readFileSync(path.join(fixtureDirectory, name));
    assert.equal(sha256(serializeNrbf(parseNrbf(bytes))), sha256(bytes), name);
    if (/^JHL_Summary_Data\d*\.sav$/iu.test(name)) continue;

    const graph = parseNrbf(bytes);
    const original = readState(graph);
    const edited = editState(original);
    const before = values(original);
    const expected = values(edited);
    const originalFields = findGameData(graph);
    const originalList = listEntries(graph, originalFields.schoolGameDataList);
    const matchingIndexes = originalList.flatMap((entry, index) => {
      if (entry == null) return [];
      const members = rawMembers(resolveNode(graph, entry));
      const player = rawMembers(resolveNode(graph, originalFields.playerSchool));
      if (members === player) return [index];
      if (['money', 'jhMoney', 'food'].some((key) => scalar(members[key]) !== before[key])) {
        return [];
      }
      return rawSchoolValues(graph, entry).str === before.str ? [index] : [];
    });
    assert.equal(matchingIndexes.length, 1, `${name}: expected one player school mirror`);

    const result = reparse(graph, edited);
    assert.deepEqual(values(readState(result)), expected, name);
    const fields = findGameData(result);
    assert.deepEqual(rawSchoolValues(result, fields.playerSchool), expected, `${name}: playerSchool`);
    const mirror = listEntries(result, fields.schoolGameDataList)[matchingIndexes[0]];
    assert.deepEqual(rawSchoolValues(result, mirror), expected, `${name}: schoolGameDataList`);
    editedCount += 1;
  }
  if (editedCount === 0) t.diagnostic('Only summary fixtures were available for byte checks');
});
