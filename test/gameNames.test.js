import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DUPLICATE_REASONS, editDistance, findDuplicateGameNames, normalizeGameName, numberSignature,
} from '../src/gameNames.js';
import { tempDatabase, playSession, HOUR, MINUTE, T0 } from './helpers.js';

const G = 'guild-1';
const game = (name, hours, playerCount = 1) => ({ name, totalSeconds: Math.round(hours * 3600), playerCount });
const named = (suggestions) => suggestions.map((suggestion) => [suggestion.reason, ...suggestion.names.map((entry) => entry.name)]);
const find = (...games) => findDuplicateGameNames(games);

test('normalisation ignores case, punctuation, spacing and accents', () => {
  assert.deepEqual(normalizeGameName('Counter-Strike 2'), { words: 'counter strike 2', key: 'counterstrike2' });
  // Punctuation becomes a word break for `words` and nothing at all for `key`, which is what lets
  // one rule cover both `Counter Strike 2` and `REPO`.
  assert.deepEqual(normalizeGameName('R.E.P.O.'), { words: 'r e p o', key: 'repo' });
  assert.equal(normalizeGameName('Pokémon Scarlet').key, normalizeGameName('Pokemon Scarlet').key);
  assert.equal(normalizeGameName('  PEAK  ').key, normalizeGameName('peak').key);
  assert.equal(normalizeGameName('Baldur’s Gate 3').key, normalizeGameName('Baldurs Gate 3').key);
});

test('the number signature reads arabic and roman alike, in any order', () => {
  assert.equal(numberSignature('diablo 4'), numberSignature('diablo iv'));
  assert.equal(numberSignature('diablo 2'), '2');
  assert.equal(numberSignature('diablo 3'), '3');
  // Digit runs count anywhere in a word; roman numerals only as whole words, or half the library
  // would be numbered.
  assert.equal(numberSignature('cs2'), '2');
  assert.equal(numberSignature('civilization'), '');
  assert.equal(numberSignature('f1 24'), '1,24');
  assert.equal(numberSignature('24 f1'), '1,24');
});

test('edit distance gives up rather than finishing a comparison it has already lost', () => {
  assert.equal(editDistance('helldivers', 'helldivrs'), 1);
  assert.equal(editDistance('hades', 'hades'), 0);
  assert.equal(editDistance('abcd', 'dcba'), 4);
  // Past the ceiling it reports only that it is past the ceiling.
  assert.equal(editDistance('short', 'a much longer name entirely', 2), 3);
  assert.equal(editDistance('helldivers 2', 'helldivrs 2', 1), 1);
});

test('names identical but for case, spacing or punctuation are grouped, however many there are', () => {
  const suggestions = find(
    game('Counter-Strike 2', 28, 6),
    game('counter strike 2', 0.2),
    game('COUNTER-STRIKE 2', 0.1),
    game('Hades', 4),
  );
  assert.deepEqual(named(suggestions), [
    [DUPLICATE_REASONS.IDENTICAL, 'Counter-Strike 2', 'counter strike 2', 'COUNTER-STRIKE 2'],
  ]);
});

test('a stray trailing space is a duplicate, since it is invisible everywhere else', () => {
  assert.deepEqual(named(find(game('PEAK', 15, 4), game('PEAK ', 0.5))), [
    [DUPLICATE_REASONS.IDENTICAL, 'PEAK', 'PEAK '],
  ]);
});

test('a typo one character away from a long name is flagged as near', () => {
  assert.deepEqual(named(find(game('Helldivers 2', 9, 3), game('Helldivrs 2', 0.2))), [
    [DUPLICATE_REASONS.NEAR, 'Helldivers 2', 'Helldivrs 2'],
  ]);
});

test('a short name a character away is left alone — PEAK and PEAR are not one game', () => {
  assert.deepEqual(find(game('PEAK', 15, 4), game('PEAR', 1)), []);
});

test('two edits are allowed only once a name is long enough for two to be a typo', () => {
  assert.deepEqual(named(find(game('Vampire Survivors', 40, 5), game('Vampire Survvrs', 0.2))), [
    [DUPLICATE_REASONS.NEAR, 'Vampire Survivors', 'Vampire Survvrs'],
  ]);
  // The same two edits on a shorter name stay unflagged: at that length two characters is a
  // different game more often than it is a typo.
  assert.deepEqual(find(game('Terraria', 8), game('Teraia', 0.2)), []);
});

test('one name extending another is flagged, which is the only way a re-title is ever caught', () => {
  assert.deepEqual(named(find(game('Realm Royale Reforged', 0.4), game('Realm Royale', 0.3))), [
    [DUPLICATE_REASONS.EXTENDS, 'Realm Royale Reforged', 'Realm Royale'],
  ]);
});

test('an extension has to begin on a word boundary', () => {
  // `portal` starts with `port`, and they are not the same game — nor is either an edit away.
  assert.deepEqual(find(game('Portal', 5), game('Port Royale', 2), game('Port', 1)), []);
});

