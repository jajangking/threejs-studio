// scene-builder.js — SINGLE SOURCE OF TRUTH
// Dipakai oleh studio (index.html) DAN renderer headless (render.html).
// Spec JSON yang sama => scene identik di viewport user dan di screenshot agent.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';
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
      const gb = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, (g.y ?? 0) - 0.05, 0));
      physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid((g.size ?? 60) / 2, 0.05, (g.size ?? 60) / 2).setFriction(0.8), gb);
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
          if (kind === 'dynamic') { desc.setLinearDamping(ph.linearDamping ?? 0.05); desc.setAngularDamping(ph.angularDamping ?? 0.05); }
          const body = physicsWorld.createRigidBody(desc);
          physicsWorld.createCollider(colliderFor(o, mesh), body);
          body.userData = { init: { p: mesh.position.clone(), q: mesh.quaternion.clone() }, nanCount: 0 };
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

  // Kontrol interaktif (slider/toggle) — nilai liveOverrides di atas spec
  const overrides = {};
  for (const c of spec.controls || []) {
    if (!c.target) continue;
    overrides[c.target] = overrides[c.target] || {};
    if (c.type === 'toggle') overrides[c.target].enabled = c.default ?? true;
    else overrides[c.target][c.param || 'speed'] = c.default ?? c.min ?? 0;
  }
  return { scene, camera, target, registry, errors, spec, animations, overrides, physicsWorld, bodyMap };
}

// Renderer dengan pengaturan warna & tone mapping yang BENAR (anti warna pucat).
export function makeRenderer(canvas, w, h, opts = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true,
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
  if (!post || !post.bloom) return null;
  const composer = new EffectComposer(renderer);
  composer.setSize(w, h);
  composer.addPass(new RenderPass(handle.scene, handle.camera));
  const b = post.bloom;
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), b.strength ?? 0.5, b.radius ?? 0.5, b.threshold ?? 0.75));
  composer.addPass(new OutputPass());
  return composer;
}

// Frame kamera otomatis dari bounding box scene (anti objek di luar frame / kamera di dalam objek).
export function frameCamera(camera, target, scene, controls, opts = {}) {
  const box = new THREE.Box3();
  scene.traverse(o => { if (o.isMesh && o.visible && o.name !== '__ground' && !o.userData?.isSky) box.expandByObject(o); });
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
export function smokeCheck(handle, renderer) {
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
  add('objects_in_view', outView.length === 0, outView.length ? `di luar frame: ${outView.join(', ')}` : `${inView.length} objek dalam frame`);

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
  w.step();
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

// ─────────────────────────── TOOLKIT BEDAH ASSEMBLY ───────────────────────────
// Semua fitur view — tidak mengubah spec. Dipakai studio DAN export HTML.

// Exploded view hierarkis: root menjauh dari pusat assembly, children menjauh dari pusat group.
// Offset aditif (kurangi offset lama, tambah baru) — aman composing dengan fisika/animasi.
export function applyExplode(handle, factor) {
  const roots = (handle.spec.objects || []).map(o => handle.registry.get(o.id)).filter(Boolean);
  const box = new THREE.Box3();
  for (const m of roots) { if (m.userData?.isSky || m.name === '__ground') continue; box.expandByObject(m); }
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() * 0.28);
  const off = (m, c, r, idx) => {
    const base = m.userData.basePos;
    if (!base) return;
    const dir = base.clone().sub(c);
    if (dir.lengthSq() < 1e-6) { const a = idx * 2.39996; dir.set(Math.cos(a), 0.35, Math.sin(a)); }
    dir.normalize();
    const prev = m.userData.explodeOff || new THREE.Vector3();
    m.position.sub(prev);
    const next = dir.multiplyScalar(factor * r);
    m.position.add(next);
    m.userData.explodeOff = next;
  };
  roots.forEach((m, i) => {
    if (m.userData?.isSky || m.name === '__ground') return;
    off(m, center, radius, i);
    if (m.type === 'Group' && m.children.length) {
      const lc = new THREE.Vector3();
      m.children.forEach(ch => lc.add(ch.userData.basePos || ch.position));
      lc.divideScalar(m.children.length);
      const lr = Math.max(0.3, m.children.reduce((acc, ch) => Math.max(acc, (ch.userData.basePos || ch.position).distanceTo(lc)), 0)) * 1.2;
      m.children.forEach((ch, j) => off(ch, lc, lr, j));
    }
  });
}

// Section / cutaway: clipping plane global (semua material terpotong, lihat isi dalam)
export function setSection(handle, renderer, opts) {
  if (!opts || !opts.enabled) { renderer.clippingPlanes = []; return; }
  const n = { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] }[opts.axis || 'x'];
  const normal = new THREE.Vector3(...n).multiplyScalar(opts.flip ? -1 : 1);
  renderer.clippingPlanes = [new THREE.Plane(normal, (opts.pos ?? 0) * (opts.flip ? -1 : 1))];
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
