import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RANKS, RANK_HOURS, rankForSeconds, formatPlayTime, formatHours, levelUpMessageTemplate, roleName } from '../src/ranks.js';

describe('rank configuration', () => {
  test('defaults load with matching names and hour thresholds', () => {
    assert.equal(RANKS.length, RANK_HOURS.length);
    assert.ok(RANKS.length >= 2);
  });

  test('hour thresholds strictly increase', () => {
    for (let i = 1; i < RANK_HOURS.length; i++) {
      assert.ok(RANK_HOURS[i] > RANK_HOURS[i - 1], `RANK_HOURS[${i}] must exceed its predecessor`);
    }
  });
});

describe('rankForSeconds', () => {
  test('returns -1 below the first threshold', () => {
    assert.equal(rankForSeconds(0), -1);
    assert.equal(rankForSeconds(RANK_HOURS[0] * 3600 - 1), -1);
  });

  test('returns rank 0 exactly at the first threshold', () => {
    assert.equal(rankForSeconds(RANK_HOURS[0] * 3600), 0);
  });

  test('returns the top rank at and above the last threshold', () => {
    const last = RANK_HOURS.length - 1;
    assert.equal(rankForSeconds(RANK_HOURS[last] * 3600), last);
    assert.equal(rankForSeconds(RANK_HOURS[last] * 3600 * 10), last);
  });

  test('lands on the correct tier for each configured threshold', () => {
    RANK_HOURS.forEach((hours, index) => {
      assert.equal(rankForSeconds(hours * 3600), index, `threshold ${hours}h should be rank ${index}`);
    });
  });

  test('never skips a tier just below the next threshold', () => {
    for (let i = 0; i < RANK_HOURS.length - 1; i++) {
      assert.equal(rankForSeconds(RANK_HOURS[i + 1] * 3600 - 1), i);
    }
  });
});

describe('formatPlayTime', () => {
  test('shows minutes only under an hour', () => {
    assert.equal(formatPlayTime(0), '0m');
    assert.equal(formatPlayTime(59), '0m');
    assert.equal(formatPlayTime(60), '1m');
    assert.equal(formatPlayTime(59 * 60), '59m');
  });

  test('shows whole hours without a minutes part', () => {
    assert.equal(formatPlayTime(3600), '1h');
    assert.equal(formatPlayTime(2 * 3600), '2h');
  });

  test('shows hours and minutes together', () => {
    assert.equal(formatPlayTime(3600 + 30 * 60), '1h 30m');
  });

  test('thousands separators appear on large hour counts', () => {
    assert.equal(formatPlayTime(1234 * 3600), '1,234h');
  });
});

describe('formatHours', () => {
  test('integers render without decimals', () => {
    assert.equal(formatHours(5), '5h');
  });

  test('fractional hours keep one decimal', () => {
    assert.equal(formatHours(1.5), '1.5h');
  });
});

describe('levelUpMessageTemplate', () => {
  test('falls back to a default containing every placeholder', () => {
    const template = levelUpMessageTemplate(0);
    for (const token of ['{user}', '{level}', '{rank}', '{hours}']) {
      assert.ok(template.includes(token), `default template should contain ${token}`);
    }
  });
});

describe('roleName', () => {
  test('maps a rank to its role name', () => {
    assert.equal(roleName('Villager'), 'Villager');
  });
});
