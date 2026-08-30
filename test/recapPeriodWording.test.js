import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The three recap-badge achievements name the period out loud, so their wording has to follow
 * RECAP_PERIOD rather than assume a weekly server.
 *
 * achievements.js reads that setting once at import and freezes it — it cannot import config.js,
 * which imports achievements.js back — so testing both settings means loading the module twice.
 * The query string is what makes that possible: ESM caches by specifier, so a different one yields
 * a fresh module instance that re-reads the environment as it was set just before.
 */
const load = async (period, tag) => {
  process.env.RECAP_PERIOD = period;
  return import(`../src/achievements.js?wording=${tag}`);
};

const describeOf = (module, id) => module.achievementById(id).description;

describe('recap badge wording follows RECAP_PERIOD', () => {
  test('a weekly server reads as weeks', async () => {
    const weekly = await load('week', 'week');
    assert.match(describeOf(weekly, 'crowned'), /Gamer of the Week badge/);
    assert.match(describeOf(weekly, 'tavern_bard'), /the week’s biggest yapper/);
    assert.match(describeOf(weekly, 'court_scribe'), /for a week of/);
  });

  test('a monthly server reads as months, with no weekly wording left behind', async () => {
    const monthly = await load('month', 'month');
    assert.match(describeOf(monthly, 'crowned'), /Gamer of the Month badge/);
    assert.match(describeOf(monthly, 'tavern_bard'), /the month’s biggest yapper/);
    assert.match(describeOf(monthly, 'court_scribe'), /for a month of/);
    for (const id of ['crowned', 'tavern_bard', 'court_scribe']) {
      assert.doesNotMatch(describeOf(monthly, id), /week/i, `${id} still mentions a week`);
    }
  });

  test('the setting is read case- and whitespace-insensitively, as config.js reads it', async () => {
    const padded = await load('  MONTH  ', 'padded');
    assert.match(describeOf(padded, 'crowned'), /Gamer of the Month badge/);
  });

  test('anything unrecognised falls back to weeks rather than throwing', async () => {
    // config.js is what refuses to start on a bad value, and it has already run before any of this
    // is rendered — so the job here is only to never produce "Gamer of the undefined".
    const nonsense = await load('fortnight', 'nonsense');
    assert.match(describeOf(nonsense, 'crowned'), /Gamer of the Week badge/);
    const unset = await load('', 'unset');
    assert.match(describeOf(unset, 'crowned'), /Gamer of the Week badge/);
  });

  test('only the wording moves — ids, names and emoji are the same either way', async () => {
    const weekly = await load('week', 'stable-week');
    const monthly = await load('month', 'stable-month');
    const shape = (module) => ['crowned', 'tavern_bard', 'court_scribe']
      .map((id) => {
        const achievement = module.achievementById(id);
        return [achievement.id, achievement.name, achievement.emoji];
      });
    assert.deepEqual(shape(weekly), shape(monthly));
  });
});
