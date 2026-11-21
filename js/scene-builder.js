// scene-builder.js — SINGLE SOURCE OF TRUTH
// Dipakai oleh studio (index.html) DAN renderer headless (render.html).
// Spec JSON yang sama => scene identik di viewport user dan di screenshot agent.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';
import { BokehPass } from '../vendor/jsm/postprocessing/BokehPass.js';
import RAPIER from '../vendor/rapier.es.js';

export const SPEC_VERSION = 1;

// PRNG deterministik (mulberry32) — seed sama, hasil sama.
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const deg = THREE.MathUtils.degToRad;

function makeGeometry(type, p = {}) {
  switch (type) {
    case 'box': return new THREE.BoxGeometry(p.width ?? 1, p.height ?? 1, p.depth ?? 1);
    case 'sphere': return new THREE.SphereGeometry(p.radius ?? 0.5, p.widthSegments ?? 48, p.heightSegments ?? 32);
    case 'cylinder': return new THREE.CylinderGeometry(p.radiusTop ?? 0.5, p.radiusBottom ?? 0.5, p.height ?? 1, p.radialSegments ?? 48);
    case 'cone': return new THREE.ConeGeometry(p.radius ?? 0.5, p.height ?? 1, p.radialSegments ?? 48);
    case 'torus': return new THREE.TorusGeometry(p.radius ?? 0.5, p.tube ?? 0.18, p.radialSegments ?? 32, p.tubularSegments ?? 96);
    case 'torusKnot': return new THREE.TorusKnotGeometry(p.radius ?? 0.5, p.tube ?? 0.16, p.tubularSegments ?? 160, p.radialSegments ?? 24);
    case 'plane': return new THREE.PlaneGeometry(p.width ?? 1, p.height ?? 1);
    case 'capsule': return new THREE.CapsuleGeometry(p.radius ?? 0.3, p.length ?? 0.6, 8, 24);
    case 'icosahedron': return new THREE.IcosahedronGeometry(p.radius ?? 0.5, p.detail ?? 0);
    case 'ring': return new THREE.RingGeometry(p.innerRadius ?? 0.3, p.outerRadius ?? 0.5, 64);
    default: throw new Error(`Tipe geometri tidak dikenal: ${type}`);
  }
}

