import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './helpers/db.js';

let t;
before(async () => { t = await openTestDb(); });
after(() => t.close());
beforeEach(() => t.reset());

test('getSettings returns the defaults when nothing is stored', () => {
  assert.deepEqual(t.data.getSettings(), t.SETTING_DEFAULTS);
});

test('saveSettings stores values and returns the merged settings', () => {
  const saved = t.data.saveSettings({ season_budget_cents: '100000', require_approval: '1' });
  assert.equal(saved.season_budget_cents, '100000');
  assert.equal(saved.require_approval, '1');
  assert.equal(saved.season_name, t.SETTING_DEFAULTS.season_name);
});

test('saving a key again overwrites it and keeps the other keys', () => {
  t.data.saveSettings({ season_budget_cents: '100000', require_approval: '1' });
  t.data.saveSettings({ season_budget_cents: '250000' });
  const s = t.data.getSettings();
  assert.equal(s.season_budget_cents, '250000');
  assert.equal(s.require_approval, '1');
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'season_budget_cents'").get().n, 1);
});

test('unknown keys are ignored and never stored', () => {
  t.data.saveSettings({ not_a_setting: 'x' });
  assert.equal(t.data.getSettings().not_a_setting, undefined);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'not_a_setting'").get().n, 0);
});

test('null is stored as an empty string and numbers as text', () => {
  t.data.saveSettings({ season_name: null, approval_threshold_cents: 5000 });
  const s = t.data.getSettings();
  assert.equal(s.season_name, '');
  assert.equal(s.approval_threshold_cents, '5000');
});

test('getSetting and setSetting work on any key', () => {
  assert.equal(t.data.getSetting('onshape_access_key'), undefined);
  t.data.setSetting('onshape_access_key', 'abc');
  t.data.setSetting('onshape_access_key', 'def');
  assert.equal(t.data.getSetting('onshape_access_key'), 'def');
});
