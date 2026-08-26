# Discord Game Tracker

Tracks time a member is visibly playing a game in Discord, stores it locally, and automatically assigns rank roles based on cumulative hours.

## What it tracks

- Discord activities whose type is **Playing** (not streaming, watching, or custom status).
- Time across all games, including changing from one game to another.
- One active game at a time per member; if Discord shows several games, the first one is used.
- Time is saved every minute and when Discord reports the game has changed/stopped.
- **Idle time is not counted.** Discord marks a member idle after roughly ten minutes without
  input while still reporting whatever game is open, so a launcher left running overnight would
  otherwise bank a full night of playtime. The clock stops when a member goes idle and restarts
  when they return; the gap counts toward nothing — not totals, not ranks, not the leaderboard,
  and not the session-length achievements. Set `PAUSE_ON_IDLE=false` to count idle time as play.
- **Sessions are capped.** For the cases idle never catches — a mouse jiggler, or a client that
  simply never reports idle — any session past `MAX_SESSION_HOURS` of active time is closed.
  Anyone genuinely still playing is picked up again on their next presence change. Keep the cap
  above your longest session-length achievement, or that one can never be earned.

## Customize ranks

In `.env`, edit these comma-separated values (the default has seven ranks):

```env
RANK_NAMES=Villager,Pathfinder,Dungeon Delver,Dragon Slayer,Realm Guardian,Mythic Hero,Eternal Legend
RANK_HOURS=1,2,3,4,5,6,7
```

Each position corresponds to the same position in `RANK_HOURS`. Players have no rank before reaching the first threshold. The values above are only a safe example; the hour values must be non-negative and strictly increase. Keep your real `.env` private if you do not want players to know the requirements. After editing `.env`, restart the bot and run `/setup` again in the server. It updates the tracker role names without losing member playtime.

You can customize every announcement independently with `LEVEL_UP_MESSAGE_1` through `LEVEL_UP_MESSAGE_7`. Use `{user}`, `{level}`, `{rank}`, and `{hours}` as placeholders. For example: `LEVEL_UP_MESSAGE_2=⚔️ {user} became a {rank} after {hours} of adventuring!`

## Setup

