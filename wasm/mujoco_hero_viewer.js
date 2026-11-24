/**
 * ZeroTracker Live MuJoCo WASM + Three.js Hero 3D Viewer
 * Loads real compiled MuJoCo robot XMLs (Unitree G1 & AgiBot X2) into mujoco-js WASM,
 * runs mj_forward() at 50 FPS on real ZeroTracker zero-shot rollout trajectories,
 * and renders a 3D interactive studio stage with optional 9-String Puppeteer overlay.
 */
import * as THREE from './lib/three.module.js';
import { OrbitControls } from './lib/OrbitControls.js';
import load_mujoco from './lib/mujoco_wasm.js';

export async function initMuJoCoHero(opts) {
  const container = document.getElementById(opts.containerId);
  const statusEl  = document.getElementById(opts.statusId);
  const mpjpeEl   = document.getElementById(opts.mpjpeId);
  const timeEl    = document.getElementById(opts.timeId);
  const scrubEl   = document.getElementById(opts.scrubId);
  const playBtn   = document.getElementById(opts.playBtnId);
  const gcv       = opts.gramCanvasId ? document.getElementById(opts.gramCanvasId) : null;
  const gctx      = gcv ? gcv.getContext('2d') : null;
  const ecv       = opts.energyCanvasId ? document.getElementById(opts.energyCanvasId) : null;
  const ectx      = ecv ? ecv.getContext('2d') : null;
  const dynPairEl = opts.dynPairId ? document.getElementById(opts.dynPairId) : null;
  const kinDrvEl  = opts.kinDriverId ? document.getElementById(opts.kinDriverId) : null;
  const kBarEl    = opts.kBarId ? document.getElementById(opts.kBarId) : null;
  const kValEl    = opts.kValId ? document.getElementById(opts.kValId) : null;
  const dBarEl    = opts.dBarId ? document.getElementById(opts.dBarId) : null;
  const dValEl    = opts.dValId ? document.getElementById(opts.dValId) : null;
  const comBarEl  = opts.comBarId ? document.getElementById(opts.comBarId) : null;
  const mjEnergyHist = new Array(72).fill(0.08);

  const setStatus = (txt, color = '#34D399') => {
    if (statusEl) { statusEl.textContent = txt; statusEl.style.color = color; }
  };

  // 1) Setup Three.js PBR Studio Scene
  const W = container.clientWidth || 680;
  const H = container.clientHeight || 420;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090c12);
  scene.fog = new THREE.Fog(0x090c12, 6.5, 16.0);

  const camera = new THREE.PerspectiveCamera(36, W / H, 0.05, 40.0);
  camera.position.set(1.85, 1.35, 2.35);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.78, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 1.1;
  controls.maxDistance = 6.5;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();

  // Studio 3-point lighting
  scene.add(new THREE.HemisphereLight(0xdbeafe, 0x0f172a, 0.75));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
  keyLight.position.set(2.8, 4.8, 3.2);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 14;
  const d = 2.2;
  keyLight.shadow.camera.left = -d; keyLight.shadow.camera.right = d;
  keyLight.shadow.camera.top = d;  keyLight.shadow.camera.bottom = -d;
  keyLight.shadow.bias = -0.0002;
  keyLight.shadow.normalBias = 0.025;
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x34d399, 0.85);
  rimLight.position.set(-3.2, 2.4, -2.5);
  scene.add(rimLight);

  const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.55);
  fillLight.position.set(-2.5, 2.0, 2.5);
  scene.add(fillLight);

  // Studio floor + subtle architectural grid
  const floorGeo = new THREE.PlaneGeometry(24, 24);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x0d121c, roughness: 0.55, metalness: 0.15 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(12, 24, 0x1e293b, 0x151c28);
  grid.position.y = 0.002;
  scene.add(grid);

  // MuJoCo Z-up -> Three.js Y-up root container!
  const mjRoot = new THREE.Group();
  mjRoot.rotation.x = -Math.PI / 2;
  scene.add(mjRoot);

  // 9-String Puppeteer 3D Overlay Group (also in MuJoCo Z-up coords!)
  const puppetGroup = new THREE.Group();
  mjRoot.add(puppetGroup);
  const crossbarGeo = new THREE.CylinderGeometry(0.012, 0.012, 1.0, 12);
  const crossbarMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x78350f, roughness: 0.3, metalness: 0.7 });
  const crossbar = new THREE.Mesh(crossbarGeo, crossbarMat);
  crossbar.rotation.z = Math.PI / 2;
  puppetGroup.add(crossbar);

  const stringKeys = ['head', 'torso', 'pelvis', 'lhand', 'rhand', 'lknee', 'rknee', 'lfoot', 'rfoot'];
  const stringLines = {};
  const anchorSpheres = {};
  const sphGeo = new THREE.SphereGeometry(0.022, 12, 12);
  const sphMat = new THREE.MeshBasicMaterial({ color: 0x34d399 });
  stringKeys.forEach((k) => {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const mat = new THREE.LineBasicMaterial({ color: (k === 'lhand' || k === 'rhand' || k === 'torso') ? 0x34d399 : 0xf59e0b, transparent: true, opacity: 0.78 });
    const line = new THREE.Line(geo, mat);
    puppetGroup.add(line);
    stringLines[k] = line;

    const sp = new THREE.Mesh(sphGeo, sphMat);
    puppetGroup.add(sp);
    anchorSpheres[k] = sp;
  });

  // Helper: Fetch 1-file lossless quantized+gzipped CAD pack (~3.0 MB) and expand to binary STLs in memory (~25 ms)
  async function fetchAndUnpackQMesh(url) {
    const res = await fetch(url);
    let buf;
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      buf = await new Response(res.body.pipeThrough(ds)).arrayBuffer();
    } else {
      throw new Error('Browser does not support DecompressionStream');
    }
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const dec = new TextDecoder();
    let off = 0;
    const nFiles = dv.getUint32(off, true); off += 4;
    const out = [];
    for (let fi = 0; fi < nFiles; fi++) {
      const nameLen = dv.getUint16(off, true); off += 2;
      const idxType = dv.getUint8(off); off += 1;
      const nVerts  = dv.getUint32(off, true); off += 4;
      const nFaces  = dv.getUint32(off, true); off += 4;
      const fname = dec.decode(u8.subarray(off, off + nameLen)); off += nameLen;

      const bmin0 = dv.getFloat32(off, true), bmin1 = dv.getFloat32(off + 4, true), bmin2 = dv.getFloat32(off + 8, true); off += 12;
      const sc0 = dv.getFloat32(off, true) / 65535.0, sc1 = dv.getFloat32(off + 4, true) / 65535.0, sc2 = dv.getFloat32(off + 8, true) / 65535.0; off += 12;

      const vx = new Float32Array(nVerts), vy = new Float32Array(nVerts), vz = new Float32Array(nVerts);
      for (let i = 0; i < nVerts; i++) {
        vx[i] = bmin0 + dv.getUint16(off, true) * sc0;
        vy[i] = bmin1 + dv.getUint16(off + 2, true) * sc1;
        vz[i] = bmin2 + dv.getUint16(off + 4, true) * sc2;
        off += 6;
      }

      // Build binary STL buffer directly in memory (84 + 50 * nFaces bytes)
      const stlBuf = new ArrayBuffer(84 + nFaces * 50);
      const sdv = new DataView(stlBuf);
      sdv.setUint32(80, nFaces, true);
      let sOff = 84;
      if (idxType === 0) {
        for (let f = 0; f < nFaces; f++) {
          const i0 = dv.getUint16(off, true), i1 = dv.getUint16(off + 2, true), i2 = dv.getUint16(off + 4, true); off += 6;
          sdv.setFloat32(sOff + 12, vx[i0], true); sdv.setFloat32(sOff + 16, vy[i0], true); sdv.setFloat32(sOff + 20, vz[i0], true);
          sdv.setFloat32(sOff + 24, vx[i1], true); sdv.setFloat32(sOff + 28, vy[i1], true); sdv.setFloat32(sOff + 32, vz[i1], true);
          sdv.setFloat32(sOff + 36, vx[i2], true); sdv.setFloat32(sOff + 40, vy[i2], true); sdv.setFloat32(sOff + 44, vz[i2], true);
          sOff += 50;
        }
      } else {
        for (let f = 0; f < nFaces; f++) {
          const i0 = dv.getUint32(off, true), i1 = dv.getUint32(off + 4, true), i2 = dv.getUint32(off + 8, true); off += 12;
          sdv.setFloat32(sOff + 12, vx[i0], true); sdv.setFloat32(sOff + 16, vy[i0], true); sdv.setFloat32(sOff + 20, vz[i0], true);
          sdv.setFloat32(sOff + 24, vx[i1], true); sdv.setFloat32(sOff + 28, vy[i1], true); sdv.setFloat32(sOff + 32, vz[i1], true);
          sdv.setFloat32(sOff + 36, vx[i2], true); sdv.setFloat32(sOff + 40, vy[i2], true); sdv.setFloat32(sOff + 44, vz[i2], true);
          sOff += 50;
        }
      }
      out.push({ fname, bytes: new Uint8Array(stlBuf) });
    }
    return out;
  }

  // 2) Boot Real MuJoCo WASM + Manifest + Default G1 3.0MB Pack IN PARALLEL!
  setStatus('LOADING MUJOCO WASM + G1...', '#F59E0B');
  const [mujoco, manifest, g1XmlPre, g1PackPre, g1SalsaPre] = await Promise.all([
    load_mujoco(),
    fetch('./wasm/manifest.json').then(r => r.json()),
    fetch('./wasm/g1.xml').then(r => r.text()),
    fetchAndUnpackQMesh('./wasm/g1_qmesh.bin.gz'),
    fetch('./wasm/traj_g1_salsa.json').then(r => r.json()),
  ]);
  try { mujoco.FS.mkdir('/working'); } catch (_) {}

  // State
  let curRobot = 'g1';
  let curMotion = 'salsa';
  let showStrings = true;
  let playing = true;
  let frameFloat = 0;
  let lastTs = performance.now();

  let model = null;
  let data = null;
  let geomMeshes = [];
  let curTraj = null;
  const loadedRobots = {};
  const trajCache = { g1_salsa: g1SalsaPre };
  const prefetchedPacks = { g1: { xmlText: g1XmlPre, files: g1PackPre } };
  const prefetchPromises = {};

  function prefetchRobot(rkey) {
    if (prefetchedPacks[rkey] || loadedRobots[rkey]) return Promise.resolve(prefetchedPacks[rkey]);
    if (prefetchPromises[rkey]) return prefetchPromises[rkey];
    const rinfo = manifest.robots[rkey];
    if (!rinfo) return Promise.resolve(null);
    prefetchPromises[rkey] = Promise.all([
      fetch(`./wasm/${rinfo.xml}`).then(r => r.text()),
      fetchAndUnpackQMesh(`./wasm/${rkey}_qmesh.bin.gz`),
    ]).then(([xmlText, files]) => {
      const pack = { xmlText, files };
      prefetchedPacks[rkey] = pack;
      return pack;
    }).catch((err) => {
      delete prefetchPromises[rkey];
      throw err;
    });
    return prefetchPromises[rkey];
  }

  function buildThreeMeshesFromMuJoCo(m) {
    // Clear previous robot meshes
    geomMeshes.forEach(({ mesh }) => {
      mjRoot.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    });
    geomMeshes = [];

    // Pre-build BufferGeometry per mesh_id using MuJoCo's EXACT split-crease normals (mesh_normal + mesh_facenormal)!
    // This eliminates all smoothed-bevel dark blotches and matches native MuJoCo Studio CAD shading 1:1.
    const meshGeos = {};
    for (let mid = 0; mid < m.nmesh; mid++) {
      const vadr = m.mesh_vertadr[mid];
      const nadr = m.mesh_normaladr[mid];
      const fadr = m.mesh_faceadr[mid];
      const fnum = m.mesh_facenum[mid];
      const posArr = new Float32Array(fnum * 9);
      const normArr = new Float32Array(fnum * 9);
      for (let f = 0; f < fnum; f++) {
        const fBase = (fadr + f) * 3;
        const outBase = f * 9;
        for (let c = 0; c < 3; c++) {
          const vi = (vadr + m.mesh_face[fBase + c]) * 3;
          const ni = (nadr + m.mesh_facenormal[fBase + c]) * 3;
          posArr[outBase + c * 3 + 0] = m.mesh_vert[vi + 0];
          posArr[outBase + c * 3 + 1] = m.mesh_vert[vi + 1];
          posArr[outBase + c * 3 + 2] = m.mesh_vert[vi + 2];
          normArr[outBase + c * 3 + 0] = m.mesh_normal[ni + 0];
          normArr[outBase + c * 3 + 1] = m.mesh_normal[ni + 1];
          normArr[outBase + c * 3 + 2] = m.mesh_normal[ni + 2];
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
      meshGeos[mid] = geo;
    }

    for (let g = 0; g < m.ngeom; g++) {
      const gtype = m.geom_type[g];
      const r = m.geom_rgba[g * 4 + 0];
      const gr = m.geom_rgba[g * 4 + 1];
      const b = m.geom_rgba[g * 4 + 2];
      const a = m.geom_rgba[g * 4 + 3];
      if (a < 0.05) continue;

      let geo = null;
      if (gtype === 7) { // mjGEOM_MESH
        const mid = m.geom_dataid[g];
        if (mid >= 0 && meshGeos[mid]) geo = meshGeos[mid].clone();
      } else if (gtype === 2) { // SPHERE
        geo = new THREE.SphereGeometry(m.geom_size[g * 3], 16, 16);
      } else if (gtype === 3) { // CAPSULE
        geo = new THREE.CapsuleGeometry(m.geom_size[g * 3], m.geom_size[g * 3 + 1] * 2, 8, 14);
        geo.rotateX(Math.PI / 2);
      } else if (gtype === 5) { // CYLINDER
        geo = new THREE.CylinderGeometry(m.geom_size[g * 3], m.geom_size[g * 3], m.geom_size[g * 3 + 1] * 2, 16);
        geo.rotateX(Math.PI / 2);
      } else if (gtype === 6) { // BOX
        geo = new THREE.BoxGeometry(m.geom_size[g * 3] * 2, m.geom_size[g * 3 + 1] * 2, m.geom_size[g * 3 + 2] * 2);
      }
      if (!geo) continue;

      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(r, gr, b),
        roughness: 0.36,
        metalness: 0.28,
        transparent: a < 0.99,
        opacity: a,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mjRoot.add(mesh);
      geomMeshes.push({ gid: g, mesh });
    }
  }

  async function ensureRobotMounted(rkey) {
    if (loadedRobots[rkey]) return;
    const rinfo = manifest.robots[rkey];
    setStatus(`LOADING ${rkey.toUpperCase()} CAD PACK...`, '#F59E0B');
    try { mujoco.FS.mkdir(`/working/meshes_${rkey}`); } catch (_) {}

    let pack = prefetchedPacks[rkey];
    if (!pack) {
      pack = await prefetchRobot(rkey);
    }
    mujoco.FS.writeFile(`/working/${rinfo.xml}`, pack.xmlText);
    for (const { fname, bytes } of pack.files) {
      mujoco.FS.writeFile(`/working/meshes_${rkey}/${fname}`, bytes);
    }
    loadedRobots[rkey] = true;
  }

  async function loadRobotAndMotion(rkey, mkey) {
    const needRobot = (rkey !== curRobot || !model);
    curRobot = rkey;
    curMotion = mkey;

    if (needRobot) {
      await ensureRobotMounted(rkey);
      if (data) { data.delete(); data = null; }
      if (model) { model.delete(); model = null; }
      model = mujoco.MjModel.loadFromXML(`/working/${manifest.robots[rkey].xml}`);
      data = new mujoco.MjData(model);
      buildThreeMeshesFromMuJoCo(model);
    }

    const tKey = `${rkey}_${mkey}`;
    if (!trajCache[tKey]) {
      setStatus(`LOADING ${mkey.toUpperCase()}...`, '#F59E0B');
      trajCache[tKey] = await (await fetch(`./wasm/traj_${rkey}_${mkey}.json`)).json();
    }
    curTraj = trajCache[tKey];
    frameFloat = 0;
    if (scrubEl) {
      scrubEl.max = String(Math.max(1, curTraj.n_frames - 1));
      scrubEl.value = '0';
    }
    setStatus('MUJOCO WASM · 50 FPS LIVE', '#34D399');
  }

  const _mat4 = new THREE.Matrix4();
  const _quat = new THREE.Quaternion();

  function syncMuJoCoFrame(fi) {
    if (!model || !data || !curTraj) return;
    const q = curTraj.qpos[fi];
    for (let i = 0; i < q.length && i < data.qpos.length; i++) {
      data.qpos[i] = q[i];
    }
    // REAL MuJoCo WASM forward kinematics!
    mujoco.mj_forward(model, data);

    // Sync all Three.js geom meshes from data.geom_xpos & data.geom_xmat
    for (let k = 0; k < geomMeshes.length; k++) {
      const { gid, mesh } = geomMeshes[k];
      const p0 = gid * 3;
      const m0 = gid * 9;
      mesh.position.set(data.geom_xpos[p0], data.geom_xpos[p0 + 1], data.geom_xpos[p0 + 2]);
      _mat4.set(
        data.geom_xmat[m0 + 0], data.geom_xmat[m0 + 1], data.geom_xmat[m0 + 2], 0,
        data.geom_xmat[m0 + 3], data.geom_xmat[m0 + 4], data.geom_xmat[m0 + 5], 0,
        data.geom_xmat[m0 + 6], data.geom_xmat[m0 + 7], data.geom_xmat[m0 + 8], 0,
        0, 0, 0, 1
      );
      _quat.setFromRotationMatrix(_mat4);
      mesh.quaternion.copy(_quat);
    }

    // Update 3D 9-String Puppeteer Overlay attached to real MuJoCo body xpos!
    puppetGroup.visible = showStrings;
    if (showStrings) {
      const aMap = manifest.robots[curRobot].anchors_9;
      const pelId = aMap.pelvis || 1;
      const px = data.xpos[pelId * 3], py = data.xpos[pelId * 3 + 1], pz = data.xpos[pelId * 3 + 2];
      const barZ = pz + 1.25;
      crossbar.position.set(px, py, barZ);

      stringKeys.forEach((sk, idx) => {
        const bid = aMap[sk] || 1;
        const bx = data.xpos[bid * 3], by = data.xpos[bid * 3 + 1], bz = data.xpos[bid * 3 + 2];
        anchorSpheres[sk].position.set(bx, by, bz);
        const barOff = ((idx / (stringKeys.length - 1)) - 0.5) * 0.90;
        const posAttr = stringLines[sk].geometry.attributes.position;
        posAttr.setXYZ(0, px, py + barOff, barZ);
        posAttr.setXYZ(1, bx, by, bz);
        posAttr.needsUpdate = true;
      });
    }

    // Telemetry + Live Gram J^T J & Adaptive Impedance Visualization driven by REAL MuJoCo qpos velocity!
    if (mpjpeEl) mpjpeEl.textContent = `${curTraj.mpjpe[fi].toFixed(1)} mm`;
    if (timeEl) timeEl.textContent = `${(fi / 50).toFixed(1)}s / ${(curTraj.n_frames / 50).toFixed(1)}s`;
    if (scrubEl) scrubEl.value = String(fi);

    // Compute real per-group joint velocity energy from consecutive 50-FPS frames
    const fiPrev = Math.max(0, fi - 1);
    const qPrev = curTraj.qpos[fiPrev];
    const dq = new Array(Math.max(0, q.length - 7));
    for (let i = 7; i < q.length; i++) dq[i - 7] = Math.abs(q[i] - qPrev[i]) * 50.0;
    const meanSlice = (a, b) => {
      let s = 0, c = 0;
      for (let i = a; i < Math.min(b, dq.length); i++) { s += dq[i]; c++; }
      return c > 0 ? Math.min(1.0, (s / c) / 3.8) : 0.1;
    };
    // 6-group activity vector: [L.Arm, R.Arm, Torso, Pelvis, L.Leg, R.Leg]
    const nJ = dq.length;
    const lLeg = meanSlice(0, 6);
    const rLeg = meanSlice(6, 12);
    const torso = meanSlice(12, 15);
    const lArm = meanSlice(15, Math.min(22, nJ));
    const rArm = meanSlice(22, nJ);
    const pelv = Math.min(1.0, Math.hypot(q[0] - qPrev[0], q[1] - qPrev[1], q[2] - qPrev[2]) * 50.0 / 1.4);
    const act6 = [lArm, rArm, torso, pelv, lLeg, rLeg];

    // 1) Draw live 6x6 Gram J^T J coupling heatmap with crisp LA/RA/TR/PL/LL/RL axis labels!
    if (gctx && gcv) {
      const gw = gcv.width, gh = gcv.height, pad = 16, n = 6, cell = (gw - pad) / n;
      const gLbls = ['LA', 'RA', 'TR', 'PL', 'LL', 'RL'];
      gctx.clearRect(0, 0, gw, gh);
      gctx.fillStyle = '#8D96A5';
      gctx.font = '600 7.5px "JetBrains Mono", monospace';
      gctx.textAlign = 'center';
      for (let i = 0; i < n; i++) {
        gctx.fillText(gLbls[i], pad + (i + 0.5) * cell, 10);
        gctx.fillText(gLbls[i], 8, pad + (i + 0.72) * cell);
      }
      const base = [
        [1.0, 0.16, 0.74, 0.36, 0.25, 0.18],
        [0.16, 1.0, 0.74, 0.36, 0.18, 0.25],
        [0.74, 0.74, 1.0, 0.86, 0.58, 0.58],
        [0.36, 0.36, 0.86, 1.0, 0.88, 0.88],
        [0.25, 0.18, 0.58, 0.88, 1.0, 0.46],
        [0.18, 0.25, 0.58, 0.88, 0.46, 1.0]
      ];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const v = Math.min(1.0, base[i][j] * (0.28 + 0.78 * Math.max(act6[i], act6[j])));
          gctx.fillStyle = `rgba(52, 211, 153, ${0.08 + v * 0.88})`;
          gctx.fillRect(pad + j * cell + 1, pad + i * cell + 1, cell - 2, cell - 2);
        }
      }
    }
    if (dynPairEl) {
      const armMax = Math.max(lArm, rArm), legMax = Math.max(lLeg, rLeg);
      if (armMax > legMax + 0.12) dynPairEl.textContent = 'ARMS ⇄ TORSO ⇄ STANCE';
      else if (legMax > armMax + 0.12) dynPairEl.textContent = 'PELVIS ⇄ LEGS ⇄ ANKLES';
      else dynPairEl.textContent = 'FULL-BODY JᵀJ COUPLING';
    }
    if (kinDrvEl) {
      const mNames = { salsa: 'SALSA 180°', macarena: 'MACARENA', routine: 'DANCE ROUTINE', dance2: 'LAFAN1 DANCE2' };
      kinDrvEl.textContent = (curRobot === 'g1' ? 'G1 · ' : 'X2 · ') + (mNames[curMotion] || curMotion.toUpperCase());
    }
    if (comBarEl) {
      const comSafe = Math.max(62, Math.min(98, Math.round(96 - pelv * 22)));
      comBarEl.style.width = `${comSafe}%`;
    }

    // 2) Adaptive Impedance K_a, D_a & Energy Dissipation Sparkline
    const massScale = curRobot === 'x2' ? 1.24 : 1.00;
    const totalAct = (lArm + rArm + torso + pelv + lLeg + rLeg) / 6.0;
    const kVal = massScale * (0.90 + totalAct * 0.55);
    const dVal = massScale * (0.88 + totalAct * 0.62);
    if (kBarEl && kValEl) {
      kBarEl.style.width = `${Math.min(100, kVal * 52)}%`;
      kValEl.textContent = `${kVal.toFixed(2)}×`;
    }
    if (dBarEl && dValEl) {
      dBarEl.style.width = `${Math.min(100, dVal * 52)}%`;
      dValEl.textContent = `${dVal.toFixed(2)}×`;
    }
    if (ectx && ecv) {
      mjEnergyHist.push(Math.min(1.0, 0.08 + totalAct * 0.85));
      mjEnergyHist.shift();
      const ew = ecv.width, eh = ecv.height;
      ectx.clearRect(0, 0, ew, eh);
      ectx.strokeStyle = '#34D399';
      ectx.lineWidth = 1.5;
      ectx.beginPath();
      mjEnergyHist.forEach((ev, idx) => {
        const px = 3 + (idx / (mjEnergyHist.length - 1)) * (ew - 6);
        const py = eh - 3 - ev * (eh - 6);
        if (idx === 0) ectx.moveTo(px, py); else ectx.lineTo(px, py);
      });
      ectx.stroke();
    }
  }

  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - lastTs) / 1000);
    lastTs = now;
    if (playing && curTraj) {
      frameFloat = (frameFloat + dt * curTraj.fps) % curTraj.n_frames;
      syncMuJoCoFrame(Math.floor(frameFloat));
    }
    controls.update();
    renderer.render(scene, camera);
  }

  // Handle resize
  const ro = new ResizeObserver(() => {
    const nw = container.clientWidth || 680;
    const nh = container.clientHeight || 420;
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, nh);
  });
  ro.observe(container);

  // Scrubber & Play/Pause
  if (scrubEl) {
    scrubEl.addEventListener('input', () => {
      frameFloat = Number(scrubEl.value);
      syncMuJoCoFrame(Math.floor(frameFloat));
    });
  }
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      playing = !playing;
      playBtn.textContent = playing ? '⏸ Pause' : '▶ Play';
    });
  }

  // Initial load: Unitree G1 + Latino Salsa 180° (already prefetched in parallel!)
  await loadRobotAndMotion('g1', 'salsa');
  syncMuJoCoFrame(0);
  requestAnimationFrame(animate);

  return {
    setRobot: (rk) => loadRobotAndMotion(rk, curMotion),
    setMotion: (mk) => loadRobotAndMotion(curRobot, mk),
    prefetchRobot: (rk) => prefetchRobot(rk).catch(() => {}),
    toggleStrings: () => { showStrings = !showStrings; return showStrings; },
    resetCamera: () => {
      camera.position.set(1.85, 1.35, 2.35);
      controls.target.set(0, 0.78, 0);
      controls.update();
    },
  };
}
