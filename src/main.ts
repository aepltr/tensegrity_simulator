
import * as BABYLON from "babylonjs";
import "babylonjs-loaders";
import "./style.css";
import { MATERIALS, CrossSectionArea, barMass, bucklingForce, SECTION_FIELDS, type Materials, type CrossSection, getMaterialById, sizeCable } from "./materials";
import { getStructure, listStructures, type StructureDef } from "./strcture";
import { createMoonEnvironment, type MoonEnvironment } from "./moonEnvironment";
import { createSubstitutionPanel } from "./substitutionPanel";
import { substituteAll, type Topology } from "./substitution";
import { FDMGrab, type FDMember, type MemberPair, type Vec3 } from "./fdm"; // NEW (FDM)
import { step as physicsStep, designPrestress, restLengthFor, memberForce, type PMember, type Hold } from "./physics";
import { createVRPanel, type VRPanelAPI } from "./vrPanel"; 

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = new BABYLON.Engine(canvas, true);
 
 
// ============================================================
// MODEL ASSUMPTIONS (display-force estimate; see report)
// ============================================================
type Planet = "moon" | "mars";
const PLANET: Planet =
  new URLSearchParams(window.location.search).get("planet") === "mars" ? "mars" : "moon";
const G = PLANET === "mars" ? 3.71 : 1.62;   // m/s²                
const MASS_PER_NODE = 0.05;      // kg
const PRESTRESS_CABLE = 50;     // N  design prestress: mean cable tension at rest
const HAND_STIFFNESS = 2000;    // N/m  grip: spring between your hand (or mouse) and the grabbed node
const HAND_DAMPING = 20;        // N·s/m  grip damping, so a carried structure doesn't bounce on the spring
 
const DEFAULT_STRUCTURE = "prism3";
let currentStructureId = DEFAULT_STRUCTURE;

// ---------- Physics state ----------
interface PhysicsPoint {
  position: BABYLON.Vector3;
  prevPosition: BABYLON.Vector3;
}
// a, b, rigid, EA (N) and restLength L0 (m) come from PMember (physics.ts)
interface Constraint extends PMember {
  designLength: number;   // length at the design (equilibrium) shape, m
  designForce: number;    // prestress force at the design shape, N (+ tension, − compression)
  force: number;          // current force, N, updated each frame
}
 
let points: PhysicsPoint[] = [];
let constraints: Constraint[] = [];
let strutMeshes: BABYLON.Mesh[] = [];
let strutRestLengths: number[] = [];   // cylinder heights at build time, for scaling
let strutIndexPairs: [number, number][] = [];
let cableLines: BABYLON.Mesh[] = [];
let cableIndexPairs: [number, number][] = [];
let pointHandles: BABYLON.Mesh[] = [];
let anchorMeshes: BABYLON.Mesh[] = [];
 
// An arrow = a shaft (cylinder) + a head (cone). Its BASE sits exactly on `from`,
// its tip at from + dir·length. The head keeps a fixed size; only the shaft stretches.
interface Arrow { shaft: BABYLON.Mesh; head: BABYLON.Mesh; headLen: number }
interface ForceArrow {
  mesh: Arrow;
  constraintIndex: number;
  end: "a" | "b";
}
let forceArrows: ForceArrow[] = [];
let nodeArrows: Arrow[] = [];

// Member arrows live INSIDE the member, touching the node:
//   tension     → points from the node into the member  (the member pulls the node)
//   compression → points from inside the member to the node (the member pushes the node)
const MEMBER_ARROW_MAX = 0.12;    // m, arrow for the largest design force
const NODE_RADIUS = 0.025;        // m, arrows start at the surface of the yellow node spheres
const NODE_ARROW_SCALE = 0.004;   // m per N, net force on a node
const NODE_ARROW_MAX = 0.15;      // m
const NODE_ARROW_MIN_FORCE = 0.3; // N, below this the node is in equilibrium: no arrow
let forceRef = 1;                 // N, largest |design force| of the current structure
 
let selectedPointIndex: number | null = null;
let dragPlane: BABYLON.Plane | null = null;
 
const xrHeld = new Set<number>();   // nodes currently held by VR hands
const isHeld = (i: number) => i === selectedPointIndex || xrHeld.has(i);

const FIXED_DT = 1 / 60;
const FLOOR_Y = 0.1;
const FRICTION = 0.6;
const PHYS_DAMPING = 0.0002; // s  structural damping β: vibrations die out, free motion doesn't (no air on the Moon)
const PHYS_SUBSTEPS = 2;     // implicit steps per frame
let anchorSet = new Set<number>();                     // nodes bolted to the ground / test rig
const holdTargets = new Map<number, BABYLON.Vector3>(); // node → where the hand/mouse wants it
let prestressStatus = "";
 
// ============================================================
// FORCE DENSITY GRAB (NEW, uses fdm.ts)
// ============================================================
// Two grab modes:
//   "dynamics" = your original position-based dynamics drag
//   "fdm"      = force density method: physics paused, every drag frame
//                solves K_ff x_f = w_f − K_fp x_p for the free nodes
type GrabMode = "dynamics" | "fdm";
let grabMode: GrabMode = "dynamics";
let fdm: FDMGrab | null = null;     // null = no usable self-stress for this structure
let fdmQ: number[] = [];            // force density per constraint, same order as `constraints`
let fdmDragging = false;            // true while the current drag is an FDM drag
let fdmStatus = "";
 
 
const toVec3 = (v: BABYLON.Vector3): Vec3 => [v.x, v.y, v.z];
 
// the HTML Grab-mode card was removed, so there is no status line to update any more
const updateFdmStatus = () => {};
 
// Called after every structure build: find the self-stress q (A q = 0),
// scale it so the average cable tension = PRESTRESS_CABLE, pick the anchors.
const setupFDM = () => {
  fdm = null;
  fdmQ = [];
  fdmDragging = false;
 
  const nodes = points.map((p) => toVec3(p.position));
  const pairs: MemberPair[] = constraints.map((c) => ({
    a: c.a, b: c.b, type: c.rigid ? "bar" : "string",
  }));
 
  // same prestress as the dynamics: q = t / L from the design forces
  if (!constraints.some((c) => c.designForce !== 0)) {
    fdmStatus = "FDM off: no self-stress at this geometry";
    updateFdmStatus();
    return;
  }
  fdmQ = constraints.map((c) => c.designForce / c.designLength);

  const members: FDMember[] = pairs.map((m, k) => ({ ...m, q: fdmQ[k] }));
  // FDM is a static solve: it needs fixed nodes. Use the structure's anchors,
  // or, for a free structure, the nodes touching the ground right now.
  const minY = Math.min(...nodes.map((n) => n[1]));
  const anchors = anchorSet.size > 0 ? [...anchorSet]
    : nodes.map((_, i) => i).filter((i) => nodes[i][1] - minY < 1e-3);
 
  fdm = new FDMGrab(nodes, members, anchors);
  fdmStatus = `FDM ready: ${anchors.length} anchor nodes`;
  updateFdmStatus();
};
 
// ============================================================
// MATERIAL + SECTION + MASS STATE (structure mass calculator)
// ============================================================
let currentStrutMaterial: Materials = getMaterialById("al-6061-t6")!;
let currentCableMaterial: Materials = getMaterialById("dyneema-sk78")!;
 
// Mutable now: the cross-section menu in setupGUI writes to this.
// Global for the whole structure (all struts share a section) - matches the
// uniform-member assumption in Skelton's mass ratios. Becomes a per-member
// array later, if/when the substitution engine needs differently sized sub-struts.
let currentStrutSection: CrossSection = {
  kind: "hollowCircle", outerDiameter: 0.02, wallThickness: 0.002,
};
 
const CABLE_SAFETY_FACTOR = 2.0;
const MIN_CABLE_DIAMETER = 0.001;
 
