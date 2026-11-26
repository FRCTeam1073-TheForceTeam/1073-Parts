import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';
import { makeColumn, makePart, makeUser } from './helpers/fixtures.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

const addTask = (part, overrides = {}) => t.data.insertTask({
  custom_part_id: part.id, text: 'Cut plate', sort: t.data.nextTaskSort(part.id), ...overrides,
});

test('insertTask stores a task that starts unchecked; getTask returns it', () => {
  const part = makePart(t.data, makeColumn(t.data));
  const task = addTask(part, { text: 'Tap 10-32 holes' });
  const got = t.data.getTask(task.id);
  assert.equal(got.text, 'Tap 10-32 holes');
  assert.equal(got.done, 0);
  assert.equal(got.done_at, null);
  assert.equal(t.data.getTask(999999), undefined);
});

test('nextTaskSort puts each new task at the end of that part\'s checklist', () => {
  const column = makeColumn(t.data);
  const part = makePart(t.data, column);
  const other = makePart(t.data, column);
  assert.equal(t.data.nextTaskSort(part.id), 1);
  addTask(part);
  addTask(part);
  addTask(other);
  assert.equal(t.data.nextTaskSort(part.id), 3);
  assert.equal(t.data.nextTaskSort(other.id), 2);
});

test('listTasksFor returns only that part\'s tasks, in checklist order', () => {
  const column = makeColumn(t.data);
  const part = makePart(t.data, column);
  const other = makePart(t.data, column);
  const second = addTask(part, { text: 'second', sort: 2 });
  const first = addTask(part, { text: 'first', sort: 1 });
  addTask(other);
  assert.deepEqual(t.data.listTasksFor(part.id).map((x) => x.id), [first.id, second.id]);
});

test('listAllTasks groups tasks by part, each part in checklist order', () => {
  const column = makeColumn(t.data);
  const a = makePart(t.data, column);
  const b = makePart(t.data, column);
  const b1 = addTask(b, { sort: 1 });
  const a2 = addTask(a, { sort: 2 });
  const a1 = addTask(a, { sort: 1 });
  assert.deepEqual(t.data.listAllTasks().map((x) => x.id), [a1.id, a2.id, b1.id]);
});

test('checking a task off records who and when; un-checking clears both', () => {
  const user = makeUser(t.data);
  const task = addTask(makePart(t.data, makeColumn(t.data)));
  const checked = t.data.updateTask(task.id, { done: 1, done_by: user.id }, t.data.taskDoneTimestamps(true));
  assert.equal(checked.done, 1);
  assert.equal(checked.done_by, user.id);
  assert.ok(checked.done_at);
  const unchecked = t.data.updateTask(task.id, { done: 0 }, t.data.taskDoneTimestamps(false));
  assert.equal(unchecked.done, 0);
  assert.equal(unchecked.done_by, null);
  assert.equal(unchecked.done_at, null);
});

test('checking an already-checked task keeps the first time it was checked', () => {
  const task = addTask(makePart(t.data, makeColumn(t.data)));
  t.data.updateTask(task.id, { done: 1 }, t.data.taskDoneTimestamps(true));
  t.db.prepare("UPDATE part_tasks SET done_at = '2026-01-01 00:00:00' WHERE id = ?").run(task.id);
  const again = t.data.updateTask(task.id, { done: 1 }, t.data.taskDoneTimestamps(true));
  assert.equal(again.done_at, '2026-01-01 00:00:00');
});

test('deleteTask removes only that task', () => {
  const part = makePart(t.data, makeColumn(t.data));
  const keep = addTask(part);
  const gone = addTask(part);
  t.data.deleteTask(gone.id);
  assert.deepEqual(t.data.listTasksFor(part.id).map((x) => x.id), [keep.id]);
});

test('deleteCustomPart also deletes the part\'s tasks', () => {
  const column = makeColumn(t.data);
  const part = makePart(t.data, column);
  const other = makePart(t.data, column);
  addTask(part);
  addTask(part);
  const survivor = addTask(other);
  t.data.deleteCustomPart(part.id);
  assert.deepEqual(t.data.listAllTasks().map((x) => x.id), [survivor.id]);
});

test('deleting the assigned person leaves the task, now unassigned', () => {
  const person = makeUser(t.data);
  const task = addTask(makePart(t.data, makeColumn(t.data)), { assigned_to: person.id });
  t.data.deleteUser(person.id);
  assert.equal(t.data.getTask(task.id).assigned_to, null);
});

test('a task keeps the stage it was added for', () => {
  const design = makeColumn(t.data);
  const make = makeColumn(t.data);
  const part = makePart(t.data, design);
  const task = addTask(part, { column_id: make.id });
  assert.equal(t.data.getTask(task.id).column_id, make.id);
});

test('deleting a stage moves its tasks to the fallback stage along with its cards', () => {
  const design = makeColumn(t.data);
  const make = makeColumn(t.data);
  const part = makePart(t.data, make);
  const task = addTask(part, { column_id: make.id });
  const other = addTask(part, { column_id: design.id });
  t.data.deleteBoardColumn(make.id, design.id);
  assert.equal(t.data.getTask(task.id).column_id, design.id);
  assert.equal(t.data.getTask(other.id).column_id, design.id);
});
