// ============================================================
// VR PANEL: the web GUI, rebuilt as a 3D panel you can use in the headset.
// Pinch (or trigger) with the hand ray to click. Fixed in place, like a control console.
// ============================================================
import * as BABYLON from "babylonjs";
import * as GUI from "babylonjs-gui";

// ---- what the panel needs from main.ts ----
export interface SectionField { key: string; label: string; value: number }

export interface VRState {
  structureId: string;
  materialId: string;
  grabMode: "dynamics" | "fdm";
  fdmStatus: string;
  planet: "moon" | "mars";
  g: number;
  sectionKind: string;
  sectionFields: SectionField[];
  cableMax: number;        // N
  strutMax: number;        // N (magnitude)
  bucklingLimit: number;   // N
  massStruts: number;      // kg
  massCables: number;
  massNodes: number;
}

export interface VRPanelAPI {
  structures: { id: string; name: string }[];
  materials: { id: string; name: string }[];
  sectionKinds: string[];
  getState: () => VRState;
  setStructure: (id: string) => void;
  setMaterial: (id: string) => void;
  toggleGrabMode: () => void;
  setSectionKind: (kind: string) => void;
  scaleSectionField: (key: string, factor: number) => void;
  setPlanet: (p: "moon" | "mars") => void;
  exitVR: () => void;
}

// ---- look ----
const C = {
  bg: "#141823F2",
  card: "#1F2533",
  line: "#2E3647",
  text: "#E8E6E0",
  dim: "#8A93A6",
  blue: "#3A6EA5",
  gold: "#C9A227",
  tension: "#3366FF",
  compression: "#FF3333",
  node: "#33FF66",
  ok: "#2E9E5B",
  bad: "#D9433B",
};
// "hollowCircle" -> "Hollow circle"
const pretty = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/\s+/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

const FONT = "Segoe UI, Helvetica, Arial, sans-serif";

const PANEL_W = 0.5;            // metres
const PANEL_H = 0.7;
const TEX_W = 1000;             // pixels
const TEX_H = 1400;

type Tab = "live" | "structure" | "material" | "section";

// ---- small builders ----
const text = (t: string, size: number, color = C.text, bold = false) => {
  const tb = new GUI.TextBlock();
  tb.text = t;
  tb.fontSize = size;
  tb.fontFamily = FONT;
  tb.color = color;
  tb.fontWeight = bold ? "bold" : "normal";
  tb.textHorizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
  tb.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
  tb.height = `${Math.round(size * 1.5)}px`;
  return tb;
};

const button = (label: string, active: boolean, onClick: () => void, activeColor = C.blue, h = 78) => {
  const b = GUI.Button.CreateSimpleButton(`b_${label}`, label);
  b.height = `${h}px`;
  b.cornerRadius = 16;
  b.thickness = 2;
  b.color = active ? activeColor : C.line;
  b.background = active ? activeColor : C.card;
  b.fontSize = 34;
  b.fontFamily = FONT;
  if (b.textBlock) b.textBlock.color = active ? (activeColor === C.gold ? "#111" : "white") : C.text;
  b.paddingBottom = "10px";
  const rest = b.background;
  b.onPointerEnterObservable.add(() => { if (!active) b.background = C.line; });
  b.onPointerOutObservable.add(() => { b.background = rest; });
  b.onPointerUpObservable.add(onClick);
  return b;
};

const card = () => {
  const r = new GUI.Rectangle();
  r.cornerRadius = 20;
  r.thickness = 0;
  r.background = C.card;
  r.adaptHeightToChildren = true;
  r.paddingBottom = "16px";
  const s = new GUI.StackPanel();
  s.width = "90%";
  s.paddingTop = "18px";
  s.paddingBottom = "18px";
  r.addControl(s);
  return { r, s };
};

// horizontal bar: segments [fraction, colour]
const bar = (segments: [number, string][], h = 34) => {
  const outer = new GUI.Rectangle();
  outer.height = `${h}px`;
  outer.cornerRadius = h / 2;
  outer.thickness = 0;
  outer.background = C.line;
  outer.paddingTop = "4px";
  let x = 0;
  for (const [f, col] of segments) {
    const seg = new GUI.Rectangle();
    seg.thickness = 0;
    seg.background = col;
    seg.width = Math.max(0, Math.min(1, f));
    seg.left = `${x * 100}%`;
    seg.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    outer.addControl(seg);
    x += f;
  }
  return outer;
};

const row = (left: GUI.Control, right: GUI.Control, h = 56) => {
  const g = new GUI.Grid();
  g.height = `${h}px`;
  g.addColumnDefinition(0.6);
  g.addColumnDefinition(0.4);
  right.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
  if (right instanceof GUI.TextBlock) right.textHorizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
  g.addControl(left, 0, 0);
  g.addControl(right, 0, 1);
  return g;
};