const _texCache = {};
function proceduralTexture(kind) {
  if (_texCache[kind]) return _texCache[kind];
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const rng = makeRng(kind === 'asphalt' ? 99 : 17);
  ctx.fillStyle = kind === 'asphalt' ? '#a8a8a8' : '#d4d4d4';
  ctx.fillRect(0, 0, 256, 256);
  // bintik noise kasar (terbaca di jarak render)
  for (let i = 0; i < 4200; i++) {
    const v = Math.floor(120 + rng() * 135);
    ctx.fillStyle = `rgba(${v},${v},${v},${(0.2 + rng() * 0.4).toFixed(2)})`;
    const s = 1 + rng() * 3;
    ctx.fillRect(rng() * 256, rng() * 256, s, s);
  }
  if (kind === 'concrete') {
    // noda besar (dibuang air hujan)
    for (let i = 0; i < 7; i++) {
      const x = rng() * 256, y = rng() * 256, rr = 12 + rng() * 30;
      const g = ctx.createRadialGradient(x, y, 2, x, y, rr);
      g.addColorStop(0, `rgba(70,72,80,${(0.10 + rng() * 0.10).toFixed(2)})`);
      g.addColorStop(1, 'rgba(70,72,80,0)');
      ctx.fillStyle = g; ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    // streak vertikal tegas
    for (let i = 0; i < 22; i++) {
      const x = rng() * 256, w = 1 + rng() * 4;
      ctx.fillStyle = `rgba(80,82,90,${(0.08 + rng() * 0.12).toFixed(2)})`;
      ctx.fillRect(x, rng() * 50, w, 130 + rng() * 126);
    }
    // garis panel lantai tegas
    ctx.fillStyle = 'rgba(60,62,70,0.22)';
    for (let y = 0; y < 256; y += 42) ctx.fillRect(0, y, 256, 2);
  } else {
    // retakan aspal
    ctx.strokeStyle = 'rgba(35,37,42,0.55)'; ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      let x = rng() * 256, y = rng() * 256;
      ctx.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (rng() - .5) * 60; y += (rng() - .5) * 60; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    // tambalan
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = `rgba(90,92,98,${(0.12 + rng() * 0.12).toFixed(2)})`;
      ctx.fillRect(rng() * 200, rng() * 200, 30 + rng() * 50, 20 + rng() * 40);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _texCache[kind] = tex;
  return tex;
}

function makeMaterial(m = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(m.color ?? '#b8bcc4'),
    metalness: m.metalness ?? 0.1,
    roughness: m.roughness ?? 0.6,
    emissive: new THREE.Color(m.emissive ?? '#000000'),
    emissiveIntensity: m.emissiveIntensity ?? 1,
    flatShading: m.flatShading ?? false,
    wireframe: m.wireframe ?? false,
    fog: m.fog ?? true,
    side: m.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (m.opacity !== undefined && m.opacity < 1) { mat.transparent = true; mat.opacity = m.opacity; }
  if (m.texture === 'concrete' || m.texture === 'asphalt') {
    const base = proceduralTexture(m.texture);
    if (m.textureRepeat) {
      const t = base.clone();
      t.repeat.set(m.textureRepeat[0], m.textureRepeat[1]);
      t.needsUpdate = true;
      mat.map = t;
    } else mat.map = base;
  }
  return mat;
}

function makeLight(l) {
  const color = new THREE.Color(l.color ?? '#ffffff');
  const intensity = l.intensity ?? 1;
  let light;
  switch (l.type) {
    case 'ambient': light = new THREE.AmbientLight(color, intensity); break;
    case 'hemisphere': light = new THREE.HemisphereLight(color, new THREE.Color(l.groundColor ?? '#223'), intensity); break;
    case 'directional': {
      light = new THREE.DirectionalLight(color, intensity);
      light.castShadow = l.castShadow ?? true;
      light.shadow.mapSize.set(1024, 1024);
      const s = l.shadowExtent ?? 20;
      Object.assign(light.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.5, far: 200 });
      light.shadow.bias = -0.0004;
      break;
    }
    case 'point': light = new THREE.PointLight(color, intensity, l.distance ?? 0, l.decay ?? 2); light.castShadow = l.castShadow ?? false; break;
    case 'spot': {
      light = new THREE.SpotLight(color, intensity, l.distance ?? 0, deg(l.angle ?? 35), l.penumbra ?? 0.4, l.decay ?? 2);
      light.castShadow = l.castShadow ?? true;
      light.shadow.mapSize.set(1024, 1024);
      break;
    }
    default: throw new Error(`Tipe lampu tidak dikenal: ${l.type}`);
  }
  light.name = l.id || l.type;
  if (l.position) light.position.fromArray(l.position);
  if (l.target && light.target) light.target.position.fromArray(l.target);
  return light;
}

// Bangun scene dari spec. Mengembalikan handle untuk studio & renderer.
export async function buildScene(spec, opts = {}) {
  const errors = [];
  const scene = new THREE.Scene();
  const registry = new Map(); // id -> Object3D

  // Fisika Rapier (opsional, spec.physics) — WASM init idempotent
  let physicsWorld = null;
  const bodyMap = new Map();
  if (spec.physics) {
    await RAPIER.init();
    const g = spec.physics.gravity || [0, -9.81, 0];
    physicsWorld = new RAPIER.World({ x: g[0], y: g[1], z: g[2] });
  }

  const env = spec.environment || {};
  scene.background = new THREE.Color(env.background ?? '#0d1017');
  if (env.fog) scene.fog = new THREE.Fog(new THREE.Color(env.fog.color ?? env.background ?? '#0d1017'), env.fog.near ?? 15, env.fog.far ?? 60);

  if (env.ground) {
    const g = env.ground;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(g.size ?? 60, g.size ?? 60),
      makeMaterial({ color: g.color ?? '#1a1e26', roughness: g.roughness ?? 0.9, metalness: g.metalness ?? 0, texture: g.texture, textureRepeat: g.textureRepeat })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = g.y ?? 0;
    ground.receiveShadow = true;
    ground.name = '__ground';
    scene.add(ground);
    registry.set('__ground', ground);
    if (physicsWorld) {
      const gb = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, (g.y ?? 0) - 0.25, 0));
      physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid((g.size ?? 60) / 2, 0.25, (g.size ?? 60) / 2).setFriction(0.8).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), gb);
    }
  }

  const camera = new THREE.PerspectiveCamera(spec.camera?.fov ?? 50, 1, 0.1, 500);
  camera.position.fromArray(spec.camera?.position ?? [6, 4, 8]);
  const target = new THREE.Vector3().fromArray(spec.camera?.target ?? [0, 1, 0]);
  camera.lookAt(target);
  camera.name = '__camera';

  for (const l of spec.lights || []) {
    try {
      const light = makeLight(l);
      scene.add(light);
      if (light.target) scene.add(light.target);
      registry.set(l.id || l.type, light);
    } catch (e) { errors.push(`light ${l.id}: ${e.message}`); }
  }

  const gltfLoader = new GLTFLoader();
  const animations = [];
  async function buildOne(o, parent) {
    if (o.type === 'rope' || o.type === 'trigger') return; // dibangun post-pass fisika
    try {
      let mesh;
      if (o.type === 'group') {
        // Pivot mekanika: children bertransformasi relatif terhadap group
        mesh = new THREE.Group();
        for (const c of o.children || []) await buildOne(c, mesh);
      } else if (o.type === 'sky') {
        // Langit gradasi (shader) — pengganti background polos
        const p = o.params || {};
        const geo = new THREE.SphereGeometry(p.radius ?? 200, 32, 16);
        const mat = new THREE.ShaderMaterial({
          side: THREE.BackSide, depthWrite: false, fog: false,
          uniforms: {
            top: { value: new THREE.Color(p.top ?? '#05070f') },
            horizon: { value: new THREE.Color(p.horizon ?? '#1a2440') },
          },
          vertexShader: 'varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vPos; void main(){ float h = clamp(normalize(vPos).y, 0.0, 1.0); vec3 col = mix(horizon, top, pow(h, 0.6)); float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453); col += (n - 0.5) / 128.0; gl_FragColor = vec4(col, 1.0); }',
        });
        mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = -1;
        mesh.frustumCulled = false;
        mesh.userData.isSky = true;
        mesh.castShadow = false; mesh.receiveShadow = false;
      } else if (o.type === 'stars') {
        const p = o.params || {};
        const rng = makeRng(p.seed ?? spec.meta?.seed ?? 1);
        const count = p.count ?? 500, r = p.radius ?? 180;
        const pos = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          const y = 0.08 + rng() * 0.92;
          const rr = Math.sqrt(Math.max(0, 1 - y * y));
          const a = rng() * Math.PI * 2;
          pos[i * 3] = r * rr * Math.cos(a);
          pos[i * 3 + 1] = r * y;
          pos[i * 3 + 2] = r * rr * Math.sin(a);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({
          color: new THREE.Color(p.color ?? '#9db4ff'), size: p.size ?? 0.7,
          sizeAttenuation: true, transparent: true, opacity: p.opacity ?? 0.85,
          fog: false, depthWrite: false,
        });
        mesh = new THREE.Points(geo, mat);
        mesh.frustumCulled = false;
        mesh.userData.isSky = true;
      } else if (o.type === 'instances') {
        // InstancedMesh — ratusan jendela/objek berulang dalam 1 draw call
        const g = o.geometry || { type: 'box', params: {} };
        const geo = makeGeometry(g.type, g.params);
        const mat = makeMaterial(o.material);
        const tr = o.transforms || [];
        mesh = new THREE.InstancedMesh(geo, mat, tr.length);
        const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), S = new THREE.Vector3(), P = new THREE.Vector3();
        tr.forEach((t, i) => {
          const arr = Array.isArray(t) ? { p: t } : t;
          P.fromArray(arr.p || [0, 0, 0]);
          const rr = arr.r || [0, 0, 0];
          E.set(deg(rr[0]), deg(rr[1]), deg(rr[2]));
          Q.setFromEuler(E);
          const sc = arr.s ?? 1;
          if (Array.isArray(sc)) S.fromArray(sc); else S.setScalar(sc);
          M.compose(P, Q, S);
          mesh.setMatrixAt(i, M);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingBox();
        mesh.castShadow = o.castShadow ?? false;
        mesh.receiveShadow = o.receiveShadow ?? false;
      } else if (o.type === 'gltf') {
        const gltf = await gltfLoader.loadAsync(o.url);
        mesh = gltf.scene;
        mesh.traverse(c => { if (c.isMesh) { c.castShadow = o.castShadow ?? true; c.receiveShadow = o.receiveShadow ?? true; } });
      } else {
        mesh = new THREE.Mesh(makeGeometry(o.type, o.params), makeMaterial(o.material));
        mesh.castShadow = o.castShadow ?? true;
        mesh.receiveShadow = o.receiveShadow ?? true;
      }
      mesh.name = o.id;
      if (o.position) mesh.position.fromArray(o.position);
      if (o.rotation) mesh.rotation.set(deg(o.rotation[0]), deg(o.rotation[1]), deg(o.rotation[2]));
      if (o.scale !== undefined) {
        if (Array.isArray(o.scale)) mesh.scale.fromArray(o.scale);
        else mesh.scale.setScalar(o.scale);
      }
      mesh.visible = o.visible ?? true;
      mesh.userData.specId = o.id;
      if (o.sky) mesh.userData.isSky = true;  // elemen langit/dekorasi jauh (awan dll)
      if (mesh.material) mesh.userData.baseEmissive = mesh.material.emissiveIntensity ?? 1;
      mesh.userData.basePos = mesh.position.clone();
      parent.add(mesh);
      registry.set(o.id, mesh);
      if (o.animate) animations.push({ id: o.id, obj: mesh, anim: o.animate,
        baseRot: mesh.rotation.clone(), basePos: mesh.position.clone(),
        baseEmissive: mesh.material?.emissiveIntensity ?? 1 });
      // rigid body (hanya objek root-level; children group tidak didukung fisika v1)
      if (o.physics && physicsWorld) {
        if (parent !== scene) { errors.push(`object ${o.id}: physics hanya untuk objek root (bukan children group)`); }
        else {
          const ph = o.physics, kind = ph.body || 'dynamic';
          const desc = kind === 'fixed' ? RAPIER.RigidBodyDesc.fixed()
            : kind === 'kinematic' ? RAPIER.RigidBodyDesc.kinematicPositionBased()
            : RAPIER.RigidBodyDesc.dynamic();
          desc.setTranslation(mesh.position.x, mesh.position.y, mesh.position.z);
          const q = mesh.quaternion;
          desc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
          if (ph.linvel) desc.setLinvel(ph.linvel[0], ph.linvel[1], ph.linvel[2]);
          if (ph.angvel) desc.setAngvel(ph.angvel[0], ph.angvel[1], ph.angvel[2]);
          if (kind === 'dynamic') { desc.setLinearDamping(ph.linearDamping ?? 0.05); desc.setAngularDamping(ph.angularDamping ?? 0.05); desc.setCcdEnabled(true); }
          const body = physicsWorld.createRigidBody(desc);
          const cd = colliderFor(o, mesh);
          cd.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
          physicsWorld.createCollider(cd, body);
          body.userData = { init: { p: mesh.position.clone(), q: mesh.quaternion.clone() }, nanCount: 0 };
          if (ph.impulse) body.applyImpulse({ x: ph.impulse[0], y: ph.impulse[1], z: ph.impulse[2] }, true);
          bodyMap.set(o.id, body);
        }
      }
    } catch (e) { errors.push(`object ${o.id}: ${e.message}`); }
  }
  for (const o of spec.objects || []) await buildOne(o, scene);

  // Joint antar body (revolute/spherical/fixed, opsional motor)
  for (const j of spec.joints || []) {
    const b1 = bodyMap.get(j.body1), b2 = bodyMap.get(j.body2);
    if (!b1 || !b2) { console.warn(`[physics] joint ${j.body1}-${j.body2} dilewati: body tidak ada (auto-prune)`); continue; }
    const v = a => ({ x: a[0], y: a[1], z: a[2] });
    const Iq = { x: 0, y: 0, z: 0, w: 1 };
    let jd;
    if (j.type === 'revolute') jd = RAPIER.JointData.revolute(v(j.anchor1 || [0,0,0]), v(j.anchor2 || [0,0,0]), v(j.axis1 || [0,1,0]), v(j.axis2 || [0,1,0]));
    else if (j.type === 'spherical') jd = RAPIER.JointData.spherical(v(j.anchor1 || [0,0,0]), v(j.anchor2 || [0,0,0]));
    else jd = RAPIER.JointData.fixed(v(j.anchor1 || [0,0,0]), Iq, v(j.anchor2 || [0,0,0]), Iq);
    try {
      const joint = physicsWorld.createImpulseJoint(jd, b1, b2, true);
      if (j.motor && j.type === 'revolute') joint.configureMotorVelocity(j.motor.velocity ?? 2, j.motor.factor ?? 1);
    } catch (e) { errors.push(`joint ${j.body1}-${j.body2}: ${e.message}`); }
  }

  // ── Fisika lanjutan: rope (rantai segmen + spherical joint) & trigger (sensor) ──
  const triggers = [];
  for (const o of spec.objects || []) {
    if (o.type === 'rope' && physicsWorld) {
      try {
        const segs = Math.max(3, Math.min(30, o.segments ?? 12));
        const len = o.length ?? 3, segLen = len / segs, r = o.radius ?? 0.04;
        let ax, ay, az, prevBody;
        if (o.anchorBody && bodyMap.has(o.anchorBody)) {
          const t = bodyMap.get(o.anchorBody).translation();
          ax = t.x; ay = t.y; az = t.z; prevBody = bodyMap.get(o.anchorBody);
        } else {
          const a = o.anchor || [0, 4, 0];
          ax = a[0]; ay = a[1]; az = a[2];
          prevBody = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(ax, ay, az));
        }
        const group = new THREE.Group(); group.name = o.id;
        const mat = new THREE.MeshStandardMaterial({ color: o.color || '#b08d57', roughness: 0.85 });
        const geo = new THREE.CylinderGeometry(r, r, segLen, 8);
        for (let i = 0; i < segs; i++) {
          const cy = ay - segLen * (i + 0.5);
          const body = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(ax, cy, az).setLinearDamping(0.1).setAngularDamping(0.1));
          physicsWorld.createCollider(RAPIER.ColliderDesc.capsule(Math.max(0.01, segLen / 2 - r), r).setDensity(0.6), body);
          body.userData = { init: { p: new THREE.Vector3(ax, cy, az), q: new THREE.Quaternion() }, nanCount: 0 };
          const a1 = i === 0 && !o.anchorBody ? { x: 0, y: 0, z: 0 } : { x: 0, y: -segLen / 2, z: 0 };
          physicsWorld.createImpulseJoint(RAPIER.JointData.spherical(a1, { x: 0, y: segLen / 2, z: 0 }), prevBody, body, true);
          const m = new THREE.Mesh(geo, mat);
          m.position.set(ax, cy, az);
          m.castShadow = true;
          group.add(m);
          const sid = `${o.id}-seg${i}`;
          registry.set(sid, m);
          bodyMap.set(sid, body);
          prevBody = body;
        }
        if (o.attachBody && bodyMap.has(o.attachBody)) {
          physicsWorld.createImpulseJoint(RAPIER.JointData.spherical({ x: 0, y: -segLen / 2, z: 0 }, { x: 0, y: 0, z: 0 }), prevBody, bodyMap.get(o.attachBody), true);
        }
        scene.add(group);
        registry.set(o.id, group);
      } catch (e) { errors.push(`rope ${o.id}: ${e.message}`); }
    }
    if (o.type === 'trigger' && physicsWorld) {
      try {
        const p = o.position || [0, 0.5, 0];
        const body = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p[0], p[1], p[2]));
        const pr = o.params || {};
        const cd = pr.radius != null ? RAPIER.ColliderDesc.ball(pr.radius)
          : RAPIER.ColliderDesc.cuboid((pr.width ?? 2) / 2, (pr.height ?? 1) / 2, (pr.depth ?? 2) / 2);
        const col = physicsWorld.createCollider(cd.setSensor(true), body);
        // visualisasi zona (transparan, tidak menghalangi)
        const vg = pr.radius != null ? new THREE.SphereGeometry(pr.radius, 16, 12) : new THREE.BoxGeometry(pr.width ?? 2, pr.height ?? 1, pr.depth ?? 2);
        const vm = new THREE.Mesh(vg, new THREE.MeshBasicMaterial({ color: o.color || '#4f8cff', transparent: true, opacity: 0.12, depthWrite: false }));
        vm.position.set(p[0], p[1], p[2]);
        scene.add(vm);
        registry.set(o.id, vm);
        triggers.push({ collider: col, spec: o, lastFire: -999 });
      } catch (e) { errors.push(`trigger ${o.id}: ${e.message}`); }
    }
  }

  // Kontrol interaktif (slider/toggle) — nilai liveOverrides di atas spec
  const overrides = {};
  for (const c of spec.controls || []) {
    if (!c.target) continue;
    overrides[c.target] = overrides[c.target] || {};
    if (c.type === 'toggle') overrides[c.target].enabled = c.default ?? true;
    else overrides[c.target][c.param || 'speed'] = c.default ?? c.min ?? 0;
  }
  return { scene, camera, target, registry, errors, spec, animations, overrides, physicsWorld, bodyMap, triggers, drag: null, powerTriggered: false };
}

