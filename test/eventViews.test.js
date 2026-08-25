import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// eventViews.js reaches config.js, which throws at import when DISCORD_TOKEN is missing — and CI
// runs with no .env at all. Set one first, then pull the module in dynamically so the assignment
// is guaranteed to happen before the graph loads. dotenv leaves an existing value alone, so a real
// local .env still wins.
process.env.DISCORD_TOKEN ??= 'test-token';
const {
  RSVP_STATUSES, MANAGE_ACTIONS, buildEventEmbed, buildEventComponents, buildEventManagePanel,
  withoutMention, contentPatchAfterReply,
} = await import('../src/interactions/eventViews.js');

const EVENT = {
  id: 7,
  title: 'Game Night',
  description: null,
  game_name: null,
  starts_at: Date.UTC(2026, 7, 22, 20, 0),
};

/** The custom ids of every button in a built component set, row by row. */
function customIds(rows) {
  return rows.map((row) => row.toJSON().components.map((button) => button.custom_id));
}

function labels(rows) {
  return rows.map((row) => row.toJSON().components.map((button) => button.label));
}

describe('withoutMention — pruning the invite ping line', () => {
  test('returns null for content that was never there', () => {
    assert.equal(withoutMention(null, '1'), null);
    assert.equal(withoutMention('', '1'), null);
  });

  test('removes the only mention, leaving nothing rather than an empty string', () => {
    // interaction.update() needs null to clear content; '' would leave the old line standing.
    assert.equal(withoutMention('<@1>', '1'), null);
  });

  test('removes a mention from the middle without welding the neighbours together', () => {
    assert.equal(withoutMention('<@1> <@2> <@3>', '2'), '<@1> <@3>');
  });

  test('removes the trailing mention without leaving a dangling space', () => {
    assert.equal(withoutMention('<@1> <@2>', '2'), '<@1>');
  });

  test('matches the nickname form Discord sometimes sends', () => {
    assert.equal(withoutMention('<@1> <@!2> <@3>', '2'), '<@1> <@3>');
  });

  test('leaves the line alone for someone who was never invited', () => {
    assert.equal(withoutMention('<@1> <@2>', '99'), '<@1> <@2>');
  });

  test('is idempotent — answering twice cannot eat a second name', () => {
    const once = withoutMention('<@1> <@2>', '1');
    assert.equal(withoutMention(once, '1'), '<@2>');
  });

  test('does not swallow text that merely starts with an s', () => {
    // Regression: the whitespace class has to survive into the RegExp. Degraded to a literal "s"
    // it matches "<@1>s" here and returns "ee you", silently eating a character of the line.
    assert.equal(withoutMention('<@1>see you', '1'), 'see you');
  });
});

describe('contentPatchAfterReply — syncing the announcement after an RSVP made elsewhere', () => {
  test('omits the key entirely when the line does not change', () => {
    // The distinction that matters: discord.js reads an absent content as "leave it alone" and a
    // null one as "clear it". Emitting the key here would blank the invite line for the edit and
    // cancel callers, which share this payload and never mean to touch it.
    assert.deepEqual(contentPatchAfterReply('<@1> <@2>', '99'), {});
    assert.ok(!('content' in contentPatchAfterReply('<@1> <@2>', '99')));
  });

  test('treats an announcement that never had a ping line as unchanged', () => {
    // discord.js reports no content as '', which withoutMention normalises to null — compared
    // raw those differ, and every RSVP would then pointlessly rewrite the message.
    assert.deepEqual(contentPatchAfterReply('', '1'), {});
    assert.deepEqual(contentPatchAfterReply(null, '1'), {});
  });

  test('prunes the responder when they are on the line', () => {
    assert.deepEqual(contentPatchAfterReply('<@1> <@2> <@3>', '2'), { content: '<@1> <@3>' });
  });

  test('clears the line explicitly once the last invitee answers', () => {
    // null rather than absent, so the ping line actually goes rather than lingering forever.
    assert.deepEqual(contentPatchAfterReply('<@1>', '1'), { content: null });
  });
});

describe('buildEventComponents — the public announcement', () => {
  test('shows the three RSVP buttons and a single Manage button', () => {
    const rows = buildEventComponents(7);
    assert.equal(rows.length, 2);
    assert.deepEqual(customIds(rows), [
      ['event:going:7', 'event:maybe:7', 'event:declined:7'],
      ['event:tools:7'],
    ]);
  });

  test('keeps Edit, Resend and Delete off the public message entirely', () => {
    // The point of the panel: everyone can see the announcement, but those three work only for
    // the creator and Manage Server, so inline they were controls that could only refuse people.
    const ids = customIds(buildEventComponents(7)).flat().join(' ');
    for (const action of ['edit', 'resend', 'delete']) {
      assert.ok(!ids.includes(`event:${action}:`), `${action} belongs in the panel, not the announcement`);
    }
  });

  test('labels are stable', () => {
    assert.deepEqual(labels(buildEventComponents(7)), [
      ["I'm in", 'Maybe', "Can't make it"],
      ['⚙️ Manage'],
    ]);
  });
});

