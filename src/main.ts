import * as BABYLON from "babylonjs";
import "./style.css";
import { MATERIALS, barMass, bucklingForce, SECTION_FIELDS, type Materials, type CrossSection, getMaterialById, sizeCable } from "./materials";
import { getStructure, listStructures, type StructureDef } from "./strcture";
import { createMoonEnvironment, type MoonEnvironment } from "./moonEnvironment";
import { createSubstitutionPanel } from "./substitutionPanel";
import { substituteAll, type Topology } from "./substitution";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = new BABYLON.Engine(canvas, true);


// ============================================================
// MODEL ASSUMPTIONS (display-force estimate; see report)
// ============================================================
const G = 9.81;                 // m/s^2  (Earth; use 1.62 for Moon)
const MASS_PER_NODE = 0.05;      // kg
const K_CABLE = 500;            // N/m  cable stiffness (for deformation force)
const K_STRUT = 5000;           // N/m  strut stiffness
const PRESTRESS_CABLE = 50;     // N  baseline tension every cable carries at rest
const PRESTRESS_STRUT = -80;    // N  baseline compression every strut carries at rest

const DEFAULT_STRUCTURE = "prism3";

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

const DAMPING = 0.98;
const SUBSTEPS = 6;
const FIXED_DT = 1 / 60;
const FLOOR_Y = 0.1;
const RESTITUTION = 0.15;
const FRICTION = 0.6;
const MAX_STEP = 0.5;   // safety clamp: no point may move more than this per frame

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
    if (i === selectedPointIndex) return;
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
    if (c.a !== selectedPointIndex) pA.position.addInPlace(correction);
    if (c.b !== selectedPointIndex) pB.position.subtractInPlace(correction);
  });

  points.forEach((p, i) => {
    if (i === selectedPointIndex) return;
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
// force = baseline prestress + stiffness * deformation from installed length
const computeForces = () => {
  constraints.forEach((c) => {
    const L = BABYLON.Vector3.Distance(points[c.a].position, points[c.b].position);
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
  dragPlane = null;
};

const buildTensegrityStructure = (scene: BABYLON.Scene, def: StructureDef) => {
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
      `${def.id}_strut${i}`, { height: strutRestLengths[i], diameter: 0.15 }, scene);
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
    const h = BABYLON.MeshBuilder.CreateSphere(`${def.id}_handle${i}`, { diameter: 0.3 }, scene);
    h.material = mats.handle;
    h.position = p.position.clone();
    return h;
  });

  forceArrows = [];
  constraints.forEach((c, ci) => {
    (["a", "b"] as const).forEach((end) => {
      const arrow = BABYLON.MeshBuilder.CreateCylinder(`${def.id}_arrow${ci}${end}`,
        { height: 1, diameterTop: 0, diameterBottom: 0.07 }, scene);
      arrow.material = c.rigid ? mats.comp : mats.tension;
      arrow.isVisible = false;
      forceArrows.push({ mesh: arrow, constraintIndex: ci, end });
    });
  });

  nodeArrows = points.map((_, i) => {
    const arrow = BABYLON.MeshBuilder.CreateCylinder(`${def.id}_node${i}`,
      { height: 1, diameterTop: 0, diameterBottom: 0.11 }, scene);
    arrow.material = mats.node;
    arrow.isVisible = false;
    return arrow;
  });
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

const setupDragInteraction = (scene: BABYLON.Scene, camera: BABYLON.ArcRotateCamera) => {
  scene.onPointerObservable.add((pointerInfo) => {
    switch (pointerInfo.type) {
      case BABYLON.PointerEventTypes.POINTERDOWN: {
        const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => pointHandles.includes(m as BABYLON.Mesh));
        if (pick?.hit && pick.pickedMesh) {
          const index = pointHandles.indexOf(pick.pickedMesh as BABYLON.Mesh);
          if (index !== -1) {
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
            const newPos = ray.origin.add(ray.direction.scale(distance));
            points[selectedPointIndex].position.copyFrom(newPos);
            points[selectedPointIndex].prevPosition.copyFrom(newPos);
          }
        }
        break;
      }
      case BABYLON.PointerEventTypes.POINTERUP: {
        selectedPointIndex = null;
        dragPlane = null;
        camera.attachControl(canvas, true);
        break;
      }
    }
  });
};

const createScene = () => {
  const scene = new BABYLON.Scene(engine);
  const camera = new BABYLON.ArcRotateCamera("camera", Math.PI / 2, Math.PI / 3, 14,
    new BABYLON.Vector3(0, 2, 0), scene);
  camera.attachControl(canvas, true);

  camera.lowerRadiusLimit = 4;
  camera.upperRadiusLimit = 120;
  camera.upperBetaLimit = Math.PI / 2.05;    // stops you flying under the surface

  const moon: MoonEnvironment = createMoonEnvironment(scene, {
    groundSize: 120,
    subdivisions: 300,
  });
  void moon;   // kept so the environment isn't garbage-collected / flagged unused

  const axes = new BABYLON.AxesViewer(scene, 1);
  const axesRoot = new BABYLON.TransformNode("axesRoot", scene);
  axes.xAxis.parent = axesRoot;
  axes.yAxis.parent = axesRoot;
  axes.zAxis.parent = axesRoot;
  axesRoot.position = new BABYLON.Vector3(-4, 0.05, -4);

  buildTensegrityStructure(scene, getStructure(DEFAULT_STRUCTURE));
  setupGUI(scene);
  setupDragInteraction(scene, camera);
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
  integrate(FIXED_DT);
  const passes = selectedPointIndex !== null ? 3 : SUBSTEPS;
  for (let i = 0; i < passes; i++) {
    solveConstraints();
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