// Renderer dengan pengaturan warna & tone mapping yang BENAR (anti warna pucat).
export function makeRenderer(canvas, w, h, opts = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, stencil: true,
    preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    powerPreference: 'high-performance',
  });
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

// Post-processing: bloom sinematik (spec.post.bloom). OutputPass mengurus tone mapping + sRGB.
export function makeComposer(handle, renderer, w, h) {
  const post = handle.spec.post;
  if (!(post && post.bloom) && !handle.dof?.enabled) return null;
  // stencilBuffer WAJIB untuk section caps (irisan solid) — RT default tidak punya stencil
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, stencilBuffer: true });
  const composer = new EffectComposer(renderer, rt);
  composer.setSize(w, h);
  composer.addPass(new RenderPass(handle.scene, handle.camera));
  if (handle.dof?.enabled) {
    const d = handle.dof;
    const bp = new BokehPass(handle.scene, handle.camera, {
      focus: d.focus ?? 5, aperture: d.aperture ?? 0.00012, maxblur: d.maxblur ?? 0.012 });
    composer.addPass(bp);
    handle.bokehPass = bp;
  }
  const b = post?.bloom || {};
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), b.strength ?? 0.5, b.radius ?? 0.5, b.threshold ?? 0.75));
  composer.addPass(new OutputPass());
  return composer;
}

