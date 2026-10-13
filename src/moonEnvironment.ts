import * as BABYLON from "babylonjs";

/**
 * Procedural lunar environment: cratered regolith, starfield, hard sunlight,
 * and Earth in the sky. Everything is generated at runtime - no texture files,
 * no network requests.
 */

export interface MoonEnvironmentOptions {
  /** Edge length of the ground plane, metres. Default 240. */
  groundSize?: number;
  /** Grid subdivisions. Higher = smoother craters, slower build. Default 220. */
  subdivisions?: number;
  /** Radius of the flat landing pad at the origin, metres. Default 9. */
  padRadius?: number;
  /** Distance over which the pad blends into the terrain. Default 7. */
  padFalloff?: number;
  /** Number of craters scattered over the ground. Default 90. */
  craterCount?: number;
  /** RNG seed - same seed gives the same terrain every reload. Default 20260917. */
  seed?: number;
  /** Show Earth in the sky. Default true. */
  showEarth?: boolean;
  /** Shadow map resolution. Default 2048. */
  shadowMapSize?: number;
}

export interface MoonEnvironment {
  ground: BABYLON.Mesh;
  sun: BABYLON.DirectionalLight;
  fill: BABYLON.HemisphericLight;
  shadows: BABYLON.ShadowGenerator;
  skybox: BABYLON.Mesh;
  earth: BABYLON.Mesh | null;
  /** Register structure meshes so they cast shadows. Call after every rebuild. */
  addShadowCasters: (meshes: BABYLON.AbstractMesh[]) => void;
  /** Clear the caster list (call before disposing a structure). */
  clearShadowCasters: () => void;
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) so the terrain is identical every reload
// ---------------------------------------------------------------------------
const makeRng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ---------------------------------------------------------------------------
// Cheap 2D value noise with fractal octaves - gives the regolith its roughness
// ---------------------------------------------------------------------------
const hash2 = (x: number, y: number, seed: number): number => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const smoothstep = (t: number) => t * t * (3 - 2 * t);

const valueNoise = (x: number, y: number, seed: number): number => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smoothstep(xf), v = smoothstep(yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
};

const fbm = (x: number, y: number, seed: number, octaves = 5): number => {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * (valueNoise(x * freq, y * freq, seed + o * 1013) - 0.5);
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
};

// ---------------------------------------------------------------------------
// Crater profile: bowl floor + raised rim + ejecta skirt
// ---------------------------------------------------------------------------
interface Crater {
  x: number; z: number; r: number; depth: number; rim: number;
}

const craterProfile = (t: number, c: Crater): number => {
  if (t > 1.9) return 0;
  // parabolic bowl, deepest at centre, reaching zero at the rim
  const bowl = t < 1 ? -c.depth * (1 - t * t) : 0;
  // raised rim, a gaussian ring centred on t = 1
  const rim = c.rim * Math.exp(-Math.pow((t - 1.0) / 0.28, 2));
  // faint ejecta blanket falling away outside
  const ejecta = t > 1 ? c.rim * 0.25 * Math.exp(-Math.pow((t - 1.0) / 0.9, 2)) : 0;
  return bowl + rim + ejecta;
};

// ---------------------------------------------------------------------------
// Starfield texture
// ---------------------------------------------------------------------------
const makeStarTexture = (scene: BABYLON.Scene, seed: number): BABYLON.DynamicTexture => {
  const W = 2048, H = 1024;
  const tex = new BABYLON.DynamicTexture("starTex", { width: W, height: H }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const rng = makeRng(seed);

  ctx.fillStyle = "#000006";
  ctx.fillRect(0, 0, W, H);

  // faint milky-way band
  for (let i = 0; i < 9000; i++) {
    const x = rng() * W;
    const bandY = H * 0.5 + Math.sin((x / W) * Math.PI * 2) * H * 0.12;
    const y = bandY + (rng() - 0.5) * H * 0.18;
    const a = rng() * 0.05;
    ctx.fillStyle = `rgba(190,200,230,${a})`;
    ctx.fillRect(x, y, 2, 2);
  }

  // ordinary stars
  for (let i = 0; i < 4200; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const mag = rng();
    const r = mag > 0.985 ? 1.8 : mag > 0.9 ? 1.1 : 0.7;
    const a = 0.25 + mag * 0.75;
    // slight colour variation: most white, a few warm or blue
    const tint = rng();
    const col = tint > 0.93 ? `rgba(255,200,170,${a})`
              : tint < 0.07 ? `rgba(190,215,255,${a})`
              : `rgba(255,255,255,${a})`;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // a handful of bright stars with a cross flare
  for (let i = 0; i < 18; i++) {
    const x = rng() * W, y = rng() * H;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y);
    ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9);
    ctx.stroke();
  }

  tex.update(false);
  return tex;
};

