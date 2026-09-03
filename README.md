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
- **Leaving the server closes the session.** Discord stops reporting anyone who is no longer in the
  server, so a member who leaves mid-game would otherwise keep banking time until the next restart
  and land as one enormous session. They are credited with what they played up to the moment they
  left. Nothing of theirs is deleted — see below.
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
4. In the Discord Developer Portal, enable **Presence Intent** and **Server Members Intent** under **Bot → Privileged Gateway Intents**. Those two are the only ones needing a switch — the message and voice-state intents behind the [talking and voice badges](#talking-and-voice-badges) are not privileged, and **Message Content** is never requested at all.
5. Invite the bot with the `bot` and `applications.commands` scopes. Give it **Manage Roles**, and put its role above the tracker roles in the server role list.
6. Start it with `npm start`.
7. A member with the **Manage Server** permission can run `/setup` in the channel where rank-up notifications should appear. This creates the tracker roles with the rank name alone (for example, `Villager`) and a default color. Then use `/info`, `/stats`, `/leaderboard`, or `/server`, and `/privacy` to control your own tracking ([Privacy and opting out](#privacy-and-opting-out)). Manage Server also gets `/backup` ([Backups](#backups)), and administrators get `/health` ([Checking the bot is alive](#checking-the-bot-is-alive)) and `/adjust` ([Correcting bad stats](#correcting-bad-stats)).

`data/tracker.sqlite` is created automatically, and the bot keeps a rotating set of nightly backups of it — see
[Backups](#backups).

## Notes

**One server per instance.** Ranks, thresholds, channel names and recap settings all come from
`.env`, so every guild the bot joins shares the same configuration and posts to same-named
channels. Run a separate instance per server if you need them configured differently.

Error lines refer to members by a short hash rather than a username or id, so pasting a stack trace
into an issue or a chat does not publish who it was about. Set `DEBUG_IDENTIFIERS=true` to log real
ids while debugging.

`PRESENCE_PLATFORM_LOG=true` logs one line for every presence carrying a game, including the
per-activity `platform` field (`ps5`, `xbox`, `desktop`) that discord.js drops before the bot sees
it. It is there to answer whether a console presence can be told apart from a desktop one — a
console keeps broadcasting a game after play stops, sometimes for hours, and neither the idle pause
nor `MAX_SESSION_HOURS` can catch that. Nothing acts on it yet; it only logs, and it is noisy, so
turn it on to capture a few real console presences and turn it back off.

Discord can only report games a member exposes through their Discord presence. The bot cannot see activity hidden by a member's privacy settings, nor activity while Discord itself is offline. After a bot restart it begins timing any current activity from the time it reconnects.

When someone reaches a new rank, the configured channel automatically receives the matching `LEVEL_UP_MESSAGE_*` from `.env`.

The leaderboard shows each player's rank, server nickname, and compact play time, such as `1. Villager PlayerName — 30m`.

Members who leave the server drop off the leaderboard and off `/server`'s most-active list, but **nothing of theirs is deleted**. Leaving a Discord server is often accidental, so their hours, rank and achievements are kept exactly as they were — rejoin and they reappear at whatever position their playtime earns, with nothing to restore. The rankings are about who is here now; the history is not. Their time does still count toward the server's total gaming time and its server achievements, which are the server's own record rather than a roster.

`/info` is the bot's front door: what it tracks, the active rank list with matching colored-square emojis and a marker on the rank you currently hold, how many weekly badges are handed out, and the commands every member can run. It deliberately shows no hours against the ranks and never lists achievements. New rank roles receive a default white, green, blue, yellow, orange, red, or purple color; colors you later set in Discord are preserved when you run `/setup` again.

## Statistics and history

The bot records each completed game session in its local SQLite database: the player, game, start/end times, session length, total time per game, and session count. It uses that history to show a player profile with total time, this month's time, most-played game, longest session, and distinct games played via `/stats`.

`/server` shows server-wide tracked players, total gaming time, most-played game, most-active player, and distinct games tracked. Detailed per-game history starts when this version is deployed; Discord does not make historic activity available for recovery.

**When we play** is a pair of histograms on `/server` showing the shape of the last 90 days: one block per hour of the day, then the same window again by day of the week, each scaled against its own busiest bucket, with the busiest hour and the busiest day named above them. It is the one thing here read off the clock and calendar a session happened on rather than how long it ran, and it exists to answer the question `/event` has to guess at — pick a time people are already around and they turn up, which needs both halves: an hour alone cannot tell a server that plays every evening from one that only plays weekends. A session counts toward *every* hour and *every* day it covered, not just the ones it started in, so an evening that runs from 20:00 past midnight says people were there at 23:00 and puts time on both days. A bucket with nothing in it is drawn differently from one with a little, so a genuinely empty slot is visible as one.

The hours and days are wall-clock hours and days in `SERVER_TIMEZONE`, which is a single zone and unrelated to the event timezone presets — it defaults to UTC, so set it to wherever most of your members live or the peak will read hours out, and a late-evening session can land on the wrong day. The zone is named under the histogram either way. This block counts hours with nobody's name attached, so like the server's total gaming time it includes members who have since left, and it is omitted entirely until there is play in the window.

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

Once a period ends, the bot posts a recap of it on its next hourly check: who played the most, how long, their most-played game, and the achievements they earned. Their avatar is used as the card's picture. Nobody is pinged — an achievement is a thing you did and pings accordingly, while a recap is a thing that happened. There are no runners-up on the card either; it is about the member who won it, and `/leaderboard` is there for the standings.

`RECAP_HOUR_UTC` (default 0) is which hour of the day the recap is posted, counted from the moment the period ended — a week ends Monday 00:00 UTC, so 18 posts it Monday 18:00 UTC. Leave it at 0 and the recap goes out as soon as the period turns over, which on a restarted bot means some arbitrary minute after midnight, read by nobody. If the bot is down when the hour passes, the recap is posted late rather than skipped.

`RECAP_PERIOD` is `week` (Monday to Sunday, UTC) or `month`. Weekly is the default so the winner's badge keeps circulating rather than parking on one person for four weeks. `RECAP_CHANNEL` picks the channel (falling back to `ACHIEVEMENT_CHANNEL`), and `RECAP_ENABLED=false` turns it off.

The winner also receives a role — `Champion of the Realm` by default — which they keep until the next recap, when it moves to whoever wins next. The bot creates the role on first use: pale blue, hoisted so the holder sits in their own section of the member list, and positioned directly beneath the bot's own role. The colour is deliberately not the gold the achievement cards use — the badge outranks every rank role, so it is what a winner's name looks like all period, and gold reads as almost the same yellow as the fourth rank. Only applied when the role is created; recolour it in Discord afterwards and the bot leaves your choice alone. That last part matters, because a member's name takes the colour of their highest coloured role — created at the default bottom position, the badge would be silently overridden by every rank role. Set `RECAP_WINNER_ROLE` to rename it, or blank to post the recap without any role. It needs **Manage Roles**, with the bot's own role above it.

`RECAP_WINNER_ROLE_ICON` optionally sets an emoji as the role's icon, shown beside the winner's name. Discord only permits role icons from **Server Boost Level 2**; below that the bot logs a note and applies the badge without one, so the value can be set ahead of time and simply starts working if the server is ever boosted.

`RECAP_MIN_HOURS` (default 2) is how much tracked play the top member needs before the title is awarded at all. Fall short and the bot posts a "nobody was worthy" card instead — grey rather than gold, wearing the bot's own avatar since there is no winner to show — and the badge comes off whoever held it, leaving the title vacant. Set it to 0 to crown anyone with any tracked play.

Each period is announced exactly once — the period is recorded after posting, so restarting the bot part-way through cannot repost it. That includes the unclaimed weeks, so they are announced once and not repeated.

Setting `RECAP_PERIOD=week` on a quiet server is the quickest way to see one, since the next Monday will produce a recap either way — with a winner if anyone cleared `RECAP_MIN_HOURS`, and the unclaimed card if not.

**Every badge is remembered.** The role moves on when the next period lands, so the result used to
vanish with it; each period's winners are now recorded permanently. From a member's second win
onward the recap card says which one it is (“their 3rd time taking the title”), and `/server` and the
`/stats` card's Server tab gain a **Hall of Fame** ranking whoever has collected the most, with a
breakdown of which badges they hold. Champion, Bard and Scribe are counted; Cave Dweller is not —
it is not a badge anybody wins, and it comes off the moment its holder turns up, so a permanent
tally of it would outlive the thing it described. Opted-out members are hidden from the Hall of
Fame, as they are from every ranking, while members who have left the server are kept and shown as
*Former member*, since it records what happened rather than who is still here. Nothing is
backdated: the record begins at the first recap after this version is deployed.

## Talking and voice badges

Not everyone who turns up plays something. Alongside Gamer of the Week, the same recap post awards two more badges — **Bard** for voice and **Scribe** for chat — so a server where the next rank is a long way off still has something changing hands every week. `SOCIAL_ENABLED=false` switches the whole thing off, handlers and all.

Both are measured in **minutes a member was active**, never in messages sent. A message count simply rewards whoever posts most often, and someone works that out within a week. A text minute is a minute in which you sent at least one message — ten messages inside the same minute is one minute. Voice minutes are ordinary elapsed time.

The two are ranked as separate boards rather than added together. A two-hour call is 120 voice minutes while typing in 120 separate minutes is an enormous week, so any combined score would have to invent an exchange rate between them that nobody would agree on. Each board is measured against itself instead.

**Voice only counts while you are actually in company.** Your clock runs when you are unmuted, undeafened, in a normal voice channel that is not the server's AFK channel, and at least one other person is in there with you. Bots do not count as company, and stage channels are excluded entirely — an audience of silent listeners is not a conversation. Your own mute stops only your own clock: somebody listening in silence still counts as company for whoever is talking, since requiring everyone present to be unmuted would let one quiet listener zero out the person actually speaking. Two people in a channel where one is muted means only the unmuted one earns; both muting stops both clocks at once.

What that cannot catch is two friends who *both* leave a call connected overnight, so `SOCIAL_VOICE_DAILY_CAP_MINUTES` (default 240) bounds how much voice time one member can bank in a day. Configuring an AFK channel in Discord helps a great deal here — the bot never counts that channel, so Discord moving idlers into it does the rest of the work. `/health` reports whether you have one.

**Nobody holds more than one badge.** Gamer of the Week has first claim; if the same member also tops a talking board, that badge passes to the next person down and the recap says who really led it. The point is that recognition spreads, not that one member collects the set. `BARD_MIN_MINUTES` (60) and `SCRIBE_MIN_MINUTES` (30) are the floors — pass-down stops there rather than sliding to somebody with four minutes, and if nobody clears the bar the badge is announced as unclaimed and comes off whoever held it. The two numbers are deliberately different: an hour in voice is one ordinary call, an hour of active typing minutes is a very heavy week.

`BARD_ROLE` and `SCRIBE_ROLE` rename the badges, or blank either to disable that one while still recording the minutes. Both take an optional `*_ROLE_ICON` on the same terms as `RECAP_WINNER_ROLE_ICON`. Like the winner badge they are created hoisted, positioned beneath the bot's own role and above the rank roles, and coloured only on creation — orchid and parchment tan, chosen because a badge overrides its holder's rank colour for the whole period and neither may be mistaken for a rank.

**`CAVE_DWELLER_ENABLED` is off, and is the only setting in `.env.example` that defaults to off.** It marks members who did nothing at all last period — no messages, no voice, no games — and it needs an explicit `true` to switch on. Consider it carefully: by its own definition it only reaches people who were not there, so it rewards nobody and is seen by almost nobody. It cannot collide with the other badges, since playing, talking or typing all disqualify you from it, and it comes off the instant a member does any of those rather than waiting for the next recap. The recap reports a count rather than naming anybody, and unlike every other badge it is not hoisted, so it colours a name without carving a public "inactive" section into the member list. `CAVE_DWELLER_GRACE_DAYS` (14) is how long someone must have been in the server, and tracked, before a period can be held against them — nobody who joined on the Friday has earned it. Turning the setting back off leaves any existing roles alone; delete the role in Discord to clear it.

Counting who posted needs only the non-privileged **Guild Messages** intent, and voice needs **Guild Voice States**, which is also non-privileged — neither needs anything enabling in the Developer Portal. The bot never requests **Message Content** and never reads, stores or logs what anybody wrote: it records that you posted, in which server, and nothing else.

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
losing the drive. If you would rather keep the copies where they are, set `BACKUP_MIRROR_DIR` to a second location and
every copy is written twice — the mirror is created if missing and rotated on the same `BACKUP_KEEP` rule. It is a
bonus rather than a requirement: a mirror that cannot be reached is logged, and reported by `/backup`, but never fails
the backup itself.

## Privacy and opting out

Any member can control their own tracking with `/privacy`, without needing an admin. Every reply is private, and the
command has no member option — it only ever acts on whoever ran it.

- **`/privacy status`** — whether you are being tracked, and a count of everything stored about you in this server.
- **`/privacy optout`** — stop being tracked.
- **`/privacy optin`** — resume.
- **`/privacy forgetme`** — permanently erase everything, behind a confirmation button.

Opting out stops presence recording immediately (any session in progress is closed rather than left to bank its
minutes at the next checkpoint) and removes you from **every ranking**: the leaderboards, the server card's most-active
list, the server records, the weekly recap, the [talking and voice badges](#talking-and-voice-badges), and the co-op and
inactivity achievements. Messages and voice stop being counted at the same moment, any voice row is dropped along with
the session, and you cannot be given Cave Dweller — not being measured has to include not being labelled for the
result. It does **not** delete anything —
opting back in restores your full history and position. Your own `/stats` card still shows you your own numbers, and
while you are opted out nobody else can pull it up.

Two things deliberately stay put. **Server-wide totals still include your past playtime**, because those are the
server's history rather than a roster of who is here — the same reasoning that keeps departed members in them. And your
**rank role is left alone**; opting out is meant to be quiet, not to visibly change your colour in the member list.

`/privacy forgetme` is the irreversible one, and there is no undo short of restoring a [backup](#backups). Two
consequences it warns you about before you confirm: co-op days are stored as *pairs*, so erasing yours also lowers the
co-op counts of everyone you played alongside, and events you created stay up (so nobody's plans are cancelled) but
stop naming you. Erasing does not change your tracking setting either way — if you opted out first, you stay opted out.

## Correcting bad stats

Sometimes what Discord reported is not what happened — a console that kept broadcasting a game into rest mode, a
mis-reported presence, a session the bot recovered wrongly after a crash. `/adjust` is the fix path; before it existed
the only option was editing the SQLite file by hand. It is restricted to administrators, and re-checks that itself in
case the default was overridden under **Server Settings → Integrations**.

- **`/adjust time`** — add or remove minutes on one game for one member. A negative number removes.
- **`/adjust session`** — void one bogus session outright, taking back the time and the session tally it credited.
- **`/adjust merge`** — fold two spellings of one game into a single name, for everybody at once.
- **`/adjust sessions`** — list what has actually been recorded, for one member or the whole server.
- **`/adjust duplicates`** — list game names that look like the same game recorded twice.
- **`/adjust log`** — the audit trail, for one member or the whole server.

`/adjust sessions` is the read-only half and the usual first step: it lists the most recent completed sessions with
the id `/adjust session` takes, and leads with anything running right now — including whether a running session is
paused because Discord reported the member idle, which is the ordinary reason a total stops moving. A session has no
id until it closes, so a running one cannot be voided yet.

The game, the session and both sides of a merge are picked from a list rather than typed. Game names arrive as free
text from Discord presence, exact punctuation and all, so a typed name that is slightly wrong would not error — it
would create a *new* game on the member's record and leave the wrong one untouched.

Corrections cannot drive a total below zero, and a subtraction is capped at what that game actually holds: asking to
remove two hours from a game with forty minutes on it removes forty, and the reply says so rather than quietly doing
less than you asked. The member total and the per-game total always move by the same amount, so the two can never
drift apart.

**A correction can lower a rank**, and the rank role is updated to match — a rank names where a member stands now.
The reply always states the totals before and after and any rank movement, so nothing about this is silent.
**Achievements are never re-locked**, though: taking time back can drop a member below a threshold they have already
cleared, and the unlock stays. That matches the rule the rest of the bot follows — raising a requirement never revokes
what someone already earned — and the alternative is a correction quietly deleting a badge somebody was shown winning.

Every applied correction is recorded permanently with who did it, to whom, how much and why. Those rows are never
deleted or edited; an audit log that can be tidied up is not an audit log. `npm run db-check` reports the net total of
corrections per server, since a total set by hand is otherwise indistinguishable from one that was earned.

Take a `/backup` first if the correction is a large one. Inverting a mistake is one more `/adjust time` with the
opposite sign, but a backup is the only way back from several corrections in a row.

### Merging two spellings of one game

Games are recorded under whatever name Discord's Rich Presence reported. When a game is renamed upstream —
Counter-Strike: Global Offensive becoming Counter-Strike 2 is the obvious case — or presence reports a variant
spelling, one game's history silently splits in two. Over a long history that is not cosmetic: it can cost somebody a
milestone on a game they have genuinely put hundreds of hours into, and it inflates their distinct-game count.

`/adjust merge` folds one name into the other across the whole server — there is no member option, because a spelling
is wrong for everybody who has it or for nobody. Time, session counts, recorded history and any session running right
now all move to the surviving name. If the name you merge into does not exist yet, it is simply a rename.

**No time is created or destroyed**, so no member total, rank or leaderboard position changes. What does change is the
number of *distinct* games: anyone who had both names now has one fewer, so game counts can read lower afterwards.
Achievements already unlocked are kept, as with every other correction, and anything the merge newly earns arrives the
next time that member plays.

It cannot be undone — merging back would not restore the split — so take a `/backup` first if you are unsure.

### Finding a split in the first place

Somebody still has to *notice* the split, and nobody goes looking. `/adjust duplicates` sweeps every game name in the
server against every other and lists the pairs worth a look, with the time and the number of members behind each name
so it is obvious which spelling is the real one. It is read-only — it never merges anything, because a merge is a
guild-wide judgement with no undo.

Suggestions come in three kinds, labelled because they are not equally trustworthy. Names that are **the same once
case, punctuation, spacing and accents are ignored** are a certainty rather than a guess — including the ones that
differ only by a stray space, which is invisible everywhere else in Discord. Names **a character or two apart** are
usually a typo. Names where **one is the other plus words** catch a re-title like Realm Royale → Realm Royale
Reforged, and are the loosest of the three: Fallout and Fallout Shelter land there too.

**A difference in numbers is treated as a sequel, never a typo**, so Diablo II and Diablo III, Portal and Portal 2,
F1 23 and F1 24 are never suggested — arabic and roman numerals alike. And the case that motivated merging in the
first place, a rename sharing no words with the old title, cannot be found this way at all. That one needs a human.

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

`/event create` first asks which timezone the event is in — a dropdown of presets configured via `EVENT_TIMEZONE_PRESETS` in `.env`, which you should set to whichever zones your own members live in (e.g. `Europe/Madrid,America/Denver,Australia/Sydney`; defaults to UTC, New York, Berlin, and Tokyo if unset). Discord modals can't contain dropdowns, so the timezone picker is a separate step before the form opens; picking one then shows the form itself (title, date/time, game, description, and how often it repeats). Submitting it posts an embed announcing the event, with **I'm in** / **Maybe** / **Can't make it** buttons underneath. Clicking one updates the embed's Going/Maybe lists live. The time you type is converted once at that point — Discord then renders it to each viewer in their own local time and format automatically via native timestamp formatting, so nobody has to do the math themselves.

Below the RSVP buttons sits a single **⚙️ Manage** button. It works for whoever created the event, or anyone with Manage Server; anyone else clicking gets a private reply saying so. It opens a panel only that person can see, holding **✏️ Edit**, **🔁 Resend** and **🗑️ Delete** — so the announcement everyone reads stays down to the three buttons everyone can actually use.

Edit asks for the timezone again (in case you want to describe the new time in a different one), then opens the form pre-filled with the current details; changing the time resets which reminder stages have already fired (so they fire again relative to the new time), but editing just the title/description/game doesn't. Resend posts the announcement again at the bottom of the channel and removes the old copy, for an event that's been buried under later chatter — the event itself is unchanged and every RSVP is kept. If members were invited by ping when the event was created, the new post carries that ping line, so whoever still hasn't answered is notified again; anyone who has already answered was dropped from that line the moment they did, and is not pinged twice. Delete removes the event and turns the embed into a crossed-out "cancelled" notice — and if the event was managed from somewhere other than its original announcement (see `/event list` below), the original announcement gets updated or cancelled too, so it never goes stale.

Events announced before the Manage button existed keep the older row of Edit/Resend/Delete buttons, and those go on working exactly as they did. Resending one replaces it with a post carrying the new layout.

`/event list` shows upcoming events with a jump link to each announcement, plus a dropdown to select one and manage it directly — this works even for events whose original message can't be found or was created before this dropdown existed, since it doesn't depend on locating that message at all.

`EVENT_REMINDER_STAGES_MINUTES` (default `720,60,0` — 12 hours before, 1 hour before, and at start) controls how many reminder stages fire and when; each pings everyone who's "Going" in the event's channel. The wording always reflects the actual time left when it sends (`"Title" event starts in 1 hour`), not the stage's nominal name, so a delayed reminder never says something already false — and the `0` ("at start") stage says `"Title" is starting now!` instead. One-off events are cleaned up automatically 24 hours after they start, so the table doesn't grow forever — no need to delete them manually unless you want to cancel one early. Recurring events are never cleaned up on that rule; they roll on to their next occurrence instead, and end when somebody deletes them.

### Recurring events

The form's last field is **Repeat**, and leaving it blank — which is what happens if you ignore it — makes a one-off, exactly as before. Fill it in with `daily`, `weekly` or `fortnightly` (`every week`, `biweekly` and `every other week` are understood too) and the event becomes a standing fixture: a few hours after each occurrence starts, it moves itself on to the next one and posts a fresh announcement at the bottom of the channel, with the RSVPs cleared and the reminder stages armed again. Nobody is pinged by that post — a series coming round again is something that happened rather than something anyone did — but the reminder stages still ping whoever signs up for the new occurrence. Editing an event and clearing the field ends the series, leaving whatever occurrence is currently scheduled as a one-off; filling it in on an existing event starts one.

The recurring event is never re-created — the same event moves forward, which is what makes it impossible to end up with two of them, and equally impossible to lose one. It also means it is never cleaned up on the 24-hour rule above: cancel a series with **🗑️ Delete**, which cancels it from that occurrence onward.

A repeat is a wall-clock rule, not a fixed number of hours: an event is stored with the timezone it was written in, so "every Friday at 20:00" is still 20:00 after the clocks change rather than drifting to 19:00 for good. Editing an event re-anchors the series to whichever timezone you picked for the edit. If the bot is offline when an occurrence passes — for an evening or for three weeks — it picks up at the *next* occurrence when it comes back and announces that one only; there is no backlog to catch up on and nothing is posted twice.

There is no monthly rule, deliberately. Monthly needs to remember which day of the month the series is anchored to, and clamping the 31st into February would quietly walk the whole series backwards through the calendar.