// Frame kamera otomatis dari bounding box scene (anti objek di luar frame / kamera di dalam objek).
export function frameCamera(camera, target, scene, controls, opts = {}) {
  const box = new THREE.Box3();
  scene.traverse(o => {
    if (!o.isMesh || !o.visible || o.name === '__ground' || o.userData?.isSky) return;
    const g = o.geometry;
    if (g) { if (!g.boundingSphere) g.computeBoundingSphere(); if ((g.boundingSphere?.radius || 0) > 1000) return; }
    box.expandByObject(o);
  });
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
  const fov = deg(camera.fov);
  const dist = (radius / Math.sin(fov / 2)) * (opts.margin ?? 1.25);
  // Pertahankan arah pandang saat ini, geser jarak & target.
  const dir = camera.position.clone().sub(controls ? controls.target : target).normalize();
  if (dir.lengthSq() < 0.01) dir.set(1, 0.6, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(0.05, dist / 100);
  camera.far = Math.max(200, dist * 20);
  camera.updateProjectionMatrix();
  if (controls) { controls.target.copy(center); controls.update(); }
  else camera.lookAt(center);
  return { center: center.toArray(), size: size.toArray(), dist };
}

// Smoke test otomatis — bug kelas klasik dideteksi SEBELUM vision loop.
export function smokeCheck(handle, renderer, opts = {}) {
  const { scene, camera, registry, errors, spec } = handle;
  const report = { errors: [...errors], checks: [] };
  const add = (id, pass, detail) => report.checks.push({ id, pass, detail });

  // 1. Nol error build
  add('no_build_errors', errors.length === 0, errors.join('; ') || 'scene terbangun tanpa error');

  // 2. Semua objek terdaftar ada di scene
  const missing = (spec.objects || []).filter(o => !registry.has(o.id)).map(o => o.id);
  add('all_objects_built', missing.length === 0, missing.length ? `gagal: ${missing.join(', ')}` : `${(spec.objects || []).length} objek terbangun`);

  // 3. Ada lampu selain ambient (scene hitam = bug klasik)
  const lights = (spec.lights || []);
  add('has_lighting', lights.length > 0, `${lights.length} lampu: ${lights.map(l => l.type).join(', ') || 'TIDAK ADA'}`);

  // 4. Render satu frame, cek piksel: bukan hitam polos / kosong
  const renderFrame = () => handle.composer ? handle.composer.render() : renderer.render(scene, camera);
  renderFrame();
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sum = 0, nonBg = 0;
  // Acuan "kosong" = warna fog bila ada (objek jauh memudar ke fog, bukan ke background)
  const bg = new THREE.Color(scene.fog ? scene.fog.color : scene.background);
  // PENTING: piksel canvas ber-encoding sRGB, warna Three.js linear — konversi dulu sebelum banding
  const bgS = bg.clone().convertLinearToSRGB();
  const bgR = bgS.r * 255, bgG = bgS.g * 255, bgB = bgS.b * 255;
  // Coverage diukur TANPA sky/bintang (langit bukan subjek) — sembunyikan sementara
  const skies = [];
  scene.traverse(o => { if ((o.userData?.isSky || o.name === '__ground') && o.visible) { skies.push(o); o.visible = false; } });
  // Ukur coverage dengan render POLOS (tanpa bloom) — bloom menyebar ke seluruh frame dan merusak metrik
  renderer.render(scene, camera);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  skies.forEach(o => o.visible = true);
  renderFrame();
  const step = 16; let n = 0;
  for (let i = 0; i < px.length; i += 4 * step) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    sum += (r + g + b) / 3; n++;
    if (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB) > 24) nonBg++;
  }
  const meanLum = sum / n;
  const coverage = nonBg / n;
  add('not_black_frame', meanLum > 4, `luminance rata-rata ${meanLum.toFixed(1)}`);
  add('subject_in_frame', coverage > 0.02, `subjek menutupi ${(coverage * 100).toFixed(1)}% piksel (target 2-70%)`);
  add('framing_not_extreme', coverage < 0.85, coverage >= 0.85 ? 'subjek memenuhi frame — kamera mungkin terlalu dekat' : 'framing wajar');

  // 5. Objek utama terlihat dari kamera (frustum test)
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const inView = [], outView = [];
  for (const o of spec.objects || []) {
    const m = registry.get(o.id);
    if (!m || m.visible === false || m.userData?.isSky) continue;
    const b = new THREE.Box3().setFromObject(m);
    (frustum.intersectsBox(b) ? inView : outView).push(o.id);
  }
  if (opts.cinematic) {
    add('objects_in_view', true, `pose sinematik — closeup sengaja (subject coverage ${(coverage * 100).toFixed(0)}%)`);
  } else {
    add('objects_in_view', outView.length === 0, outView.length ? `di luar frame: ${outView.join(', ')}` : `${inView.length} objek dalam frame`);
  }

  // 6. Oklusi: objek utama tidak boleh terhalang objek lain dari sudut kamera
  const ray = new THREE.Raycaster();
  const occluded = [];
  const meshesAll = [];
  scene.traverse(o => { if (o.isMesh && o.visible && !o.userData?.isSky && o.name !== '__ground') meshesAll.push(o); });
  // Hanya subjek kecil yang WAJIB terlihat langsung: mobil, orang, lampu, matahari/bulan.
  // Gedung besar boleh bertumpuk sebagian (komposisi wajar); atap/pohon/dekorasi dikecualikan.
  const base = id => /^(mobil|orang)-\d+/.test(id) ? id.match(/^(mobil|orang)-\d+/)[0] : id;
  for (const o of spec.objects || []) {
    if (!/^(mobil-\d+$|orang-\d+-badan|bulb-|matahari$|bulan$|antena-lampu$)/.test(o.id)) continue;
    const m = registry.get(o.id);
    if (!m || m.visible === false) continue;
    const b = new THREE.Box3().setFromObject(m);
    const c = b.getCenter(new THREE.Vector3());
    const dir = c.clone().sub(camera.position);
    const dist = dir.length();
    ray.set(camera.position, dir.normalize());
    ray.far = dist - 0.05;
    const hits = ray.intersectObjects(meshesAll, false);
    const blocker = hits.find(h => base(h.object.userData?.specId || '') !== base(o.id));
    if (blocker) occluded.push(`${o.id}←${blocker.object.userData?.specId || blocker.object.name}`);
  }
  add('objects_unoccluded', occluded.length === 0, occluded.length ? `terhalang: ${occluded.slice(0, 6).join(', ')}` : 'subjek utama (mobil/orang/lampu) terlihat langsung');

  report.pass = report.checks.every(c => c.pass);
  report.coverage = coverage;
  report.meanLum = meanLum;
  return report;
}

// Collider otomatis dari geometri objek (skala ikut diperhitungkan)
function colliderFor(o, mesh) {
  const p = o.params || {};
  const s = Array.isArray(o.scale) ? o.scale : [o.scale ?? 1, o.scale ?? 1, o.scale ?? 1];
  const ph = o.physics || {};
  let cd;
  switch (o.type) {
    case 'box': cd = RAPIER.ColliderDesc.cuboid((p.width ?? 1) / 2 * s[0], (p.height ?? 1) / 2 * s[1], (p.depth ?? 1) / 2 * s[2]); break;
    case 'sphere': cd = RAPIER.ColliderDesc.ball((p.radius ?? 0.5) * Math.max(...s)); break;
    case 'cylinder': case 'cone': cd = RAPIER.ColliderDesc.cylinder((p.height ?? 1) / 2 * s[1], (p.radiusTop ?? p.radius ?? 0.5) * s[0]); break;
    case 'capsule': cd = RAPIER.ColliderDesc.capsule((p.length ?? 0.6) / 2 * s[1], (p.radius ?? 0.3) * s[0]); break;
    default: {
      const b = new THREE.Box3().setFromObject(mesh);
      const sz = b.getSize(new THREE.Vector3());
      cd = RAPIER.ColliderDesc.cuboid(Math.max(0.01, sz.x / 2), Math.max(0.01, sz.y / 2), Math.max(0.01, sz.z / 2));
    }
  }
  if (ph.restitution !== undefined) cd.setRestitution(ph.restitution);
  if (ph.friction !== undefined) cd.setFriction(ph.friction);
  if (ph.density !== undefined) cd.setDensity(ph.density);
  return cd;
}

