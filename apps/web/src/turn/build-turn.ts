// Turns what the player clicked into the `ExecuteTurn` the server validates.
// It makes no legality decision: every option offered came from a
// `turn_affordances` frame, which the server derived by running the real
// validator. This file only assembles.
import type { ActionAffordance, ExecuteTurn, Tile } from "@ai-dm/schemas";

export interface Selection {
  actorId: string;
  destinationTile?: Tile;
  action: ActionAffordance;
  targetId?: string;
}

/**
 * `ExecuteTurn.tacticalRationaleEnglish` is required and English (invariant 2),
 * but the player is typing Hebrew or not typing at all. So the client
 * synthesises a factual description of the selection — never player-authored
 * text. It exists so a human turn and an agent turn leave the same shape in
 * the log.
 */
export function describeSelection(selection: Selection): string {
  const parts: string[] = [];
  if (selection.destinationTile !== undefined) {
    const [x, y] = selection.destinationTile;
    parts.push(`move to (${String(x)},${String(y)})`);
  }
  if (selection.action.actionId !== undefined && selection.targetId !== undefined) {
    parts.push(
      `${selection.action.actionType} ${selection.targetId} with ${selection.action.actionId}`,
    );
  } else if (selection.targetId !== undefined) {
    parts.push(`${selection.action.actionType} ${selection.targetId}`);
  } else {
    parts.push(selection.action.actionType);
  }
  return `Player selected: ${parts.join("; ")}.`;
}

export function buildTurn(selection: Selection): ExecuteTurn {
  // Optional keys are OMITTED rather than set to `undefined`:
  // `exactOptionalPropertyTypes` is on, so assigning `undefined` to an
  // optional property does not typecheck.
  const mainAction: ExecuteTurn["mainAction"] = {
    actionType: selection.action.actionType,
    ...(selection.action.actionId === undefined ? {} : { actionId: selection.action.actionId }),
    ...(selection.targetId === undefined ? {} : { targetIds: [selection.targetId] }),
  };

  return {
    actorId: selection.actorId,
    ...(selection.destinationTile === undefined
      ? {}
      : {
          movement: [{ destinationTile: selection.destinationTile, pathType: "direct" as const }],
        }),
    mainAction,
    tacticalRationaleEnglish: describeSelection(selection),
  };
}