interface MassBreakdown {
  struts: number; cables: number; nodes: number; total: number;
}
 
const ComputeMassBreakdown = (): MassBreakdown => {
  let struts = 0;
  strutIndexPairs.forEach(([a, b]) => {
    const L = BABYLON.Vector3.Distance(points[a].position, points[b].position);
    // FIXED: was passing currentCableMaterial - strut mass was computed with the
    // cable material's density, so the struts figure was wrong.
    struts += barMass(L, currentStrutMaterial, currentStrutSection);
  });
 
  let cables = 0;
  cableIndexPairs.forEach(([a, b], i) => {
    const L = BABYLON.Vector3.Distance(points[a].position, points[b].position);
    const tension = constraints[strutIndexPairs.length + i].force;
    const section = sizeCable(
      tension, currentCableMaterial, CABLE_SAFETY_FACTOR, MIN_CABLE_DIAMETER
    );
    cables += barMass(L, currentCableMaterial, section);
  });
 
  const nodes = points.length * MASS_PER_NODE;
  return { struts, cables, nodes, total: struts + cables + nodes };
};
 
let massReadoutEl: HTMLDivElement;
let readoutEl: HTMLDivElement;
 
const computeMinBuckling = (): number => {
  let min = Infinity;
  strutIndexPairs.forEach(([a, b]) => {
    const length = BABYLON.Vector3.Distance(points[a].position, points[b].position);
    const pcr = bucklingForce(length, currentStrutMaterial, currentStrutSection);
    if (pcr < min) min = pcr;
  });
  return min;
};
 
// ---------- Physics: prestressed elastic members, implicit Euler (physics.ts) ----------
// EA from the chosen materials; rest length L0 so that, at the design shape,
// every member carries exactly its design prestress (strings short, struts long).
const updateMemberProperties = () => {
  const EAstrut = currentStrutMaterial.youngsModulus * CrossSectionArea(currentStrutSection);
  constraints.forEach((c) => {
    if (c.rigid) {
      c.EA = EAstrut;
    } else {
      const sec = sizeCable(c.designForce, currentCableMaterial, CABLE_SAFETY_FACTOR, MIN_CABLE_DIAMETER);
      c.EA = currentCableMaterial.youngsModulus * CrossSectionArea(sec);
    }
    c.restLength = restLengthFor(c.designLength, c.designForce, c.EA);
  });
};

const stepPhysics = (dt: number) => {
  // forget targets of nodes nobody holds any more
  for (const i of holdTargets.keys()) if (!isHeld(i)) holdTargets.delete(i);
  const holds: Hold[] = [...holdTargets].map(([node, target]) => ({ node, target, k: HAND_STIFFNESS, c: HAND_DAMPING }));
  physicsStep(points, constraints, dt, {
    g: G, nodeMass: MASS_PER_NODE, floorY: FLOOR_Y, friction: FRICTION,
    damping: PHYS_DAMPING, substeps: PHYS_SUBSTEPS,
    isFixed: (i) => anchorSet.has(i), holds,
  });
};
 
// ---------- Forces ----------
// dynamics mode: the real member force t = EA (L − L0) / L0 (slack strings = 0)
// FDM mode (NEW): force = q · L, the member force that is exactly in equilibrium
const computeForces = () => {
  const useFdm = grabMode === "fdm" && fdm !== null && fdmQ.length === constraints.length;
  constraints.forEach((c, i) => {
    const L = BABYLON.Vector3.Distance(points[c.a].position, points[c.b].position);
    if (useFdm) {
      c.force = fdmQ[i] * L;
      return;
    }
    c.force = memberForce(points, c);
  });
};
 
const makeArrow = (name: string, mat: BABYLON.Material, shaftD: number, headD: number, headLen: number, scene: BABYLON.Scene): Arrow => {
  const shaft = BABYLON.MeshBuilder.CreateCylinder(`${name}_shaft`, { height: 1, diameter: shaftD, tessellation: 8 }, scene);
  shaft.bakeTransformIntoVertices(BABYLON.Matrix.Translation(0, 0.5, 0));   // base at the origin
  const head = BABYLON.MeshBuilder.CreateCylinder(`${name}_head`, { height: headLen, diameterTop: 0, diameterBottom: headD, tessellation: 12 }, scene);
  head.bakeTransformIntoVertices(BABYLON.Matrix.Translation(0, headLen / 2, 0));
  for (const m of [shaft, head]) {
    m.material = mat;
    m.isPickable = false;
    m.isVisible = false;
    m.rotationQuaternion = BABYLON.Quaternion.Identity();
  }
  return { shaft, head, headLen };
};

const hideArrow = (a: Arrow) => { a.shaft.isVisible = false; a.head.isVisible = false; };
const disposeArrow = (a: Arrow) => { a.shaft.dispose(); a.head.dispose(); };

/** Draw arrow `a` from `from`, pointing along unit vector `dir`, total length `length`. */
const placeArrow = (a: Arrow, from: BABYLON.Vector3, dir: BABYLON.Vector3, length: number) => {
  const q = a.shaft.rotationQuaternion!;
  BABYLON.Quaternion.FromUnitVectorsToRef(BABYLON.Vector3.UpReadOnly, dir, q);
  a.head.rotationQuaternion!.copyFrom(q);
  const headLen = Math.min(a.headLen, length * 0.5);
  const shaftLen = Math.max(length - headLen, 1e-4);
  a.shaft.position.copyFrom(from);
  a.shaft.scaling.set(1, shaftLen, 1);
  a.head.position.copyFrom(from).addInPlace(dir.scale(shaftLen));
  a.head.scaling.set(1, headLen / a.headLen, 1);
  a.shaft.isVisible = true;
  a.head.isVisible = true;
};
 
// ============================================================
// HEAT MAP: colour every member by how hard it is working
// ============================================================
// In a pin-jointed tensegrity each member is a two-force member: the axial force
// is the SAME all along it. So the heat map colours each bar/cable as a whole.
type HeatMode = "type" | "force" | "utilization";
let heatMode: HeatMode = "force";

// 0 → blue, 0.25 → cyan, 0.5 → green, 0.75 → yellow, 1 → red
const HEAT_STOPS = ["#2C7BB6", "#00A6CA", "#7FD18B", "#F9D057", "#D7191C"].map((h) => BABYLON.Color3.FromHexString(h));
const heatColor = (x: number) => {
  const t = Math.min(1, Math.max(0, x)) * (HEAT_STOPS.length - 1);
  const i = Math.min(Math.floor(t), HEAT_STOPS.length - 2);
  return BABYLON.Color3.Lerp(HEAT_STOPS[i], HEAT_STOPS[i + 1], t - i);
};

// how loaded member ci is, as a number from 0 (nothing) to 1 (full scale)
const memberLoad = (ci: number): number => {
  const c = constraints[ci];
  if (heatMode === "force") return Math.abs(c.force) / (2 * forceRef);
  // utilization
  const L = BABYLON.Vector3.Distance(points[c.a].position, points[c.b].position);
  if (c.rigid) {
    const A = CrossSectionArea(currentStrutSection);
    const yieldCap = currentStrutMaterial.yieldStrength * A;
    const cap = c.force < 0 ? Math.min(bucklingForce(L, currentStrutMaterial, currentStrutSection), yieldCap) : yieldCap;
    return Math.abs(c.force) / cap;
  }
  const sec = sizeCable(c.designForce, currentCableMaterial, CABLE_SAFETY_FACTOR, MIN_CABLE_DIAMETER);
  return c.force / (currentCableMaterial.yieldStrength * CrossSectionArea(sec));
};

