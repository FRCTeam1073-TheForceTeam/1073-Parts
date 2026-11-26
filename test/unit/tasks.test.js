// Checklist tasks on custom parts: the pure rules in server/logic.js and the HTTP routes, against an in-memory store.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskData, buildTaskPatch, canDeleteTask, HttpError, TASK_TEXT_MAX } from '../../server/logic.js';
import { startHarness } from './helpers/app-harness.js';

const student = { id: 1, username: 'sam', display_name: 'Sam Student', role: 'student', password_hash: 'x' };
const otherStudent = { id: 2, username: 'pat', display_name: 'Pat Student', role: 'student', password_hash: 'x' };
const mentor = { id: 3, username: 'mo', display_name: 'Mo Mentor', role: 'mentor', password_hash: 'x' };
const users = [student, otherStudent, mentor];

const throws400 = (fn, message) => assert.throws(fn, (err) => err instanceof HttpError && err.status === 400 && err.message === message);

describe('task rules', () => {
  it('trims the task text and keeps the assignee as a number', () => {
    assert.deepEqual(buildTaskData({ text: '  Cut plate  ', assigned_to: '3' }), { text: 'Cut plate', assigned_to: 3, column_id: null });
  });

  it('treats a missing or empty assignee as nobody', () => {
    assert.equal(buildTaskData({ text: 'Deburr' }).assigned_to, null);
    assert.equal(buildTaskData({ text: 'Deburr', assigned_to: '' }).assigned_to, null);
  });

  it('refuses a task with no text', () => {
    throws400(() => buildTaskData({ text: '   ' }), 'Task text is required');
    throws400(() => buildTaskData({}), 'Task text is required');
  });

  it(`refuses task text longer than ${TASK_TEXT_MAX} characters`, () => {
    throws400(() => buildTaskData({ text: 'x'.repeat(TASK_TEXT_MAX + 1) }), `Keep a task under ${TASK_TEXT_MAX} characters`);
    assert.equal(buildTaskData({ text: 'x'.repeat(TASK_TEXT_MAX) }).text.length, TASK_TEXT_MAX);
  });

  it('refuses an assignee that is not a positive whole number', () => {
    throws400(() => buildTaskData({ text: 'Tap holes', assigned_to: 'abc' }), 'Unknown team member');
    throws400(() => buildTaskData({ text: 'Tap holes', assigned_to: -2 }), 'Unknown team member');
  });

  it('a patch keeps only the fields that were sent and turns done into 1 or 0', () => {
    assert.deepEqual(buildTaskPatch({ done: true }), { done: 1 });
    assert.deepEqual(buildTaskPatch({ done: false, extra: 'ignored' }), { done: 0 });
    assert.deepEqual(buildTaskPatch({ text: ' New name ', assigned_to: null }), { text: 'New name', assigned_to: null });
    assert.deepEqual(buildTaskPatch({}), {});
  });

  it('keeps the stage a new task is for as a number', () => {
    assert.equal(buildTaskData({ text: 'Cut', column_id: '7' }).column_id, 7);
  });

  it('refuses a stage that is not a positive whole number', () => {
    throws400(() => buildTaskData({ text: 'Cut', column_id: 'x' }), 'Unknown stage');
    throws400(() => buildTaskPatch({ column_id: 0 }), 'Unknown stage');
  });

  it('a patch can move a task to another stage, but not to no stage', () => {
    assert.deepEqual(buildTaskPatch({ column_id: 4 }), { column_id: 4 });
    throws400(() => buildTaskPatch({ column_id: null }), 'Unknown stage');
  });

  it('a patch that renames a task to blank is refused', () => {
    throws400(() => buildTaskPatch({ text: '' }), 'Task text is required');
  });

  it('lets mentors, the task\'s creator and the part\'s creator delete a task, and nobody else', () => {
    const task = { created_by: 1 };
    const part = { created_by: 2 };
    assert.equal(canDeleteTask(mentor, task, part), true);
    assert.equal(canDeleteTask(student, task, part), true);
    assert.equal(canDeleteTask(otherStudent, task, part), true);
    assert.equal(canDeleteTask({ id: 9, role: 'student' }, task, part), false);
    assert.equal(canDeleteTask({ id: 9, role: 'student' }, task, undefined), false);
  });
});

