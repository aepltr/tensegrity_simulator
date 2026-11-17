
import * as BABYLON from "babylonjs";
import "babylonjs-loaders";
import "./style.css";
import { MATERIALS, barMass, bucklingForce, SECTION_FIELDS, type Materials, type CrossSection, getMaterialById, sizeCable } from "./materials";
import { getStructure, listStructures, type StructureDef } from "./strcture";
import { createMoonEnvironment, type MoonEnvironment } from "./moonEnvironment";
import { createSubstitutionPanel } from "./substitutionPanel";
import { substituteAll, type Topology } from "./substitution";
import { FDMGrab, selfStress, type FDMember, type MemberPair, type Vec3 } from "./fdm"; // NEW (FDM)
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
const K_CABLE = 500;            // N/m  cable stiffness (for deformation force)
const K_STRUT = 5000;           // N/m  strut stiffness
const PRESTRESS_CABLE = 50;     // N  baseline tension every cable carries at rest
const PRESTRESS_STRUT = -80;    // N  baseline compression every strut carries at rest
 
const DEFAULT_STRUCTURE = "prism3";
let currentStructureId = DEFAULT_STRUCTURE;

// ---------- Physics state ----------
interface PhysicsPoint {
  position: BABYLON.Vector3;
  prevPosition: BABYLON.Vector3;
}
interface Constraint {
  a: number;
  b: number;
  restLength: number;     // installed length (NO prestress offset - this is the honest fix)
  stiffness: number;      // N/m, for the deformation part of the force
  prestress: number;      // N, baseline force at rest (+tension / -compression)
  rigid: boolean;         // true = strut, false = cable
  force: number;          // current display force in N, updated each frame
}
 
let points: PhysicsPoint[] = [];
let constraints: Constraint[] = [];
let strutMeshes: BABYLON.Mesh[] = [];
let strutRestLengths: number[] = [];   // cylinder heights at build time, for scaling
let strutIndexPairs: [number, number][] = [];
let cableLines: BABYLON.LinesMesh[] = [];
let cableIndexPairs: [number, number][] = [];
let pointHandles: BABYLON.Mesh[] = [];
 
interface ForceArrow {
  mesh: BABYLON.Mesh;
  constraintIndex: number;
  end: "a" | "b";
}
let forceArrows: ForceArrow[] = [];
let nodeArrows: BABYLON.Mesh[] = [];
 
const MEMBER_ARROW_SCALE = 0.006;  // metres of arrow per newton
const NODE_ARROW_SCALE = 0.02;
const MIN_ARROW_LEN = 0.2;
const MAX_ARROW_LEN = 1.5;
 
let selectedPointIndex: number | null = null;
let dragPlane: BABYLON.Plane | null = null;
 
const xrHeld = new Set<number>();   // nodes currently held by VR hands
const isHeld = (i: number) => i === selectedPointIndex || xrHeld.has(i);

const DAMPING = 0.98;
const SUBSTEPS = 6;
const FIXED_DT = 1 / 60;
const FLOOR_Y = 0.1;
const RESTITUTION = 0.15;
const FRICTION = 0.6;
const MAX_STEP = 0.5;   // safety clamp: no point may move more than this per frame
 
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
let fdmStatusEl: HTMLDivElement | null = null;
 
const ANCHOR_TOL = 1e-3;            // nodes within this of the lowest y are anchors (ground)
 
const toVec3 = (v: BABYLON.Vector3): Vec3 => [v.x, v.y, v.z];
 
const updateFdmStatus = () => {
  if (fdmStatusEl) fdmStatusEl.textContent = fdmStatus;
};
 
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
 
  const ss = selfStress(nodes, pairs);
  if (!ss.exists) {
    fdmStatus = "FDM off: no self-stress at this geometry";
    updateFdmStatus();
    return;
  }
  if (!ss.feasible) {
    fdmStatus = "FDM off: self-stress puts a cable in compression";
    updateFdmStatus();
    return;
  }
 
  // q from A q = 0 has no units (any multiple works). Pick the scale so the
  // mean cable tension t = q·L equals PRESTRESS_CABLE.
  let tensionSum = 0;
  let cableCount = 0;
  pairs.forEach((m, k) => {
    if (m.type !== "string") return;
    const L = BABYLON.Vector3.Distance(points[m.a].position, points[m.b].position);
    tensionSum += ss.q[k] * L;
    cableCount++;
  });
  const scale = PRESTRESS_CABLE / (tensionSum / cableCount);
  fdmQ = ss.q.map((q) => q * scale);
 
  const members: FDMember[] = pairs.map((m, k) => ({ ...m, q: fdmQ[k] }));
  const minY = Math.min(...nodes.map((n) => n[1]));
  const anchors = nodes.map((_, i) => i).filter((i) => nodes[i][1] - minY < ANCHOR_TOL);
 
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
 