const STRUT_COLOR = new BABYLON.Color3(0.9, 0.4, 0.1);
const CABLE_COLOR = new BABYLON.Color3(0.9, 0.9, 0.9);
const updateMemberColors = () => {
  const nStruts = strutMeshes.length;
  const paint = (mesh: BABYLON.Mesh, ci: number, typeColor: BABYLON.Color3) => {
    const mat = mesh.material as BABYLON.StandardMaterial;
    const col = heatMode === "type" ? typeColor : heatColor(memberLoad(ci));
    mat.diffuseColor = col;
    mat.emissiveColor = col.scale(heatMode === "type" ? 0.15 : 0.45);   // glows a bit, readable in shadow
  };
  strutMeshes.forEach((m, i) => paint(m, i, STRUT_COLOR));
  cableLines.forEach((m, i) => paint(m, nStruts + i, CABLE_COLOR));
};

// put a cylinder of height `baseHeight` between a and b
const placeBetween = (mesh: BABYLON.Mesh, a: BABYLON.Vector3, b: BABYLON.Vector3, baseHeight: number) => {
  const delta = b.subtract(a);
  const dist = delta.length();
  if (dist < 0.0001) return;
  mesh.position = a.add(b).scale(0.5);
  mesh.scaling.y = dist / baseHeight;
  if (!mesh.rotationQuaternion) mesh.rotationQuaternion = new BABYLON.Quaternion();
  BABYLON.Quaternion.FromUnitVectorsToRef(BABYLON.Vector3.UpReadOnly, delta.scale(1 / dist), mesh.rotationQuaternion);
};

const updateMeshes = () => {
  strutIndexPairs.forEach(([ia, ib], i) =>
    placeBetween(strutMeshes[i], points[ia].position, points[ib].position, strutRestLengths[i]));
  cableIndexPairs.forEach(([ia, ib], i) =>
    placeBetween(cableLines[i], points[ia].position, points[ib].position, 1));
  points.forEach((p, i) => {
    pointHandles[i].position.copyFrom(p.position);
  });
};
 
const updateForceArrows = () => {
  if (heatMode !== "type") { forceArrows.forEach((f) => hideArrow(f.mesh)); return; }
  forceArrows.forEach(({ mesh, constraintIndex, end }) => {
    const c = constraints[constraintIndex];
    const node = end === "a" ? points[c.a].position : points[c.b].position;
    const other = end === "a" ? points[c.b].position : points[c.a].position;
    const toOther = other.subtract(node);
    const L = toOther.length();
    if (L < 1e-4 || Math.abs(c.force) < 0.05) { hideArrow(mesh); return; }
    const inward = toOther.scale(1 / L);                       // from the node into the member
    const start = node.add(inward.scale(NODE_RADIUS));         // surface of the node sphere
    const length = Math.min((Math.abs(c.force) / forceRef) * MEMBER_ARROW_MAX, 0.4 * L - NODE_RADIUS);
    if (length <= 0.005) { hideArrow(mesh); return; }
    if (c.force > 0) {
      placeArrow(mesh, start, inward, length);                 // tension: pulls the node inward
    } else {
      placeArrow(mesh, start.add(inward.scale(length)), inward.scale(-1), length);   // compression: pushes on the node
    }
  });
};
 
const updateNodeArrows = () => {
  if (heatMode !== "type") { nodeArrows.forEach(hideArrow); return; }
  points.forEach((p, i) => {
    const net = new BABYLON.Vector3(0, -MASS_PER_NODE * G, 0);
    constraints.forEach((c) => {
      if (c.a !== i && c.b !== i) return;
      const other = c.a === i ? points[c.b].position : points[c.a].position;
      const toOther = other.subtract(p.position);
      const d = toOther.length();
      if (d < 0.0001) return;
      const unit = toOther.scale(1 / d);
      net.addInPlace(unit.scale(c.force));
    });
    const mag = net.length();
    const arrow = nodeArrows[i];
    if (mag < NODE_ARROW_MIN_FORCE) { hideArrow(arrow); return; }   // node in equilibrium
    const length = Math.min(mag * NODE_ARROW_SCALE, NODE_ARROW_MAX);
    const dir = net.scale(1 / mag);
    placeArrow(arrow, p.position.add(dir.scale(NODE_RADIUS)), dir, length);
  });
};
 
const updateReadout = () => {
  if (!readoutEl) return;
  let cablePeakTension = 0, strutPeakCompression = 0;
  constraints.forEach((c) => {
    if (c.rigid) strutPeakCompression = Math.min(strutPeakCompression, c.force);
    else cablePeakTension = Math.max(cablePeakTension, c.force);
  });
  readoutEl.textContent =
    `g=${G} m/s²  m=${MASS_PER_NODE} kg/node\n` +
    `${prestressStatus}\n` +
    `design: mean cable tension ${PRESTRESS_CABLE} N\n` +
    `forces: ${grabMode === "fdm" && fdm ? "FDM, t = q·L" : "elastic, t = EA·(L − L0)/L0"}\n` +   // NEW (FDM)
    `\nMax cable tension: ${cablePeakTension.toFixed(1)} N\n` +
    `Max strut compression: ${strutPeakCompression.toFixed(1)} N`;
};
 
// ============================================================
// BUILD
// ============================================================
 
// Shared materials - created ONCE and reused across structure swaps.
// (Previously these were built inside the build function, so every swap
// leaked a fresh set of five StandardMaterials.)
let sharedMats: {
  strut: BABYLON.StandardMaterial;
  handle: BABYLON.StandardMaterial;
  tension: BABYLON.StandardMaterial;
  comp: BABYLON.StandardMaterial;
  node: BABYLON.StandardMaterial;
  anchor: BABYLON.StandardMaterial;
} | null = null;
 
const initMaterials = (scene: BABYLON.Scene) => {
  if (sharedMats) return sharedMats;
 
  const strut = new BABYLON.StandardMaterial("strutMat", scene);
  strut.diffuseColor = new BABYLON.Color3(0.9, 0.4, 0.1);
 
  const handle = new BABYLON.StandardMaterial("handleMat", scene);
  handle.diffuseColor = new BABYLON.Color3(1, 0.9, 0.2);
  handle.emissiveColor = new BABYLON.Color3(0.4, 0.35, 0);
 
  const tension = new BABYLON.StandardMaterial("tensionMat", scene);
  tension.diffuseColor = new BABYLON.Color3(0.2, 0.4, 1);
  tension.emissiveColor = new BABYLON.Color3(0.1, 0.2, 0.5);
 
  const comp = new BABYLON.StandardMaterial("compMat", scene);
  comp.diffuseColor = new BABYLON.Color3(1, 0.2, 0.2);
  comp.emissiveColor = new BABYLON.Color3(0.5, 0.1, 0.1);
 
  const node = new BABYLON.StandardMaterial("nodeMat", scene);
  node.diffuseColor = new BABYLON.Color3(0.2, 1, 0.4);
  node.emissiveColor = new BABYLON.Color3(0.1, 0.4, 0.15);
 
  const anchor = new BABYLON.StandardMaterial("anchorMat", scene);
  anchor.diffuseColor = new BABYLON.Color3(0.22, 0.24, 0.28);
  anchor.specularColor = new BABYLON.Color3(0.4, 0.4, 0.45);

  sharedMats = { strut, handle, tension, comp, node, anchor };
  return sharedMats;
};
 
const clearCurrentStructure = () => {
  strutMeshes.forEach((m) => m.dispose(false, true));   // true = also dispose its own material
  cableLines.forEach((m) => m.dispose(false, true));
  pointHandles.forEach((h) => h.dispose());
  anchorMeshes.forEach((m) => m.dispose());
  anchorMeshes = [];
  forceArrows.forEach((a) => disposeArrow(a.mesh));
  nodeArrows.forEach(disposeArrow);
 
  strutMeshes = [];
  strutRestLengths = [];
  cableLines = [];
  pointHandles = [];
  forceArrows = [];
  nodeArrows = [];
  points = [];
  constraints = [];
  strutIndexPairs = [];
  cableIndexPairs = [];
 
  // a dragged handle no longer exists after a swap
  selectedPointIndex = null;
  xrHeld.clear();
  dragPlane = null;
  fdmDragging = false;   // NEW (FDM)
};
 
