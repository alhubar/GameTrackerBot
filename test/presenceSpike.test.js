import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeRawPresence } from '../src/presenceSpike.js';

/** A raw PRESENCE_UPDATE packet, shaped the way the gateway sends one. */
function packet(activities, extra = {}) {
  return {
    t: 'PRESENCE_UPDATE',
    d: {
      user: { id: '123456789012345678' },
      status: 'online',
      activities,
      ...extra,
    },
  };
}

const PLAYING = 0;
const LISTENING = 2;

describe('describeRawPresence — what it ignores', () => {
  const ignored = [
    ['a packet that is not a presence', { t: 'MESSAGE_CREATE', d: { content: 'hi' } }],
    ['a presence with no activities at all', packet([])],
    ['a presence whose activities are missing entirely', { t: 'PRESENCE_UPDATE', d: { user: { id: '1' }, status: 'idle' } }],
    ['a presence carrying only a non-Playing activity', packet([{ type: LISTENING, name: 'Spotify' }])],
    ['undefined', undefined],
    ['null', null],
  ];

  for (const [label, input] of ignored) {
    test(`says nothing about ${label}`, () => {
      assert.equal(describeRawPresence(input), null);
    });
  }
});

describe('describeRawPresence — what it captures', () => {
  test('reports the platform field discord.js drops', () => {
    const line = describeRawPresence(packet([{ type: PLAYING, name: 'Helldivers 2', platform: 'ps5', application_id: '9876' }]));
    assert.match(line, /platform=ps5/);
    assert.match(line, /Helldivers 2/);
    assert.match(line, /application_id=9876/);
  });

  test('marks an absent platform rather than printing undefined', () => {
    const line = describeRawPresence(packet([{ type: PLAYING, name: 'Factorio' }]));
    assert.match(line, /platform=\(absent\)/);
    assert.match(line, /application_id=\(absent\)/);
  });

  test('reports client_status, the other candidate signal', () => {
    const line = describeRawPresence(packet([{ type: PLAYING, name: 'Factorio' }], { client_status: { mobile: 'online' } }));
    assert.match(line, /client_status=mobile=online/);
  });

  test('marks an empty client_status rather than printing nothing', () => {
    const line = describeRawPresence(packet([{ type: PLAYING, name: 'Factorio' }], { client_status: {} }));
    assert.match(line, /client_status=\(none\)/);
  });

  test('describes every Playing activity, and only those', () => {
    const line = describeRawPresence(packet([
      { type: LISTENING, name: 'Spotify' },
      { type: PLAYING, name: 'Deep Rock Galactic', platform: 'desktop' },
      { type: PLAYING, name: 'Rocket League', platform: 'xbox' },
    ]));
    assert.match(line, /Deep Rock Galactic/);
    assert.match(line, /Rocket League/);
    assert.doesNotMatch(line, /Spotify/);
  });

  // The spike's output is meant to be pasted into the issue it belongs to, so it goes through the
  // same identifier hashing every other log line uses.
  test('does not print the raw user id', () => {
    const line = describeRawPresence(packet([{ type: PLAYING, name: 'Factorio' }]));
    assert.doesNotMatch(line, /123456789012345678/);
    assert.match(line, /member:[0-9a-f]{8}/);
  });
});