1. Install [Node.js 20 or later](https://nodejs.org/).
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env`, then fill in `DISCORD_TOKEN`.
4. In the Discord Developer Portal, enable **Presence Intent** and **Server Members Intent** under **Bot → Privileged Gateway Intents**.
5. Invite the bot with the `bot` and `applications.commands` scopes. Give it **Manage Roles**, and put its role above the tracker roles in the server role list.
6. Start it with `npm start`.
7. A member with the **Manage Server** permission can run `/setup` in the channel where rank-up notifications should appear. This creates the tracker roles with the rank name alone (for example, `Villager`) and a default color. Then use `/info`, `/stats`, `/leaderboard`, or `/server`. Administrators also get `/health` — see [Checking the bot is alive](#checking-the-bot-is-alive).

`data/tracker.sqlite` is created automatically, and the bot keeps a rotating set of nightly backups of it — see
[Backups](#backups).

## Notes

**One server per instance.** Ranks, thresholds, channel names and recap settings all come from
`.env`, so every guild the bot joins shares the same configuration and posts to same-named
channels. Run a separate instance per server if you need them configured differently.

Error lines refer to members by a short hash rather than a username or id, so pasting a stack trace
into an issue or a chat does not publish who it was about. Set `DEBUG_IDENTIFIERS=true` to log real
ids while debugging.

Discord can only report games a member exposes through their Discord presence. The bot cannot see activity hidden by a member's privacy settings, nor activity while Discord itself is offline. After a bot restart it begins timing any current activity from the time it reconnects.

When someone reaches a new rank, the configured channel automatically receives the matching `LEVEL_UP_MESSAGE_*` from `.env`.

The leaderboard shows each player's rank, server nickname, and compact play time, such as `1. Villager PlayerName — 30m`.

Members who leave the server drop off the leaderboard and off `/server`'s most-active list, but **nothing of theirs is deleted**. Leaving a Discord server is often accidental, so their hours, rank and achievements are kept exactly as they were — rejoin and they reappear at whatever position their playtime earns, with nothing to restore. The rankings are about who is here now; the history is not. Their time does still count toward the server's total gaming time and its server achievements, which are the server's own record rather than a roster.

`/info` shows the active rank list with matching colored-square emojis. New roles receive a default white, green, blue, yellow, orange, red, or purple color; colors you later set in Discord are preserved when you run `/setup` again.

## Statistics and history

The bot records each completed game session in its local SQLite database: the player, game, start/end times, session length, total time per game, and session count. It uses that history to show a player profile with total time, this month's time, most-played game, longest session, and distinct games played via `/stats`.

`/server` shows server-wide tracked players, total gaming time, most-played game, most-active player, and distinct games tracked. Detailed per-game history starts when this version is deployed; Discord does not make historic activity available for recovery.

**Server records** appear on both `/server` and the `/stats` card's Server tab: the longest single session, the largest gaming group, and the biggest game collection. Each is deliberately something no other command surfaces — nothing else shows how long a single sitting ran, how many people play one game, or who has the widest library, so a record adds information rather than restating the list above it. Unlike achievements, a record is not permanent — it names whoever holds it right now and changes hands the moment somebody beats it, so there is nothing to unlock and no announcement when one moves. Records a server has not set yet are simply omitted rather than shown empty.

The last two — the largest group and the biggest collection — only count a game once someone has put a real hour into it, the same bar the server milestones use, so a game launched for a minute never counts toward either. Note that the **Games played** figure on a member's own `/stats` card is a plain count of everything they have ever launched and applies no such bar, so the two numbers are answering different questions and will not match. The longest-session record can only be read from recorded sessions, so on a database that predates per-session history it starts from the day that history began rather than the server's first day.

## Achievements

The bot awards personal achievements across a wide range of play patterns. What they are and what triggers them is intentionally not documented here, and there's no in-bot command that lists the locked ones either — so unlocking one is a surprise. If you want the full list (to tune something, or just to peek), it's in `src/achievements.js`.

Set `ACHIEVEMENT_CHANNEL` in `.env` to the text channel name where unlocks should be announced. Set `ACHIEVEMENT_ANNOUNCEMENTS=false` to stop announcements without affecting which achievements are unlocked. `/stats` shows a member's unlock count and badges (e.g. `🏆 Achievements (3/35)`), but never the locked list. Achievements are tracked per server, not globally.

Time-of-day achievements are intentionally not included, since session timestamps are stored in UTC and the bot has no per-member timezone — and there's no reliable way to get a player's timezone from Discord automatically, so it would need a manual `/timezone` command with no guarantee everyone sets it up.

## Server achievements

Separate from personal achievements, the server itself unlocks one-time, server-wide milestones across a dozen categories covering things like community growth, collective playtime, and shared activity patterns. Unlike personal achievements, these aren't secret — `/server` and the `/stats` card's Server tab show the full list with progress, locked and unlocked alike. The specific categories aren't documented here either; see `src/serverAchievements.js` for the definitions.

Every category's threshold is configurable via the `SERVER_*` variables in `.env` — see `.env.example` for the full set and what each one tunes, since what counts as a milestone depends heavily on server size. One category has no threshold to configure; it always requires exactly as many rank tiers as `RANK_NAMES`/`RANK_HOURS` define.

Unlocks post a standalone banner to `ACHIEVEMENT_CHANNEL` (same channel and toggle as personal achievements) with a snapshot of the server's stats at that moment.

## Stats card

`/stats [member]` posts an interactive embed with five tabs — Statistics, Games, Achievements, Leaderboard, and Server — click a button to switch views in place. Statistics is the default view when the command runs. The Achievements tab lists what that member has actually unlocked (name, emoji, and description — no spoilers for what's still locked); the Leaderboard tab has an All-Time page and a This Month page; the Server tab shows server-wide stats, the server records, plus the server achievement list. All three paginate. Only the member who ran the command can use its buttons; anyone else clicking gets a private reminder to run their own.

`/leaderboard` and `/server` still work as standalone plain-text commands too, for a quick look without opening the card. `/leaderboard` now shows both the all-time and this-month totals in one reply. `/server` shows the top 3 most active players instead of just one, plus the server records and the server achievement list.

Achievement unlocks (personal and server-wide) post as embeds now instead of plain messages — gold-colored, with the unlocking player's avatar (or the server's icon for server achievements) as the thumbnail.

## Gamer of the Week

Once a period ends, the bot posts a recap of it on its next hourly check: who played the most, how long, their most-played game, the achievements they earned, and the runners-up. The winner is pinged and their avatar is used as the card's picture.

`RECAP_PERIOD` is `week` (Monday to Sunday, UTC) or `month`. Weekly is the default so the winner's badge keeps circulating rather than parking on one person for four weeks. `RECAP_CHANNEL` picks the channel (falling back to `ACHIEVEMENT_CHANNEL`), and `RECAP_ENABLED=false` turns it off.

The winner also receives a role — `Champion of the Realm` by default — which they keep until the next recap, when it moves to whoever wins next. The bot creates the role on first use: pale blue, hoisted so the holder sits in their own section of the member list, and positioned directly beneath the bot's own role. The colour is deliberately not the gold the achievement cards use — the badge outranks every rank role, so it is what a winner's name looks like all period, and gold reads as almost the same yellow as the fourth rank. Only applied when the role is created; recolour it in Discord afterwards and the bot leaves your choice alone. That last part matters, because a member's name takes the colour of their highest coloured role — created at the default bottom position, the badge would be silently overridden by every rank role. Set `RECAP_WINNER_ROLE` to rename it, or blank to post the recap without any role. It needs **Manage Roles**, with the bot's own role above it.

`RECAP_WINNER_ROLE_ICON` optionally sets an emoji as the role's icon, shown beside the winner's name. Discord only permits role icons from **Server Boost Level 2**; below that the bot logs a note and applies the badge without one, so the value can be set ahead of time and simply starts working if the server is ever boosted.

`RECAP_MIN_HOURS` (default 2) is how much tracked play the top member needs before the title is awarded at all. Fall short and the bot posts a "nobody was worthy" card instead — grey rather than gold, wearing the bot's own avatar since there is no winner to show — and the badge comes off whoever held it, leaving the title vacant. Set it to 0 to crown anyone with any tracked play.

Each period is announced exactly once — the period is recorded after posting, so restarting the bot part-way through cannot repost it. That includes the unclaimed weeks, so they are announced once and not repeated.

Setting `RECAP_PERIOD=week` on a quiet server is the quickest way to see one, since the next Monday will produce a recap either way — with a winner if anyone cleared `RECAP_MIN_HOURS`, and the unclaimed card if not.

## Checking the bot is alive

`/health` reports whether tracking is actually running. It is restricted to administrators — Discord hides it from
everyone else, and the command re-checks the permission itself in case the default was overridden under **Server
Settings → Integrations**. The reply is private either way.

It exists because of a specific blind spot: this bot deliberately swallows Discord-facing errors so one failing feature
cannot take the whole process down, which means a stalled gateway connection or a wedged checkpoint loop looks exactly
like a quiet evening — no crash, no message, playtime silently not accruing. `/health` shows the two ages that tell
those apart:

- **Presence tracking** — when the last presence event arrived, and how many have arrived this run. Nothing at all
  after a while usually means the **Presence Intent** is off.
- **Checkpoint loop** — when the 60-second banking loop last ran. Flagged red if it has missed several ticks.

Alongside those it shows uptime, gateway latency, guild count, whether the database is readable, the number of active
sessions, tracked players, and how many achievements have been unlocked.

## Backups

Once a day at `BACKUP_HOUR_UTC` (default 04:00 UTC) the bot writes a copy of the database to `BACKUP_DIR`
(default `data/backups`) named `tracker-YYYY-MM-DD.sqlite`, then deletes everything past the newest `BACKUP_KEEP`
(default 7). Set `BACKUP_ENABLED=false` to turn the schedule off.

The copy goes through SQLite's online backup API rather than a file copy, so it is a consistent snapshot taken while
the bot is still running — there is no need to stop anything, and no `-wal`/`-shm` files to keep alongside it. Each is a
complete database: to restore one, stop the bot, put it where `DATABASE_PATH` points, and start again.

Whether the night's copy has been taken is read off the filenames already in the directory rather than stored
anywhere, so restarting the bot can neither skip a night nor take a second copy. A bot that was down at the scheduled
hour takes that day's copy when it comes back up.

Members with **Manage Server** can also run `/backup` for a copy on demand — before a risky change, say. It writes the
same day-stamped name, so it replaces the day's copy rather than adding to the series.

Point `BACKUP_DIR` at a different disk than the database if you can. A backup beside the original does not survive
losing the drive.

## Maintenance

`npm run db-check` prints a read-only integrity report for the database — impossible session durations, sessions that
end before they start, orphaned event signups, unlocked achievement ids that no longer exist, rank roles stranded by a
shortened `RANK_NAMES`, and so on. It opens the file read-only and never writes, so it is safe to run against a live
database with the bot running. It exits non-zero if it finds an error, so it drops straight into a cron job.

Point it elsewhere with `npm run db-check -- --db path/to/tracker.sqlite`, and add `--verbose` to list the offending
rows rather than just counting them.

It reports problems and never repairs them, which is deliberate. In particular there is **no rebuild-from-sessions
mode**: per-session history was added to a schema that already had running totals, so on any database created before
that change the early hours exist only in the totals and cannot be reconstructed. Recomputing the totals from session
rows would delete that history and demote members whose rank depends on it. The check reports the size of that gap and
leaves the numbers alone.

`scripts/preflight-upgrade.js` is the other maintenance tool — it answers what a *new* set of achievement thresholds
would unlock on an existing database before you deploy them.

## Development

```bash
npm test         # the full suite (node's built-in test runner — no framework dependency)
npm run test:watch
npm run lint     # eslint
npm run dev      # run the bot with --watch
```

Every push runs lint plus the suite on Node 20, 22 and 24 via GitHub Actions. The tests state achievement thresholds
outright, so read them only if you don't mind the spoilers the rest of this file avoids.

## Events

`/event create` first asks which timezone the event is in — a dropdown of presets configured via `EVENT_TIMEZONE_PRESETS` in `.env`, which you should set to whichever zones your own members live in (e.g. `Europe/Madrid,America/Denver,Australia/Sydney`; defaults to UTC, New York, Berlin, and Tokyo if unset). Discord modals can't contain dropdowns, so the timezone picker is a separate step before the form opens; picking one then shows the form itself (title, date/time, game, description). Submitting it posts an embed announcing the event, with **I'm in** / **Maybe** / **Can't make it** buttons underneath. Clicking one updates the embed's Going/Maybe lists live. The time you type is converted once at that point — Discord then renders it to each viewer in their own local time and format automatically via native timestamp formatting, so nobody has to do the math themselves.

Below the RSVP buttons sits a single **⚙️ Manage** button. It works for whoever created the event, or anyone with Manage Server; anyone else clicking gets a private reply saying so. It opens a panel only that person can see, holding **✏️ Edit**, **🔁 Resend** and **🗑️ Delete** — so the announcement everyone reads stays down to the three buttons everyone can actually use.

Edit asks for the timezone again (in case you want to describe the new time in a different one), then opens the form pre-filled with the current details; changing the time resets which reminder stages have already fired (so they fire again relative to the new time), but editing just the title/description/game doesn't. Resend posts the announcement again at the bottom of the channel and removes the old copy, for an event that's been buried under later chatter — the event itself is unchanged and every RSVP is kept. If members were invited by ping when the event was created, the new post carries that ping line, so whoever still hasn't answered is notified again; anyone who has already answered was dropped from that line the moment they did, and is not pinged twice. Delete removes the event and turns the embed into a crossed-out "cancelled" notice — and if the event was managed from somewhere other than its original announcement (see `/event list` below), the original announcement gets updated or cancelled too, so it never goes stale.

Events announced before the Manage button existed keep the older row of Edit/Resend/Delete buttons, and those go on working exactly as they did. Resending one replaces it with a post carrying the new layout.

`/event list` shows upcoming events with a jump link to each announcement, plus a dropdown to select one and manage it directly — this works even for events whose original message can't be found or was created before this dropdown existed, since it doesn't depend on locating that message at all.

`EVENT_REMINDER_STAGES_MINUTES` (default `720,60,0` — 12 hours before, 1 hour before, and at start) controls how many reminder stages fire and when; each pings everyone who's "Going" in the event's channel. The wording always reflects the actual time left when it sends (`"Title" event starts in 1 hour`), not the stage's nominal name, so a delayed reminder never says something already false — and the `0` ("at start") stage says `"Title" is starting now!` instead. Events are cleaned up automatically 24 hours after they start, so the table doesn't grow forever — no need to delete them manually unless you want to cancel one early.