// ---------- Physics: geometry only (installed rest lengths, no prestress driving it) ----------
const integrate = (dt: number) => {
  const gVec = new BABYLON.Vector3(0, -G * dt * dt, 0);
  points.forEach((p, i) => {
    if (isHeld(i)) return;
    const velocity = p.position.subtract(p.prevPosition).scale(DAMPING);
    const newPos = p.position.add(velocity).add(gVec);
    // safety clamp to prevent runaway explosion
    const step = newPos.subtract(p.position);
    if (step.length() > MAX_STEP) {
      newPos.copyFrom(p.position.add(step.normalize().scale(MAX_STEP)));
    }
    p.prevPosition.copyFrom(p.position);
    p.position.copyFrom(newPos);
  });
};
 
const solveConstraints = () => {
  constraints.forEach((c) => {
    const pA = points[c.a];
    const pB = points[c.b];
    const delta = pB.position.subtract(pA.position);
    const dist = delta.length();
    if (dist < 0.0001) return;
    const diff = dist - c.restLength;
    if (!c.rigid && diff <= 0) return; // cables can't push
    const correction = delta.scale((diff / dist) * 0.5);
    if (!isHeld(c.a)) pA.position.addInPlace(correction);
    if (!isHeld(c.b)) pB.position.subtractInPlace(correction);
  });
 
  points.forEach((p, i) => {
    if (isHeld(i)) return;
    if (p.position.y < FLOOR_Y) {
      const vx = p.position.x - p.prevPosition.x;
      const vy = p.position.y - p.prevPosition.y;
      const vz = p.position.z - p.prevPosition.z;
      p.position.y = FLOOR_Y;
      p.prevPosition.y = p.position.y + vy * RESTITUTION;
      p.prevPosition.x = p.position.x - vx * FRICTION;
      p.prevPosition.z = p.position.z - vz * FRICTION;
    }
  });
};
 
// ---------- Forces: DISPLAY ONLY, computed from geometry (never fed back into motion) ----------
// dynamics mode: force = baseline prestress + stiffness * deformation from installed length
// FDM mode (NEW): force = q · L, the member force that is exactly in equilibrium
const computeForces = () => {
  const useFdm = grabMode === "fdm" && fdm !== null && fdmQ.length === constraints.length;
  constraints.forEach((c, i) => {
    const L = BABYLON.Vector3.Distance(points[c.a].position, points[c.b].position);
    if (useFdm) {
      c.force = fdmQ[i] * L;
      return;
    }
    const deformation = L - c.restLength;
    c.force = c.prestress + c.stiffness * deformation;
    // cables physically cannot go into compression - floor the displayed force at 0
    if (!c.rigid && c.force < 0) c.force = 0;
  });
};
 
const orientArrow = (mesh: BABYLON.Mesh, origin: BABYLON.Vector3, direction: BABYLON.Vector3, length: number) => {
  mesh.isVisible = true;
  mesh.position = origin.add(direction.scale(length / 2));
  const up = BABYLON.Vector3.Up();
  const axis = BABYLON.Vector3.Cross(up, direction);
  const angle = Math.acos(BABYLON.Scalar.Clamp(BABYLON.Vector3.Dot(up, direction), -1, 1));
  if (axis.length() > 0.0001) {
    mesh.rotationQuaternion = BABYLON.Quaternion.RotationAxis(axis.normalize(), angle);
  } else {
    mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
  }
  mesh.scaling.y = length;
};
 
const updateMeshes = () => {
  strutIndexPairs.forEach(([ia, ib], i) => {
    const a = points[ia].position;
    const b = points[ib].position;
    const mesh = strutMeshes[i];
    mesh.position = a.add(b).scale(0.5);
    const delta = b.subtract(a);
    const dist = delta.length();
    if (dist < 0.0001) return;
    const direction = delta.scale(1 / dist);
    // struts were built at their installed length; scale so the mesh tracks the
    // actual current length instead of staying frozen at the build-time height
    mesh.scaling.y = dist / strutRestLengths[i];
    const up = BABYLON.Vector3.Up();
    const axis = BABYLON.Vector3.Cross(up, direction);
    const angle = Math.acos(BABYLON.Scalar.Clamp(BABYLON.Vector3.Dot(up, direction), -1, 1));
    if (axis.length() > 0.0001) {
      mesh.rotationQuaternion = BABYLON.Quaternion.RotationAxis(axis.normalize(), angle);
    }
  });
  cableIndexPairs.forEach(([ia, ib], i) => {
    const a = points[ia].position;
    const b = points[ib].position;
    cableLines[i] = BABYLON.MeshBuilder.CreateLines("cable", {
      points: [a, b],
      instance: cableLines[i],
    }) as BABYLON.LinesMesh;
  });
  points.forEach((p, i) => {
    pointHandles[i].position.copyFrom(p.position);
  });
};
 