describe('buildEventManagePanel — the ephemeral panel', () => {
  test('holds Edit, Resend and Delete on one row', () => {
    const rows = buildEventManagePanel(7);
    assert.equal(rows.length, 1);
    assert.deepEqual(customIds(rows), [['event:edit:7', 'event:resend:7', 'event:delete:7']]);
    assert.deepEqual(labels(rows), [['✏️ Edit', '🔁 Resend', '🗑️ Delete']]);
  });

  test('reuses the ids the announcement row used to carry', () => {
    // Load-bearing for the transition: every event already posted still shows the old inline row,
    // and those buttons keep working because the ids moved surface without changing.
    assert.deepEqual(customIds(buildEventManagePanel(7)).flat(), ['event:edit:7', 'event:resend:7', 'event:delete:7']);
  });
});

describe('event button actions', () => {
  const renderedActions = () => [...customIds(buildEventComponents(7)), ...customIds(buildEventManagePanel(7))]
    .flat().map((id) => id.split(':')[1]);

  test('every rendered action is one the dispatcher recognises', () => {
    // handleEventButton writes an unrecognised action straight into event_signups.status, which
    // has no CHECK constraint — these two lists drifting apart is what the guard exists to catch.
    for (const action of renderedActions()) {
      assert.ok(
        RSVP_STATUSES.includes(action) || MANAGE_ACTIONS.includes(action),
        `${action} is rendered but is neither an RSVP status nor a managed action`,
      );
    }
  });

  test('every managed action is reachable from some button', () => {
    const rendered = renderedActions();
    for (const action of MANAGE_ACTIONS) assert.ok(rendered.includes(action), `${action} is gated but never rendered`);
  });

  test('RSVP and manage actions never overlap', () => {
    assert.deepEqual(RSVP_STATUSES.filter((status) => MANAGE_ACTIONS.includes(status)), []);
  });

  test('the panel opener does not reuse the /event list select id', () => {
    // `event:manage` is that select's exact customId. The router keeps the two apart — it matches
    // the select on equality, and only for a string select — but sharing the word would not.
    const [, manageRow] = buildEventComponents(7);
    assert.equal(manageRow.toJSON().components[0].custom_id, 'event:tools:7');
  });

  test('ids stay inside Discord 100-character cap for any plausible event id', () => {
    const ids = [
      ...customIds(buildEventComponents(Number.MAX_SAFE_INTEGER)),
      ...customIds(buildEventManagePanel(Number.MAX_SAFE_INTEGER)),
    ].flat();
    for (const id of ids) assert.ok(id.length <= 100, `${id} is ${id.length} chars`);
  });
});

describe('buildEventEmbed', () => {
  test('titles the embed and renders the start time as both absolute and relative stamps', () => {
    const embed = buildEventEmbed(EVENT, []).toJSON();
    const seconds = Math.floor(EVENT.starts_at / 1000);
    assert.equal(embed.title, 'Game Night');
    assert.equal(embed.fields[0].name, '🗓️ When');
    assert.equal(embed.fields[0].value, `<t:${seconds}:F>\n<t:${seconds}:R>`);
  });

  test('invites the first signup when nobody has answered', () => {
    const embed = buildEventEmbed(EVENT, []).toJSON();
    const going = embed.fields.find((field) => field.name.startsWith('✅'));
    assert.equal(going.name, '✅ Going (0)');
    assert.equal(going.value, 'Nobody yet — be the first!');
  });

  test('omits the maybe and declined sections while they are empty', () => {
    const names = buildEventEmbed(EVENT, []).toJSON().fields.map((field) => field.name);
    assert.deepEqual(names, ['🗓️ When', '✅ Going (0)']);
  });

  test('counts and lists each status separately', () => {
    const embed = buildEventEmbed(EVENT, [
      { user_id: '1', status: 'going' },
      { user_id: '2', status: 'going' },
      { user_id: '3', status: 'maybe' },
      { user_id: '4', status: 'declined' },
    ]).toJSON();
    const field = (prefix) => embed.fields.find((row) => row.name.startsWith(prefix));
    assert.equal(field('✅').name, '✅ Going (2)');
    assert.equal(field('✅').value, '<@1>, <@2>');
    assert.equal(field('🤔').name, '🤔 Maybe (1)');
    assert.equal(field('🤔').value, '<@3>');
    assert.equal(field('❌').name, "❌ Can't make it (1)");
    assert.equal(field('❌').value, '<@4>');
  });

  test('adds the optional game and description only when the event has them', () => {
    const bare = buildEventEmbed(EVENT, []).toJSON();
    assert.equal(bare.description, undefined);
    assert.ok(!bare.fields.some((field) => field.name === '🎮 Game'));

    const full = buildEventEmbed({ ...EVENT, description: 'Bring snacks', game_name: 'Deep Rock' }, []).toJSON();
    assert.equal(full.description, 'Bring snacks');
    assert.equal(full.fields.find((field) => field.name === '🎮 Game').value, 'Deep Rock');
  });
});
