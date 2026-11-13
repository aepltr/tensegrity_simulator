
// fdm.ts — Force density method (FDM) with grab interaction.
//
// Notation follows the lecture:
//   q_k   signed force density, q > 0 string (tension), q < 0 bar (compression)
//   K     force-density matrix, K = C^T diag(q) C  (= Cs^T γ Cs − Cb^T λ Cb)
//   N K = W   nodal equilibrium
//
// Grab = boundary condition. Split nodes into fixed (p) and free (f):
//   K_ff x_f = w_f − K_fp x_p      (once per axis x, y, z)
// The fixed set is {anchors} ∪ {grabbed node}. K_ff depends only on the
// partition and q, so we factor it ONCE at grab start, and every frame
// is just a back-substitution with a new right-hand side.
 
export type Vec3 = [number, number, number];
 
export interface FDMember {
  a: number;              // tail node index
  b: number;              // head node index
  type: "bar" | "string";
  q: number;              // signed force density (N/m)
}
 
// ---------- 1. Force-density matrix K ----------
export function buildK(j: number, members: FDMember[]): number[][] {
  const K: number[][] = Array.from({ length: j }, () => new Array(j).fill(0));
  for (const m of members) {
    K[m.a][m.a] += m.q;
    K[m.b][m.b] += m.q;
    K[m.a][m.b] -= m.q;
    K[m.b][m.a] -= m.q;
  }
  return K;
}
 
// ---------- 2. LU factorization with partial pivoting ----------
// K_ff is symmetric but NOT positive definite (bars have q < 0),
// so Cholesky is not safe. LU with pivoting is.
interface LU { lu: number[][]; piv: number[]; }
 
function luFactor(A: number[][], relTol = 1e-10): LU {
  const n = A.length;
  const lu = A.map(row => row.slice());
  const piv = Array.from({ length: n }, (_, i) => i);
  let scale = 0;
  for (const row of A) for (const v of row) scale = Math.max(scale, Math.abs(v));
 
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(lu[i][k]) > Math.abs(lu[p][k])) p = i;
    }
    if (Math.abs(lu[p][k]) < relTol * scale) {
      throw new Error(
        "FDM: K_ff is singular. Fix at least 4 non-coplanar nodes " +
        "(e.g. the 3 base nodes + the grabbed node)."
      );
    }
    [lu[k], lu[p]] = [lu[p], lu[k]];
    [piv[k], piv[p]] = [piv[p], piv[k]];
    for (let i = k + 1; i < n; i++) {
      lu[i][k] /= lu[k][k];
      const f = lu[i][k];
      for (let c = k + 1; c < n; c++) lu[i][c] -= f * lu[k][c];
    }
  }
  return { lu, piv };
}
 
function luSolve({ lu, piv }: LU, b: number[]): number[] {
  const n = lu.length;
  const x = piv.map(i => b[i]);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < i; c++) x[i] -= lu[i][c] * x[c];
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let c = i + 1; c < n; c++) x[i] -= lu[i][c] * x[c];
    x[i] /= lu[i][i];
  }
  return x;
}
 
// ---------- 3. Grab controller ----------
export class FDMGrab {
  nodes: Vec3[];                      // current positions (updated in place)
  members: FDMember[];               // read by memberForces / residual
  private anchors: number[];          // permanently fixed nodes (e.g. ground)
  private loads: Vec3[];
  private K: number[][];
  private free: number[] = [];
  private fixed: number[] = [];
  private Kfp: number[][] = [];
  private lu: LU | null = null;
  private grabbed = -1;
 
  constructor(nodes: Vec3[], members: FDMember[], anchors: number[], loads?: Vec3[]) {
    this.nodes = nodes;
    this.members = members;
    this.anchors = anchors;
    this.loads = loads ?? nodes.map(() => [0, 0, 0] as Vec3);
    this.K = buildK(nodes.length, members);
  }
 
  get isGrabbing(): boolean { return this.grabbed >= 0; }
 
  /** Call on pointer/controller down. Throws if the partition is singular. */
  startGrab(g: number): void {
    const fixedSet = new Set<number>([...this.anchors, g]);
    this.fixed = [...fixedSet];
    this.free = this.nodes.map((_, i) => i).filter(i => !fixedSet.has(i));
 
    const Kff = this.free.map(r => this.free.map(c => this.K[r][c]));
    this.Kfp = this.free.map(r => this.fixed.map(c => this.K[r][c]));
    this.lu = luFactor(Kff);          // the expensive part, done once
    this.grabbed = g;
  }
 
