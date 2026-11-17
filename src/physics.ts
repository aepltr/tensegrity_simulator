// ============================================================
// physics.ts — prestressed tensegrity dynamics (XPBD, "small steps")
// ============================================================
// Every member is an elastic bar with a real axial stiffness EA (N):
//     force  t = EA · (L − L0) / L0        (+ tension, − compression)
// Strings cannot push: when L < L0 they go slack and carry nothing.
//
// PRESTRESS: a self-stress state q (A·q = 0) gives design forces t = q·L that
// are in equilibrium on their own. Each member's rest length L0 is chosen so
// that, at the design geometry, it carries exactly that force:
//     L0 = L_design / (1 + t / EA)
// → strings are made slightly SHORT, struts slightly LONG. Assembled, they
//   fight each other, and that internal fight is what makes a tensegrity stiff.
//
// Solver: linearly implicit (backward) Euler, Baraff & Witkin 1998.
// Each step solves ONE linear system with the full tangent stiffness
//     K = Σ (EA/L0)·n nᵀ  +  (t/L)·(I − n nᵀ)        ← material + geometric (prestress) stiffness
//     [M + (h·β + h²)·K] Δv = h·(f − (β + h)·K·v)        β = structural damping
// so bars stay bars (no "stretchy" iterative error), the prestress is held
// exactly at rest (f = 0 at the design shape), and it is stable at any stiffness.
//
// Pure TypeScript, no Babylon: Babylon's Vector3 fits the V3 shape, so main.ts
// passes its own points directly, and tests can run without a browser.

import { jacobiEigen, luFactor, luSolve } from "./fdm";

export interface V3 { x: number; y: number; z: number }
export interface PNode { position: V3; prevPosition: V3 }

export interface PMember {
  a: number;
  b: number;
  rigid: boolean;        // true = strut (push + pull), false = string (pull only)
  EA: number;            // axial stiffness, N
  restLength: number;    // L0, m
}

/** A hand (or mouse) holding node `node`: spring k (N/m) toward `target`, damper c (N·s/m). */
export interface Hold { node: number; target: V3; k: number; c: number }

export interface StepOptions {
  g: number;             // m/s², downward
  nodeMass: number;      // kg
  floorY: number;
  friction: number;      // Coulomb coefficient μ (0 = ice)
  damping: number;       // s, structural (stiffness-proportional) damping β: damps vibrations,
                         // NOT free motion — on the Moon a falling or tipping structure feels no drag
  substeps: number;
  isFixed: (i: number) => boolean;   // anchors
  holds: Hold[];
}

const GROUND_K = 1e5;     // N/m   ground contact stiffness (0.5 N of weight → 5 µm sink)
const GROUND_C = 50;      // N·s/m ground contact damping (landings don't bounce forever)

const len = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