const buildTensegrityStructure = (scene: BABYLON.Scene, def: StructureDef) => {
  currentStructureId = def.id;
  clearCurrentStructure();
  const mats = initMaterials(scene);
 
  const rawPoints = def.generatePoints(def.params);
  points = rawPoints.map((pos) => ({ position: pos.clone(), prevPosition: pos.clone() }));
 
  // Deep-copy the pair arrays. Assigning def.strutIndexPairs directly hands out a
  // live reference to the catalogue entry, so any runtime mutation (e.g. removing
  // a failed strut for the buckling animation) would corrupt the catalogue.
  strutIndexPairs = def.strutIndexPairs.map(([a, b]) => [a, b] as [number, number]);
  cableIndexPairs = def.cableIndexPairs.map(([a, b]) => [a, b] as [number, number]);
 
  // Members + design prestress (self-stress closest to "bars push, strings pull")
  anchorSet = new Set(def.anchors);
  holdTargets.clear();
  const pairs = [
    ...strutIndexPairs.map(([a, b]) => ({ a, b, rigid: true })),
    ...cableIndexPairs.map(([a, b]) => ({ a, b, rigid: false })),
  ];
  const design = designPrestress(points.map((p) => p.position), pairs, PRESTRESS_CABLE);
  prestressStatus = design.ok ? design.message : `NO prestress: ${design.message}`;
  constraints = pairs.map((m, k) => {
    const L = BABYLON.Vector3.Distance(points[m.a].position, points[m.b].position);
    return { ...m, EA: 1, restLength: L, designLength: L, designForce: design.forces[k], force: design.forces[k] };
  });
  updateMemberProperties();
 
  strutRestLengths = strutIndexPairs.map(([a, b]) =>
    BABYLON.Vector3.Distance(points[a].position, points[b].position)
  );
 
  strutMeshes = strutIndexPairs.map((_pair, i) => {
    const mesh = BABYLON.MeshBuilder.CreateCylinder(
      `${def.id}_strut${i}`, { height: strutRestLengths[i], diameter: 0.015 }, scene);
    mesh.material = mats.strut.clone(`${def.id}_strutMat${i}`);   // own material → own heat colour
    return mesh;
  });
 
  cableLines = cableIndexPairs.map((_pair, i) => {
    const mesh = BABYLON.MeshBuilder.CreateCylinder(
      `${def.id}_cable${i}`, { height: 1, diameter: 0.004, tessellation: 8 }, scene);
    mesh.material = mats.strut.clone(`${def.id}_cableMat${i}`);
    mesh.isPickable = false;
    return mesh;
  });
 
  pointHandles = points.map((p, i) => {
    const h = BABYLON.MeshBuilder.CreateSphere(`${def.id}_handle${i}`, { diameter: 0.05 }, scene);
    h.material = mats.handle;
    h.position = p.position.clone();
    return h;
  });
 
  // anchors: dark blocks, plus a support post when the anchor is off the ground (test rig)
  anchorMeshes = [];
  def.anchors.forEach((i) => {
    const p = points[i].position;
    const block = BABYLON.MeshBuilder.CreateBox(`${def.id}_anchor${i}`, { size: 0.04 }, scene);
    block.position = p.clone();
    block.material = mats.anchor;
    block.isPickable = false;
    anchorMeshes.push(block);
    const postH = p.y - FLOOR_Y;
    if (postH > 0.03) {
      const post = BABYLON.MeshBuilder.CreateCylinder(`${def.id}_post${i}`, { height: postH, diameter: 0.015 }, scene);
      post.position = new BABYLON.Vector3(p.x, FLOOR_Y + postH / 2, p.z);
      post.material = mats.anchor;
      post.isPickable = false;
      anchorMeshes.push(post);
    }
  });

  forceRef = Math.max(1, ...constraints.map((c) => Math.abs(c.designForce)));
  refreshHeatLegend();
  forceArrows = [];
  constraints.forEach((c, ci) => {
    (["a", "b"] as const).forEach((end) => {
      const arrow = makeArrow(`${def.id}_arrow${ci}${end}`, c.rigid ? mats.comp : mats.tension,
        c.rigid ? 0.006 : 0.004, c.rigid ? 0.022 : 0.016, 0.03, scene);
      forceArrows.push({ mesh: arrow, constraintIndex: ci, end });
    });
  });
 
  nodeArrows = points.map((_, i) => makeArrow(`${def.id}_node${i}`, mats.node, 0.005, 0.018, 0.03, scene));
 
  setupFDM();   // NEW (FDM): self-stress + anchors for this structure
};
 