  /** Call every frame while grabbing. target = pointer/hand position. */
  drag(target: Vec3): Vec3[] {
    if (!this.lu) return this.nodes;
    this.nodes[this.grabbed] = [...target] as Vec3;
 
    for (let axis = 0; axis < 3; axis++) {
      // rhs = w_f − K_fp x_p
      const rhs = this.free.map((i, r) => {
        let s = this.loads[i][axis];
        for (let c = 0; c < this.fixed.length; c++) {
          s -= this.Kfp[r][c] * this.nodes[this.fixed[c]][axis];
        }
        return s;
      });
      const xf = luSolve(this.lu, rhs);
      this.free.forEach((i, r) => { this.nodes[i][axis] = xf[r]; });
    }
    return this.nodes;
  }
 
  /** Call on pointer/controller up. */
  endGrab(): void {
    this.lu = null;
    this.grabbed = -1;
  }
 
  /** Call if q changes (new self-stress, prestress slider, substitution). */
  setForceDensities(members: FDMember[]): void {
    this.members = members;
    this.K = buildK(this.nodes.length, members);
    if (this.grabbed >= 0) this.startGrab(this.grabbed);
  }
}
 
// ---------- 4. Checks (use these in the paper) ----------
 
/** Max norm of internal + external force at the given nodes. Should be ~0 at free nodes. */
export function residual(nodes: Vec3[], members: FDMember[], loads: Vec3[], at: number[]): number {
  const F: Vec3[] = nodes.map((_, i) => [...loads[i]] as Vec3);
  for (const m of members) {
    for (let d = 0; d < 3; d++) {
      const f = m.q * (nodes[m.b][d] - nodes[m.a][d]); // force on a, toward b if q > 0
      F[m.a][d] += f;
      F[m.b][d] -= f;
    }
  }
  return Math.max(0, ...at.map(i => Math.hypot(...F[i])));
}
 
export function memberLength(nodes: Vec3[], m: FDMember): number {
  const [p, r] = [nodes[m.a], nodes[m.b]];
  return Math.hypot(r[0] - p[0], r[1] - p[1], r[2] - p[2]);
}
 
/** Largest relative bar-length change vs a reference shape. FDM keeps q, not lengths. */
export function barLengthDrift(ref: Vec3[], now: Vec3[], members: FDMember[]): number {
  let worst = 0;
  for (const m of members) {
    if (m.type !== "bar") continue;
    const l0 = memberLength(ref, m);
    worst = Math.max(worst, Math.abs(memberLength(now, m) - l0) / l0);
  }
  return worst;
}
 
/** Member forces t_k = q_k * l_k (signed, + tension). Feed these to per-member sizing. */
export function memberForces(nodes: Vec3[], members: FDMember[]): number[] {
  return members.map(m => m.q * memberLength(nodes, m));
}
 
// ---------- 5. Self-test on the 3-bar prism ----------
// Y is up (Babylon convention). Twist φ = 150°.
// Self-stress ratio from the lecture: q_ring : q_vertical : q_bar = 1 : √3 : −√3
export function prism(r = 1, h = 1, phiDeg = 150, qRing = 1): { nodes: Vec3[]; members: FDMember[] } {
  const phi = (phiDeg * Math.PI) / 180;
  const nodes: Vec3[] = [];
  for (let i = 0; i < 3; i++) {
    const t = (2 * Math.PI * i) / 3;
    nodes.push([r * Math.cos(t), 0, r * Math.sin(t)]);
  }
  for (let i = 0; i < 3; i++) {
    const t = (2 * Math.PI * i) / 3 + phi;
    nodes.push([r * Math.cos(t), h, r * Math.sin(t)]);
  }
  const s3 = Math.sqrt(3);
  const members: FDMember[] = [];
  for (let i = 0; i < 3; i++) members.push({ a: i, b: 3 + i, type: "bar", q: -s3 * qRing });
  for (let i = 0; i < 3; i++) members.push({ a: i, b: (i + 1) % 3, type: "string", q: qRing });
  for (let i = 0; i < 3; i++) members.push({ a: 3 + i, b: 3 + ((i + 1) % 3), type: "string", q: qRing });
  for (let i = 0; i < 3; i++) members.push({ a: i, b: 3 + ((i + 2) % 3), type: "string", q: s3 * qRing });
  return { nodes, members };
}
 