const updateForceArrows = () => {
  forceArrows.forEach(({ mesh, constraintIndex, end }) => {
    const c = constraints[constraintIndex];
    const pA = points[c.a].position;
    const pB = points[c.b].position;
    const delta = pB.subtract(pA);
    const dist = delta.length();
    if (dist < 0.0001) { mesh.isVisible = false; return; }
    const unit = delta.scale(1 / dist);
 
    const magnitude = Math.abs(c.force);
    const length = Math.min(MIN_ARROW_LEN + magnitude * MEMBER_ARROW_SCALE, MAX_ARROW_LEN);
 
    const tension = c.force > 0;
    let origin: BABYLON.Vector3;
    let direction: BABYLON.Vector3;
    if (end === "a") {
      origin = pA;
      direction = tension ? unit : unit.scale(-1);
    } else {
      origin = pB;
      direction = tension ? unit.scale(-1) : unit;
    }
    orientArrow(mesh, origin, direction, length);
  });
};
 
const updateNodeArrows = () => {
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
    const mesh = nodeArrows[i];
    if (mag < 0.0001) { mesh.isVisible = false; return; }
    const dir = net.scale(1 / mag);
    const length = Math.min(MIN_ARROW_LEN + mag * NODE_ARROW_SCALE, MAX_ARROW_LEN);
    orientArrow(mesh, p.position, dir, length);
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
    `K_cable=${K_CABLE} N/m  K_strut=${K_STRUT} N/m\n` +
    `prestress: cable +${PRESTRESS_CABLE} N, strut ${PRESTRESS_STRUT} N\n` +
    `forces: ${grabMode === "fdm" && fdm ? "FDM, t = q·L" : "dynamics estimate"}\n` +   // NEW (FDM)
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
 
  sharedMats = { strut, handle, tension, comp, node };
  return sharedMats;
};
 
const clearCurrentStructure = () => {
  strutMeshes.forEach((m) => m.dispose());
  cableLines.forEach((l) => l.dispose());
  pointHandles.forEach((h) => h.dispose());
  forceArrows.forEach((a) => a.mesh.dispose());
  nodeArrows.forEach((a) => a.dispose());
 
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
 
  // NOTE: restLength = installed length (NOT offset). Prestress is a force baseline for
  // DISPLAY, stored separately - it does not distort the geometry the solver targets.
  constraints = [
    ...strutIndexPairs.map(([a, b]) => {
      const installed = BABYLON.Vector3.Distance(points[a].position, points[b].position);
      return { a, b, rigid: true, stiffness: K_STRUT, restLength: installed, prestress: PRESTRESS_STRUT, force: 0 };
    }),
    ...cableIndexPairs.map(([a, b]) => {
      const installed = BABYLON.Vector3.Distance(points[a].position, points[b].position);
      return { a, b, rigid: false, stiffness: K_CABLE, restLength: installed, prestress: PRESTRESS_CABLE, force: 0 };
    }),
  ];
 
  strutRestLengths = strutIndexPairs.map(([a, b]) =>
    BABYLON.Vector3.Distance(points[a].position, points[b].position)
  );
 
  strutMeshes = strutIndexPairs.map((_pair, i) => {
    const mesh = BABYLON.MeshBuilder.CreateCylinder(
      `${def.id}_strut${i}`, { height: strutRestLengths[i], diameter: 0.015 }, scene);
    mesh.material = mats.strut;
    return mesh;
  });
 
  cableLines = cableIndexPairs.map(([a, b], i) =>
    BABYLON.MeshBuilder.CreateLines(`${def.id}_cable${i}`, {
      points: [points[a].position, points[b].position], updatable: true,
    }, scene)
  );
  cableLines.forEach((l) => (l.color = new BABYLON.Color3(0.9, 0.9, 0.9)));
 
  pointHandles = points.map((p, i) => {
    const h = BABYLON.MeshBuilder.CreateSphere(`${def.id}_handle${i}`, { diameter: 0.05 }, scene);
    h.material = mats.handle;
    h.position = p.position.clone();
    return h;
  });
 
  forceArrows = [];
  constraints.forEach((c, ci) => {
    (["a", "b"] as const).forEach((end) => {
      const arrow = BABYLON.MeshBuilder.CreateCylinder(`${def.id}_arrow${ci}${end}`,
        { height: 0.5, diameterTop: 0, diameterBottom: 0.007 }, scene);
      arrow.material = c.rigid ? mats.comp : mats.tension;
      arrow.isVisible = false;
      forceArrows.push({ mesh: arrow, constraintIndex: ci, end });
    });
  });
 
  nodeArrows = points.map((_, i) => {
    const arrow = BABYLON.MeshBuilder.CreateCylinder(`${def.id}_node${i}`,
      { height: 0.5, diameterTop: 0, diameterBottom: 0.011 }, scene);
    arrow.material = mats.node;
    arrow.isVisible = false;
    return arrow;
  });
 
  setupFDM();   // NEW (FDM): self-stress + anchors for this structure
};
 