// ---------------------------------------------------------------------------
// Earth texture
// ---------------------------------------------------------------------------
const makeEarthTexture = (scene: BABYLON.Scene, seed: number): BABYLON.DynamicTexture => {
  const W = 1024, H = 512;
  const tex = new BABYLON.DynamicTexture("earthTex", { width: W, height: H }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const rng = makeRng(seed);

  // ocean
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#cfe6f5");
  grad.addColorStop(0.18, "#1a4f8a");
  grad.addColorStop(0.5, "#10639e");
  grad.addColorStop(0.82, "#1a4f8a");
  grad.addColorStop(1, "#dce9f2");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // landmasses: blobby clusters
  for (let c = 0; c < 10; c++) {
    const cx = rng() * W, cy = H * 0.2 + rng() * H * 0.6;
    const blobs = 16 + Math.floor(rng() * 22);
    for (let b = 0; b < blobs; b++) {
      const x = cx + (rng() - 0.5) * 190;
      const y = cy + (rng() - 0.5) * 120;
      const r = 12 + rng() * 42;
      const green = rng();
      ctx.fillStyle = green > 0.72
        ? `rgba(150,130,85,0.92)`
        : `rgba(${60 + rng() * 40 | 0},${105 + rng() * 45 | 0},${50 + rng() * 30 | 0},0.92)`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  // polar caps
  ctx.fillStyle = "rgba(255,255,255,0.93)";
  ctx.fillRect(0, 0, W, H * 0.055);
  ctx.fillRect(0, H * 0.945, W, H * 0.055);

  // clouds
  for (let i = 0; i < 480; i++) {
    const x = rng() * W;
    const y = H * 0.06 + rng() * H * 0.88;
    const r = 10 + rng() * 40;
    ctx.fillStyle = `rgba(255,255,255,${0.10 + rng() * 0.30})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  tex.update(false);
  return tex;
};

// ---------------------------------------------------------------------------
// Regolith surface texture: fine grey speckle
// ---------------------------------------------------------------------------
const makeRegolithTexture = (scene: BABYLON.Scene, seed: number): BABYLON.DynamicTexture => {
  const S = 1024;
  const tex = new BABYLON.DynamicTexture("regolithTex", { width: S, height: S }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const rng = makeRng(seed);

  ctx.fillStyle = "#8d8a86";
  ctx.fillRect(0, 0, S, S);

  // fine grain
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 34;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n * 0.9));
  }
  ctx.putImageData(img, 0, 0);

  // scattered small rocks and micro-craters
  for (let i = 0; i < 1400; i++) {
    const x = rng() * S, y = rng() * S, r = 1 + rng() * 5;
    const dark = rng() > 0.45;
    ctx.fillStyle = dark ? `rgba(70,68,66,${0.25 + rng() * 0.4})`
                         : `rgba(185,182,176,${0.15 + rng() * 0.3})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  tex.update(false);
  return tex;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export const createMoonEnvironment = (
  scene: BABYLON.Scene,
  opts: MoonEnvironmentOptions = {}
): MoonEnvironment => {
  const groundSize    = opts.groundSize    ?? 240;
  const subdivisions  = opts.subdivisions  ?? 220;
  const padRadius     = opts.padRadius     ?? 9;
  const padFalloff    = opts.padFalloff    ?? 7;
  const craterCount   = opts.craterCount   ?? 90;
  const seed          = opts.seed          ?? 20260917;
  const showEarth     = opts.showEarth     ?? true;
  const shadowMapSize = opts.shadowMapSize ?? 2048;

  const rng = makeRng(seed);

  // -- space is black --------------------------------------------------------
  scene.clearColor = new BABYLON.Color4(0, 0, 0.012, 1);
  scene.ambientColor = new BABYLON.Color3(0.05, 0.05, 0.06);

  // -- starfield skybox ------------------------------------------------------
  const skybox = BABYLON.MeshBuilder.CreateSphere(
    "starDome", { diameter: 2000, segments: 32, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene);
  const skyMat = new BABYLON.StandardMaterial("starDomeMat", scene);
  skyMat.emissiveTexture = makeStarTexture(scene, seed ^ 0x5bf03);
  skyMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
  skyMat.specularColor = new BABYLON.Color3(0, 0, 0);
  skyMat.backFaceCulling = false;
  skyMat.disableLighting = true;
  skybox.material = skyMat;
  skybox.infiniteDistance = true;
  skybox.isPickable = false;

  // -- cratered ground -------------------------------------------------------
  const ground = BABYLON.MeshBuilder.CreateGround(
    "moonGround",
    { width: groundSize, height: groundSize, subdivisions, updatable: true },
    scene
  );

  // scatter craters; keep them clear of the landing pad
  const craters: Crater[] = [];
  let guard = 0;
  while (craters.length < craterCount && guard++ < craterCount * 40) {
    const x = (rng() - 0.5) * groundSize * 0.96;
    const z = (rng() - 0.5) * groundSize * 0.96;
    // power-law-ish size distribution: many small, few large
    const u = rng();
    const r = 1.8 + Math.pow(u, 3.2) * 26;
    if (Math.hypot(x, z) < padRadius + padFalloff + r * 1.2) continue;
    craters.push({
      x, z, r,
      depth: r * (0.16 + rng() * 0.12),
      rim:   r * (0.045 + rng() * 0.05),
    });
  }

  const positions = ground.getVerticesData(BABYLON.VertexBuffer.PositionKind);
  if (positions) {
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const z = positions[i + 2];
      let h = 0;

      // rolling terrain + fine roughness
      h += fbm(x * 0.012, z * 0.012, seed, 5) * 5.2;
      h += fbm(x * 0.09,  z * 0.09,  seed + 77, 3) * 0.55;

      // craters
      for (let c = 0; c < craters.length; c++) {
        const cr = craters[c];
        const dx = x - cr.x, dz = z - cr.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < cr.r * 1.95) h += craterProfile(dist / cr.r, cr);
      }

      // flatten the landing pad so the structure rests on level ground
      const rad = Math.sqrt(x * x + z * z);
      if (rad < padRadius + padFalloff) {
        const blend = rad <= padRadius
          ? 0
          : smoothstep((rad - padRadius) / padFalloff);
        h *= blend;
      }

      positions[i + 1] = h;
    }
    ground.updateVerticesData(BABYLON.VertexBuffer.PositionKind, positions);

    const normals: number[] = [];
    const indices = ground.getIndices();
    if (indices) {
      BABYLON.VertexData.ComputeNormals(positions, indices, normals);
      ground.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals);
    }
  }

  const groundMat = new BABYLON.StandardMaterial("moonGroundMat", scene);
  const regolith = makeRegolithTexture(scene, seed ^ 0x1c0de);
  regolith.uScale = 90;
  regolith.vScale = 90;
  groundMat.diffuseTexture = regolith;
  groundMat.diffuseColor = new BABYLON.Color3(1, 1, 1);
  // regolith is almost perfectly diffuse - no shine at all
  groundMat.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
  groundMat.specularPower = 1;
  ground.material = groundMat;
  ground.receiveShadows = true;
  ground.isPickable = false;

  // -- lighting: one hard sun, almost no fill --------------------------------
  const sun = new BABYLON.DirectionalLight(
    "sun", new BABYLON.Vector3(-0.55, -0.62, 0.56), scene);
  sun.position = new BABYLON.Vector3(60, 70, -60);
  sun.intensity = 2.7;
  sun.diffuse = new BABYLON.Color3(1.0, 0.985, 0.95);
  sun.specular = new BABYLON.Color3(0.35, 0.35, 0.33);

  // vacuum: the only fill is bounce off the regolith, so keep it dim and grey
  const fill = new BABYLON.HemisphericLight(
    "regolithBounce", new BABYLON.Vector3(0, 1, 0), scene);
  fill.intensity = 0.14;
  fill.diffuse = new BABYLON.Color3(0.55, 0.54, 0.52);
  fill.groundColor = new BABYLON.Color3(0.28, 0.27, 0.25);
  fill.specular = new BABYLON.Color3(0, 0, 0);

  // -- hard shadows ----------------------------------------------------------
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 260;
  sun.autoUpdateExtends = false;
  sun.shadowFrustumSize = 44;

  const shadows = new BABYLON.ShadowGenerator(shadowMapSize, sun);
  shadows.usePoissonSampling = false;      // no softening
  shadows.useExponentialShadowMap = false;
  shadows.bias = 0.00035;
  shadows.normalBias = 0.012;
  shadows.setDarkness(0.02);               // near-black: no atmosphere to scatter

  const addShadowCasters = (meshes: BABYLON.AbstractMesh[]) => {
    meshes.forEach((m) => shadows.addShadowCaster(m, false));
  };
  const clearShadowCasters = () => {
    const rl = shadows.getShadowMap()?.renderList;
    if (rl) rl.length = 0;
  };

  // -- Earth -----------------------------------------------------------------
  let earth: BABYLON.Mesh | null = null;
  if (showEarth) {
    earth = BABYLON.MeshBuilder.CreateSphere("earth", { diameter: 46, segments: 48 }, scene);
    earth.position = new BABYLON.Vector3(150, 105, 235);
    earth.isPickable = false;
    earth.rotation.z = 0.41;               // axial tilt, for looks

    const earthMat = new BABYLON.StandardMaterial("earthMat", scene);
    const earthTex = makeEarthTexture(scene, seed ^ 0xea27b4);
    earthMat.diffuseTexture = earthTex;
    earthMat.emissiveTexture = earthTex;
    // mostly lit, but keep a little shading so it reads as a sphere
    earthMat.emissiveColor = new BABYLON.Color3(0.62, 0.62, 0.66);
    earthMat.diffuseColor = new BABYLON.Color3(0.5, 0.5, 0.5);
    earthMat.specularColor = new BABYLON.Color3(0.06, 0.06, 0.08);
    earth.material = earthMat;

    // slow rotation
    scene.onBeforeRenderObservable.add(() => {
      if (earth) earth.rotation.y += 0.00022;
    });

    // thin atmosphere halo
    const halo = BABYLON.MeshBuilder.CreateSphere("earthHalo", { diameter: 49, segments: 32 }, scene);
    halo.parent = earth;
    halo.isPickable = false;
    const haloMat = new BABYLON.StandardMaterial("earthHaloMat", scene);
    haloMat.emissiveColor = new BABYLON.Color3(0.25, 0.45, 0.85);
    haloMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    haloMat.specularColor = new BABYLON.Color3(0, 0, 0);
    haloMat.alpha = 0.13;
    haloMat.backFaceCulling = false;
    haloMat.disableLighting = true;
    halo.material = haloMat;
  }

  const dispose = () => {
    ground.dispose();
    skybox.dispose();
    earth?.dispose();
    sun.dispose();
    fill.dispose();
    shadows.dispose();
  };

  return { ground, sun, fill, shadows, skybox, earth, addShadowCasters, clearShadowCasters, dispose };
};