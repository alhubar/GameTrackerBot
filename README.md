# Discord Game Tracker

Tracks time a member is visibly playing a game in Discord, stores it locally, and automatically assigns rank roles based on cumulative hours.

## What it tracks

- Discord activities whose type is **Playing** (not streaming, watching, or custom status).
- Time across all games, including changing from one game to another.
- One active game at a time per member; if Discord shows several games, the first one is used.
- Time is saved every minute and when Discord reports the game has changed/stopped.

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
5. Invite the bot with the `bot` and `applications.commands` scopes. Give it **Manage Roles**, and put its role above the ten tracker roles in the server role list.
6. Start it with `npm start`.
7. A member with the **Manage Server** permission can run `/setup` in the channel where rank-up notifications should appear. This creates the tracker roles with the rank name alone (for example, `Villager`) and a default color. Then use `/info`, `/stats`, `/leaderboard`, or `/server`.

`data/tracker.sqlite` is created automatically. Back it up if you want to preserve history when moving the bot.

## Notes

Discord can only report games a member exposes through their Discord presence. The bot cannot see activity hidden by a member's privacy settings, nor activity while Discord itself is offline. After a bot restart it begins timing any current activity from the time it reconnects.

When someone reaches a new rank, the configured channel automatically receives the matching `LEVEL_UP_MESSAGE_*` from `.env`.

The leaderboard shows each player's rank, server nickname, and compact play time, such as `1. Villager PlayerName — 30m`.

`/info` shows the active rank list with matching colored-square emojis. New roles receive a default white, green, blue, yellow, orange, red, or purple color; colors you later set in Discord are preserved when you run `/setup` again.

## Statistics and history

The bot records each completed game session in its local SQLite database: the player, game, start/end times, session length, total time per game, and session count. It uses that history to show a player profile with total time, this month's time, most-played game, longest session, and distinct games played via `/stats`.

`/server` shows server-wide tracked players, total gaming time, most-played game, most-active player, and distinct games tracked. Detailed per-game history starts when this version is deployed; Discord does not make historic activity available for recovery.

## Achievements

The bot awards personal achievements across a wide range of play patterns. What they are and what triggers them is intentionally not documented here, and there's no in-bot command that lists the locked ones either — so unlocking one is a surprise. If you want the full list (to tune something, or just to peek), it's in `src/achievements.js`.

Set `ACHIEVEMENT_CHANNEL` in `.env` to the text channel name where unlocks should be announced. Set `ACHIEVEMENT_ANNOUNCEMENTS=false` to stop announcements without affecting which achievements are unlocked. `/stats` shows a member's unlock count and badges (e.g. `🏆 Achievements (3/35)`), but never the locked list. Achievements are tracked per server, not globally.

Time-of-day achievements are intentionally not included, since session timestamps are stored in UTC and the bot has no per-member timezone — and there's no reliable way to get a player's timezone from Discord automatically, so it would need a manual `/timezone` command with no guarantee everyone sets it up.

## Server achievements

Separate from personal achievements, the server itself unlocks one-time, server-wide milestones across a dozen categories covering things like community growth, collective playtime, and shared activity patterns. Unlike personal achievements, these aren't secret — `/server` and the `/stats` card's Server tab show the full list with progress, locked and unlocked alike. The specific categories aren't documented here either; see `src/serverAchievements.js` for the definitions.

Every category's threshold is configurable via the `SERVER_*` variables in `.env` — see `.env.example` for the full set and what each one tunes, since what counts as a milestone depends heavily on server size. One category has no threshold to configure; it always requires exactly as many rank tiers as `RANK_NAMES`/`RANK_HOURS` define.

Unlocks post a standalone banner to `ACHIEVEMENT_CHANNEL` (same channel and toggle as personal achievements) with a snapshot of the server's stats at that moment.

## Stats card

`/stats [member]` posts an interactive embed with five tabs — Statistics, Games, Achievements, Leaderboard, and Server — click a button to switch views in place. Statistics is the default view when the command runs. The Achievements tab lists what that member has actually unlocked (name, emoji, and description — no spoilers for what's still locked); the Leaderboard tab has an All-Time page and a This Month page; the Server tab shows server-wide stats plus the server achievement list. All three paginate. Only the member who ran the command can use its buttons; anyone else clicking gets a private reminder to run their own.

`/leaderboard` and `/server` still work as standalone plain-text commands too, for a quick look without opening the card. `/leaderboard` now shows both the all-time and this-month totals in one reply. `/server` shows the top 3 most active players instead of just one, plus the server achievement list.

Achievement unlocks (personal and server-wide) post as embeds now instead of plain messages — gold-colored, with the unlocking player's avatar (or the server's icon for server achievements) as the thumbnail.