describe('task routes', () => {
  let h;
  const calls = (op) => h.state.calls.filter((c) => c.op === op);
  before(async () => {
    h = await startHarness({
      storeOptions: {
        users,
        columns: [{ id: 1, name: 'Design' }, { id: 2, name: 'Manufacturing' }],
        customParts: [
          { id: 20, name: 'Side plate', column_id: 1, sort: 1, created_by: otherStudent.id },
          { id: 21, name: 'Spacer', column_id: 1, sort: 2, created_by: mentor.id },
        ],
        tasks: [
          { id: 40, custom_part_id: 20, text: 'Cut plate', sort: 1, created_by: otherStudent.id },
          { id: 41, custom_part_id: 20, text: 'Deburr', sort: 2, done: 1, done_by: mentor.id, created_by: mentor.id },
          { id: 42, custom_part_id: 21, text: 'Print', sort: 1, created_by: mentor.id },
        ],
      },
    });
  });
  after(() => h.close());

  it('needs a signed-in user', async () => {
    const res = await h.call('POST', '/api/custom-parts/20/tasks', { body: { text: 'Tap holes' } });
    assert.equal(res.status, 401);
  });

  it('lists each part with its own tasks in checklist order', async () => {
    const res = await h.call('GET', '/api/custom-parts', { user: student });
    const plate = res.json.find((p) => p.id === 20);
    const spacer = res.json.find((p) => p.id === 21);
    assert.deepEqual(plate.tasks.map((t) => t.id), [40, 41]);
    assert.deepEqual(spacer.tasks.map((t) => t.id), [42]);
  });

  it('adds a task to the end of a part\'s checklist, recording who added it', async () => {
    const res = await h.call('POST', '/api/custom-parts/20/tasks', { user: student, body: { text: ' Tap 10-32 holes ', assigned_to: 1 } });
    assert.equal(res.status, 200);
    assert.equal(res.json.text, 'Tap 10-32 holes');
    assert.equal(res.json.custom_part_id, 20);
    assert.equal(res.json.assigned_to, 1);
    assert.equal(res.json.created_by, student.id);
    assert.equal(res.json.sort, 3);
  });

  it('puts a new task in the stage the part is in now when no stage is given', async () => {
    const res = await h.call('POST', '/api/custom-parts/21/tasks', { user: student, body: { text: 'Sand' } });
    assert.equal(res.json.column_id, 1);
  });

  it('puts a new task in the stage it was added for', async () => {
    const res = await h.call('POST', '/api/custom-parts/21/tasks', { user: student, body: { text: 'Pack', column_id: 2 } });
    assert.equal(res.json.column_id, 2);
  });

  it('refuses a new task for a stage that is not on the board', async () => {
    const res = await h.call('POST', '/api/custom-parts/21/tasks', { user: student, body: { text: 'Pack', column_id: 99 } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Unknown stage');
  });

  it('moves a task to another stage', async () => {
    const res = await h.call('PATCH', '/api/tasks/42', { user: student, body: { column_id: 2 } });
    assert.equal(res.json.column_id, 2);
  });

  it('refuses to move a task to a stage that is not on the board', async () => {
    const res = await h.call('PATCH', '/api/tasks/42', { user: student, body: { column_id: 99 } });
    assert.equal(res.status, 400);
  });

  it('refuses a task on a part that does not exist', async () => {
    const res = await h.call('POST', '/api/custom-parts/999/tasks', { user: student, body: { text: 'Cut' } });
    assert.equal(res.status, 404);
  });

  it('refuses a task with no text', async () => {
    const res = await h.call('POST', '/api/custom-parts/20/tasks', { user: student, body: { text: '' } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Task text is required');
  });

  it('refuses a task assigned to someone who is not on the team', async () => {
    const res = await h.call('POST', '/api/custom-parts/20/tasks', { user: student, body: { text: 'Cut', assigned_to: 77 } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Unknown team member');
  });

  it('checking a task off records who did it and stamps the time', async () => {
    const res = await h.call('PATCH', '/api/tasks/40', { user: student, body: { done: true } });
    assert.equal(res.json.done, 1);
    assert.equal(res.json.done_by, student.id);
    const last = calls('updateTask').at(-1);
    assert.equal(last.args[2], 'done_at = NOW');
  });

  it('checking an already-checked task keeps the original person', async () => {
    const res = await h.call('PATCH', '/api/tasks/41', { user: student, body: { done: true } });
    assert.equal(res.json.done_by, mentor.id);
  });

  it('un-checking a task clears who and when', async () => {
    await h.call('PATCH', '/api/tasks/41', { user: student, body: { done: false } });
    const last = calls('updateTask').at(-1);
    assert.deepEqual(last.args[1], { done: 0 });
    assert.equal(last.args[2], 'done_at = NULL, done_by = NULL');
  });

  it('renaming a task does not touch its done time', async () => {
    await h.call('PATCH', '/api/tasks/42', { user: student, body: { text: 'Print in PETG' } });
    const last = calls('updateTask').at(-1);
    assert.deepEqual(last.args[1], { text: 'Print in PETG' });
    assert.equal(last.args[2], '');
  });

  it('refuses to reassign a task to someone who is not on the team', async () => {
    const res = await h.call('PATCH', '/api/tasks/42', { user: student, body: { assigned_to: 77 } });
    assert.equal(res.status, 400);
  });

  it('refuses to change a task that does not exist', async () => {
    const res = await h.call('PATCH', '/api/tasks/999', { user: student, body: { done: true } });
    assert.equal(res.status, 404);
  });

  it('stops a student deleting a task they did not add on a part they did not add', async () => {
    const res = await h.call('DELETE', '/api/tasks/42', { user: student });
    assert.equal(res.status, 403);
    assert.ok(h.store.getTask(42));
  });

  it('lets the person who added the part delete any of its tasks', async () => {
    const res = await h.call('DELETE', '/api/tasks/41', { user: otherStudent });
    assert.deepEqual(res.json, { ok: true });
    assert.equal(h.store.getTask(41), null);
  });

  it('lets a mentor delete any task', async () => {
    const res = await h.call('DELETE', '/api/tasks/40', { user: mentor });
    assert.deepEqual(res.json, { ok: true });
  });

  it('treats deleting a task that is already gone as done', async () => {
    const res = await h.call('DELETE', '/api/tasks/999', { user: student });
    assert.deepEqual(res.json, { ok: true });
  });

  it('creates a new part together with its first tasks', async () => {
    const res = await h.call('POST', '/api/custom-parts', { user: student, body: { name: 'Gusset', tasks: [{ text: 'Cut' }, { text: 'Drill' }] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.tasks.map((t) => t.text), ['Cut', 'Drill']);
    assert.deepEqual(res.json.tasks.map((t) => t.sort), [1, 2]);
  });

  it('keeps the stage each first task of a new part was added for', async () => {
    const res = await h.call('POST', '/api/custom-parts', { user: student, body: { name: 'Plate', column_id: 1, tasks: [{ text: 'CAD' }, { text: 'Cut', column_id: 2 }] } });
    assert.deepEqual(res.json.tasks.map((t) => t.column_id), [1, 2]);
  });

  it('keeps a task that was ticked before the new part was first saved as done', async () => {
    const res = await h.call('POST', '/api/custom-parts', { user: student, body: { name: 'Bracket plate', tasks: [{ text: 'Cut', done: true }, { text: 'Drill' }] } });
    const [cut, drill] = res.json.tasks;
    assert.equal(cut.done, 1);
    assert.equal(cut.done_by, student.id);
    assert.equal(drill.done, 0);
  });

  it('refuses a new part whose tasks are invalid', async () => {
    const res = await h.call('POST', '/api/custom-parts', { user: student, body: { name: 'Bracket', tasks: [{ text: '' }] } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Task text is required');
  });
});
