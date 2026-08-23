// The battle board. Plain Canvas 2D: `apps/web/CLAUDE.md` caps the POC at
// 30x30 tiles and forbids WebGL/Pixi without a perf-based ADR.
//
// It renders terrain, tokens and highlights drawn ONLY from `reachableTiles`
// and the catalogue. It computes no distances and knows no rules — a tile is
// reachable because the server said so, having run the real validator.
//
// Alongside the canvas it renders a visually-hidden button per reachable tile
// and per combatant. That is the keyboard and screen-reader path, and it is
// also what the tests drive, since jsdom has no 2D context to inspect.
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { CampaignState, Tile, TerrainType, TurnAffordances } from "@ai-dm/schemas";
import type { CatalogueCombatant } from "../net/api.js";

export const TILE_PX = 32;

export interface GridProps {
  snapshot: CampaignState;
  affordances: TurnAffordances | null;
  catalogue: CatalogueCombatant[];
  selectedTile: Tile | null;
  onTileClick: (tile: Tile) => void;
  onCombatantClick: (combatantId: string) => void;
}

/**
 * Keyed by every `TerrainType` member via a mapped type, not an index
 * signature: if a sixth terrain is ever added to the schema, this object
 * literal fails to typecheck instead of silently falling through to a
 * default fill. A tile's terrain read (`tiles[y]?.[x] ?? "normal"`, below)
 * already has its own fallback, so no `undefined` branch is needed here.
 */
const TERRAIN_FILL: Record<TerrainType, string> = {
  normal: "#f4efe6",
  difficult: "#d9cbb2",
  blocking: "#4a4038",
  half_cover: "#c9b79a",
  three_quarters_cover: "#a89474",
};

export function Grid(props: GridProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { snapshot, affordances, selectedTile } = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    // jsdom provides no 2D context; the accessible list below is the render
    // that matters under test, so bailing out here is correct, not a stub.
    const context = canvas?.getContext("2d") ?? null;
    if (canvas === null || context === null) return;

    context.clearRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < snapshot.grid.height; y += 1) {
      for (let x = 0; x < snapshot.grid.width; x += 1) {
        const terrain = snapshot.grid.tiles[y]?.[x] ?? "normal";
        context.fillStyle = TERRAIN_FILL[terrain];
        context.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
        context.strokeStyle = "#cbbfae";
        context.strokeRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
      }
    }

    for (const [x, y] of affordances?.reachableTiles ?? []) {
      context.fillStyle = "rgba(70, 140, 90, 0.35)";
      context.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
    }

    if (selectedTile !== null) {
      context.strokeStyle = "#2f6b45";
      context.lineWidth = 3;
      context.strokeRect(
        selectedTile[0] * TILE_PX + 1,
        selectedTile[1] * TILE_PX + 1,
        TILE_PX - 2,
        TILE_PX - 2,
      );
      context.lineWidth = 1;
    }

    for (const combatant of snapshot.combatants) {
      const [x, y] = combatant.position;
      context.fillStyle =
        combatant.status !== "alive"
          ? "#8a8a8a"
          : combatant.faction === "party"
            ? "#2f5fa8"
            : "#a83232";
      context.beginPath();
      context.arc(
        x * TILE_PX + TILE_PX / 2,
        y * TILE_PX + TILE_PX / 2,
        TILE_PX / 2 - 4,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
  }, [snapshot, affordances, selectedTile]);

  const nameOf = (combatantId: string): string =>
    props.catalogue.find((each) => each.combatantId === combatantId)?.nameHebrew ?? combatantId;

  return (
    <div className="grid">
      <canvas
        ref={canvasRef}
        width={snapshot.grid.width * TILE_PX}
        height={snapshot.grid.height * TILE_PX}
        onClick={(event) => {
          const canvas = event.currentTarget;
          const bounds = canvas.getBoundingClientRect();
          // The canvas's CSS size can differ from its `width`/`height`
          // attributes (e.g. once a stylesheet exists), so a click position
          // is scaled back into canvas pixels before dividing into tiles
          // rather than assuming 1:1 layout. Guarded against a zero/NaN
          // scale for a canvas that hasn't laid out yet.
          const scaleX = bounds.width > 0 ? bounds.width / canvas.width : 1;
          const scaleY = bounds.height > 0 ? bounds.height / canvas.height : 1;
          const x = Math.floor((event.clientX - bounds.left) / (TILE_PX * scaleX));
          const y = Math.floor((event.clientY - bounds.top) / (TILE_PX * scaleY));
          const reachable = affordances?.reachableTiles ?? [];
          // A click on a tile the server did not offer is dropped here rather
          // than sent and rejected: the affordance set is the authority the
          // client renders, so honouring it is not a rules decision.
          if (reachable.some(([tx, ty]) => tx === x && ty === y)) props.onTileClick([x, y]);
        }}
      />

      <ul className="visually-hidden-list">
        {(affordances?.reachableTiles ?? []).map(([x, y]) => (
          <li key={`${String(x)},${String(y)}`}>
            <button
              type="button"
              onClick={() => {
                props.onTileClick([x, y]);
              }}
            >
              {/* Coordinates are an LTR fragment inside an RTL document. */}
              <bdi>
                ({String(x)},{String(y)})
              </bdi>
            </button>
          </li>
        ))}
        {snapshot.combatants.map((combatant) => (
          <li key={combatant.combatantId}>
            <button
              type="button"
              onClick={() => {
                props.onCombatantClick(combatant.combatantId);
              }}
            >
              <bdi>{nameOf(combatant.combatantId)}</bdi>{" "}
              <bdi>
                {String(combatant.currentHp)}/{String(combatant.maxHp)}
              </bdi>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