// ============================================================
// GUI
// ============================================================
let refreshHeatLegend = () => {};
const setupGUI = (scene: BABYLON.Scene) => {
  const overlay = document.createElement("div");
  overlay.className = "gui";                       // all the styling lives in style.css
  overlay.innerHTML = `<div class="gui-header">Tensegrity Lab</div>`;

  // a rounded card with a small grey title; returns the card so we can fill it
  const card = (title: string) => {
    const c = document.createElement("div");
    c.className = "gui-card";
    c.innerHTML = `<div class="gui-title">${title}</div>`;
    overlay.appendChild(c);
    return c;
  };

  // --- Forces ---
  const forcesCard = card("Forces");
  forcesCard.innerHTML +=
    `<div id="arrowLegend">` +
    `<div class="gui-legend"><span class="gui-dot" style="background:#3366ff"></span>Tension (cables)</div>` +
    `<div class="gui-legend"><span class="gui-dot" style="background:#ff3333"></span>Compression (struts)</div>` +
    `<div class="gui-legend"><span class="gui-dot" style="background:#33ff66"></span>Net force at node</div>` +
    `</div>`;
  const readout = document.createElement("div");
  readout.className = "gui-readout";
  forcesCard.appendChild(readout);

  // --- Force view: arrows OR heat map ---
  const heatCard = card("Force view");
  const heatRow = document.createElement("div");
  heatRow.className = "gui-seg";
  const heatBar = document.createElement("div");
  heatBar.className = "gui-heatbar";
  const heatLabels = document.createElement("div");
  heatLabels.className = "gui-heatlabels";
  const renderHeat = () => {
    Array.from(heatRow.children).forEach((c) =>
      c.classList.toggle("active", (c as HTMLElement).dataset.mode === heatMode));
    heatBar.style.display = heatLabels.style.display = heatMode === "type" ? "none" : "";
    heatLabels.innerHTML = heatMode === "force"
      ? `<span>0 N</span><span>${forceRef.toFixed(0)} N</span><span>${(2 * forceRef).toFixed(0)} N</span>`
      : `<span>0 %</span><span>50 %</span><span>100 % = fails</span>`;
    const legend = document.getElementById("arrowLegend");
    if (legend) legend.style.display = heatMode === "type" ? "" : "none";
  };
  ([["type", "Arrows"], ["force", "Heat: force"], ["utilization", "Heat: use"]] as [HeatMode, string][]).forEach(([mode, label]) => {
    const b = document.createElement("button");
    b.className = "gui-btn";
    b.textContent = label;
    b.dataset.mode = mode;
    b.addEventListener("click", () => { heatMode = mode; renderHeat(); });
    heatRow.appendChild(b);
  });
  heatCard.append(heatRow, heatBar, heatLabels);
  refreshHeatLegend = renderHeat;   // so a new structure updates the N labels
 
  // --- Structure menu ---
  const structRow = document.createElement("div");
  structRow.className = "gui-list";
  listStructures().forEach(({ id, name }) => {
    const btn = document.createElement("button");
    btn.textContent = name;
    btn.className = "gui-btn";
    btn.classList.toggle("active", id === DEFAULT_STRUCTURE);
    btn.addEventListener("click", () => {
      buildTensegrityStructure(scene, getStructure(id));
      Array.from(structRow.children).forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      updateMassReadout();
    });
    structRow.appendChild(btn);
  });
  card("Structure").appendChild(structRow);
  
  // --- Material menu ---
  const btnRow = document.createElement("div");
  btnRow.className = "gui-list";
  MATERIALS.forEach((m) => {
    const btn = document.createElement("button");
    btn.textContent = m.name;
    btn.className = "gui-btn";
    btn.classList.toggle("gold", m.id === currentStrutMaterial.id);
    btn.addEventListener("click", () => {
      currentStrutMaterial = m;
      // highlight the active button
      Array.from(btnRow.children).forEach((c) => c.classList.remove("gold"));
      btn.classList.add("gold");
      updateMassReadout();
    });
    btnRow.appendChild(btn);
  });
  card("Strut material").appendChild(btnRow);
 
  // --- Cross-section menu ---
  const sectionCard = card("Cross-section");
  const shapeSelect = document.createElement("select");
  for (const kind of Object.keys(SECTION_FIELDS)) {
    const opt = document.createElement("option");
    opt.value = kind;
    opt.textContent = kind;
    shapeSelect.appendChild(opt);
  }
  // start the dropdown on whatever currentStrutSection already is
  shapeSelect.value = currentStrutSection.kind;
  sectionCard.appendChild(shapeSelect);

  const shapeFields = document.createElement("div");
  sectionCard.appendChild(shapeFields);
 
  // Build a CrossSection object out of whatever inputs are currently on screen.
  // The `as CrossSection` cast is the one unchecked seam: the values come from
  // DOM strings, so TypeScript can't verify the shape. It's safe because the
  // inputs were generated from SECTION_FIELDS in the first place.
  const readSection = (): CrossSection => {
    const kind = shapeSelect.value as CrossSection["kind"];
    const obj: Record<string, unknown> = { kind };
    shapeFields.querySelectorAll("input").forEach((input) => {
      obj[input.dataset.key!] = Number(input.value);
    });
    return obj as CrossSection;
  };
 
  const onSectionChange = () => {
    currentStrutSection = readSection();
    updateMassReadout();
  };
 
  const renderFields = (kind: CrossSection["kind"]) => {
    shapeFields.innerHTML = "";
    for (const f of SECTION_FIELDS[kind]) {
      const label = document.createElement("label");
      label.textContent = f.label;

      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.001";
      input.min = "0.0001";
      input.value = String(f.default);
      input.dataset.key = f.key;     // remembers which CrossSection field this is
      input.addEventListener("input", onSectionChange);

      label.appendChild(input);
      shapeFields.appendChild(label);
    }
  };
 
  shapeSelect.addEventListener("change", () => {
    renderFields(shapeSelect.value as CrossSection["kind"]);
    onSectionChange();
  });
 
  renderFields(shapeSelect.value as CrossSection["kind"]);
  onSectionChange();
 
  const massReadout = document.createElement("div");
  massReadout.className = "gui-mono";
  card("Mass & buckling").appendChild(massReadout);
  massReadoutEl = massReadout;
 
  document.body.appendChild(overlay);
  renderHeat();                     // now #arrowLegend is on the page
  readoutEl = readout;
  updateMassReadout();
};
 
const updateMassReadout = () => {
  updateMemberProperties();   // material / section may have changed → new EA, same prestress
  if (!massReadoutEl) return;
 
  const m = ComputeMassBreakdown();
  const pcr = computeMinBuckling();
 
  let worstCompression = 0;
  constraints.forEach((c) => {
    if (c.rigid) worstCompression = Math.min(worstCompression, c.force);
  });
  const compressionMag = Math.abs(worstCompression);
  const safe = compressionMag < pcr;
  const utilisation = Number.isFinite(pcr) && pcr > 0 ? (100 * compressionMag) / pcr : 0;
 
  massReadoutEl.textContent =
    `Struts:  ${m.struts.toFixed(3)} kg  (${(100 * m.struts / m.total).toFixed(0)}%)\n` +
    `Cables:  ${m.cables.toFixed(4)} kg  (${(100 * m.cables / m.total).toFixed(1)}%)\n` +
    `Nodes:   ${m.nodes.toFixed(3)} kg  (${(100 * m.nodes / m.total).toFixed(0)}%)\n` +
    `TOTAL:   ${m.total.toFixed(3)} kg\n` +
    `Buckling limit: ${Number.isFinite(pcr) ? pcr.toFixed(0) : "n/a"} N\n` +
    `Max compression: ${compressionMag.toFixed(0)} N (${utilisation.toFixed(0)}%)\n` +
    `Status: ${safe ? "OK" : "BUCKLES ⚠"}`;
};
 
// Moves node `index` to newPos (mouse or VR hand).
// viaFdm = true: one FDM solve moves every free node to equilibrium.
const moveNode = (index: number, newPos: BABYLON.Vector3, viaFdm: boolean) => {
  if (viaFdm && fdm) {
    const solved = fdm.drag(toVec3(newPos));
    solved.forEach((n, i) => {
      points[i].position.set(n[0], n[1], n[2]);
      points[i].prevPosition.copyFrom(points[i].position);
    });
  } else {
    // dynamics: don't teleport the node — pull it with a spring (HAND_STIFFNESS)
    holdTargets.set(index, newPos.clone());
  }
};

const setupDragInteraction = (scene: BABYLON.Scene, camera: BABYLON.ArcRotateCamera) => {
  scene.onPointerObservable.add((pointerInfo) => {
    switch (pointerInfo.type) {
      case BABYLON.PointerEventTypes.POINTERDOWN: {
        const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => pointHandles.includes(m as BABYLON.Mesh));
        if (pick?.hit && pick.pickedMesh) {
          const index = pointHandles.indexOf(pick.pickedMesh as BABYLON.Mesh);
          if (index !== -1) {
            // NEW (FDM): in FDM mode, start an FDM grab first
            if (grabMode === "fdm") {
              if (!fdm) break;                       // FDM not available for this structure
              fdm.nodes = points.map((p) => toVec3(p.position));
              try {
                fdm.startGrab(index);
                fdmDragging = true;
              } catch {
                fdmStatus = "FDM: that node is an anchor, grab another one";
                updateFdmStatus();
                break;                               // don't select anything
              }
            }
            selectedPointIndex = index;
            camera.detachControl();
            dragPlane = BABYLON.Plane.FromPositionAndNormal(points[index].position, camera.getForwardRay().direction);
          }
        }
        break;
      }
      case BABYLON.PointerEventTypes.POINTERMOVE: {
        if (selectedPointIndex !== null && dragPlane) {
          const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, BABYLON.Matrix.Identity(), camera);
          const distance = ray.intersectsPlane(dragPlane);
          if (distance !== null) {
            moveNode(selectedPointIndex, ray.origin.add(ray.direction.scale(distance)), fdmDragging);
          }
        }
        break;
      }
      case BABYLON.PointerEventTypes.POINTERUP: {
        if (fdmDragging && fdm) fdm.endGrab();   // NEW (FDM)
        fdmDragging = false;                     // NEW (FDM)
        selectedPointIndex = null;
        dragPlane = null;
        camera.attachControl(canvas, true);
        break;
      }
    }
  });
};

const GRAB_RADIUS = 0.06;   // 6 cm: how close the hand must be to a node
 

const handPosition = (c: BABYLON.WebXRInputSource) =>
  (c.grip ?? c.pointer).getAbsolutePosition();