export function selfTest(): void {
  const { nodes, members } = prism();
  const zero = nodes.map(() => [0, 0, 0] as Vec3);
  const all = nodes.map((_, i) => i);
  const ref = nodes.map(n => [...n] as Vec3);
 
  console.log("1. Prism residual at 150° (should be ~0):",
    residual(nodes, members, zero, all).toExponential(2));
 
  const bad = prism(1, 1, 140);
  console.log("2. Prism residual at 140° (should NOT be ~0):",
    residual(bad.nodes, bad.members, zero, [0, 1, 2, 3, 4, 5]).toFixed(3));
 
  const fdm = new FDMGrab(nodes.map(n => [...n] as Vec3), members, [0, 1, 2]);
  try {
    // Anchors only = 3 coplanar nodes, not enough
    fdm.startGrab(0); // grabbing an anchor adds no new fixed node
    console.log("3. Anchors only: unexpectedly solvable");
  } catch (e) {
    console.log("3. Anchors only: singular, as expected");
  }
  fdm.endGrab();
 
  fdm.startGrab(3);
  fdm.drag(ref[3]);
  const err = Math.max(...fdm.nodes.map((n, i) => Math.hypot(n[0] - ref[i][0], n[1] - ref[i][1], n[2] - ref[i][2])));
  console.log("4. Grab top node, no move -> shape unchanged (should be ~0):", err.toExponential(2));
 
  fdm.drag([ref[3][0], ref[3][1] + 0.2, ref[3][2]]);
  console.log("5. Lift grabbed node 0.2 -> residual at free nodes (should be ~0):",
    residual(fdm.nodes, members, zero, [4, 5]).toExponential(2));
  console.log("   Bar length drift:", (100 * barLengthDrift(ref, fdm.nodes, members)).toFixed(1), "%");
  fdm.endGrab();
}
 
// ---------- 6. Self-stress from geometry: A q = 0 ----------
// Builds the equilibrium matrix A (3j × b) and finds q as the eigenvector of
// AᵀA with the smallest eigenvalue (same as the last right singular vector of A).
// Sign is chosen so bars are in compression (q < 0).
 
export interface MemberPair { a: number; b: number; type: "bar" | "string"; }
 
export interface SelfStressResult {
  q: number[];          // one q per member, same order as the input
  feasible: boolean;    // bars all q < 0 and strings all q > 0
  exists: boolean;      // smallest eigenvalue ≈ 0, i.e. A really has a null space
  ratio: number;        // λ_min / λ_max of AᵀA (≈ 0 means a self-stress exists)
}
 
/** Jacobi eigenvalue method for a small symmetric matrix. Returns eigenvalues and eigenvectors (columns). */
function jacobiEigen(S: number[][], sweeps = 100): { values: number[]; vectors: number[][] } {
  const n = S.length;
  const a = S.map(r => r.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, c) => (i === c ? 1 : 0)));
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let r = p + 1; r < n; r++) off += a[p][r] * a[p][r];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let r = p + 1; r < n; r++) {
        if (Math.abs(a[p][r]) < 1e-300) continue;
        const theta = (a[r][r] - a[p][p]) / (2 * a[p][r]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akr = a[k][r];
          a[k][p] = c * akp - s * akr;
          a[k][r] = s * akp + c * akr;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], ark = a[r][k];
          a[p][k] = c * apk - s * ark;
          a[r][k] = s * apk + c * ark;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkr = v[k][r];
          v[k][p] = c * vkp - s * vkr;
          v[k][r] = s * vkp + c * vkr;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}
 
export function selfStress(nodes: Vec3[], members: MemberPair[]): SelfStressResult {
  const b = members.length;
  const j = nodes.length;
  // Column k of A: (n_b − n_a) in the rows of node a, −(n_b − n_a) in the rows of node b
  const A: number[][] = Array.from({ length: 3 * j }, () => new Array(b).fill(0));
  members.forEach((m, k) => {
    for (let d = 0; d < 3; d++) {
      const diff = nodes[m.b][d] - nodes[m.a][d];
      A[3 * m.a + d][k] = diff;
      A[3 * m.b + d][k] = -diff;
    }
  });
  // AᵀA (b × b)
  const AtA: number[][] = Array.from({ length: b }, () => new Array(b).fill(0));
  for (let r = 0; r < 3 * j; r++) {
    for (let p = 0; p < b; p++) {
      if (A[r][p] === 0) continue;
      for (let c = 0; c < b; c++) AtA[p][c] += A[r][p] * A[r][c];
    }
  }
  const { values, vectors } = jacobiEigen(AtA);
  let iMin = 0, vMax = 0;
  values.forEach((val, i) => {
    if (val < values[iMin]) iMin = i;
    vMax = Math.max(vMax, Math.abs(val));
  });
  let q = vectors.map(row => row[iMin]);
  // Sign: bars in compression
  const barSum = members.reduce((s, m, k) => s + (m.type === "bar" ? q[k] : 0), 0);
  if (barSum > 0) q = q.map(x => -x);
 
  const ratio = vMax > 0 ? values[iMin] / vMax : 1;
  const tol = 1e-9 * Math.max(...q.map(Math.abs));
  const feasible = members.every((m, k) => (m.type === "bar" ? q[k] < -tol : q[k] > tol));
  return { q, feasible, exists: ratio < 1e-10, ratio };
}
 