## Gamer of the Week

Once a period ends, the bot posts a recap of it on its next hourly check: who played the most, how long, their most-played game, the achievements they earned, and the runners-up. The winner is pinged and their avatar is used as the card's picture.

`RECAP_PERIOD` is `week` (Monday to Sunday, UTC) or `month`. Weekly is the default so the winner's badge keeps circulating rather than parking on one person for four weeks. `RECAP_CHANNEL` picks the channel (falling back to `ACHIEVEMENT_CHANNEL`), and `RECAP_ENABLED=false` turns it off.

The winner also receives a role — `Champion of the Realm` by default — which they keep until the next recap, when it moves to whoever wins next. The bot creates the role on first use: gold, hoisted so the holder sits in their own section of the member list, and positioned directly beneath the bot's own role. That last part matters, because a member's name takes the colour of their highest coloured role — created at the default bottom position, the badge would be silently overridden by every rank role. Set `RECAP_WINNER_ROLE` to rename it, or blank to post the recap without any role. It needs **Manage Roles**, with the bot's own role above it.

`RECAP_WINNER_ROLE_ICON` optionally sets an emoji as the role's icon, shown beside the winner's name. Discord only permits role icons from **Server Boost Level 2**; below that the bot logs a note and applies the badge without one, so the value can be set ahead of time and simply starts working if the server is ever boosted.

`RECAP_MIN_HOURS` (default 2) is how much tracked play the top member needs before the title is awarded at all. Fall short and the bot posts a "nobody was worthy" card instead — grey rather than gold, wearing the bot's own avatar since there is no winner to show — and the badge comes off whoever held it, leaving the title vacant. Set it to 0 to crown anyone with any tracked play.

Each period is announced exactly once — the period is recorded after posting, so restarting the bot part-way through cannot repost it. That includes the unclaimed weeks, so they are announced once and not repeated.

Setting `RECAP_PERIOD=week` on a quiet server is the quickest way to see one, since the next Monday will produce a recap either way — with a winner if anyone cleared `RECAP_MIN_HOURS`, and the unclaimed card if not.

## Events

`/event create` first asks which timezone the event is in — a dropdown of presets configured via `EVENT_TIMEZONE_PRESETS` in `.env`, which you should set to whichever zones your own members live in (e.g. `Europe/Madrid,America/Denver,Australia/Sydney`; defaults to UTC, New York, Berlin, and Tokyo if unset). Discord modals can't contain dropdowns, so the timezone picker is a separate step before the form opens; picking one then shows the form itself (title, date/time, game, description). Submitting it posts an embed announcing the event, with **I'm in** / **Maybe** / **Can't make it** buttons underneath. Clicking one updates the embed's Going/Maybe lists live. The time you type is converted once at that point — Discord then renders it to each viewer in their own local time and format automatically via native timestamp formatting, so nobody has to do the math themselves.

A second row of buttons — **✏️ Edit** and **🗑️ Delete** — is visible to everyone but only works for whoever created the event; anyone else clicking gets a private "only the creator" reply. Edit asks for the timezone again (in case you want to describe the new time in a different one), then opens the form pre-filled with the current details; changing the time resets which reminder stages have already fired (so they fire again relative to the new time), but editing just the title/description/game doesn't. Delete removes the event and turns the embed into a crossed-out "cancelled" notice — and if the event was managed from somewhere other than its original announcement (see `/event list` below), the original announcement gets updated or cancelled too, so it never goes stale.

`/event list` shows upcoming events with a jump link to each announcement, plus a dropdown to select one and manage it (Edit/Delete) directly — this works even for events whose original message can't be found or was created before this dropdown existed, since it doesn't depend on locating that message at all.

`EVENT_REMINDER_STAGES_MINUTES` (default `720,60,0` — 12 hours before, 1 hour before, and at start) controls how many reminder stages fire and when; each pings everyone who's "Going" in the event's channel. The wording always reflects the actual time left when it sends (`"Title" event starts in 1 hour`), not the stage's nominal name, so a delayed reminder never says something already false — and the `0` ("at start") stage says `"Title" is starting now!` instead. Events are cleaned up automatically 24 hours after they start, so the table doesn't grow forever — no need to delete them manually unless you want to cancel one early.