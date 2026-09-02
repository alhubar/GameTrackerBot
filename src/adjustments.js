/**
 * Manual stat corrections, and the audit trail behind them.
 *
 * Every other write in this bot is earned: presence comes in, time goes up. These two are the
 * escape hatch for when what Discord reported was not what happened — a console that kept
 * broadcasting into rest mode, a mis-reported presence, a session the bot recovered wrongly. Before
 * this existed the only fix was editing the SQLite file by hand.
 *
 * Two rules hold for both operations:
 *
 * - **Nothing is silent.** Each applied correction writes a `stat_adjustments` row naming who did
 *   it, to whom, how much and why. That row is the only evidence a total was changed by hand rather
 *   than earned, so it is written in the same breath as the change and never removed.
 * - **Achievements are never re-locked.** Taking time back can drop a member below a threshold they
 *   have already cleared, and the unlock stays. This matches the rule the rest of the project
 *   follows for retuning — raising a requirement never revokes what someone already has — and the
 *   alternative is a correction quietly deleting a badge somebody was shown earning. Rank roles do
 *   move, because a rank names where you stand now rather than what you once reached.
 *
 * A merge is the odd one out on the second rule only in that it has nothing to re-lock: it moves no
 * time, so no total and no rank can change. What it does change is how many *distinct* games a
 * member has, which several achievements count — see `mergeGames`.
 */

export const ADJUSTMENT_KINDS = { TIME: 'time', SESSION: 'session', MERGE: 'merge', CAP: 'cap' };

/** No member initiated a cap claw-back, so it is attributed to the same sentinel `purgeMember` uses
 * for a stat_adjustments row with no accountable actor. */
export const SYSTEM_ACTOR_ID = '0';

/**
 * Adds or removes time on one game for one member.
 *
 * Returns what was actually applied, which is not always what was asked for: a subtraction is
 * capped at the time the game holds. `appliedSeconds === 0` means the correction was a no-op — the
 * game had nothing left to take — and nothing is written, audit row included, because a log of
 * attempts that changed nothing makes the real corrections harder to find.
 */
export function applyTimeAdjustment(db, { guildId, userId, actorId, gameName, deltaSeconds, reason }, now = Date.now()) {
  const result = db.adjustPlaytime(guildId, userId, gameName, deltaSeconds);
  if (result.appliedSeconds !== 0) {
    db.recordAdjustment({
      guildId, userId, actorId, kind: ADJUSTMENT_KINDS.TIME, gameName,
      deltaSeconds: result.appliedSeconds, reason,
    }, now);
  }
  return result;
}

/**
 * Claws back the seconds a session banked past `MAX_SESSION_HOURS` before the checkpoint tick
 * caught it. `closeSessionsExceeding` already writes the play_sessions row at the cap; this is the
 * other half — the same excess still sitting in game_stats/member_stats from the continuous
 * checkpointing that ran while the session was still active. Uses the same clamped subtraction as
 * a manual `/adjust` correction, and leaves the same kind of stat_adjustments trail so the drop is
 * explicable rather than a silent total change.
 *
 * A no-op (`excessSeconds` of 0, the ordinary case — the tick usually catches the cap within a
 * minute) writes nothing, same reasoning as a manual adjustment that clamped to zero.
 */
export function clawBackSessionCap(db, { guildId, userId, gameName, excessSeconds, capSeconds }, now = Date.now()) {
  if (!excessSeconds) return null;
  const result = db.adjustPlaytime(guildId, userId, gameName, -excessSeconds);
  if (result.appliedSeconds !== 0) {
    db.recordAdjustment({
      guildId, userId, actorId: SYSTEM_ACTOR_ID, kind: ADJUSTMENT_KINDS.CAP, gameName,
      deltaSeconds: result.appliedSeconds,
      reason: `Session ran past the ${Math.floor(capSeconds / 3600)}h cap; the checkpoint tick was `
        + `late, so ${Math.floor(excessSeconds / 60)}m banked before it caught up was clawed back.`,
    }, now);
  }
  return result;
}

/**
 * Voids one completed session, removing the history row and the time and session tally it
 * contributed. Returns null when the id does not exist or belongs to another guild — the caller
 * reports that rather than treating it as a failure.
 */
export function voidSession(db, { guildId, sessionId, actorId, reason }, now = Date.now()) {
  const result = db.deletePlaySession(guildId, sessionId);
  if (!result) return null;
  // Recorded even when the clamp made this worth zero seconds: unlike a no-op time adjustment, a
  // session row genuinely disappeared here, and that is a change somebody may need to explain.
  db.recordAdjustment({
    guildId, userId: result.session.user_id, actorId, kind: ADJUSTMENT_KINDS.SESSION,
    gameName: result.session.game_name, deltaSeconds: result.appliedSeconds,
    sessionId, reason,
  }, now);
  return result;
}

/**
 * Folds one game name into another for the whole guild, and logs it against every member it moved.
 *
 * Returns null when nothing is recorded under `fromName` or the two names are the same — the caller
 * reports that rather than writing an audit row for a merge that did not happen.
 *
 * **One row per affected member**, because that is how the log is read: `/adjust log member:@them`
 * has to be able to answer why their per-game history looks different from what they remember.
 * `deltaSeconds` is **0** on every one of them, and must stay 0 — the column's contract is what was
 * applied to a member's total, so that replaying it reproduces the totals, and a merge applies
 * nothing. The seconds that moved between names are recoverable from the game rows themselves.
 *
 * **Nothing is re-evaluated here.** A merge can newly satisfy a per-game milestone (the whole point
 * of the issue behind it) and can lower a distinct-game count that is already banked. Both follow
 * the same rule the other corrections do: what is unlocked stays unlocked, and anything newly
 * earned lands the next time that member plays, when the evaluators run against the merged rows.
 */
export function mergeGames(db, { guildId, fromName, intoName, actorId, reason }, now = Date.now()) {
  const result = db.mergeGameNames(guildId, fromName, intoName);
  if (!result) return null;
  for (const member of result.members) {
    db.recordAdjustment({
      guildId, userId: member.userId, actorId, kind: ADJUSTMENT_KINDS.MERGE,
      gameName: fromName, mergedInto: intoName, deltaSeconds: 0, reason,
    }, now);
  }
  return result;
}
