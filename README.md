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

## GitHub Release announcements

Set `GITHUB_REPOSITORY` to the GitHub repository in `owner/repository` form and set `CHANGES_CHANNEL` to the text channel name for release notes. A member with **Manage Server** permission can run `/changes` to fetch and publicly post the latest published GitHub Release title and notes. The bot never announces releases automatically, and it records the last announced release so it will not post duplicate notes. Use `/changes force:True` when an admin intentionally wants to announce the same release again. Create a GitHub Release when you are ready, then run `/changes` to share it. For private repositories, add a GitHub token with read access as `GITHUB_TOKEN` in the uncommitted `.env` file.
