
import * as BABYLON from "babylonjs";
// If you load Babylon from a <script> tag instead of npm, delete the import above —
// the global BABYLON namespace is already in scope.

export interface StructureDef {
  /** Stable key used for lookup and mesh-name prefixing. */
  id: string;
  /** Human-readable label for UI (dropdown, HUD). */
  name: string;
  /** Tunable geometry parameters. Mutate a copy of these to drive live sliders. */
  params: Record<string, number>;
  /** Returns node positions in index order. Index = node id used by the pair arrays. */
  generatePoints: (p: Record<string, number>) => BABYLON.Vector3[];
  /** Compression members (bars). */
  strutIndexPairs: [number, number][];
  /** Tension members (cables/strings). */
  cableIndexPairs: [number, number][];
  /** true = self-equilibrates standalone; false = needs pinned nodes or an external load. */
  selfStressed: boolean;
  /** Nodes where external axial load is applied (only meaningful when selfStressed = false). */
  loadNodes?: number[];
}

export const structureCatalogue: Record<string, StructureDef> = {
  /* ------------------------------------------------------------------ *
   * 3-STRUT PRISM  —  6 nodes, 3 struts, 9 cables
   * Classic twisted triangular prism. Self-stressed at the twist angle.
   * ------------------------------------------------------------------ */
  prism3: {
    id: "prism3",
    name: "3-Strut Prism",
    params: { radius: 2, height: 3, twist: Math.PI / 6, startY: 4 },
    generatePoints: ({ radius, height, twist, startY }) => {
      const bottomPos = [0, 1, 2].map((i) => {
        const angle = (i * 2 * Math.PI) / 3;
        return new BABYLON.Vector3(
          radius * Math.cos(angle),
          startY,
          radius * Math.sin(angle)
        );
      });
      const topPos = [0, 1, 2].map((i) => {
        const angle = (i * 2 * Math.PI) / 3 + twist;
        return new BABYLON.Vector3(
          radius * Math.cos(angle),
          startY + height,
          radius * Math.sin(angle)
        );
      });
      return [...bottomPos, ...topPos];
    },
    strutIndexPairs: [
      [0, 4],
      [1, 5],
      [2, 3],
    ],
    cableIndexPairs: [
      [3, 4],
      [4, 5],
      [5, 3], // top triangle
      [0, 1],
      [1, 2],
      [2, 0], // bottom triangle
      [0, 3],
      [1, 4],
      [2, 5], // verticals
    ],
    selfStressed: true,
  },

  /* ------------------------------------------------------------------ *
   * T-BAR  —  7 nodes, 6 struts, 12i addes  cables
   * Longitudinal bar split at its midpoint (node 1), with a transverse
   * cross at the kink. Cables run from each cross tip to both far ends,
   * bracing the midpoint against lateral movement — i.e. against buckling.
   *
   * NOTE: the transverse cross is modelled as FOUR separate struts all
   * pinned to node 1, not two continuous bars passing through it. A single
   * bar 3-4 would have no kinematic connection to the longitudinal member.
   * ------------------------------------------------------------------ */
  tbar: {
    id: "tbar",
    name: "T-Bar",
    params: { halfLength: 1.5, transverse: 1.0, startY: 4 },
    generatePoints: ({ halfLength: L, transverse: t, startY }) => [
      new BABYLON.Vector3(0, startY, 0), // 0  bottom end
      new BABYLON.Vector3(0, startY + L, 0), // 1  centre (kink node)
      new BABYLON.Vector3(0, startY + 2 * L, 0), // 2  top end
      new BABYLON.Vector3(t, startY + L, 0), // 3  cross +X
      new BABYLON.Vector3(-t, startY + L, 0), // 4  cross -X
      new BABYLON.Vector3(0, startY + L, t), // 5  cross +Z
      new BABYLON.Vector3(0, startY + L, -t), // 6  cross -Z
    ],
    strutIndexPairs: [
      [0, 1],
      [1, 2], // longitudinal, split at centre
      [1, 3],
      [1, 4],
      [1, 5],
      [1, 6], // transverse cross arms
    ],
    cableIndexPairs: [
      [0, 3],
      [3, 2],
      [0, 4],
      [4, 2],
      [0, 5],
      [5, 2],
      [0, 6],
      [6, 2],
      [3,6],
      [3,5],
      [6,4],
      [5,4]
    ],
    selfStressed: true,
  },

  /* ------------------------------------------------------------------ *
   * D-BAR  —  4 nodes, 4 struts, 2 cables
   * Rhombus of four bars with strings on BOTH diagonals. The long-diagonal
   * string (0-2) supplies the axial compression that would otherwise have
   * to come from an external load, so the unit is self-stressed standalone.
   *
   * Equilibrium result worth checking against your force readout:
   *   q_long = q_short = -q_bar   (equal force-density magnitude everywhere)
   * Member force = q x length, so the long string always carries more than
   * the short one. Holds at ANY aspect ratio — no tuning needed.
   *
   * CAUTION: with both diagonals present this is a complete graph on 4
   * nodes — a FLAT tetrahedron. Degenerate tetrahedra are first-order
   * flexible out of plane, so Verlet noise can make it wobble or pop.
   * If that happens, nudge one node slightly off-plane or damp
   * out-of-plane velocity.
   * ------------------------------------------------------------------ */
  dbar: {
    id: "dbar",
    name: "D-Bar",
    params: { halfHeight: 1.5, width: 1.0, startY: 4 },
    generatePoints: ({ halfHeight: h, width: w, startY }) => [
      new BABYLON.Vector3(0, startY, 0), // 0  bottom
      new BABYLON.Vector3(w, startY + h, 0), // 1  right
      new BABYLON.Vector3(0, startY + 2 * h, 0), // 2  top
      new BABYLON.Vector3(-w, startY + h, 0), // 3  left
    ],
    strutIndexPairs: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ],
    cableIndexPairs: [
      [1, 3], // short diagonal
      [0, 2], // long diagonal
    ],
    selfStressed: true,
  },
};

export function getStructure(id: string): StructureDef {
  const def = structureCatalogue[id];
  if (!def) {
    throw new Error(
      `Unknown structure: "${id}". Available: ${Object.keys(structureCatalogue).join(", ")}`
    );
  }
  return def;
}

/** Convenience for building a dropdown / selector UI. */
export function listStructures(): { id: string; name: string }[] {
  return Object.values(structureCatalogue).map(({ id, name }) => ({ id, name }));
}