const findNearestNode = (pos: BABYLON.Vector3): number | null => {
  let best: number | null = null;
  let bestDist = GRAB_RADIUS;
  for (let i = 0; i < points.length; i++) {
    if (anchorSet.has(i)) continue;              // anchors are bolted down
    const d = BABYLON.Vector3.Distance(points[i].position, pos);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
};

// ============================================================
// VR PANEL: connects the 3D panel (vrPanel.ts) to the simulator state
// ============================================================
const makeVRPanelAPI = (scene: BABYLON.Scene, exitVR: () => void): VRPanelAPI => ({
  structures: listStructures(),
  materials: MATERIALS.map((m) => ({ id: m.id, name: m.name })),
  sectionKinds: Object.keys(SECTION_FIELDS),

  getState: () => {
    let cableMax = 0, strutMax = 0;
    constraints.forEach((c) => {
      if (c.rigid) strutMax = Math.max(strutMax, -c.force);
      else cableMax = Math.max(cableMax, c.force);
    });
    const m = ComputeMassBreakdown();
    const sec = currentStrutSection as unknown as Record<string, number>;
    return {
      structureId: currentStructureId,
      materialId: currentStrutMaterial.id,
      grabMode,
      fdmStatus: grabMode === "fdm" ? fdmStatus : prestressStatus,
      planet: PLANET,
      g: G,
      sectionKind: currentStrutSection.kind,
      sectionFields: SECTION_FIELDS[currentStrutSection.kind].map((f) => ({
        key: f.key, label: f.label, value: sec[f.key],
      })),
      cableMax,
      strutMax,
      bucklingLimit: computeMinBuckling(),
      massStruts: m.struts,
      massCables: m.cables,
      massNodes: m.nodes,
    };
  },

  setStructure: (id) => {
    buildTensegrityStructure(scene, getStructure(id));
    updateMassReadout();
  },
  setMaterial: (id) => {
    const m = getMaterialById(id);
    if (m) currentStrutMaterial = m;
    updateMassReadout();
  },
  toggleGrabMode: () => {
    grabMode = grabMode === "fdm" ? "dynamics" : "fdm";
    if (grabMode === "dynamics") points.forEach((p) => p.prevPosition.copyFrom(p.position));
  },
  setSectionKind: (kind) => {
    const k = kind as CrossSection["kind"];
    const obj: Record<string, unknown> = { kind: k };
    SECTION_FIELDS[k].forEach((f) => (obj[f.key] = f.default));
    currentStrutSection = obj as CrossSection;
    updateMassReadout();
  },
  scaleSectionField: (key, factor) => {
    const sec = { ...currentStrutSection } as unknown as Record<string, number>;
    sec[key] = Math.max(0.0005, sec[key] * factor);   // never below 0.5 mm
    currentStrutSection = sec as unknown as CrossSection;
    updateMassReadout();
  },
  setPlanet: (p) => { window.location.search = `?planet=${p}`; },
  exitVR,
});


// One grabber per hand: works with bare hands (pinch) or controllers (grip)
type Grabber = {
  side: "left" | "right";
  hand: BABYLON.WebXRHand | null;
  controller: BABYLON.WebXRInputSource | null;
  held: number | null;        // node this hand is holding
  usesFdm: boolean;           // true if this hand owns the FDM grab
  ball: BABYLON.Mesh;
  mat: BABYLON.StandardMaterial;
};

const PINCH_ON = 0.02;    // fingertips closer than 2 cm = pinching
const PINCH_OFF = 0.04;   // must open past 4 cm to release (no flicker)

const makeGrabber = (side: "left" | "right", scene: BABYLON.Scene): Grabber => {
  const ball = BABYLON.MeshBuilder.CreateSphere(`ball_${side}`, { diameter: 2 * GRAB_RADIUS }, scene);
  const mat = new BABYLON.StandardMaterial(`ballMat_${side}`, scene);
  mat.alpha = 0.3;
  ball.material = mat;
  ball.isPickable = false;
  ball.isVisible = false;
  return { side, hand: null, controller: null, held: null, usesFdm: false, ball, mat };
};

const updateGrabber = (g: Grabber) => {
  // 1. grab point + is the hand closing?
  let pos: BABYLON.Vector3 | null = null;
  let closing = false;
  if (g.hand) {
    const thumb = g.hand.getJointMesh(BABYLON.WebXRHandJoint.THUMB_TIP).getAbsolutePosition();
    const index = g.hand.getJointMesh(BABYLON.WebXRHandJoint.INDEX_FINGER_TIP).getAbsolutePosition();
    pos = thumb.add(index).scale(0.5);
    const gap = BABYLON.Vector3.Distance(thumb, index);
    closing = gap < (g.held !== null ? PINCH_OFF : PINCH_ON);
  } else if (g.controller) {
    pos = handPosition(g.controller);
    closing = g.controller.inputSource.gamepad?.buttons[1]?.pressed ?? false;
  }

  g.ball.isVisible = pos !== null;
  if (!pos) return;
  g.ball.position.copyFrom(pos);

  let nearest = findNearestNode(pos);
  if (nearest !== null && xrHeld.has(nearest) && nearest !== g.held) nearest = null;  // other hand has it

  // blue = closing, green = node in reach, red = nothing
  g.mat.emissiveColor = closing ? BABYLON.Color3.Blue()
    : nearest !== null ? BABYLON.Color3.Green() : BABYLON.Color3.Red();

  // 2. start grab
  if (closing && g.held === null && nearest !== null) {
    if (grabMode === "fdm") {
      if (!fdm || fdmDragging) return;          // FDM handles one node at a time
      fdm.nodes = points.map((p) => toVec3(p.position));
      try { fdm.startGrab(nearest); }
      catch { fdmStatus = "FDM: that node is an anchor"; updateFdmStatus(); return; }
      fdmDragging = true;
      g.usesFdm = true;
    }
    g.held = nearest;
    xrHeld.add(nearest);
  }

  // 3. release
  if (!closing && g.held !== null) {
    if (g.usesFdm && fdm) fdm.endGrab();
    if (g.usesFdm) fdmDragging = false;
    g.usesFdm = false;
    xrHeld.delete(g.held);
    g.held = null;
  }

  // 4. follow the hand
  if (g.held !== null) moveNode(g.held, pos, g.usesFdm);
};

const setupXR = async (scene: BABYLON.Scene, floor: BABYLON.AbstractMesh) => {
  try {
    const xr = await scene.createDefaultXRExperienceAsync({
      floorMeshes: [floor],
      disableTeleportation: true,   // both hands are for grabbing now
    });

    const grabbers = { left: makeGrabber("left", scene), right: makeGrabber("right", scene) };
    const sideOf = (s: XRHandedness) => (s === "left" || s === "right" ? grabbers[s] : null);

    // bare hands
    let handTracking = xr.baseExperience.featuresManager.getEnabledFeature(
      BABYLON.WebXRFeatureName.HAND_TRACKING) as BABYLON.WebXRHandTracking | null;
    if (!handTracking) {
      handTracking = xr.baseExperience.featuresManager.enableFeature(
        BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", { xrInput: xr.input }) as BABYLON.WebXRHandTracking;
    }
    handTracking.onHandAddedObservable.add((h) => {
      const g = sideOf(h.xrController.inputSource.handedness);
      if (g) g.hand = h;
    });
    handTracking.onHandRemovedObservable.add((h) => {
      const g = sideOf(h.xrController.inputSource.handedness);
      if (g && g.hand === h) g.hand = null;
    });

    // controllers (if you pick them up)
    const addController = (c: BABYLON.WebXRInputSource) => {
      if (c.inputSource.hand) return;
      const g = sideOf(c.inputSource.handedness);
      if (g) g.controller = c;
    };
    xr.input.controllers.forEach(addController);
    xr.input.onControllerAddedObservable.add(addController);
    xr.input.onControllerRemovedObservable.add((c) => {
      const g = sideOf(c.inputSource.handedness);
      if (g && g.controller === c) g.controller = null;
    });

    scene.onBeforeRenderObservable.add(() => {
      updateGrabber(grabbers.left);
      updateGrabber(grabbers.right);
    });

    // the menu console: only visible inside VR
    const panel = createVRPanel(scene, makeVRPanelAPI(scene, () => { void xr.baseExperience.exitXRAsync(); }));
    panel.setVisible(false);

    const placeConsole = () => {
      const eye = xr.baseExperience.camera.position.clone();
      const spot = new BABYLON.Vector3(-0.45, eye.y - 0.15, -0.4);
      let floorY = 0;
      try {
        // terrain height under the console, so the stand touches the ground
        const down = new BABYLON.Ray(new BABYLON.Vector3(spot.x, eye.y + 50, spot.z), new BABYLON.Vector3(0, -1, 0), 200);
        const hit = scene.pickWithRay(down, (m) => m === floor);
        if (hit?.pickedPoint) floorY = hit.pickedPoint.y;
      } catch (e) {
        console.warn("console: ground ray failed", e);
      }
      if (floorY > spot.y - 0.3) floorY = spot.y - 1.2;   // ground above the screen? ignore it
      panel.placeFacing(spot, eye, floorY);
      panel.setVisible(true);
    };

    xr.baseExperience.onInitialXRPoseSetObservable.add((xrCamera) => {
      xrCamera.position.x = 0;
      xrCamera.position.z = -0.8;   // 80 cm in front of the structure
      placeConsole();
    });
    xr.baseExperience.onStateChangedObservable.add((state) => {
      if (state === BABYLON.WebXRState.IN_XR) placeConsole();          // backup, in case the pose event is missed
      if (state === BABYLON.WebXRState.NOT_IN_XR) panel.setVisible(false);
    });

    return xr;
  } catch (e) {
    console.warn("XR not available:", e);
  }
};
 
const addMountainSilhouettes = (scene: BABYLON.Scene, horizon: BABYLON.Color3) => {
  type Massif = { az: number; width: number; height: number };   // az in degrees, same as sunAzimuthDeg

  const ring = (name: string, radius: number, massifs: Massif[], baseH: number,
                haze: number, seed: number) => {
    let s = seed;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    // high-frequency ridged noise = rocky detail along each mountain
    const waves = Array.from({ length: 6 }, (_, k) => ({
      freq: 12 + k * 9 + Math.floor(rnd() * 6),
      amp: 1 / (k + 1),
      phase: rnd() * Math.PI * 2,
    }));
    const N = 1440;
    const top: BABYLON.Vector3[] = [];
    const bottom: BABYLON.Vector3[] = [];
    for (let i = 0; i <= N; i++) {
      const azDeg = (i / N) * 360;
      const a = BABYLON.Tools.ToRadians(azDeg);
      // rocky detail, 0..1
      let n = 0, norm = 0;
      waves.forEach((w) => { n += w.amp * (1 - Math.abs(Math.sin(a * w.freq + w.phase))); norm += w.amp; });
      const rough = n / norm;
      // sum of mountains, each a bell shape around its direction
      let h = baseH * ( 0.04 + 0.6 * rough);
      massifs.forEach((m) => {
        const d = ((azDeg - m.az + 540) % 360) - 180;            // angular distance, -180..180
        h += m.height * Math.exp(-((d / m.width) ** 2)) * (0.55 + 0.45 * rough);
      });
      const x = Math.sin(a) * radius, z = Math.cos(a) * radius;  // same convention as the sun
      top.push(new BABYLON.Vector3(x, h, z));
      bottom.push(new BABYLON.Vector3(x, -400, z));
    }
    const mesh = BABYLON.MeshBuilder.CreateRibbon(name, { pathArray: [bottom, top] }, scene);

    const dark = new BABYLON.Color3(0.42, 0.22, 0.14);
    const topCol = BABYLON.Color3.Lerp(dark, horizon, haze);
    const cols: number[] = [];
    for (let i = 0; i <= N; i++) cols.push(horizon.r, horizon.g, horizon.b, 1);
    for (let i = 0; i <= N; i++) cols.push(topCol.r, topCol.g, topCol.b, 1);
    mesh.setVerticesData(BABYLON.VertexBuffer.ColorKind, cols);

    const mat = new BABYLON.StandardMaterial(name + "Mat", scene);
    mat.disableLighting = true;
    mat.emissiveColor = BABYLON.Color3.White();
    mat.backFaceCulling = false;
    mat.fogEnabled = false;
    mesh.material = mat;
    mesh.infiniteDistance = true;
    mesh.isPickable = false;
  };

  // FAR range: taller, paler. The sun (az 180) sits in the gap between 140 and 225.
  ring("farRidges", 4200, [
    { az: 140, width: 25, height: 650 },
    { az: 225, width: 30, height: 560 },
    { az: 300, width: 35, height: 450 },
    { az: 40,  width: 30, height: 500 },
  ], 30, 0.7, 7);

  // NEAR range: lower, darker hills, continuing the valley walls around you
  ring("nearRidges", 3400, [
    { az: 0,   width: 20, height: 200 },
    { az: 45,  width: 15, height: 160 },
    { az: 90,  width: 22, height: 220 },
    { az: 150, width: 18, height: 230 },
    { az: 210, width: 15, height: 200 },
    { az: 260, width: 20, height: 180 },
    { az: 315, width: 18, height: 210 },
  ], 40, 0.5, 42);
};

const setupMarsAtmosphere = (scene: BABYLON.Scene, env: MoonEnvironment) => {
  // ---- Tuning knobs ----
  const sunElevationDeg = 10;   // sun height above the horizon (low = dramatic)
  const sunAzimuthDeg = 180;    // compass direction of the sun (180 = in front of the default camera)
  const horizon = new BABYLON.Color3(0.93, 0.62, 0.42);   // pale peach near the horizon
  const zenith  = new BABYLON.Color3(0.70, 0.38, 0.24);   // deeper rust overhead
  const glowCol = new BABYLON.Color3(1.00, 0.90, 0.70);   // bright glow around the sun

  const el = BABYLON.Tools.ToRadians(sunElevationDeg);
  const az = BABYLON.Tools.ToRadians(sunAzimuthDeg);
  const toSun = new BABYLON.Vector3(
    Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));

  // ---- Gradient sky dome (colors painted per vertex) ----
  const dome = BABYLON.MeshBuilder.CreateSphere("marsSky",
    { diameter: 9000, segments: 48, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene);
  const pos = dome.getVerticesData(BABYLON.VertexBuffer.PositionKind)!;
  const cols: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    const d = new BABYLON.Vector3(pos[i], pos[i + 1], pos[i + 2]).normalize();
    const t = Math.pow(Math.max(d.y, 0), 0.6);                          // 0 at horizon, 1 overhead
    const base = BABYLON.Color3.Lerp(horizon, zenith, t);
    const g = Math.pow(Math.max(BABYLON.Vector3.Dot(d, toSun), 0), 8);  // glow near the sun
    const c = BABYLON.Color3.Lerp(base, glowCol, g * 0.85);
    cols.push(c.r, c.g, c.b, 1);
  }
  dome.setVerticesData(BABYLON.VertexBuffer.ColorKind, cols);
  const domeMat = new BABYLON.StandardMaterial("marsSkyMat", scene);
  domeMat.disableLighting = true;
  domeMat.emissiveColor = BABYLON.Color3.White();
  domeMat.backFaceCulling = false;
  domeMat.fogEnabled = false;          // the sky itself is not hazed
  dome.material = domeMat;
  dome.infiniteDistance = true;        // always surrounds the viewer
  dome.isPickable = false;

  // ---- Sun disk + glow ----
  const sunDisk = BABYLON.MeshBuilder.CreateDisc("marsSun", { radius: 45, tessellation: 48 }, scene);
  sunDisk.position = toSun.scale(4400);
  sunDisk.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;   // always faces you
  sunDisk.infiniteDistance = true;
  sunDisk.isPickable = false;
  const sunMat = new BABYLON.StandardMaterial("marsSunMat", scene);
  sunMat.disableLighting = true;
  sunMat.emissiveColor = new BABYLON.Color3(1.0, 0.97, 0.9);
  sunMat.fogEnabled = false;
  sunDisk.material = sunMat;

  const glow = new BABYLON.GlowLayer("sunGlow", scene);
  glow.addIncludedOnlyMesh(sunDisk);   // only the sun glows
  glow.intensity = 1.5;

  // ---- Light coming FROM that sun ----
  env.sun.direction = toSun.scale(-1);
  env.sun.position = toSun.scale(100);
  env.sun.intensity = 2.0;
  env.sun.diffuse = new BABYLON.Color3(1.0, 0.82, 0.62);   // warm, low-sun light
  env.fill.intensity = 0.35;                               // dust bounces light into shadows
  env.fill.diffuse = horizon;
  env.fill.groundColor = new BABYLON.Color3(0.30, 0.18, 0.12);
  env.shadows.setDarkness(0.45);

  // ---- Dust haze matching the horizon ----
  scene.clearColor = new BABYLON.Color4(horizon.r, horizon.g, horizon.b, 1);
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogColor = horizon;
  scene.fogDensity = 0.0008;

  addMountainSilhouettes(scene, horizon);
};
  
const setupWorld = async (scene: BABYLON.Scene, moon: MoonEnvironment) => {
  try {
    const file = PLANET === "mars" ? "/mars_terrain.glb" : "/moon_terrain.glb";
    const result = await BABYLON.ImportMeshAsync(file, scene);
    const terrain = result.meshes.find((m) => m.getTotalVertices() > 0)!;
    // NOTE: no createNormals here - the .glb already has correct normals

    // Regolith material from moonEnvironment, tiled for 3 km
    const groundMat = moon.ground.material as BABYLON.StandardMaterial;
    const regolith = groundMat.diffuseTexture as BABYLON.Texture;
    regolith.uScale = 1000;   // ~3 m per tile
    regolith.vScale = 1000;
    terrain.material = groundMat;
    terrain.receiveShadows = true;
    terrain.isPickable = false;

    // Procedural extras off on both planets
    moon.skybox.setEnabled(false);
    moon.earth?.setEnabled(false);
    moon.ground.setEnabled(false);

    if (PLANET === "moon") {
      // Low polar sun, almost no ambient (vacuum), real NASA star map
      moon.sun.direction = new BABYLON.Vector3(-0.8, -0.15, 0.58).normalize();
      moon.sun.intensity = 2.7;
      moon.fill.intensity = 0.14;
      const stars = new BABYLON.PhotoDome("realStars", "/starmap_4k.jpg", { size: 10000 }, scene);
      stars.mesh.isPickable = false;
      stars.rotation.x = Math.PI;   // south celestial pole overhead
    } else {
      // Mars: butterscotch sky, dust haze, warm light, softer shadows
      const sky = new BABYLON.Color3(0.80, 0.62, 0.45);
      groundMat.diffuseColor = new BABYLON.Color3(0.80, 0.50, 0.33);
      moon.sun.direction = new BABYLON.Vector3(-0.5, -0.6, 0.6).normalize();
      moon.sun.intensity = 2.2;
      moon.sun.diffuse = new BABYLON.Color3(1.0, 0.92, 0.82);
      moon.fill.groundColor = new BABYLON.Color3(0.45, 0.3, 0.22);
      setupMarsAtmosphere(scene, moon);
    }

    // Both planets: place the sun along its direction (for shadows)
    moon.sun.position = moon.sun.direction.scale(-100);

    await setupXR(scene, terrain);
  } catch (e) {
    console.warn("Terrain failed to load, using old ground:", e);
    await setupXR(scene, moon.ground);
  }
};
 
const addPlanetSwitch = () => {
  const bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:10";
  (["moon", "mars"] as const).forEach((p) => {
    const b = document.createElement("button");
    b.textContent = p === "moon" ? "🌘 Moon" : "🔴 Mars";
    const active = p === PLANET;
    b.style.cssText = `padding:8px 16px;border-radius:6px;border:1px solid #c9a227;cursor:pointer;
      background:${active ? "#c9a227" : "#222"};color:${active ? "#000" : "#fff"}`;
    b.onclick = () => { window.location.search = `?planet=${p}`; };
    bar.appendChild(b);
  });
  document.body.appendChild(bar);
};

  const createScene = () => {
  const scene = new BABYLON.Scene(engine);
  const camera = new BABYLON.ArcRotateCamera("camera", Math.PI / 2, 1.2, 1.2,
  new BABYLON.Vector3(0, 0.2, 0), scene);
camera.attachControl(canvas, true);

camera.lowerRadiusLimit = 0.3;
camera.upperRadiusLimit = 120;
camera.upperBetaLimit = Math.PI / 2.05;    // stops you flying under the surface
camera.minZ = 0.01;                        // no clipping when close
camera.wheelDeltaPercentage = 0.02;        // smooth zoom at small scale
  const moon: MoonEnvironment = createMoonEnvironment(scene, {
    groundSize: 120,
    subdivisions: 300,
  });
 
  const axes = new BABYLON.AxesViewer(scene, 1);
  const axesRoot = new BABYLON.TransformNode("axesRoot", scene);
  axes.xAxis.parent = axesRoot;
  axes.yAxis.parent = axesRoot;
  axes.zAxis.parent = axesRoot;
  axesRoot.position = new BABYLON.Vector3(-4, 0.05, -4);
 
  buildTensegrityStructure(scene, getStructure(DEFAULT_STRUCTURE));
  setupGUI(scene);
  setupDragInteraction(scene, camera);
  addPlanetSwitch();
  void setupWorld(scene, moon);
  return scene;
};
 
const scene = createScene();
const currentTopology = (): Topology => ({
  points: points.map((p) => p.position.clone()),
  struts: strutIndexPairs.map(([a, b]) => [a, b] as [number, number]),
  cables: cableIndexPairs.map(([a, b]) => [a, b] as [number, number]),
});
const originalTopology = currentTopology();
 
const subPanel = createSubstitutionPanel({
  onApply: (alpha, n) => {
    let topo = originalTopology;
    for (let k = 0; k < n; k++) topo = substituteAll(topo, alpha);
 
    const muBars = 2 ** -n + Math.tan(alpha) ** 2.5 * (1 - 2 ** -n);
    subPanel.setStats(
      `nodes  ${originalTopology.points.length} → ${topo.points.length}\n` +
      `struts ${originalTopology.struts.length} → ${topo.struts.length}\n` +
      `cables ${originalTopology.cables.length} → ${topo.cables.length}\n` +
      `μ predicted (bars) = ${muBars.toFixed(3)}`
    );
    // later: buildFromTopology(topo);
  },
  onReset: () => subPanel.setStats(""),
});
 
// the mass/buckling panel is expensive-ish, so refresh it a few times a second
// rather than every frame - but it DOES need to refresh, otherwise the
// "BUCKLES" status stays frozen at whatever it was when the GUI was built
let frameCount = 0;
const MASS_READOUT_INTERVAL = 15;
 
engine.runRenderLoop(() => {
  // NEW (FDM): physics only runs in dynamics mode; FDM mode is static form-finding
  if (grabMode === "dynamics") {
    stepPhysics(FIXED_DT);
  }
  computeForces();
  updateMeshes();
  updateMemberColors();
  updateForceArrows();
  updateNodeArrows();
  updateReadout();
 
  if (++frameCount % MASS_READOUT_INTERVAL === 0) updateMassReadout();
 
  scene.render();
});
 
window.addEventListener("resize", () => {
  engine.resize();
});
 