export const memberLength = (nodes: PNode[], m: { a: number; b: number }) => {
  const pa = nodes[m.a].position, pb = nodes[m.b].position;
  return len(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
};

/** Axial force in N: + tension, − compression. Slack strings return 0. */
export const memberForce = (nodes: PNode[], m: PMember) => {
  const t = (m.EA * (memberLength(nodes, m) - m.restLength)) / m.restLength;
  return m.rigid ? t : Math.max(0, t);
};

/** Rest length that gives force `t` at length `L` (see header). */
export const restLengthFor = (L: number, t: number, EA: number) => L / (1 + t / EA);

/** Pull of a hold spring on its node, N. */
export const holdForce = (nodes: PNode[], h: Hold) => {
  const p = nodes[h.node].position;
  return h.k * len(h.target.x - p.x, h.target.y - p.y, h.target.z - p.z);
};

// ------------------------------------------------------------
// Design prestress: the self-stress state closest to "bars push, strings pull"
// ------------------------------------------------------------
export interface PrestressResult {
  ok: boolean;
  forces: number[];      // design force per member, N (+ tension, − compression)
  states: number;        // number of independent self-stress states
  message: string;
}

export function designPrestress(
  nodes: V3[],
  members: { a: number; b: number; rigid: boolean }[],
  meanStringTension: number,
): PrestressResult {
  const b = members.length;
  const fail = (message: string, states = 0): PrestressResult =>
    ({ ok: false, forces: new Array(b).fill(0), states, message });

  // Equilibrium matrix A (3n × b): column k = member k's direction at both ends
  const A: number[][] = Array.from({ length: 3 * nodes.length }, () => new Array(b).fill(0));
  members.forEach((m, k) => {
    const d = [nodes[m.b].x - nodes[m.a].x, nodes[m.b].y - nodes[m.a].y, nodes[m.b].z - nodes[m.a].z];
    for (let i = 0; i < 3; i++) {
      A[3 * m.a + i][k] = d[i];
      A[3 * m.b + i][k] = -d[i];
    }
  });

  // Null space of A = eigenvectors of AᵀA with ~zero eigenvalue
  const AtA: number[][] = Array.from({ length: b }, () => new Array(b).fill(0));
  for (const row of A)
    for (let p = 0; p < b; p++) {
      if (row[p] === 0) continue;
      for (let c = 0; c < b; c++) AtA[p][c] += row[p] * row[c];
    }
  const { values, vectors } = jacobiEigen(AtA);
  const vMax = Math.max(...values.map(Math.abs));
  const nullIdx = values.map((v, i) => [v, i]).filter(([v]) => Math.abs(v) < 1e-9 * vMax).map(([, i]) => i);
  if (nullIdx.length === 0) return fail("no self-stress: the geometry is not an equilibrium shape");

  // Project the sign pattern s (bars −1, strings +1) onto the null space:
  // the self-stress closest to "every bar pushes, every string pulls".
  const s = members.map((m) => (m.rigid ? -1 : 1));
  const q = new Array(b).fill(0);
  for (const j of nullIdx) {
    const v = vectors.map((row) => row[j]);
    const dot = v.reduce((acc, vk, k) => acc + vk * s[k], 0);
    for (let k = 0; k < b; k++) q[k] += dot * v[k];
  }
  const qMax = Math.max(...q.map(Math.abs));
  if (qMax < 1e-12) return fail("self-stress exists but cannot have bars in compression", nullIdx.length);
  const bad = q.filter((qk, k) => qk * s[k] <= 1e-6 * qMax).length;
  if (bad > 0) return fail(`${bad} member(s) would carry the wrong sign of force`, nullIdx.length);

  // Forces t = q·L, scaled so the mean string tension = meanStringTension
  const L = members.map((m) => len(nodes[m.b].x - nodes[m.a].x, nodes[m.b].y - nodes[m.a].y, nodes[m.b].z - nodes[m.a].z));
  const t = q.map((qk, k) => qk * L[k]);
  const strings = t.filter((_, k) => !members[k].rigid);
  const mean = strings.reduce((a, x) => a + x, 0) / strings.length;
  const scale = meanStringTension / mean;
  return {
    ok: true,
    forces: t.map((x) => x * scale),
    states: nullIdx.length,
    message: `prestressed (${nullIdx.length} self-stress state${nullIdx.length > 1 ? "s" : ""})`,
  };
}

// ------------------------------------------------------------
// One frame of dynamics
// ------------------------------------------------------------
export function step(nodes: PNode[], members: PMember[], dt: number, o: StepOptions) {
  const h = dt / o.substeps;
  const n = nodes.length;
  const m = o.nodeMass;

  // free nodes get equation rows; anchors are removed from the system
  const row = new Array<number>(n).fill(-1);
  let dof = 0;
  for (let i = 0; i < n; i++) if (!o.isFixed(i)) row[i] = 3 * dof++;
  const N = 3 * dof;
  if (N === 0) return;

  // velocities from the previous step
  const v = new Float64Array(3 * n);
  nodes.forEach((nd, i) => {
    v[3 * i] = (nd.position.x - nd.prevPosition.x) / h;
    v[3 * i + 1] = (nd.position.y - nd.prevPosition.y) / h;
    v[3 * i + 2] = (nd.position.z - nd.prevPosition.z) / h;
  });

  for (let s = 0; s < o.substeps; s++) {
    const f = new Float64Array(N);                       // forces on free DOFs
    const K: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
    const P = (i: number, d: number) => (d === 0 ? nodes[i].position.x : d === 1 ? nodes[i].position.y : nodes[i].position.z);

    const vf_y = (i: number) => v[3 * i + 1];

    // gravity
    for (let i = 0; i < n; i++) if (row[i] >= 0) f[row[i] + 1] -= m * o.g;

    // members
    for (const mb of members) {
      const d = [P(mb.b, 0) - P(mb.a, 0), P(mb.b, 1) - P(mb.a, 1), P(mb.b, 2) - P(mb.a, 2)];
      const L = len(d[0], d[1], d[2]);
      if (L < 1e-9) continue;
      const t = (mb.EA * (L - mb.restLength)) / mb.restLength;
      if (!mb.rigid && t <= 0) continue;                 // slack string: no force, no stiffness
      const u = d.map((x) => x / L);
      // force: tension pulls a toward b and b toward a
      for (let k = 0; k < 3; k++) {
        if (row[mb.a] >= 0) f[row[mb.a] + k] += t * u[k];
        if (row[mb.b] >= 0) f[row[mb.b] + k] -= t * u[k];
      }
      // tangent stiffness block Ke = (EA/L0) u uᵀ + (t/L)(I − u uᵀ)
      // exact tangent: compressed struts give NEGATIVE geometric stiffness. Keeping it exact
      // matters: a "cleaned-up" K would fake stiffness against rigid rotations and stop
      // a tipping structure from falling over.
      const km = mb.EA / mb.restLength, kg = t / L;
      for (let p = 0; p < 3; p++)
        for (let q = 0; q < 3; q++) {
          const ke = km * u[p] * u[q] + kg * ((p === q ? 1 : 0) - u[p] * u[q]);
          const ra = row[mb.a], rb = row[mb.b];
          if (ra >= 0) K[ra + p][ra + q] += ke;
          if (rb >= 0) K[rb + p][rb + q] += ke;
          if (ra >= 0 && rb >= 0) { K[ra + p][rb + q] -= ke; K[rb + p][ra + q] -= ke; }
        }
    }

    // hands: spring k toward the target
    for (const hd of o.holds) {
      const r = row[hd.node];
      if (r < 0) continue;
      f[r] += hd.k * (hd.target.x - P(hd.node, 0));
      f[r + 1] += hd.k * (hd.target.y - P(hd.node, 1));
      f[r + 2] += hd.k * (hd.target.z - P(hd.node, 2));
      for (let k = 0; k < 3; k++) K[r + k][r + k] += hd.k;
    }
    // hand damping (implicit): extra c·h on the diagonal, −c·v on the right-hand side
    const C = new Float64Array(N);
    for (const hd of o.holds) {
      const r = row[hd.node];
      if (r >= 0) for (let k = 0; k < 3; k++) C[r + k] += hd.c;
    }

    // ground: a stiff one-sided spring + damper under every node below the floor.
    // It is in the implicit system, so landings are smooth (no position "snapping").
    const normal = new Float64Array(n);                  // contact force per node, N
    for (let i = 0; i < n; i++) {
      const r = row[i];
      const pen = o.floorY - nodes[i].position.y;
      if (r < 0 || pen <= 0) continue;
      normal[i] = Math.max(0, GROUND_K * pen - GROUND_C * vf_y(i));
      f[r + 1] += GROUND_K * pen;
      K[r + 1][r + 1] += GROUND_K;
      C[r + 1] += GROUND_C;
      // friction, also inside the solve: a tangential damper that gives at most μ·N
      // (regularized Coulomb; below 1 cm/s the node essentially sticks)
      const vt = Math.hypot(v[3 * i], v[3 * i + 2]);
      const cf = (o.friction * normal[i]) / Math.max(vt, 0.01);
      C[r] += cf;
      C[r + 2] += cf;
    }

    // [M + (hβ + h²) K] Δv = h (f − (β + h) K v)
    const vf = new Float64Array(N);
    for (let i = 0; i < n; i++) if (row[i] >= 0) for (let k = 0; k < 3; k++) vf[row[i] + k] = v[3 * i + k];
    const A = K.map((r, i) => r.map((x, j) => (h * o.damping + h * h) * x + (i === j ? m + h * C[i] : 0)));
    const rhs = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      let Kv = 0;
      for (let j = 0; j < N; j++) Kv += K[i][j] * vf[j];
      rhs[i] = h * (f[i] - C[i] * vf[i] - (o.damping + h) * Kv);
    }
    let dv: number[];
    try { dv = luSolve(luFactor(A, 1e-14), rhs); }
    catch { return; }                                     // degenerate geometry: skip this frame

    // update velocity and position
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      nd.prevPosition.x = nd.position.x; nd.prevPosition.y = nd.position.y; nd.prevPosition.z = nd.position.z;
      if (row[i] < 0) { v[3 * i] = v[3 * i + 1] = v[3 * i + 2] = 0; continue; }
      for (let k = 0; k < 3; k++) v[3 * i + k] += dv[row[i] + k];
      nd.position.x += h * v[3 * i]; nd.position.y += h * v[3 * i + 1]; nd.position.z += h * v[3 * i + 2];
      // safety net for very fast impacts: never more than 1 cm into the ground
      if (nd.position.y < o.floorY - 0.01) { nd.position.y = o.floorY - 0.01; if (v[3 * i + 1] < 0) v[3 * i + 1] = 0; }
    }
  }
  // leave prevPosition so that (position − prevPosition)/h is the current velocity
  nodes.forEach((nd, i) => {
    nd.prevPosition.x = nd.position.x - h * v[3 * i];
    nd.prevPosition.y = nd.position.y - h * v[3 * i + 1];
    nd.prevPosition.z = nd.position.z - h * v[3 * i + 2];
  });
}