// ============================================================
// GUI
// ============================================================
const setupGUI = (scene: BABYLON.Scene) => {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;top:12px;left:12px;padding:12px 14px;" +
    "background:rgba(20,20,35,0.82);color:white;font-family:sans-serif;" +
    "font-size:13px;line-height:1.5;border-radius:8px;" +
    "white-space:pre;z-index:10;";
  const legend =
    `<div style="display:flex;align-items:center;margin-bottom:4px;">` +
    `<span style="width:16px;height:16px;background:#3366ff;display:inline-block;margin-right:8px;border-radius:3px;"></span>Tension (cables)</div>` +
    `<div style="display:flex;align-items:center;margin-bottom:4px;">` +
    `<span style="width:16px;height:16px;background:#ff3333;display:inline-block;margin-right:8px;border-radius:3px;"></span>Compression (struts)</div>` +
    `<div style="display:flex;align-items:center;margin-bottom:8px;">` +
    `<span style="width:16px;height:16px;background:#33ff66;display:inline-block;margin-right:8px;border-radius:3px;"></span>Net force at node</div>`;
  const readout = document.createElement("div");
  overlay.innerHTML = legend;
  overlay.appendChild(readout);
 
  // --- Structure menu ---
  const structTitle = document.createElement("div");
  structTitle.textContent = "Structure";
  structTitle.style.cssText = "margin-top:10px;margin-bottom:6px;font-weight:600;";
  overlay.appendChild(structTitle);
 
  const structRow = document.createElement("div");
  structRow.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-bottom:8px;";
  listStructures().forEach(({ id, name }) => {
    const btn = document.createElement("button");
    btn.textContent = name;
    btn.style.cssText =
      "text-align:left;padding:5px 8px;font-size:12px;border-radius:5px;cursor:pointer;" +
      "border:1px solid #444;background:#2a2f38;color:#e8e6e0;";
    if (id === DEFAULT_STRUCTURE) btn.style.background = "#3a6ea5";
    btn.addEventListener("click", () => {
      buildTensegrityStructure(scene, getStructure(id));
      Array.from(structRow.children).forEach((c) =>
        ((c as HTMLElement).style.background = "#2a2f38"));
      btn.style.background = "#3a6ea5";
      updateMassReadout();
    });
    structRow.appendChild(btn);
  });
  overlay.appendChild(structRow);
 
  // --- Grab mode (NEW, FDM) ---
  const grabTitle = document.createElement("div");
  grabTitle.textContent = "Grab mode";
  grabTitle.style.cssText = "margin-top:10px;margin-bottom:6px;font-weight:600;";
  overlay.appendChild(grabTitle);
 
  const grabBtn = document.createElement("button");
  grabBtn.style.cssText =
    "text-align:left;padding:5px 8px;font-size:12px;border-radius:5px;cursor:pointer;" +
    "border:1px solid #444;background:#2a2f38;color:#e8e6e0;width:100%;";
  const renderGrabBtn = () => {
    grabBtn.textContent = grabMode === "fdm" ? "Force density (physics paused)" : "Dynamics";
    grabBtn.style.background = grabMode === "fdm" ? "#3a6ea5" : "#2a2f38";
  };
  grabBtn.addEventListener("click", () => {
    grabMode = grabMode === "fdm" ? "dynamics" : "fdm";
    // leaving FDM: zero the velocities so Verlet doesn't see a jump
    if (grabMode === "dynamics") points.forEach((p) => p.prevPosition.copyFrom(p.position));
    renderGrabBtn();
  });
  renderGrabBtn();
  overlay.appendChild(grabBtn);
 
  const fdmStatusDiv = document.createElement("div");
  fdmStatusDiv.style.cssText = "font-size:11px;color:#aab;margin-top:4px;margin-bottom:8px;";
  overlay.appendChild(fdmStatusDiv);
  fdmStatusEl = fdmStatusDiv;
  updateFdmStatus();
 
  // --- Material menu ---
  const matTitle = document.createElement("div");
  matTitle.textContent = "Material";
  matTitle.style.cssText = "margin-top:10px;margin-bottom:6px;font-weight:600;";
  overlay.appendChild(matTitle);
 
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-bottom:8px;";
  MATERIALS.forEach((m) => {
    const btn = document.createElement("button");
    btn.textContent = m.name;
    btn.style.cssText =
      "text-align:left;padding:5px 8px;font-size:12px;border-radius:5px;cursor:pointer;" +
      "border:1px solid #444;background:#2a2f38;color:#e8e6e0;";
    if (m.id === currentStrutMaterial.id) btn.style.background = "#c9a227";
    btn.addEventListener("click", () => {
      currentStrutMaterial = m;
      // highlight the active button
      Array.from(btnRow.children).forEach((c) =>
        ((c as HTMLElement).style.background = "#2a2f38"));
      btn.style.background = "#c9a227";
      updateMassReadout();
    });
    btnRow.appendChild(btn);
  });
  overlay.appendChild(btnRow);
 
  // --- Cross-section menu ---
  // All of this is LOCAL to setupGUI: the elements are created here, so the
  // closures below always have real elements to talk to. Nothing is looked up
  // with getElementById, which is what blanked the page before.
  const shapeTitle = document.createElement("div");
  shapeTitle.textContent = "Cross-section";
  shapeTitle.style.cssText = "margin-top:10px;margin-bottom:6px;font-weight:600;";
  overlay.appendChild(shapeTitle);
 
  const shapeSelect = document.createElement("select");
  shapeSelect.style.cssText =
    "width:100%;padding:5px 8px;font-size:12px;border-radius:5px;" +
    "border:1px solid #444;background:#2a2f38;color:#e8e6e0;margin-bottom:6px;";
  for (const kind of Object.keys(SECTION_FIELDS)) {
    const opt = document.createElement("option");
    opt.value = kind;
    opt.textContent = kind;
    shapeSelect.appendChild(opt);
  }
  // start the dropdown on whatever currentStrutSection already is
  shapeSelect.value = currentStrutSection.kind;
  overlay.appendChild(shapeSelect);
 
  const shapeFields = document.createElement("div");
  shapeFields.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-bottom:8px;";
  overlay.appendChild(shapeFields);
 
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
      label.style.cssText =
        "font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;";
 
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.001";
      input.min = "0.0001";
      input.value = String(f.default);
      input.dataset.key = f.key;     // remembers which CrossSection field this is
      input.style.cssText =
        "width:80px;padding:2px 4px;font-size:12px;border-radius:4px;" +
        "border:1px solid #444;background:#2a2f38;color:#e8e6e0;";
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
  massReadout.style.cssText = "font-family:monospace;font-size:13px;color:#c9a227;";
  overlay.appendChild(massReadout);
  massReadoutEl = massReadout;
 
  document.body.appendChild(overlay);
  readoutEl = readout;
  updateMassReadout();
};
 
const updateMassReadout = () => {
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
 
// Moves the grabbed node to newPos (mouse or VR hand)
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
    points[index].position.copyFrom(newPos);
    points[index].prevPosition.copyFrom(newPos);
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
    const d = BABYLON.Vector3.Distance(points[i].position, pos);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
};

// ============================================================
// VR PANEL: connects the 3D panel (vrPanel.ts) to the simulator state
// ============================================================
const makeVRPanelAPI = (scene: BABYLON.Scene, exitVR: () => void): VRPanelAPI => ({  structures: listStructures(),
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
      fdmStatus,
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
  h += m.height * Math.exp(-((d / m.width) ** 2)) * (0.55 + 0.45 * rough);      });
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
    integrate(FIXED_DT);
    const passes = selectedPointIndex !== null || xrHeld.size > 0 ? 3 : SUBSTEPS;
    for (let i = 0; i < passes; i++) {
      solveConstraints();
    }
  }
  computeForces();
  updateMeshes();
  updateForceArrows();
  updateNodeArrows();
  updateReadout();
 
  if (++frameCount % MASS_READOUT_INTERVAL === 0) updateMassReadout();
 
  scene.render();
});
 
window.addEventListener("resize", () => {
  engine.resize();
});
 