// ============================================================
export function createVRPanel(scene: BABYLON.Scene, api: VRPanelAPI) {
  // --- the console: screen + back plate (tilted) and a stand (vertical) ---
  const root = new BABYLON.TransformNode("vrPanelRoot", scene);

  const plane = BABYLON.MeshBuilder.CreatePlane("vrPanel", { width: PANEL_W, height: PANEL_H }, scene);
  plane.parent = root;

  const metal = new BABYLON.StandardMaterial("consoleMetal", scene);
  metal.diffuseColor = BABYLON.Color3.FromHexString("#3A4150");
  metal.specularColor = new BABYLON.Color3(0.5, 0.5, 0.55);
  metal.specularPower = 48;
  metal.emissiveColor = BABYLON.Color3.FromHexString("#0E1118");

  // back plate: slightly bigger than the screen, just behind it (+Z = behind)
  const back = BABYLON.MeshBuilder.CreateBox("consoleBack",
    { width: PANEL_W + 0.03, height: PANEL_H + 0.03, depth: 0.025 }, scene);
  back.parent = root;
  back.position.z = 0.014;
  back.material = metal;
  back.isPickable = false;

  // stand: post + round foot, NOT parented to root so it stays vertical
  const stand = new BABYLON.TransformNode("consoleStand", scene);
  const post = BABYLON.MeshBuilder.CreateCylinder("consolePost", { diameter: 0.045, height: 1 }, scene);
  post.parent = stand;
  post.material = metal;
  post.isPickable = false;
  const foot = BABYLON.MeshBuilder.CreateCylinder("consoleFoot", { diameter: 0.32, height: 0.02 }, scene);
  foot.parent = stand;
  foot.material = metal;
  foot.isPickable = false;

  const adt = GUI.AdvancedDynamicTexture.CreateForMesh(plane, TEX_W, TEX_H, true);

  const frame = new GUI.Rectangle();
  frame.cornerRadius = 36;
  frame.thickness = 3;
  frame.color = C.line;
  frame.background = C.bg;
  adt.addControl(frame);

  const main = new GUI.StackPanel();
  main.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP;
  main.width = `${TEX_W - 80}px`;
  main.paddingTop = "30px";
  frame.addControl(main);

  // --- header ---
  const header = new GUI.Grid();
  header.height = "90px";
  header.addColumnDefinition(0.6);
  header.addColumnDefinition(0.4);
  header.addControl(text("Tensegrity Lab", 56, C.text, true), 0, 0);
  // exit button, top right: red, always visible on every tab
  const exit = GUI.Button.CreateSimpleButton("exitVR", "✕  Exit VR");
  exit.width = "300px";
  exit.height = "78px";
  exit.cornerRadius = 39;
  exit.thickness = 0;
  exit.background = C.bad;
  exit.color = "white";
  exit.fontSize = 34;
  exit.fontFamily = FONT;
  exit.fontWeight = "bold";
  exit.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
  exit.onPointerEnterObservable.add(() => (exit.background = "#F05A50"));
  exit.onPointerOutObservable.add(() => (exit.background = C.bad));
  exit.onPointerUpObservable.add(() => api.exitVR());
  header.addControl(exit, 0, 1);
  main.addControl(header);

  // --- tabs ---
  let tab: Tab = "live";
  const tabRow = new GUI.Grid();
  tabRow.height = "96px";
  const tabs: [Tab, string][] = [["live", "Live"], ["structure", "Structure"], ["material", "Material"], ["section", "Section"]];
  tabs.forEach(() => tabRow.addColumnDefinition(1 / tabs.length));
  main.addControl(tabRow);

  const content = new GUI.StackPanel();
  content.paddingTop = "16px";
  main.addControl(content);

  // live text blocks (updated a few times per second)
  let live: {
    cable: GUI.TextBlock; strut: GUI.TextBlock; util: GUI.TextBlock; utilBar: GUI.Rectangle | null;
    utilHolder: GUI.StackPanel; status: GUI.TextBlock; statusBox: GUI.Rectangle;
    mass: GUI.TextBlock; massHolder: GUI.StackPanel; massLegend: GUI.TextBlock; fdm: GUI.TextBlock;
  } | null = null;

  const renderTabs = () => {
    tabRow.clearControls();
    tabs.forEach(([id, label], i) => {
      const b = button(label, tab === id, () => { tab = id; render(); }, C.blue, 80);
      b.paddingLeft = "6px";
      b.paddingRight = "6px";
      b.fontSize = 32;
      tabRow.addControl(b, 0, i);
    });
  };

  // ---------- tab: LIVE ----------
  const renderLive = () => {
    const s = api.getState();

    // forces
    const f = card();
    f.s.addControl(text(`Forces  ·  ${s.planet === "mars" ? "Mars" : "Moon"} g = ${s.g} m/s²`, 36, C.dim, true));
    const legend = new GUI.StackPanel();
    legend.isVertical = false;
    legend.height = "60px";
    ([["Tension", C.tension], ["Compression", C.compression], ["Net at node", C.node]] as const).forEach(([t, col]) => {
      const dot = new GUI.Ellipse();
      dot.width = "26px"; dot.height = "26px"; dot.thickness = 0; dot.background = col;
      legend.addControl(dot);
      const lt = text(`  ${t}     `, 28, C.text);
      lt.resizeToFit = true;
      legend.addControl(lt);
    });
    f.s.addControl(legend);
    const cable = text("", 40, C.tension, true);
    const strut = text("", 40, C.compression, true);
    f.s.addControl(row(text("Max cable tension", 32), cable));
    f.s.addControl(row(text("Max strut compression", 32), strut));
    content.addControl(f.r);

    // buckling
    const b = card();
    b.s.addControl(text("Buckling", 36, C.dim, true));
    const util = text("", 40, C.text, true);
    b.s.addControl(row(text("Utilisation", 32), util));
    const utilHolder = new GUI.StackPanel();
    b.s.addControl(utilHolder);
    const statusBox = new GUI.Rectangle();
    statusBox.height = "70px"; statusBox.cornerRadius = 35; statusBox.thickness = 0;
    statusBox.paddingTop = "12px";
    const status = text("", 34, "white", true);
    status.textHorizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    status.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    statusBox.addControl(status);
    b.s.addControl(statusBox);
    content.addControl(b.r);

    // mass
    const m = card();
    m.s.addControl(text("Mass", 36, C.dim, true));
    const mass = text("", 40, C.gold, true);
    m.s.addControl(row(text("Total", 32), mass));
    const massHolder = new GUI.StackPanel();
    m.s.addControl(massHolder);
    const massLegend = text("", 26, C.dim);
    m.s.addControl(massLegend);
    content.addControl(m.r);

    // grab mode
    const g = card();
    g.s.addControl(text("Grab mode", 36, C.dim, true));
    const seg = new GUI.Grid();
    seg.height = "90px";
    seg.addColumnDefinition(0.5);
    seg.addColumnDefinition(0.5);
    const isFdm = s.grabMode === "fdm";
    const dyn = button("Dynamics", !isFdm, () => { if (isFdm) { api.toggleGrabMode(); render(); } });
    const fdmB = button("Force density", isFdm, () => { if (!isFdm) { api.toggleGrabMode(); render(); } });
    dyn.paddingRight = "8px"; fdmB.paddingLeft = "8px";
    seg.addControl(dyn, 0, 0);
    seg.addControl(fdmB, 0, 1);
    g.s.addControl(seg);
    const fdm = text("", 26, C.dim);
    fdm.textWrapping = true;
    fdm.resizeToFit = false;
    fdm.height = "40px";
    g.s.addControl(fdm);
    content.addControl(g.r);

    live = { cable, strut, util, utilBar: null, utilHolder, status, statusBox, mass, massHolder, massLegend, fdm };
    updateLive();
  };

  const updateLive = () => {
    if (!live) return;
    const s = api.getState();
    live.cable.text = `${s.cableMax.toFixed(1)} N`;
    live.strut.text = `${s.strutMax.toFixed(1)} N`;

    const u = Number.isFinite(s.bucklingLimit) && s.bucklingLimit > 0 ? s.strutMax / s.bucklingLimit : 0;
    live.util.text = `${(100 * u).toFixed(0)} %`;
    const col = u < 0.6 ? C.ok : u < 1 ? C.gold : C.bad;
    live.utilHolder.clearControls();
    live.utilHolder.addControl(bar([[Math.min(u, 1), col]]));
    const ok = u < 1;
    live.statusBox.background = ok ? C.ok : C.bad;
    live.status.text = ok
      ? `OK · limit ${Number.isFinite(s.bucklingLimit) ? s.bucklingLimit.toFixed(0) : "n/a"} N`
      : "BUCKLES ⚠";

    const total = s.massStruts + s.massCables + s.massNodes;
    live.mass.text = `${total.toFixed(3)} kg`;
    live.massHolder.clearControls();
    if (total > 0) {
      live.massHolder.addControl(bar([
        [s.massStruts / total, C.compression],
        [s.massCables / total, C.tension],
        [s.massNodes / total, C.dim],
      ]));
    }
    live.massLegend.text =
      `struts ${s.massStruts.toFixed(3)}   cables ${s.massCables.toFixed(4)}   nodes ${s.massNodes.toFixed(3)} kg`;
    live.fdm.text = s.grabMode === "fdm" ? s.fdmStatus || "FDM ready: physics paused" : "Pinch a node with either hand";
  };

  // ---------- tab: STRUCTURE / MATERIAL ----------
  const renderList = (title: string, items: { id: string; name: string }[], current: string,
                      pick: (id: string) => void, color: string) => {
    const c = card();
    c.s.addControl(text(title, 36, C.dim, true));
    items.forEach((it) => c.s.addControl(button(it.name, it.id === current, () => { pick(it.id); render(); }, color, 90)));
    content.addControl(c.r);
  };

  // ---------- tab: SECTION ----------
  const renderSection = () => {
    const s = api.getState();
    const c = card();
    c.s.addControl(text("Strut cross-section", 36, C.dim, true));
    const grid = new GUI.Grid();
    const cols = 2;
    const rows = Math.ceil(api.sectionKinds.length / cols);
    grid.height = `${rows * 88}px`;
    for (let i = 0; i < cols; i++) grid.addColumnDefinition(1 / cols);
    for (let i = 0; i < rows; i++) grid.addRowDefinition(1 / rows);
    api.sectionKinds.forEach((k, i) => {
      const b = button(pretty(k), k === s.sectionKind, () => { api.setSectionKind(k); render(); }, C.blue, 84);
      b.paddingLeft = "6px"; b.paddingRight = "6px"; b.fontSize = 30;
      grid.addControl(b, Math.floor(i / cols), i % cols);
    });
    c.s.addControl(grid);
    content.addControl(c.r);

    const d = card();
    d.s.addControl(text("Dimensions", 36, C.dim, true));
    s.sectionFields.forEach((f) => {
      d.s.addControl(text(pretty(f.label.replace(" (m)", "")), 30, C.text));
      const g = new GUI.Grid();
      g.height = "96px";
      g.addColumnDefinition(0.22);
      g.addColumnDefinition(0.56);
      g.addColumnDefinition(0.22);
      const value = text(`${(f.value * 1000).toFixed(1)} mm`, 44, C.gold, true);
      value.textHorizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
      value.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
      g.addControl(button("−", false, () => { api.scaleSectionField(f.key, 1 / 1.1); render(); }, C.blue, 86), 0, 0);
      g.addControl(value, 0, 1);
      g.addControl(button("+", false, () => { api.scaleSectionField(f.key, 1.1); render(); }, C.blue, 86), 0, 2);
      d.s.addControl(g);
    });
    content.addControl(d.r);
  };

  // ---------- footer: planet ----------
  const footer = new GUI.Grid();
  footer.height = "110px";
  footer.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_BOTTOM;
  footer.width = `${TEX_W - 80}px`;
  footer.paddingBottom = "24px";
  footer.addColumnDefinition(0.5);
  footer.addColumnDefinition(0.5);
  frame.addControl(footer);
  const renderFooter = () => {
    const p = api.getState().planet;
    footer.clearControls();
    const moon = button("Moon", p === "moon", () => api.setPlanet("moon"), C.gold, 84);
    const mars = button("Mars", p === "mars", () => api.setPlanet("mars"), C.gold, 84);
    moon.paddingRight = "8px"; mars.paddingLeft = "8px";
    footer.addControl(moon, 0, 0);
    footer.addControl(mars, 0, 1);
  };

  const render = () => {
    content.clearControls();
    live = null;
    renderTabs();
    const s = api.getState();
    if (tab === "live") renderLive();
    if (tab === "structure") renderList("Structure", api.structures, s.structureId, api.setStructure, C.blue);
    if (tab === "material") renderList("Strut material", api.materials, s.materialId, api.setMaterial, C.gold);
    if (tab === "section") renderSection();
    renderFooter();
    updateLive();
  };
  render();

  // refresh the live numbers ~6 times a second
  let frames = 0;
  scene.onBeforeRenderObservable.add(() => {
    if (root.isEnabled() && ++frames % 10 === 0) updateLive();
  });

  return {
    root,
    /** put the console at `pos`, screen tilted to face `viewer`, stand down to `floorY` */
    placeFacing(pos: BABYLON.Vector3, viewer: BABYLON.Vector3, floorY = 0) {
      root.position.copyFrom(pos);
      root.lookAt(pos.scale(2).subtract(viewer));   // screen front is -Z, so look AWAY from the viewer

      const top = pos.y - PANEL_H / 2 + 0.05;       // post meets the back plate near its bottom
      const h = Math.max(0.05, top - floorY);
      // post sits 4 cm BEHIND the screen (away from the viewer), so it never pokes through
      const behind = pos.subtract(viewer);
      behind.y = 0;
      behind.normalize().scaleInPlace(0.04);
      stand.position.set(pos.x + behind.x, 0, pos.z + behind.z);
      post.scaling.y = h;
      post.position.y = floorY + h / 2;
      foot.position.y = floorY + 0.01;
    },
    setVisible(v: boolean) { root.setEnabled(v); stand.setEnabled(v); },
    refresh: render,
  };
}
