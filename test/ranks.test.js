import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RANKS, RANK_HOURS, rankForSeconds, formatPlayTime, formatHours, levelUpMessageTemplate, roleName,
  detectRankShift,
} from '../src/ranks.js';

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

describe('detectRankShift', () => {
  // Every saved role currently named exactly what its saved index expects.
  const settled = () => new Map(RANKS.map((rank, index) => [`role-${index}`, roleName(rank)]));

  test('finds nothing when every saved role still matches its saved index', () => {
    const savedRoles = RANKS.map((_, index) => ({ rank_index: index, role_id: `role-${index}` }));
    assert.deepEqual(detectRankShift(savedRoles, settled()), []);
  });

  test('does not flag a deliberate rename — the old name matches nothing in RANKS', () => {
    const savedRoles = [{ rank_index: 0, role_id: 'role-0' }];
    const roleNames = new Map([['role-0', 'A Name Nobody Configured']]);
    assert.deepEqual(detectRankShift(savedRoles, roleNames), []);
  });

  test('flags a saved role whose current name matches a different index — the insertion signature', () => {
    // Saved as rank 0, but its live Discord name is now rank 1's name: exactly what an insertion
    // one slot earlier in RANK_NAMES does to every role after the insertion point.
    const savedRoles = [{ rank_index: 0, role_id: 'role-0' }];
    const roleNames = new Map([['role-0', roleName(RANKS[1])]]);
    const shifts = detectRankShift(savedRoles, roleNames);
    assert.equal(shifts.length, 1);
    assert.deepEqual(shifts[0], { savedIndex: 0, foundIndex: 1, roleId: 'role-0', name: roleName(RANKS[1]) });
  });

  test('flags every role in a shifted tail, not just the first', () => {
    // Ranks 1..end all shifted down one, as an insertion before index 1 would leave them.
    const savedRoles = RANKS.map((_, index) => ({ rank_index: index, role_id: `role-${index}` }));
    const roleNames = settled();
    for (let index = 1; index < RANKS.length - 1; index++) {
      roleNames.set(`role-${index}`, roleName(RANKS[index + 1]));
    }
    const shifted = detectRankShift(savedRoles, roleNames);
    assert.deepEqual(shifted.map((s) => s.savedIndex), Array.from({ length: RANKS.length - 2 }, (_, i) => i + 1));
  });

  test('ignores a saved role whose live Discord role no longer exists', () => {
    const savedRoles = [{ rank_index: 0, role_id: 'deleted-role' }];
    assert.deepEqual(detectRankShift(savedRoles, new Map()), []);
  });
});