test('a difference in numbers is a sequel and is never suggested, by any of the three rules', () => {
  const sequels = [
    [game('Diablo II', 10), game('Diablo III', 20)], // one character apart
    [game('Diablo IV', 15), game('Diablo II', 3)], // and again, roman against roman
    [game('F1 23', 3), game('F1 24', 4)], // one digit apart
    [game('The Sims 3', 1), game('The Sims 4', 2)],
    [game('Portal', 5), game('Portal 2', 9)], // an extension that is only a number
    [game('Battlefield 1', 2), game('Battlefield 4', 6)],
  ];
  for (const pair of sequels) assert.deepEqual(find(...pair), [], pair.map((entry) => entry.name).join(' vs '));
});

test('a roman numeral read out of a word costs a suggestion rather than inventing one', () => {
  // `x` parses as ten, so this pair is treated as differing in numbers and left alone. The safe
  // direction: a missed suggestion is a shrug, a wrong merge cannot be undone.
  assert.deepEqual(find(game('Mega Man X', 1), game('Mega Man', 2)), []);
});

test('strongest evidence leads, then the pair holding the most time between them', () => {
  const suggestions = find(
    game('Realm Royale', 0.3), game('Realm Royale Reforged', 0.4),
    game('Helldivers 2', 9, 3), game('Helldivrs 2', 0.2),
    game('Hades', 2), game('hades', 0.1),
    game('Vampire Survivors', 40, 5), game('Vampire Survivrs', 0.5),
  );
  assert.deepEqual(suggestions.map((suggestion) => suggestion.reason), [
    DUPLICATE_REASONS.IDENTICAL, DUPLICATE_REASONS.NEAR, DUPLICATE_REASONS.NEAR, DUPLICATE_REASONS.EXTENDS,
  ]);
  // Within the near matches, the pair holding 40 hours outranks the pair holding 9.
  assert.deepEqual(suggestions[1].names.map((entry) => entry.name), ['Vampire Survivors', 'Vampire Survivrs']);
});

test('the name holding the most time leads its group, since that is the one to keep', () => {
  const [suggestion] = find(game('counter strike 2', 0.2), game('Counter-Strike 2', 28, 6));
  assert.deepEqual(suggestion.names.map((entry) => entry.name), ['Counter-Strike 2', 'counter strike 2']);
  assert.deepEqual(suggestion.names[0], { name: 'Counter-Strike 2', totalSeconds: 28 * 3600, playerCount: 6 });
});

test('a spelling already grouped as identical does not raise the same near match twice', () => {
  // Three spellings of one game and one typo of it: the group is reported once, and the typo is
  // reported once against the group rather than once per spelling.
  const suggestions = find(
    game('Vampire Survivors', 40, 5), game('vampire survivors', 1), game('VAMPIRE SURVIVORS', 0.5),
    game('Vampire Survivrs', 0.2),
  );
  assert.deepEqual(named(suggestions), [
    [DUPLICATE_REASONS.IDENTICAL, 'Vampire Survivors', 'vampire survivors', 'VAMPIRE SURVIVORS'],
    [DUPLICATE_REASONS.NEAR, 'Vampire Survivors', 'Vampire Survivrs'],
  ]);
});

test('a library with nothing wrong in it produces nothing', () => {
  assert.deepEqual(find(
    game('World of Warcraft', 48), game('Counter-Strike 2', 28, 6), game('PEAK', 15, 4),
    game('Diablo IV', 15), game('Nioh 3', 8), game('R.E.P.O.', 6, 3), game('Overwatch', 1),
    game('The Witcher 3: Wild Hunt', 0.2), game('Autodesk Navisworks Freedom 2027', 0.1),
  ), []);
  assert.deepEqual(find(), []);
  // A name that normalises to nothing at all cannot be compared to anything.
  assert.deepEqual(find(game('!!!', 1), game('???', 1)), []);
});

test('getGuildGameTotals reports every name with its time and how many members hold it', () => {
  const { db, cleanup } = tempDatabase();
  try {
    playSession(db, G, 'user-1', 'Hades', T0, 2 * HOUR);
    playSession(db, G, 'user-2', 'Hades', T0, 30 * MINUTE);
    playSession(db, G, 'user-2', 'hades', T0 + 3 * HOUR, 10 * MINUTE);
    playSession(db, 'guild-2', 'user-1', 'Elsewhere', T0, HOUR);
    // A running session's game counts, exactly as it does in the picker: no game_stats row exists
    // for it until the first checkpoint, and the misspelling is often the one on the clock.
    db.startSession(G, 'user-3', 'Just Launched', T0);

    const totals = db.getGuildGameTotals(G);
    assert.deepEqual(totals, [
      { name: 'Hades', totalSeconds: 2.5 * 3600, playerCount: 2 },
      { name: 'hades', totalSeconds: 600, playerCount: 1 },
      { name: 'Just Launched', totalSeconds: 0, playerCount: 1 },
    ]);
    // Case is preserved rather than folded, because the split is the thing being looked for.
    assert.deepEqual(named(findDuplicateGameNames(totals)), [[DUPLICATE_REASONS.IDENTICAL, 'Hades', 'hades']]);
  } finally {
    cleanup();
  }
});

test('a member holding a game twice over is one player, not two', () => {
  const { db, cleanup } = tempDatabase();
  try {
    playSession(db, G, 'user-1', 'Hades', T0, HOUR);
    db.startSession(G, 'user-1', 'Hades', T0 + 2 * HOUR);
    assert.deepEqual(db.getGuildGameTotals(G), [{ name: 'Hades', totalSeconds: 3600, playerCount: 1 }]);
  } finally {
    cleanup();
  }
});