// Step fisika fixed-timestep + sinkronisasi transform mesh dari rigid body
export function stepPhysics(handle, dt = 1 / 60) {
  const w = handle.physicsWorld;
  if (!w) return;
  w.timestep = dt;
  const aq = handle.audio?.enabled ? handle.audio.eventQueue : undefined;
  w.step(aq);
  if (aq) {
    aq.drainCollisionEvents((h1, h2, started) => {
      handle.audio.collisionEvents = (handle.audio.collisionEvents || 0) + 1;
      if (!started) return;
      try {
        const c1 = w.getCollider(h1), c2 = w.getCollider(h2);
        const b1 = c1?.parent(), b2 = c2?.parent();
        const dyn = (b1 && b1.isDynamic()) ? b1 : (b2 && b2.isDynamic()) ? b2 : null;
        if (!dyn) return;
        const v = dyn.linvel();
        const strength = Math.hypot(v.x, v.y, v.z);
        if (strength < 0.8) return;
        const t = dyn.translation();
        audioImpact(handle, { x: t.x, y: t.y, z: t.z }, strength);
      } catch (e) { /* collider sudah dihapus */ }
    });
  }
  handle.physTime = (handle.physTime || 0) + dt;
  for (const tr of handle.triggers || []) {
    const o = tr.spec, act = o.onEnter || {};
    w.intersectionPairsWith(tr.collider, (other) => {
      const b = other.parent();
      if (!b || !b.isDynamic || !b.isDynamic()) return;
      if (handle.physTime - tr.lastFire < (o.cooldown ?? 2)) return;
      tr.lastFire = handle.physTime;
      if (act.action === 'impulse' && act.impulse) b.applyImpulse({ x: act.impulse[0], y: act.impulse[1], z: act.impulse[2] }, true);
      else if (act.action === 'explode') applyExplosion(handle, o.position || [0, 0.5, 0], act.force ?? 8, act.radius ?? 4);
      else if (act.action === 'power') handle.powerTriggered = true;
    });
  }
  for (const [id, body] of handle.bodyMap) {
    const m = handle.registry.get(id);
    if (!m) continue;
    const t = body.translation(), r = body.rotation();
    // Guard NaN: solver bisa meledak (joint bermotor vs body jatuh, impuls ekstrem).
    // Self-healing: kembalikan body ke transform awal, velocity nol — mesh tidak boleh hilang.
    if (!Number.isFinite(t.x + t.y + t.z + r.x + r.y + r.z + r.w)) {
      const ini = body.userData?.init;
      if (ini) {
        body.setTranslation({ x: ini.p.x, y: ini.p.y, z: ini.p.z }, true);
        body.setRotation({ x: ini.q.x, y: ini.q.y, z: ini.q.z, w: ini.q.w }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        body.userData.nanCount = (body.userData.nanCount || 0) + 1;
        if (body.userData.nanCount === 1) console.warn(`[physics] NaN terdeteksi pada ${id} — body di-reset ke posisi awal (self-healing)`);
        m.position.copy(ini.p);
        m.quaternion.copy(ini.q);
      }
      continue;
    }
    m.position.set(t.x, t.y, t.z);
    m.quaternion.set(r.x, r.y, r.z, r.w);
  }
}

// Mekanika: spin/oscillate/float/blink + saklar power (spec.power.affects = id terdampak).
// Deterministik terhadap t — render headless menangkap pose pada t tetap.
export function applyAnimations(handle, t, powerOn = true) {
  const power = handle.spec.power;
  const affects = new Set(power?.affects || []);
  const ov = handle.overrides || {};
  const blinkIds = new Set();
  for (const a of handle.animations || []) {
    if (handle.bodyMap?.has(a.id) && ['spin', 'oscillate', 'float'].includes(a.anim.type)) continue;  // fisika menang atas keyframe transform; animasi material tetap boleh
    const o = ov[a.id] || {};
    const an = a.anim, ax = an.axis || 'z';
    const enabled = o.enabled ?? an.enabled ?? true;
    const active = (powerOn || !affects.has(a.id)) && enabled;
    const ramp = an.accel ? Math.min(1, t / an.accel) : 1;  // ramp-up (mis. bilah mulai pelan saat menyala)
    if (an.type === 'spin') {
      const speed = o.speed ?? an.speed ?? 5;
      a.obj.rotation[ax] = a.baseRot[ax] + (active ? speed * t * ramp : 0);
    } else if (an.type === 'oscillate') {
      const amp = o.amplitude ?? an.amplitude ?? 30;
      const period = o.period ?? an.period ?? 4;
      a.obj.rotation[ax] = a.baseRot[ax] + (active ? deg(amp) * Math.sin(2 * Math.PI * t / period + (an.phase ?? 0)) : 0);
    } else if (an.type === 'float') {
      const amp = o.amplitude ?? an.amplitude ?? 0.2;
      const period = o.period ?? an.period ?? 3;
      a.obj.position.y = a.basePos.y + (active ? amp * Math.sin(2 * Math.PI * t / period) : 0);
    } else if (an.type === 'blink' && a.obj.material) {
      blinkIds.add(a.id);
      const period = o.period ?? an.period ?? 1;
      const hi = active && Math.sin(2 * Math.PI * t / period) > 0;
      a.obj.material.emissiveIntensity = hi ? (an.max ?? a.baseEmissive) : (an.min ?? 0.05);
    } else if (an.type === 'colorCycle' && a.obj.material) {
      const period = o.period ?? an.period ?? 4;
      const hue = active ? ((t / period) + (an.phase ?? 0)) % 1 : (an.phase ?? 0);
      a.obj.material.emissive.setHSL(hue, an.saturation ?? 0.9, an.lightness ?? 0.55);
      if (an.tintBody) a.obj.material.color.setHSL(hue, (an.saturation ?? 0.9) * 0.7, 0.5);
    }
  }
  if (power) for (const id of affects) {
    if (blinkIds.has(id)) continue;
    const o = handle.registry.get(id);
    if (o?.material?.emissive) o.material.emissiveIntensity = powerOn ? (o.userData.baseEmissive ?? 1) : (o.userData.baseEmissive ?? 1) * 0.06;
  }
}

// Reset ringan semua rigid body ke transform awal (untuk timeline scrub & tombol reset)
export function resetPhysics(handle) {
  if (!handle.bodyMap) return;
  for (const [id, body] of handle.bodyMap) {
    const init = body.userData?.init;
    if (!init) continue;
    body.setTranslation({ x: init.p.x, y: init.p.y, z: init.p.z }, true);
    body.setRotation({ x: init.q.x, y: init.q.y, z: init.q.z, w: init.q.w }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const m = handle.registry.get(id);
    if (m) { m.position.copy(init.p); m.quaternion.copy(init.q); }
  }
}

// ── Depth of field / rack focus (produksi — hanya view, bukan spec design) ──
export function setDOF(handle, renderer, w, h, opts) {
  handle.dof = opts && opts.enabled ? opts : null;
  if (handle.composer) { try { handle.composer.dispose(); } catch (e) { /* abaikan */ } }
  handle.composer = makeComposer(handle, renderer, w, h);
  handle.bokehPass = handle.dof ? handle.bokehPass : null;
  return !!handle.dof;
}
export function updateDOF(handle) {
  const bp = handle.bokehPass, d = handle.dof;
  if (!bp || !d) return;
  if (d.target && d.focusMode !== 'manual') {
    const m = handle.registry.get(d.target);
    if (m) {
      m.updateWorldMatrix(true, false);
      const p = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
      bp.uniforms.focus.value = p.distanceTo(handle.camera.position);
    }
  } else if (d.focus != null) bp.uniforms.focus.value = d.focus;
  if (d.aperture != null) bp.uniforms.aperture.value = d.aperture;
}

// ── Ledakan radial: impuls ke semua body dynamic (falloff linear) ──
export function applyExplosion(handle, center, force = 8, radius = 4) {
  if (!handle.physicsWorld) return 0;
  const c = Array.isArray(center) ? new THREE.Vector3(...center) : center;
  let n = 0;
  for (const [id, body] of handle.bodyMap) {
    if (!body.isDynamic || !body.isDynamic()) continue;
    const t = body.translation();
    const d = new THREE.Vector3(t.x - c.x, t.y - c.y, t.z - c.z);
    const dist = d.length();
    if (dist > radius) continue;
    d.normalize().multiplyScalar(force * (1 - dist / radius) + force * 0.15);
    d.y += force * 0.25 * (1 - dist / radius);
    body.applyImpulse({ x: d.x, y: d.y, z: d.z }, true);
    n++;
  }
  return n;
}

// ── Drag fisika dengan mouse (joint ke body kinematic cursor) ──
export function startDrag(handle, id, point) {
  const body = handle.bodyMap?.get(id);
  if (!body || !body.isDynamic()) return false;
  endDrag(handle);
  const cursor = handle.physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(point.x, point.y, point.z));
  const local = body.toLocalPoint({ x: point.x, y: point.y, z: point.z });
  const Iq = { x: 0, y: 0, z: 0, w: 1 };
  const joint = handle.physicsWorld.createImpulseJoint(RAPIER.JointData.fixed(local, Iq, { x: 0, y: 0, z: 0 }, Iq), body, cursor, true);
  handle.drag = { cursor, joint, body, id };
  return true;
}
export function moveDrag(handle, point) {
  if (handle.drag) handle.drag.cursor.setNextKinematicTranslation({ x: point.x, y: point.y, z: point.z });
}
export function endDrag(handle) {
  if (!handle.drag) return;
  try {
    handle.physicsWorld.removeImpulseJoint(handle.drag.joint, true);
    handle.physicsWorld.removeRigidBody(handle.drag.cursor);
  } catch (e) { /* sudah terhapus */ }
  handle.drag = null;
}

// ─────────────────────────── AUDIO MEKANIKA (WebAudio sintetis) ───────────────────────────
export function makeAudio(handle) {
  if (handle.audio) return handle.audio;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  const master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
  const humOsc = ctx.createOscillator(); humOsc.type = 'sawtooth'; humOsc.frequency.value = 70;
  const humFilter = ctx.createBiquadFilter(); humFilter.type = 'lowpass'; humFilter.frequency.value = 240;
  const humGain = ctx.createGain(); humGain.gain.value = 0;
  const humPanner = ctx.createPanner(); humPanner.panningModel = 'HRTF'; humPanner.distanceModel = 'inverse'; humPanner.refDistance = 2;
  humOsc.connect(humFilter); humFilter.connect(humGain); humGain.connect(humPanner); humPanner.connect(master);
  humOsc.start();
  handle.audio = { ctx, master, humOsc, humGain, humPanner, enabled: true, lastImpact: -1, impactCount: 0, eventQueue: new RAPIER.EventQueue(true) };
  return handle.audio;
}
export function updateAudio(handle, powerOn, speed = 1) {
  const a = handle.audio; if (!a) return;
  const au = handle.spec.audio || {};
  const m = handle.registry.get(au.hum?.object || 'motor');
  if (m) {
    m.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
    a.humPanner.setPosition(p.x, p.y, p.z);
  }
  const t = a.ctx.currentTime;
  a.humGain.gain.setTargetAtTime(powerOn ? (au.hum?.gain ?? 0.12) : 0, t, 0.15);
  a.humOsc.frequency.setTargetAtTime((au.hum?.baseFreq ?? 70) * (0.6 + Math.max(0.2, speed) * 0.4), t, 0.2);
  const cam = handle.camera, l = a.ctx.listener;
  const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  if (l.positionX) {
    l.positionX.value = cam.position.x; l.positionY.value = cam.position.y; l.positionZ.value = cam.position.z;
    l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
    l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
  } else { l.setPosition(cam.position.x, cam.position.y, cam.position.z); l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
}
export function audioImpact(handle, pos, strength) {
  const a = handle.audio; if (!a || !a.enabled) return;
  const now = a.ctx.currentTime;
  if (now - a.lastImpact < 0.05) return;
  a.lastImpact = now; a.impactCount++;
  const dur = 0.09;
  const buf = a.ctx.createBuffer(1, Math.floor(a.ctx.sampleRate * dur), a.ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
  const src = a.ctx.createBufferSource(); src.buffer = buf;
  const g = a.ctx.createGain(); g.gain.value = Math.min(0.5, 0.06 + strength * 0.015);
  const f = a.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 350 + Math.min(2000, strength * 60);
  const p = a.ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 2;
  p.setPosition(pos.x, pos.y, pos.z);
  src.connect(f); f.connect(g); g.connect(p); p.connect(a.master);
  src.start();
}
export function audioClick(handle) {
  const a = handle.audio; if (!a || !a.enabled) return;
  const t = a.ctx.currentTime;
  const o = a.ctx.createOscillator(); o.type = 'square';
  o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(220, t + 0.06);
  const g = a.ctx.createGain(); g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  o.connect(g); g.connect(a.master); o.start(t); o.stop(t + 0.08);
}

// ─────────────────────────── KAMERA SINEMATIK ───────────────────────────
// Spec: cameraPath = { shots: [...], loop?, autoplay? } ATAU { keyframes: [...], duration }
// Shot: { id?, type: orbit|dolly|zoom|crane|path, duration, target?(id objek|[x,y,z]),
//         framing?{object,fill}|preset closeup/medium/wide, ease?, caption?, explode?[from,to], ... }
// Framing terukur: jarak = (ukuranObjek/2) / (tan(fov/2) * fill) — objek mengisi `fill` frame.

const EASE = {
  linear: u => u,
  in: u => u * u * u,
  out: u => 1 - Math.pow(1 - u, 3),
  inOut: u => u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2,
};
const FILL = { closeup: 0.7, medium: 0.4, wide: 0.18, establish: 0.1 };

export function frameDistance(size, fovDeg, fill = 0.5) {
  return (size / 2) / (Math.tan((fovDeg * Math.PI / 180) / 2) * fill);
}

function objWorldPos(handle, t, stable = false) {
  if (Array.isArray(t)) return new THREE.Vector3(...t);
  const m = handle.registry.get(t);
  if (!m) return new THREE.Vector3(0, 2, 0);
  m.updateWorldMatrix(true, false);
  const p = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
  // Shot dengan explode: kunci target ke posisi SEBELUM meledak — kalau tidak,
  // kamera mengejar objek yang ikut bergeser dan subjek tengah 'lari' dari frame.
  if (stable && m.userData.explodeOff) {
    const off = m.userData.explodeOff.clone();
    if (m.parent && m.parent !== handle.scene) {
      off.applyMatrix4(new THREE.Matrix4().extractRotation(m.parent.matrixWorld));
    }
    p.sub(off);
  }
  return p;
}
function objSize(handle, id) {
  const m = handle.registry.get(id);
  if (!m) return 2;
  const box = new THREE.Box3().setFromObject(m);
  const s = box.getSize(new THREE.Vector3());
  return Math.max(0.3, Math.max(s.x, s.y, s.z));
}

export function compileCameraPath(handle) {
  const cp = handle.spec.cameraPath;
  if (!cp) return null;
  const fovBase = handle.spec.camera?.fov ?? 50;
  if (Array.isArray(cp.keyframes) && cp.keyframes.length >= 2) {
    const kfs = cp.keyframes.map(k => ({ t: k.t ?? 0, pos: new THREE.Vector3(...(k.pos || [0, 3, 8])), target: new THREE.Vector3(...(k.target || [0, 2, 0])), fov: k.fov ?? fovBase, caption: k.caption || '' }));
    kfs.sort((a, b) => a.t - b.t);
    const dur = cp.duration ?? kfs[kfs.length - 1].t;
    const posCurve = kfs.length >= 3 ? new THREE.CatmullRomCurve3(kfs.map(k => k.pos)) : null;
    return { mode: 'keyframes', kfs, dur, posCurve, loop: cp.loop !== false, autoplay: cp.autoplay !== false, shots: [] };
  }
  const shots = (cp.shots || []).map((s, i) => {
    const dur = Math.max(0.5, s.duration ?? 4);
    const fov = s.fov ?? fovBase;
    const ease = EASE[s.ease] || EASE.inOut;
    const fill = s.framing?.fill ?? FILL[s.preset] ?? 0.4;
    const frameId = s.framing?.object || (typeof s.target === 'string' ? s.target : null);
    const dist = frameId ? frameDistance(objSize(handle, frameId), fov, fill) : null;
    return { ...s, i, dur, fov, ease, fill, dist, caption: s.caption || '' };
  });
  let acc = 0;
  shots.forEach(s => { s.t0 = acc; acc += s.dur; });
  return { mode: 'shots', shots, dur: acc, loop: cp.loop !== false, autoplay: cp.autoplay !== false };
}

// sample pada waktu t → { pos, target, fov, explode, caption, shotIndex, shotProgress }
export function sampleCameraPath(handle, path, t) {
  if (!path) return null;
  const dur = path.dur || 1;
  let tt = path.loop ? ((t % dur) + dur) % dur : Math.min(t, dur);
  if (path.mode === 'keyframes') {
    const kfs = path.kfs;
    let a = kfs[0], b = kfs[kfs.length - 1];
    for (let i = 0; i < kfs.length - 1; i++) {
      if (tt >= kfs[i].t && tt <= kfs[i + 1].t) { a = kfs[i]; b = kfs[i + 1]; break; }
    }
    const span = Math.max(0.001, b.t - a.t);
    const u = EASE.inOut(Math.min(1, Math.max(0, (tt - a.t) / span)));
    const pos = path.posCurve && kfs.length >= 3
      ? path.posCurve.getPoint(Math.min(1, Math.max(0, tt / dur)))
      : a.pos.clone().lerp(b.pos, u);
    return { pos, target: a.target.clone().lerp(b.target, u), fov: a.fov + (b.fov - a.fov) * u, explode: null, caption: u < 0.5 ? a.caption : b.caption, shotIndex: -1, shotProgress: tt / dur };
  }
  let s = path.shots[path.shots.length - 1];
  for (const sh of path.shots) { if (tt >= sh.t0 && tt < sh.t0 + sh.dur) { s = sh; break; } }
  const rawU = Math.min(1, Math.max(0, (tt - s.t0) / s.dur));
  const u = s.type === 'journey' ? rawU : s.ease(rawU);  // journey meluncur konstan, tanpa akselerasi global
  let sampleCaption = s.caption || '';
  let target = s.target ? objWorldPos(handle, s.target, s.explode != null) : new THREE.Vector3(0, 2, 0);
  const fov = s.fov;
  let pos;
  if (s.type === 'orbit') {
    const r = s.radius ?? s.dist ?? 6;
    const h = s.height ?? r * 0.45;
    const a0 = (s.startAngle ?? 0) * Math.PI / 180;
    const sweep = (s.sweep ?? 360) * Math.PI / 180;
    const a = a0 + sweep * u;
    pos = target.clone().add(new THREE.Vector3(Math.cos(a) * r, h, Math.sin(a) * r));
  } else if (s.type === 'dolly') {
    const from = new THREE.Vector3(...(s.from || [0, 3, 10]));
    const to = new THREE.Vector3(...(s.to || [0, 3, 5]));
    pos = from.lerp(to, u);
  } else if (s.type === 'zoom') {
    const d0 = s.fromDistance ?? (s.dist ?? 6) * 2.2;
    const d1 = s.toDistance ?? s.dist ?? 3;
    const dir = new THREE.Vector3(...(s.direction || [0.6, 0.35, 1])).normalize();
    pos = target.clone().add(dir.multiplyScalar(d0 + (d1 - d0) * u));
  } else if (s.type === 'crane') {
    const base = new THREE.Vector3(...(s.from || [6, 1, 6]));
    const y1 = s.toY ?? 8;
    pos = new THREE.Vector3(base.x, base.y + (y1 - base.y) * u, base.z);
  } else if (s.type === 'path') {
    const pts = (s.points || [[0, 3, 8], [4, 4, 4], [0, 5, -4]]).map(p => new THREE.Vector3(...p));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    pos = curve.getPoint(u);
  } else if (s.type === 'journey') {
    // Satu shot MENYAMBUNG: kamera meluncur dari stop ke stop tanpa cut.
    // stop = {target:id|[x,y,z], fill, distance, offset, hold, caption}
    const stops = s.stops || [];
    const poses = stops.map(st => {
      const tg = st.target ? objWorldPos(handle, st.target) : new THREE.Vector3(...(st.at || [0, 1.5, 0]));
      const id = typeof st.target === 'string' ? st.target : null;
      const size = id ? objSize(handle, id) : 2;
      const dist = st.distance ?? frameDistance(size, fov, st.fill ?? 0.5);
      const dir = new THREE.Vector3(...(st.offset || [0.5, 0.3, 1])).normalize();
      return { tg, p: tg.clone().add(dir.multiplyScalar(dist)), hold: st.hold ?? 0.6, caption: st.caption || '' };
    });
    if (poses.length) {
      let x = u, cur = poses[0];
      if (poses.length > 1) {
        const travelW = 2;
        const total = poses.reduce((a, p) => a + p.hold, 0) + (poses.length - 1) * travelW;
        x = u * total;
        let i = 0;
        while (i < poses.length - 1 && x > poses[i].hold + travelW) { x -= poses[i].hold + travelW; i++; }
        if (x <= poses[i].hold) cur = poses[i];
        else {
          const seg = Math.min(1, Math.max(0, (x - poses[i].hold) / travelW));
          const e = seg * seg * (3 - 2 * seg); // smoothstep — meluncur, bukan memotong
          cur = { tg: poses[i].tg.clone().lerp(poses[i + 1].tg, e),
                  p: poses[i].p.clone().lerp(poses[i + 1].p, e),
                  caption: e < 0.5 ? poses[i].caption : poses[i + 1].caption };
        }
      }
      pos = cur.p;
      target = cur.tg;
      if (cur.caption) sampleCaption = cur.caption;
    } else pos = target.clone().add(new THREE.Vector3(0, 2, 6));
  } else {
    pos = target.clone().add(new THREE.Vector3(0, 2, 6));
  }
  let explode = null;
  if (Array.isArray(s.explode)) explode = s.explode[0] + (s.explode[1] - s.explode[0]) * u;
  else if (typeof s.explode === 'number') explode = s.explode;
  return { pos, target, fov, explode, caption: sampleCaption || s.caption, shotIndex: s.i, shotProgress: u, shot: s };
}

// ─────────────────────────── TOOLKIT BEDAH ASSEMBLY ───────────────────────────
// Semua fitur view — tidak mengubah spec. Dipakai studio DAN export HTML.

// Exploded view hierarkis: root menjauh dari pusat assembly, children menjauh dari pusat group.
// Offset aditif (kurangi offset lama, tambah baru) — aman composing dengan fisika/animasi.
export function applyExplode(handle, factor) {
  const roots = (handle.spec.objects || []).map(o => handle.registry.get(o.id)).filter(Boolean);
  const isScenery = m => m.userData?.isSky || m.name === '__ground' || /^(backdrop|ground|langit|bintang)$/i.test(m.userData?.specId || '');
  // Pusat & radius dari posisi DASAR (bukan posisi terkini) — stabil, tidak drift tiap frame.
  // Pakai MEDIAN per sumbu: dua konektor di ujung kabel tidak menarik pusat menjauh
  // dari inti kabel (mean membuat kawat tengah ikut meledak).
  const coords = [[], [], []];
  for (const m of roots) {
    if (isScenery(m) || !m.userData.basePos) continue;
    const b = m.userData.basePos;
    coords[0].push(b.x); coords[1].push(b.y); coords[2].push(b.z);
  }
  const n = coords[0].length;
  if (!n) return;
  const center = new THREE.Vector3();
  for (let i = 0; i < 3; i++) {
    coords[i].sort((a, b) => a - b);
    const mid = n >> 1;
    center.setComponent(i, n % 2 ? coords[i][mid] : (coords[i][mid - 1] + coords[i][mid]) / 2);
  }
  let radius = 0.5;
  for (const m of roots) {
    if (isScenery(m) || !m.userData.basePos) continue;
    radius = Math.max(radius, m.userData.basePos.distanceTo(center));
  }
  radius *= 0.75;
  const off = (m, c, r, idx) => {
    const base = m.userData.basePos;
    if (!base) return;
    const dir = base.clone().sub(c);
    const prev = m.userData.explodeOff || new THREE.Vector3();
    m.position.sub(prev);
    // Anchor: objek di sekitar pusat assembly (kawat dalam, inti kabel) TIDAK boleh
    // terbang menjauh — kalau tidak, 'titik tengah' bergeser saat exploded/shoot.
    // Dengan inti diam & jaket menjauh, isi dalam justru terbuka dengan sendirinya.
    const anchorR = Math.max(0.2, r * 0.3);
    if (dir.length() < anchorR) { m.userData.explodeOff = new THREE.Vector3(); return; }
    dir.normalize();
    // Bias vertikal: part tidak menusuk lantai — sebar horizontal/atas.
    // Arah lurus ke bawah perlu komponen horizontal dulu (renormalisasi saja mengembalikan -1).
    if (dir.y < -0.1) {
      if (Math.hypot(dir.x, dir.z) < 1e-3) { const a = idx * 2.39996; dir.x = Math.cos(a); dir.z = Math.sin(a); }
      dir.y = -0.1;
      dir.normalize();
    }
    const next = dir.multiplyScalar(factor * r);
    // Clamp root ke atas lantai HANYA saat benar-benar meledak — di factor 0
    // clamp ini menggeser objek (posisi y=0 → 0.05) setiap kali tombol Rapat ditekan.
    if (factor > 0 && m.parent === handle.scene && base.y + next.y < 0.05) next.y = 0.05 - base.y;
    m.position.add(next);
    m.userData.explodeOff = next;
  };
  roots.forEach((m, i) => {
    if (isScenery(m)) return;
    off(m, center, radius, i);
    if (m.type === 'Group' && m.children.length) {
      const lc = new THREE.Vector3();
      let cn = 0;
      m.children.forEach(ch => { if (ch.userData.basePos) { lc.add(ch.userData.basePos); cn++; } });
      if (!cn) return;
      lc.divideScalar(cn);
      const lr = Math.max(0.3, m.children.reduce((acc, ch) => Math.max(acc, (ch.userData.basePos || ch.position).distanceTo(lc)), 0)) * 1.1;
      m.children.forEach((ch, j) => off(ch, lc, lr, j));
    }
  });
}

// Section / cutaway: clipping plane global (semua material terpotong, lihat isi dalam)
export function setSection(handle, renderer, opts) {
  disposeCaps(handle);
  // pulihkan side material semula
  handle.scene.traverse(m => {
    if (m.isMesh && m.userData.sectionOrigSide !== undefined) {
      m.material.side = m.userData.sectionOrigSide;
      delete m.userData.sectionOrigSide;
    }
  });
  if (!opts || !opts.enabled) { renderer.clippingPlanes = []; return; }
  renderer.localClippingEnabled = true;
  const n = { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] }[opts.axis || 'x'];
  const normal = new THREE.Vector3(...n).multiplyScalar(opts.flip ? -1 : 1);
  const plane = new THREE.Plane(normal, (opts.pos ?? 0) * (opts.flip ? -1 : 1));
  renderer.clippingPlanes = [plane];
  // DoubleSide WAJIB: dari sisi potong, dinding dalam half yang tersisa adalah backface
  // (FrontSide = culled = solid "hilang"). DoubleSide menampilkan dinding dalam irisan.
  handle.scene.traverse(m => {
    if (m.isMesh && m.material && m.userData.sectionOrigSide === undefined) {
      m.userData.sectionOrigSide = m.material.side;
      m.material.side = THREE.DoubleSide;
    }
  });
  if (opts.caps !== false) buildCaps(handle, plane);
}

// ── Section caps: irisan terlihat SOLID (teknik stencil three.js) ──
function buildCaps(handle, plane) {
  const groups = [];
  const box = new THREE.Box3();
  handle.scene.traverse(m => {
    if (!m.isMesh || m.userData?.isSky || m.name === '__ground' || m.parent?.name === '__labels') return;
    if (!m.geometry) return;
    // Hanya solid TERTUTUP — geometri terbuka (plane/ring) merusak stencil → cap bocor jadi dinding raksasa
    if (/Plane|Ring|Shape/.test(m.geometry.type)) return;
    if (/^(backdrop|ground|jalan|trotoar|langit|bintang)/i.test(m.userData?.specId || '')) return;
    box.setFromObject(m);
    if (box.isEmpty()) return;
    // hanya mesh yang benar-benar terpotong plane
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() * 0.5;
    if (Math.abs(plane.distanceToPoint(c)) > r) return;
    const g = new THREE.Group();
    const base = new THREE.MeshBasicMaterial();
    base.depthWrite = false; base.depthTest = false; base.colorWrite = false;
    base.stencilWrite = true; base.stencilFunc = THREE.AlwaysStencilFunc;
    const m0 = base.clone(); m0.side = THREE.BackSide; m0.clippingPlanes = [plane];
    m0.stencilFail = m0.stencilZFail = m0.stencilZPass = THREE.IncrementWrapStencilOp;
    const m1 = base.clone(); m1.side = THREE.FrontSide; m1.clippingPlanes = [plane];
    m1.stencilFail = m1.stencilZFail = m1.stencilZPass = THREE.DecrementWrapStencilOp;
    const a = new THREE.Mesh(m.geometry, m0); a.renderOrder = 1;
    const b = new THREE.Mesh(m.geometry, m1); b.renderOrder = 1;
    g.add(a, b);
    g.matrixAutoUpdate = false;
    handle.scene.add(g);
    groups.push({ src: m, g });
  });
  // satu bidang cap global menutup semua irisan
  const capGeo = new THREE.PlaneGeometry(400, 400);
  const capMat = new THREE.MeshBasicMaterial({
    color: 0xd0d4dc, side: THREE.DoubleSide,
    stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
  });
  const cap = new THREE.Mesh(capGeo, capMat);
  cap.renderOrder = 2;
  cap.onAfterRender = (r) => r.clearStencil();
  plane.coplanarPoint(cap.position);
  cap.lookAt(cap.position.x - plane.normal.x, cap.position.y - plane.normal.y, cap.position.z - plane.normal.z);
  handle.scene.add(cap);
  handle.capSystem = { groups, cap, plane };
  syncCaps(handle);
}
// sync transform grup stencil mengikuti mesh sumber (fisika/animasi/explore) — panggil tiap frame
export function syncCaps(handle) {
  const cs = handle.capSystem;
  if (!cs) return;
  for (const { src, g } of cs.groups) {
    src.updateWorldMatrix(true, false);
    g.matrix.copy(src.matrixWorld);
    g.matrixWorldNeedsUpdate = true;
  }
}
function disposeCaps(handle) {
  const cs = handle.capSystem;
  if (!cs) return;
  for (const { g } of cs.groups) {
    handle.scene.remove(g);
    g.children.forEach(c => c.material.dispose());
  }
  handle.scene.remove(cs.cap);
  cs.cap.geometry.dispose(); cs.cap.material.dispose();
  handle.capSystem = null;
}

// X-ray: semua part transpar kecuali yang dipilih (lihat internals di sekitar part)
export function setXray(handle, enabled, exceptId) {
  handle.scene.traverse(m => {
    if (!m.isMesh || m.userData?.isSky || m.name === '__ground') return;
    if (enabled) {
      if (!m.userData.xrayOrig) m.userData.xrayOrig = { t: m.material.transparent, o: m.material.opacity, d: m.material.depthWrite };
      const keep = exceptId && (m.userData.specId === exceptId || isDescendantOf(m, handle.registry.get(exceptId)));
      m.material.transparent = true;
      m.material.opacity = keep ? (m.userData.xrayOrig.o ?? 1) : 0.18;
      m.material.depthWrite = !!keep;
    } else if (m.userData.xrayOrig) {
      m.material.transparent = m.userData.xrayOrig.t;
      m.material.opacity = m.userData.xrayOrig.o;
      m.material.depthWrite = m.userData.xrayOrig.d;
      delete m.userData.xrayOrig;
    }
    m.material.needsUpdate = true;
  });
}
function isDescendantOf(m, root) {
  if (!root) return false;
  let p = m.parent;
  while (p) { if (p === root) return true; p = p.parent; }
  return false;
}

// Isolate: sembunyikan semua kecuali part terpilih (solo view)
export function setIsolate(handle, enabled, id) {
  const roots = (handle.spec.objects || []).map(o => handle.registry.get(o.id)).filter(Boolean);
  if (enabled && id) {
    let target = handle.registry.get(id);
    while (target && target.parent && target.parent !== handle.scene) target = target.parent;
    for (const m of roots) {
      if (m.userData.isolateOrig === undefined) m.userData.isolateOrig = m.visible;
      m.visible = (m === target);
    }
  } else {
    for (const m of roots) {
      if (m.userData.isolateOrig !== undefined) { m.visible = m.userData.isolateOrig; delete m.userData.isolateOrig; }
    }
  }
}

// Label nama part (sprite teks di atas tiap objek root)
export function makeLabels(handle) {
  if (handle.labelGroup) return handle.labelGroup;
  const g = new THREE.Group();
  g.name = '__labels';
  for (const o of handle.spec.objects || []) {
    const m = handle.registry.get(o.id);
    if (!m || m.userData?.isSky) continue;
    const box = new THREE.Box3().setFromObject(m);
    if (box.isEmpty()) continue;
    const c = box.getCenter(new THREE.Vector3());
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 96;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(15,17,22,0.82)';
    ctx.beginPath(); ctx.roundRect(4, 4, 504, 88, 16); ctx.fill();
    ctx.font = '600 44px system-ui'; ctx.fillStyle = '#cfd3dc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((o.name || o.id).slice(0, 28), 256, 50);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(1.6, 0.3, 1);
    sp.position.set(c.x, box.max.y + 0.35, c.z);
    sp.renderOrder = 999;
    g.add(sp);
  }
  g.visible = false;
  handle.scene.add(g);
  handle.labelGroup = g;
  return g;
}

export function disposeHandle(handle) {
  handle.scene.traverse(o => {
    if (o.isMesh) {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => { m?.map?.dispose(); m?.dispose(); });
    }
  });
}
