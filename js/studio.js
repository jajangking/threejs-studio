// studio.js — workspace mirip Blender: outliner, viewport, inspector,
// panel kontrak/checklist/iterasi/konsol/feedback. Sinkron dengan agent via /api/state.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TransformControls } from '../vendor/TransformControls.js';
import { GLTFExporter } from '../vendor/GLTFExporter.js';
import { buildScene, makeRenderer, makeComposer, frameCamera, smokeCheck, disposeHandle, applyAnimations, stepPhysics, applyExplode, setSection, setXray, setIsolate, makeLabels, syncCaps, resetPhysics, compileCameraPath, sampleCameraPath, applyExplosion, startDrag, moveDrag, endDrag, makeAudio, updateAudio, audioClick } from './scene-builder.js';

const $ = s => document.querySelector(s);
const deg = THREE.MathUtils.degToRad, rad2deg = THREE.MathUtils.radToDeg;
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

// ── state ──
let spec = null, handle = null, renderer, orbit, gizmo, grid;
let selectedId = null, dirty = false, lastMtime = 0, serverState = null;
let iterations = [], cmpSel = [], consoleErrors = 0, liveReport = null;
let dragging = false, downPos = null;
// ── Undo/redo drag gizmo (snapshot transform sebelum & sesudah drag) ──
const HISTORY = [];
let histIndex = 0, dragBefore = null;
let animT = 0, animPlaying = true, powerOn = true, physAcc = 0;
let explodeFactor = 0, lastExplode = 0, xrayOn = false, isolateOn = false, labelsOn = false;
let sectionOpts = { enabled: false, axis: 'x', pos: 0, flip: false, caps: true };
let measureMode = false, measurePts = [], measureGroup = null;
let cinePath = null, cinePlaying = false, cineT = 0, cineExplode = null;
let audioOn = false;
const clock = new THREE.Clock();

// ── responsif: drawer mobile ──
const mqMobile = window.matchMedia('(max-width:639px)');
const mqTablet = window.matchMedia('(max-width:1023px)');
function closeDrawers() {
  document.body.classList.remove('drawer-outliner', 'drawer-inspector');
}
function toggleDrawer(which) {
  const cls = 'drawer-' + which;
  const open = !document.body.classList.contains(cls);
  closeDrawers();
  if (open) document.body.classList.add(cls);
}
$('#btnDrawerOutliner').onclick = () => toggleDrawer('outliner');
$('#btnDrawerInspector').onclick = () => toggleDrawer('inspector');
$('#drawerBackdrop').onclick = closeDrawers;
window.addEventListener('resize', () => { if (!mqMobile.matches) closeDrawers(); });

// ── console capture ──
const conLog = $('#consoleLog');
function log(msg, cls = 'dim') {
  const t = new Date().toLocaleTimeString('id-ID');
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${t}] ${msg}`;
  conLog.appendChild(div);
  conLog.parentElement.scrollTop = conLog.parentElement.scrollHeight;
}
window.addEventListener('error', e => { consoleErrors++; log('ERROR: ' + e.message, 'err'); updErrBadge(); });
window.addEventListener('unhandledrejection', e => { consoleErrors++; log('REJECTION: ' + (e.reason?.message || e.reason), 'err'); updErrBadge(); });
function updErrBadge() { const b = $('#errBadge'); b.style.display = consoleErrors ? '' : 'none'; b.textContent = consoleErrors; }

function toast(msg, ms = 2600) {
  const t = $('#vpToast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}

// ── three setup (boot dari default, bukan dari fetch — hindari blank boot) ──
const canvas = $('#viewport');
const wrap = $('#viewportWrap');
renderer = makeRenderer(canvas, wrap.clientWidth || 800, wrap.clientHeight || 600, { preserveDrawingBuffer: true });
const bootScene = new THREE.Scene();
bootScene.background = new THREE.Color('#0d1017');
const bootCam = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
bootCam.position.set(6, 4, 8);
orbit = new OrbitControls(bootCam, canvas);
orbit.enableDamping = true; orbit.dampingFactor = 0.08;
orbit.target.set(0, 1, 0);
grid = new THREE.GridHelper(60, 60, 0x3a4152, 0x232833);
grid.name = '__grid';
bootScene.add(grid);
gizmo = new TransformControls(bootCam, canvas);
gizmo.addEventListener('dragging-changed', e => {
  orbit.enabled = !e.value; dragging = e.value;
  if (e.value && selectedId) {
    const o = spec?.objects?.find(x => x.id === selectedId);
    if (o) dragBefore = { id: o.id, p: [...o.position], r: [...o.rotation], s: [...o.scale] };
  } else if (!e.value && dragBefore) {
    const o = spec?.objects?.find(x => x.id === dragBefore.id);
    if (o) {
      const after = { id: o.id, p: [...o.position], r: [...o.rotation], s: [...o.scale] };
      if (JSON.stringify(after) !== JSON.stringify(dragBefore)) {
        HISTORY.splice(histIndex);
        HISTORY.push({ before: dragBefore, after });
        if (HISTORY.length > 30) HISTORY.shift();
        histIndex = HISTORY.length;
        updateHistoryUI();
        toast('↶ Posisi tercatat — Ctrl+Z untuk undo');
      }
    }
    dragBefore = null;
  }
});
gizmo.addEventListener('objectChange', () => {
  if (!gizmo.object || !selectedId) return;
  const o = spec?.objects?.find(x => x.id === selectedId);
  const m = gizmo.object;
  if (o) {
    o.position = m.position.toArray().map(v => round(v));
    o.rotation = [m.rotation.x, m.rotation.y, m.rotation.z].map(v => round(rad2deg(v), 2));
    o.scale = m.scale.toArray().map(v => round(v));
    markDirty(); renderInspector();
  }
});
bootScene.add(gizmo);

new ResizeObserver(() => {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  handle?.composer?.setSize(w, h);
  const cam = handle?.camera || bootCam;
  cam.aspect = w / h; cam.updateProjectionMatrix();
}).observe(wrap);

// ── render loop ──
let frames = 0, statT = 0;
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (handle?.physicsWorld && animPlaying && explodeFactor === 0) {
    physAcc += dt;
    let n = 0;
    while (physAcc >= 1 / 60 && n < 4) { stepPhysics(handle, 1 / 60); physAcc -= 1 / 60; n++; }
  }
  if (handle?.animations?.length) {
    if (animPlaying) animT += dt;
    applyAnimations(handle, animT, powerOn);
  }
  if (handle && !cinePlaying && (explodeFactor > 0 || lastExplode > 0)) {
    applyExplode(handle, explodeFactor);
    lastExplode = explodeFactor;
  }
  if (handle?.capSystem) syncCaps(handle);
  if (handle?.powerTriggered) { handle.powerTriggered = false; powerOn = !powerOn; updateVpControls(); audioClick(handle); toast('⚡ Trigger: power berubah'); }

  // produksi (tur/timeline/audio) ada di Studio Rekaman (/rekaman)
  orbit.update();
  const cam = handle?.camera || bootCam;
  const sc = handle?.scene || bootScene;
  if (handle?.composer) handle.composer.render(); else renderer.render(sc, cam);
  frames++;
  const now = performance.now();
  if (now - statT > 600) {
    const fps = Math.round(frames * 1000 / (now - statT));
    $('#vpStats').textContent = `${fps} fps · ${renderer.info.render.calls} draws · ${renderer.info.render.triangles.toLocaleString('id')} tris`;
    frames = 0; statT = now;
  }
}
animate();

// ── build / rebuild ──
async function rebuild(newSpec, announce) {
  if (handle) { gizmo.detach(); disposeHandle(handle); }
  spec = newSpec;
  handle = await buildScene(spec);
  handle.scene.add(grid);
  handle.scene.add(gizmo);
  handle.camera.aspect = wrap.clientWidth / Math.max(1, wrap.clientHeight);
  handle.camera.updateProjectionMatrix();
  handle.composer = makeComposer(handle, renderer, wrap.clientWidth, Math.max(1, wrap.clientHeight));
  animT = 0; animPlaying = true; powerOn = spec.power?.default ?? true; physAcc = 0;
  explodeFactor = 0; lastExplode = 0; xrayOn = false; isolateOn = false; labelsOn = false;
  sectionOpts = { enabled: false, axis: 'x', pos: 0, flip: false, caps: true };
  renderer.clippingPlanes = [];
  measureMode = false; measurePts = [];
  if (measureGroup) { handle?.scene.remove(measureGroup); measureGroup = null; }
  if (audioOn) { const a = makeAudio(handle); if (a) a.ctx.resume(); }
  cinePath = compileCameraPath(handle);
  cineT = 0; cineExplode = null;
  cinePlaying = false;  // tur sinematik = wilayah Studio Rekaman
  orbit.enabled = true;
  HISTORY.length = 0; histIndex = 0; updateHistoryUI();
  updateVpControls(); renderBedahPanel();
  orbit.object = handle.camera;
  orbit.target.copy(handle.target);
  orbit.update();
  gizmo.camera = handle.camera;
  handle.errors.forEach(e => log('BUILD: ' + e, 'err'));
  if (handle.errors.length) { consoleErrors += handle.errors.length; updErrBadge(); }
  $('#sceneName').textContent = spec.meta?.name || 'scene';
  document.title = `${spec.meta?.name || 'scene'} — Three.js Studio`;
  renderOutliner(); renderInspector();
  if (selectedId && handle.registry.has(selectedId)) gizmo.attach(handle.registry.get(selectedId));
  else { selectedId = null; gizmo.detach(); }
  if (announce) toast(announce);
  log(`scene dimuat: ${spec.meta?.name} (${(spec.objects || []).length} objek, ${(spec.lights || []).length} lampu)`, 'ok');
}

function markDirty() { dirty = true; $('#btnSave').disabled = false; $('#syncDot').classList.add('stale'); }
function clearDirty() { dirty = false; $('#btnSave').disabled = true; $('#syncDot').classList.remove('stale'); $('#dirtyBanner').classList.remove('show'); }
$('#btnSave').disabled = true;

// ── outliner ──
const TYPE_ICO = { box: '▣', sphere: '◉', cylinder: '⬭', cone: '▲', torus: '◎', torusKnot: '✿', plane: '▭', capsule: '⬮', icosahedron: '⬟', ring: '◍', gltf: '🧊' };
const LIGHT_ICO = { ambient: '☀', hemisphere: '◐', directional: '⇢', point: '✦', spot: '▽' };
function renderOutliner() {
  const el = $('#outlinerList'); el.innerHTML = '';
  $('#olCount').textContent = `${(spec.objects || []).length} obj`;
  const sec = t => { const d = document.createElement('div'); d.className = 'ol-section'; d.textContent = t; el.appendChild(d); };
  const item = (id, ico, name, opts = {}) => {
    const d = document.createElement('div');
    d.className = 'ol-item' + (id === selectedId ? ' selected' : '');
    d.innerHTML = `<span class="ico">${ico}</span><span class="nm"></span>` + (opts.eye ? `<span class="eye${opts.visible === false ? ' off' : ''}">👁</span>` : '');
    d.querySelector('.nm').textContent = name;
    d.onclick = e => {
      if (e.target.classList.contains('eye')) { toggleVisible(id); e.stopPropagation(); return; }
      select(id);
    };
    el.appendChild(d);
  };
  sec('Objek');
  (spec.objects || []).forEach(o => item(o.id, TYPE_ICO[o.type] || '▣', o.name || o.id, { eye: true, visible: o.visible }));
  sec('Lampu');
  (spec.lights || []).forEach((l, i) => item(l.id || `light-${i}`, LIGHT_ICO[l.type] || '✦', `${l.id || l.type} (${l.type})`));
  sec('Scene');
  item('__camera', '🎥', 'Kamera');
  item('__env', '🌍', 'Lingkungan');
}
function toggleVisible(id) {
  const o = spec.objects.find(x => x.id === id); if (!o) return;
  o.visible = o.visible === false ? true : false;
  const m = handle.registry.get(id); if (m) m.visible = o.visible;
  markDirty(); renderOutliner();
}
function select(id) {
  selectedId = id;
  const m = handle?.registry.get(id);
  if (m && m.isMesh) gizmo.attach(m); else gizmo.detach();
  renderOutliner(); renderInspector(); updateChatTarget();
  if (xrayOn && handle) setXray(handle, true, id);
  if (isolateOn && handle) setIsolate(handle, true, id);
  if (mqMobile.matches && id) closeDrawers();  // pilih objek -> kembali ke viewport
}

function updateChatTarget() {
  const el = $('#chatTarget'); if (!el) return;
  el.innerHTML = '';
  if (!selectedId) return;
  const o = (spec?.objects || []).find(x => x.id === selectedId);
  const span = document.createElement('span');
  span.textContent = '🎯 Target agent: ' + selectedId + (o?.name && o.name !== selectedId ? ' (' + o.name + ')' : '');
  const x = document.createElement('button');
  x.textContent = '✕'; x.title = 'Lepas target (agent bebas memilih)';
  x.onclick = () => select(null);
  el.appendChild(span); el.appendChild(x);
}

// ── inspector ──
function inp(type, value, cls, onch, extra = '') {
  const i = document.createElement('input');
  i.type = type; i.value = value; if (cls) i.className = cls;
  if (extra) i.setAttribute('style', extra);
  i.addEventListener('change', () => onch(i.type === 'number' ? parseFloat(i.value) || 0 : i.value));
  if (type === 'range') i.addEventListener('input', () => onch(parseFloat(i.value)));
  return i;
}
function row(lbl, ...els) {
  const d = document.createElement('div'); d.className = 'insp-row';
  const l = document.createElement('span'); l.className = 'lbl'; l.textContent = lbl;
  d.appendChild(l); els.forEach(e => d.appendChild(e)); return d;
}
function vec3(arr, cls, onch) {
  const d = document.createElement('div'); d.className = 'vec3';
  ['x', 'y', 'z'].forEach((ax, i) => {
    const n = inp('number', round(arr[i] ?? 0), `axis-${ax}`, v => { const a = [...arr]; a[i] = v; onch(a); });
    n.step = 0.1; d.appendChild(n);
  });
  return d;
}
function group(title) {
  const g = document.createElement('div'); g.className = 'insp-group';
  const l = document.createElement('label'); l.textContent = title; g.appendChild(l); return g;
}
function renderInspector() {
  const el = $('#inspBody'); el.innerHTML = '';
  if (!spec) return;
  if (!selectedId) { el.innerHTML = '<div class="insp-empty">Pilih objek di outliner atau viewport.<br><br>Klik dua kartu di tab Iterasi untuk membandingkan hasil agent.</div>'; return; }
  const agentBtn = document.createElement('button');
  agentBtn.textContent = '🤖 Edit bagian ini via Agent';
  agentBtn.style.cssText = 'width:100%;margin-bottom:10px;padding:8px';
  agentBtn.title = 'Buka tab Agent dengan objek ini sebagai target';
  agentBtn.onclick = () => { openTab('agent'); setTimeout(() => $('#chatText').focus(), 350); };
  el.appendChild(agentBtn);
  const obj = spec.objects?.find(o => o.id === selectedId);
  const li = (spec.lights || []).findIndex(l => (l.id || '') === selectedId);
  const light = li >= 0 ? spec.lights[li] : null;

  if (obj) {
    const m = handle.registry.get(obj.id);
    const g1 = group(`Objek · ${obj.type}`);
    g1.appendChild(row('Posisi', vec3(obj.position || [0, 0, 0], '', a => { obj.position = a; m.position.fromArray(a); markDirty(); })));
    g1.appendChild(row('Rotasi°', vec3(obj.rotation || [0, 0, 0], '', a => { obj.rotation = a; m.rotation.set(deg(a[0]), deg(a[1]), deg(a[2])); markDirty(); })));
    const sc = Array.isArray(obj.scale) ? obj.scale : [obj.scale ?? 1, obj.scale ?? 1, obj.scale ?? 1];
    g1.appendChild(row('Skala', vec3(sc, '', a => { obj.scale = a; m.scale.fromArray(a); markDirty(); })));
    el.appendChild(g1);
    if (obj.type !== 'gltf') {
      const mat = obj.material = obj.material || {};
      const g2 = group('Material');
      g2.appendChild(row('Warna', inp('color', mat.color || '#b8bcc4', '', v => { mat.color = v; m.material.color.set(v); markDirty(); })));
      g2.appendChild(row('Metal', inp('range', mat.metalness ?? 0.1, '', v => { mat.metalness = v; m.material.metalness = v; markDirty(); }), ));
      g2.appendChild(row('Rough', inp('range', mat.roughness ?? 0.6, '', v => { mat.roughness = v; m.material.roughness = v; markDirty(); })));
      g2.appendChild(row('Emisif', inp('color', mat.emissive || '#000000', '', v => { mat.emissive = v; m.material.emissive.set(v); markDirty(); })));
      g2.appendChild(row('Kuat emis', inp('number', mat.emissiveIntensity ?? 1, '', v => { mat.emissiveIntensity = v; m.material.emissiveIntensity = v; markDirty(); })));
      g2.appendChild(row('Opasitas', inp('range', mat.opacity ?? 1, '', v => { mat.opacity = v; m.material.transparent = v < 1; m.material.opacity = v; markDirty(); })));
      el.appendChild(g2);
    }
    return;
  }
  if (light) {
    const L = handle.registry.get(light.id || light.type);
    const g = group(`Lampu · ${light.type}`);
    g.appendChild(row('Warna', inp('color', light.color || '#ffffff', '', v => { light.color = v; L?.color.set(v); markDirty(); })));
    g.appendChild(row('Intensitas', inp('number', light.intensity ?? 1, '', v => { light.intensity = v; if (L) L.intensity = v; markDirty(); })));
    if (light.position) g.appendChild(row('Posisi', vec3(light.position, '', a => { light.position = a; L?.position.fromArray(a); markDirty(); })));
    el.appendChild(g); return;
  }
  if (selectedId === '__camera') {
    const c = spec.camera = spec.camera || {};
    const g = group('Kamera');
    g.appendChild(row('FOV', inp('number', c.fov ?? 50, '', v => { c.fov = v; handle.camera.fov = v; handle.camera.updateProjectionMatrix(); markDirty(); })));
    g.appendChild(row('Posisi', vec3(c.position || [6, 4, 8], '', a => { c.position = a; handle.camera.position.fromArray(a); markDirty(); })));
    g.appendChild(row('Target', vec3(c.target || [0, 1, 0], '', a => { c.target = a; orbit.target.fromArray(a); handle.target.fromArray(a); markDirty(); })));
    el.appendChild(g); return;
  }
  if (selectedId === '__env') {
    const env = spec.environment = spec.environment || {};
    const g = group('Lingkungan');
    g.appendChild(row('Background', inp('color', env.background || '#0d1017', '', v => { env.background = v; handle.scene.background.set(v); markDirty(); })));
    const fog = env.fog = env.fog || { color: env.background || '#0d1017', near: 15, far: 60 };
    g.appendChild(row('Fog warna', inp('color', fog.color || '#0d1017', '', v => { fog.color = v; if (handle.scene.fog) handle.scene.fog.color.set(v); else handle.scene.fog = new THREE.Fog(v, fog.near, fog.far); markDirty(); })));
    g.appendChild(row('Fog near', inp('number', fog.near ?? 15, '', v => { fog.near = v; if (handle.scene.fog) handle.scene.fog.near = v; markDirty(); })));
    g.appendChild(row('Fog far', inp('number', fog.far ?? 60, '', v => { fog.far = v; if (handle.scene.fog) handle.scene.fog.far = v; markDirty(); })));
    if (env.ground) g.appendChild(row('Ground', inp('color', env.ground.color || '#1a1e26', '', v => { env.ground.color = v; handle.registry.get('__ground')?.material.color.set(v); markDirty(); })));
    el.appendChild(g);
  }
}

// ── foto referensi → scene ──
$('#btnRef').onclick = () => $('#refFile').click();
$('#refFile').onchange = async () => {
  const f = $('#refFile').files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = async () => {
    toast('Menganalisis foto dengan vision…');
    try {
      const r = await fetch('/api/reference', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: reader.result, name: f.name }) }).then(x => x.json());
      const th = $('#refThumb');
      th.style.display = 'flex';
      th.innerHTML = `<img src="${reader.result}"><span>${r.analyzed ? 'Referensi aktif — agent akan membangun mendekati foto ini' : 'Foto tersimpan (analisis vision tidak tersedia — agent lihat deskripsi manual)'}</span><button title="Hapus referensi">✕</button>`;
      th.querySelector('button').onclick = async () => { await fetch('/api/reference/clear', { method: 'POST' }); th.style.display = 'none'; th.innerHTML = ''; toast('Referensi dihapus'); };
      toast(r.analyzed ? 'Foto dianalisis — kirim prompt untuk membangun' : 'Foto tersimpan');
    } catch (e) { toast('Upload gagal: ' + e.message); }
  };
  reader.readAsDataURL(f);
};

// ── aksi klik objek (spec.onClick) ──
function doClickAction(o) {
  const act = o?.onClick;
  if (!act || !handle) return false;
  if (act.action === 'power') { powerOn = !powerOn; audioClick(handle); updateVpControls(); toast(powerOn ? '⚡ Nyala' : '⏻ Mati'); }
  else if (act.action === 'impulse') { const b = handle.bodyMap?.get(o.id); if (b && act.impulse) b.applyImpulse({ x: act.impulse[0], y: act.impulse[1], z: act.impulse[2] }, true); }
  else if (act.action === 'explode') { const n = applyExplosion(handle, act.center || o.position || [0, 1, 0], act.force ?? 8, act.radius ?? 5); toast(`💥 ${n} body terdorong`); }
  else if (act.action === 'toggle') { const m = handle.registry.get(o.id); if (m) m.visible = !m.visible; }
  else return false;
  return true;
}

// ── undo/redo drag komponen ──
function applyTransform(t, id) {
  const o = spec?.objects?.find(x => x.id === id);
  if (!o) return;
  o.position = [...t.p]; o.rotation = [...t.r]; o.scale = [...t.s];
  const m = handle?.registry?.get(id);
  if (m) {
    m.position.fromArray(t.p);
    m.rotation.set(t.r[0] * Math.PI / 180, t.r[1] * Math.PI / 180, t.r[2] * Math.PI / 180);
    m.scale.fromArray(t.s);
    if (m.userData.explodeOff) m.position.add(m.userData.explodeOff);
  }
  if (m && gizmo.object === m) gizmo.attach(m);
  renderInspector(); markDirty();
}
function updateHistoryUI() {
  const el = $('#vpHistory'); if (!el) return;
  el.innerHTML = '';
  const u = document.createElement('button');
  u.textContent = '↶'; u.title = 'Undo drag terakhir (Ctrl+Z)'; u.disabled = histIndex <= 0;
  u.onclick = () => { if (histIndex <= 0) return; const h = HISTORY[--histIndex]; applyTransform(h.before, h.before.id); updateHistoryUI(); toast(`↶ Undo: ${h.before.id}`); };
  const r = document.createElement('button');
  r.textContent = '↷'; r.title = 'Redo (Ctrl+Shift+Z)'; r.disabled = histIndex >= HISTORY.length;
  r.onclick = () => { if (histIndex >= HISTORY.length) return; const h = HISTORY[histIndex++]; applyTransform(h.after, h.before.id); updateHistoryUI(); toast(`↷ Redo: ${h.before.id}`); };
  el.append(u, r);
}
addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  if (['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)) return;
  e.preventDefault();
  if (e.shiftKey) { if (histIndex < HISTORY.length) { const h = HISTORY[histIndex++]; applyTransform(h.after, h.before.id); updateHistoryUI(); toast(`↷ Redo: ${h.before.id}`); } }
  else if (histIndex > 0) { const h = HISTORY[--histIndex]; applyTransform(h.before, h.before.id); updateHistoryUI(); toast(`↶ Undo: ${h.before.id}`); }
});
updateHistoryUI();

// ── panel kamera sinematik ──
function renderCinePanel() {
  const el = $('#vpCine'); if (!el) return;
  el.innerHTML = '';
  const cap = $('#cineCaption'); if (cap) { cap.textContent = ''; cap.style.display = 'none'; }
  if (!cinePath) return;
  const play = document.createElement('button');
  const paint = () => { play.textContent = cinePlaying ? '⏹ Stop' : '🎥 Putar'; play.classList.toggle('on', cinePlaying); };
  play.onclick = () => {
    cinePlaying = !cinePlaying;
    orbit.enabled = !cinePlaying;
    if (cinePlaying) { cineT = 0; }
    else { const sm = sampleCameraPath(handle, cinePath, cineT); if (sm) orbit.target.copy(sm.target); if (cineExplode !== null) { applyExplode(handle, explodeFactor); lastExplode = explodeFactor; } const c = $('#cineCaption'); if (c) c.style.display = 'none'; }
    paint(); renderTimeline();
  };
  paint();
  el.appendChild(play);
  if (cinePath.mode === 'shots') {
    cinePath.shots.forEach((s, i) => {
      const c = document.createElement('button');
      c.className = 'cine-chip';
      c.textContent = s.id || `${s.type} ${i + 1}`;
      c.title = `${s.type} · ${s.dur}s${s.dist ? ' · jarak ' + s.dist.toFixed(1) + 'm · fill ' + Math.round(s.fill * 100) + '%' : ''}${s.caption ? '\n' + s.caption : ''}`;
      c.onclick = () => { cineT = s.t0 + 0.01; if (!cinePlaying) { const sm = sampleCameraPath(handle, cinePath, cineT); if (sm) { handle.camera.position.copy(sm.pos); handle.camera.lookAt(sm.target); handle.camera.fov = sm.fov; handle.camera.updateProjectionMatrix(); orbit.target.copy(sm.target); if (sm.explode !== null) { applyExplode(handle, sm.explode); lastExplode = sm.explode; } } if (handle.composer) handle.composer.render(); else renderer.render(handle.scene, handle.camera); } };
      el.appendChild(c);
    });
  } else {
    const c = document.createElement('span'); c.className = 'cine-info'; c.textContent = `keyframes · ${cinePath.dur}s`;
    el.appendChild(c);
  }
  const info = document.createElement('span'); info.id = 'cineShotInfo'; info.className = 'cine-info';
  el.appendChild(info);
}

// ── timeline animasi (scrub deterministik; fisika di-resimulasi dari reset) ──
function renderTimeline() {
  const el = $('#vpTimeline'); if (!el) return;
  el.innerHTML = '';
  if (!handle) return;
  const hasTime = (handle.animations?.length || 0) > 0 || !!handle.physicsWorld || !!cinePath;
  if (!hasTime) return;
  const play = document.createElement('button');
  const paintPlay = () => { play.textContent = animPlaying ? '⏸' : '▶'; };
  play.onclick = () => { animPlaying = !animPlaying; paintPlay(); updateVpControls(); };
  paintPlay();
  const t = document.createElement('span'); t.id = 'tlTime'; t.textContent = '0.0s';
  const s = document.createElement('input'); s.type = 'range'; s.id = 'tlSlider';
  s.min = 0; s.max = cinePath ? +cinePath.dur.toFixed(1) : 10; s.step = 0.05; s.value = 0;
  s.oninput = () => {
    animPlaying = false; paintPlay(); updateVpControls();
    if (cinePath) {
      cineT = parseFloat(s.value);
      const sm = sampleCameraPath(handle, cinePath, cineT);
      if (sm) {
        handle.camera.position.copy(sm.pos); handle.camera.lookAt(sm.target);
        handle.camera.fov = sm.fov; handle.camera.updateProjectionMatrix();
        orbit.target.copy(sm.target);
        if (sm.explode !== null) { applyExplode(handle, sm.explode); lastExplode = sm.explode; }
        const cap = $('#cineCaption'); if (cap) { cap.textContent = sm.caption || ''; cap.style.display = sm.caption ? 'block' : 'none'; }
      }
      if (handle.composer) handle.composer.render(); else renderer.render(handle.scene, handle.camera);
      t.textContent = cineT.toFixed(1) + 's';
      return;
    }
    animT = parseFloat(s.value);
    if (handle.physicsWorld) {
      resetPhysics(handle);
      const n = Math.min(600, Math.round(animT * 60));
      for (let i = 0; i < n; i++) stepPhysics(handle, 1 / 60);
    }
    applyAnimations(handle, animT, powerOn);
    if (handle.composer) handle.composer.render(); else renderer.render(handle.scene, handle.camera);
    t.textContent = animT.toFixed(1) + 's';
  };
  el.append(play, t, s);
}

// ── alat ukur: klik 2 titik permukaan → garis + label jarak ──
function addMeasurePoint(p) {
  if (!measureGroup) { measureGroup = new THREE.Group(); measureGroup.name = '__measure'; handle.scene.add(measureGroup); }
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xff9a3c, depthTest: false }));
  dot.position.copy(p); dot.renderOrder = 998;
  measureGroup.add(dot);
  measurePts.push(p.clone());
  if (measurePts.length === 2) {
    const [a, b] = measurePts;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0xff9a3c, depthTest: false }));
    line.renderOrder = 998;
    measureGroup.add(line);
    const d = a.distanceTo(b);
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 80;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(20,16,10,0.88)'; ctx.beginPath(); ctx.roundRect(4, 4, 248, 72, 14); ctx.fill();
    ctx.font = '700 40px system-ui'; ctx.fillStyle = '#ffb066'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(d.toFixed(2) + ' m', 128, 42);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
    sp.scale.set(0.9, 0.28, 1);
    sp.position.copy(a).lerp(b, 0.5).add(new THREE.Vector3(0, 0.2, 0));
    sp.renderOrder = 999;
    measureGroup.add(sp);
    measurePts = [];
    toast(`Jarak: ${d.toFixed(2)} m`);
  }
}
function clearMeasure() {
  if (measureGroup) {
    measureGroup.children.forEach(c => { c.geometry?.dispose(); c.material?.map?.dispose(); c.material?.dispose(); });
    handle?.scene.remove(measureGroup);
  }
  measureGroup = null; measurePts = [];
}

// Rentang slider potong: dari posisi objek SPEC (bukan bbox scene — langit/bintang radius 70rb merusaknya)
function sectionRange(axis) {
  const i = { x: 0, y: 1, z: 2 }[axis] ?? 0;
  let lo = Infinity, hi = -Infinity;
  for (const o of spec.objects || []) {
    const m = handle.registry.get(o.id);
    if (!m || m.userData?.isSky) continue;
    // ⚠️ bbox per objek SPEC (bukan seluruh scene) + buang mesh langit/ground raksasa
    const box = new THREE.Box3();
    m.traverse(x => {
      if (!x.isMesh || x.name === '__ground' || x.parent?.name === '__labels' || x.userData?.isSky) return;
      const g = x.geometry;
      if (g) { if (!g.boundingSphere) g.computeBoundingSphere(); if ((g.boundingSphere?.radius || 0) > 1000) return; }
      box.expandByObject(x);
    });
    if (box.isEmpty()) continue;
    const a = box.min.getComponent(i), b = box.max.getComponent(i);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 1000 || Math.abs(b) > 1000) continue;
    lo = Math.min(lo, a); hi = Math.max(hi, b);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo > 200) { lo = -5; hi = 5; }
  const pad = Math.max(0.15, (hi - lo) * 0.15);
  return [+(lo - pad).toFixed(2), +(hi + pad).toFixed(2)];
}

// ── panel bedah assembly (exploded/section/xray/isolate/label) ──
function renderBedahPanel() {
  const el = $('#vpBedah'); if (!el) return;
  el.innerHTML = '';
  if (!handle) return;
  const head = document.createElement('div'); head.className = 'bedah-head';
  head.innerHTML = '<b>🔬 Bedah</b>';
  const col = document.createElement('button'); col.textContent = '▾'; col.className = 'bedah-col';
  col.onclick = () => { el.classList.toggle('collapsed'); col.textContent = el.classList.contains('collapsed') ? '▸' : '▾'; };
  head.appendChild(col); el.appendChild(head);
  const body = document.createElement('div'); body.className = 'bedah-body';

  // Explode
  const r1 = document.createElement('div'); r1.className = 'mech-row';
  const l1 = document.createElement('span'); l1.className = 'mech-label'; l1.textContent = 'Exploded';
  const s1 = document.createElement('input'); s1.type = 'range'; s1.min = 0; s1.max = 1; s1.step = 0.01; s1.value = explodeFactor;
  const v1 = document.createElement('span'); v1.className = 'mech-val'; v1.textContent = Math.round(explodeFactor * 100) + '%';
  s1.oninput = () => { explodeFactor = parseFloat(s1.value); v1.textContent = Math.round(explodeFactor * 100) + '%'; };
  r1.append(l1, s1, v1); body.appendChild(r1);
  const rp = document.createElement('div'); rp.className = 'mech-row bedah-toggles';
  [[0, 'Rapat'], [0.35, 'Lapisan'], [0.7, 'Terbuka']].forEach(([f, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { explodeFactor = f; s1.value = f; v1.textContent = Math.round(f * 100) + '%'; if (handle) { applyExplode(handle, f); lastExplode = f; } };
    rp.appendChild(b);
  });
  body.appendChild(rp);

  // Section
  const r2 = document.createElement('div'); r2.className = 'mech-row';
  const t2 = document.createElement('button');
  const paintT2 = () => { t2.textContent = (sectionOpts.enabled ? '☑' : '☐') + ' Section'; t2.classList.toggle('on', sectionOpts.enabled); };
  t2.onclick = () => { sectionOpts.enabled = !sectionOpts.enabled; setSection(handle, renderer, sectionOpts); paintT2(); };
  paintT2();
  const ax = document.createElement('select');
  ['x', 'y', 'z'].forEach(a => { const o = document.createElement('option'); o.value = a; o.textContent = a.toUpperCase(); ax.appendChild(o); });
  ax.value = sectionOpts.axis;
  ax.onchange = () => { sectionOpts.axis = ax.value; setSection(handle, renderer, sectionOpts); };
  const fl = document.createElement('button'); fl.textContent = '⇄'; fl.title = 'Balik arah potong';
  fl.onclick = () => { sectionOpts.flip = !sectionOpts.flip; setSection(handle, renderer, sectionOpts); };
  r2.append(t2, ax, fl); body.appendChild(r2);
  const r3 = document.createElement('div'); r3.className = 'mech-row';
  const l3 = document.createElement('span'); l3.className = 'mech-label'; l3.textContent = 'Posisi potong';
  const s3 = document.createElement('input'); s3.type = 'range';
  const [rlo, rhi] = sectionRange(sectionOpts.axis);
  s3.min = rlo; s3.max = rhi;
  s3.step = 0.05; s3.value = sectionOpts.pos;
  const v3 = document.createElement('span'); v3.className = 'mech-val'; v3.textContent = (+sectionOpts.pos).toFixed(1);
  s3.oninput = () => { sectionOpts.pos = parseFloat(s3.value); v3.textContent = sectionOpts.pos.toFixed(1); setSection(handle, renderer, sectionOpts); };
  ax.addEventListener('change', () => {
    const [nlo, nhi] = sectionRange(sectionOpts.axis);
    s3.min = nlo; s3.max = nhi;
    sectionOpts.pos = (nlo + nhi) / 2;
    s3.value = sectionOpts.pos; v3.textContent = sectionOpts.pos.toFixed(1);
    setSection(handle, renderer, sectionOpts);
  });
  r3.append(l3, s3, v3); body.appendChild(r3);

  // Toggle: xray / isolate / label
  const r4 = document.createElement('div'); r4.className = 'mech-row bedah-toggles';
  const mk = (label, get, set) => {
    const b = document.createElement('button');
    const paint = () => { b.textContent = (get() ? '☑ ' : '☐ ') + label; b.classList.toggle('on', get()); };
    b.onclick = () => { set(!get()); paint(); };
    paint(); return b;
  };
  r4.appendChild(mk('X-ray', () => xrayOn, v => { xrayOn = v; setXray(handle, v, selectedId); }));
  r4.appendChild(mk('Isolasi', () => isolateOn, v => {
    if (v && !selectedId) { toast('Pilih part dulu untuk isolasi'); return; }
    isolateOn = v; setIsolate(handle, v, selectedId);
  }));
  r4.appendChild(mk('Label', () => labelsOn, v => { labelsOn = v; makeLabels(handle).visible = v; }));
  body.appendChild(r4);
  const r5 = document.createElement('div'); r5.className = 'mech-row bedah-toggles';
  r5.appendChild(mk('Caps', () => sectionOpts.caps, v => { sectionOpts.caps = v; if (sectionOpts.enabled) setSection(handle, renderer, sectionOpts); }));
  r5.appendChild(mk('📏 Ukur', () => measureMode, v => { measureMode = v; toast(v ? 'Klik 2 titik permukaan untuk mengukur' : 'Mode ukur selesai'); }));
  const clr = document.createElement('button'); clr.textContent = '✕'; clr.title = 'Hapus semua ukuran';
  clr.onclick = clearMeasure;
  r5.appendChild(clr);
  body.appendChild(r5);
  el.appendChild(body);
}

// ── kontrol mekanika di viewport ──
function renderMechControls() {
  const el = $('#vpMech'); if (!el) return;
  el.innerHTML = '';
  if (!handle?.overrides) return;
  for (const c of spec.controls || []) {
    if (!c.target || !handle.registry.has(c.target)) continue;
    const row = document.createElement('div'); row.className = 'mech-row';
    if (c.type === 'toggle') {
      const b = document.createElement('button');
      const get = () => handle.overrides[c.target]?.enabled ?? true;
      const paint = () => { b.textContent = (get() ? '☑ ' : '☐ ') + c.label; b.classList.toggle('on', get()); };
      b.onclick = () => {
        handle.overrides[c.target] = handle.overrides[c.target] || {};
        handle.overrides[c.target].enabled = !get(); paint();
      };
      paint(); row.appendChild(b);
    } else {
      const lab = document.createElement('span'); lab.className = 'mech-label'; lab.textContent = c.label;
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = c.min ?? 0; inp.max = c.max ?? 100; inp.step = c.step ?? 1;
      inp.value = handle.overrides[c.target]?.[c.param || 'speed'] ?? c.default ?? 0;
      const val = document.createElement('span'); val.className = 'mech-val'; val.textContent = inp.value;
      inp.oninput = () => {
        handle.overrides[c.target] = handle.overrides[c.target] || {};
        handle.overrides[c.target][c.param || 'speed'] = parseFloat(inp.value);
        val.textContent = inp.value;
      };
      row.appendChild(lab); row.appendChild(inp); row.appendChild(val);
    }
    el.appendChild(row);
  }
}

function updateVpControls() {
  const el = $('#vpControls'); if (!el) return;
  el.innerHTML = '';
  renderMechControls();
  const hasAnim = (handle?.animations?.length || 0) > 0 || !!handle?.physicsWorld;
  if (spec?.power) {
    const b = document.createElement('button');
    b.className = 'vp-ctl' + (powerOn ? ' on' : '');
    b.textContent = (powerOn ? '⏻ ' : '⭘ ') + (spec.power.label || 'Nyala');
    b.title = 'Saklar daya mekanika';
    b.onclick = () => { powerOn = !powerOn; audioClick(handle); updateVpControls(); };
    el.appendChild(b);
  }
  if (hasAnim) {
    const b = document.createElement('button');
    b.className = 'vp-ctl';
    b.textContent = animPlaying ? '⏸ Jeda' : '▶ Putar';
    b.title = 'Jalankan/jeda animasi & simulasi fisika';
    b.onclick = () => { animPlaying = !animPlaying; updateVpControls(); };
    el.appendChild(b);
  }
  if (handle?.physicsWorld) {
    const b = document.createElement('button');
    b.className = 'vp-ctl';
    b.textContent = '↺ Reset fisika';
    b.title = 'Kembalikan semua rigid body ke posisi awal';
    b.onclick = () => rebuild(spec, 'Fisika di-reset ke keadaan awal');
    el.appendChild(b);
    const ex = document.createElement('button');
    ex.className = 'vp-ctl';
    ex.textContent = '💥 Ledakan';
    ex.title = 'Impuls radial ke semua body dynamic (pusat & force dari spec.explosion)';
    ex.onclick = () => {
      const e = spec.explosion || {};
      const n = applyExplosion(handle, e.center || [0, 1, 0], e.force ?? 8, e.radius ?? 5);
      toast(`💥 ${n} body terdorong`);
    };
    el.appendChild(ex);
  }
}

// ── picking ──
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let dragPlane = null;
const dragVec = new THREE.Vector3();
canvas.addEventListener('pointerdown', e => {
  downPos = [e.clientX, e.clientY];
  if (e.shiftKey && handle?.physicsWorld && !cinePlaying) {
    const r = canvas.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, handle.camera);
    const meshes = (spec.objects || []).map(o => handle.registry.get(o.id)).filter(m => m && m.visible !== false);
    const hits = ray.intersectObjects(meshes, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.specId) o = o.parent;
      const id = o?.userData.specId;
      if (id && startDrag(handle, id, hits[0].point)) {
        const camDir = new THREE.Vector3(); handle.camera.getWorldDirection(camDir);
        dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, hits[0].point);
        orbit.enabled = false;
        toast('Drag fisika aktif — lepas untuk melepas');
      }
    }
  }
});
canvas.addEventListener('pointermove', e => {
  if (!handle?.drag || !dragPlane) return;
  const r = canvas.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, handle.camera);
  if (ray.ray.intersectPlane(dragPlane, dragVec)) moveDrag(handle, dragVec);
});
canvas.addEventListener('pointerup', e => {
  if (handle?.drag) { endDrag(handle); dragPlane = null; if (!cinePlaying) orbit.enabled = true; downPos = null; return; }
  if (!downPos || dragging || !handle) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 5 || e.button !== 0) return;
  const r = canvas.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, handle.camera);
  if (measureMode) {
    const mh = ray.intersectObjects(handle.scene.children, true)
      .filter(h => h.object.isMesh && h.object.parent?.name !== '__labels' && !h.object.userData?.isSky && h.object.renderOrder < 1);
    if (mh.length) addMeasurePoint(mh[0].point);
    return;
  }
  const meshes = (spec.objects || []).map(o => handle.registry.get(o.id)).filter(m => m && m.visible !== false);
  const hits = ray.intersectObjects(meshes, true);
  if (hits.length) {
    let o = hits[0].object;
    while (o && !o.userData.specId) o = o.parent;
    const id = o?.userData.specId || null;
    select(id);
    if (id) {
      const so = (spec.objects || []).find(x => x.id === id);
      if (so?.onClick) doClickAction(so);
    }
  } else select(null);
});

// ── toolbar ──
$('#gizmoSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  gizmo.setMode(b.dataset.mode);
  document.querySelectorAll('#gizmoSeg button').forEach(x => x.classList.toggle('active', x === b));
});
function doFrame() {
  if (!handle) return;
  if (selectedId && handle.registry.get(selectedId)?.isMesh) {
    const box = new THREE.Box3().setFromObject(handle.registry.get(selectedId));
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const dist = radius / Math.sin(deg(handle.camera.fov) / 2) * 1.4;
    const dir = handle.camera.position.clone().sub(orbit.target).normalize();
    handle.camera.position.copy(center).addScaledVector(dir, dist);
    orbit.target.copy(center); orbit.update();
    spec.camera.position = handle.camera.position.toArray().map(v => round(v));
    spec.camera.target = center.toArray().map(v => round(v));
    markDirty();
  } else {
    const r = frameCamera(handle.camera, handle.target, handle.scene, orbit);
    if (r) {
      spec.camera.position = handle.camera.position.toArray().map(v => round(v));
      spec.camera.target = orbit.target.toArray().map(v => round(v));
      markDirty();
    }
  }
  toast('Kamera di-frame ulang');
}
$('#btnFrame').onclick = doFrame;
$('#btnGrid').onclick = () => { grid.visible = !grid.visible; $('#btnGrid').classList.toggle('active', grid.visible); };
$('#btnReload').onclick = async () => { await poll(true); toast('Spec dimuat ulang dari server'); };
$('#btnSave').onclick = async () => {
  const res = await fetch('/api/scene', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene: spec }) });
  const j = await res.json();
  if (j.ok) { clearDirty(); lastMtime = Date.now() / 1000; toast('Tersimpan — agent membaca scene.json + feedback'); log('user menyimpan edit ke scene.json', 'ok'); }
  else toast('Gagal menyimpan: ' + j.error);
};
$('#btnKeepMine').onclick = () => { $('#dirtyBanner').classList.remove('show'); lastMtime = serverState?.scene_mtime || lastMtime; toast('Versimu dipertahankan — jangan lupa Simpan'); };
$('#btnTakeAgent').onclick = () => { clearDirty(); rebuild(serverState.scene, 'Versi agent dimuat'); lastMtime = serverState.scene_mtime; };
$('#btnCollapse').onclick = () => {
  const b = $('#bottom'); b.classList.toggle('collapsed');
  $('#btnCollapse').textContent = b.classList.contains('collapsed') ? '▴' : '▾';
};

// ── keyboard ──
window.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'w') $('#gizmoSeg [data-mode=translate]').click();
  else if (k === 'e') $('#gizmoSeg [data-mode=rotate]').click();
  else if (k === 'r') $('#gizmoSeg [data-mode=scale]').click();
  else if (k === 'f') doFrame();
  else if (k === 'escape') { select(null); closeDrawers(); }
});

// ── tabs ──
function openTab(name) {
  const b = document.querySelector(`#tabs button[data-tab="${name}"]`);
  if (b) b.click();
}
document.querySelectorAll('#tabs button[data-tab]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('#tabs button[data-tab]').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tabpage').forEach(p => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
    const bottom = $('#bottom');
    bottom.classList.remove('collapsed');
    bottom.classList.toggle('agent-open', b.dataset.tab === 'agent');
    $('#btnCollapse').textContent = '▾';
    if (b.dataset.tab === 'agent') {
      markAgentSeen();
      const log = $('#chatLog'); log.scrollTop = log.scrollHeight;
      if (!mqMobile.matches) setTimeout(() => $('#chatText').focus({ preventScroll: true }), 60);
    }
  };
});
// Mobile: mulai dengan panel bawah terlipat agar viewport jadi layar utama.
if (mqMobile.matches) {
  $('#bottom').classList.add('collapsed');
  $('#btnCollapse').textContent = '▴';
}
mqMobile.addEventListener('change', e => {
  if (e.matches) { $('#bottom').classList.add('collapsed'); $('#btnCollapse').textContent = '▴'; }
  else { closeDrawers(); $('#bottom').classList.remove('collapsed'); $('#btnCollapse').textContent = '▾'; }
});

// ── checklist ──
function renderChecklist(report, label) {
  const el = $('#ckList'); el.innerHTML = '';
  if (!report?.checks) { el.innerHTML = '<div class="insp-empty">Belum ada hasil cek untuk iterasi ini.</div>'; $('#ckSummary').textContent = ''; return; }
  const pass = report.checks.filter(c => c.pass).length;
  $('#ckSummary').innerHTML = `<b style="color:${report.pass ? 'var(--ok)' : 'var(--bad)'}">${pass}/${report.checks.length} lolos</b> · ${label}`;
  report.checks.forEach(c => {
    const d = document.createElement('div'); d.className = 'ck-item';
    d.innerHTML = `<span class="st ${c.pass ? 'pass' : 'fail'}">${c.pass ? '✓' : '✗'}</span><span class="nm"></span><span class="dt"></span>`;
    d.querySelector('.nm').textContent = c.id;
    d.querySelector('.dt').textContent = c.detail || '';
    el.appendChild(d);
  });
}
function fillCkSelect() {
  const sel = $('#ckIterSel'); const cur = sel.value;
  sel.innerHTML = '<option value="live">Smoke test live (viewport ini)</option>' +
    iterations.map(it => `<option value="${it.id}">${it.id}${it.checklist ? (it.checklist.pass ? ' ✓' : ' ✗') : ''}</option>`).join('');
  sel.value = cur && [...sel.options].some(o => o.value === cur) ? cur : (iterations.length ? iterations[iterations.length - 1].id : 'live');
  showCk();
}
function showCk() {
  const v = $('#ckIterSel').value;
  if (v === 'live') renderChecklist(liveReport, liveReport ? 'live' : 'belum dijalankan — klik ▶');
  else { const it = iterations.find(x => x.id === v); renderChecklist(it?.checklist?.smoke || it?.checklist, v); }
}
$('#ckIterSel').onchange = showCk;
$('#btnLiveCheck').onclick = () => {
  if (!handle) return;
  liveReport = smokeCheck(handle, renderer);
  log(`smoke test live: ${liveReport.pass ? 'PASS' : 'FAIL'} (coverage ${(liveReport.coverage * 100).toFixed(1)}%, luminance ${liveReport.meanLum.toFixed(1)})`, liveReport.pass ? 'ok' : 'err');
  $('#ckIterSel').value = 'live'; showCk();
  toast(liveReport.pass ? 'Smoke test live: semua lolos ✓' : 'Smoke test live: ada yang gagal ✗');
};

// ── iterations gallery ──
function renderIterations() {
  const g = $('#iterGallery'); g.innerHTML = '';
  $('#iterCount').textContent = iterations.length ? `(${iterations.length})` : '';
  iterations.forEach(it => {
    const c = document.createElement('div');
    c.className = 'iter-card' + (cmpSel.includes(it.id) ? ' cmp-selected' : '');
    const rep = it.checklist?.smoke || it.checklist;
    const st = rep ? `<span class="${rep.pass ? 'pass' : 'fail'}">${rep.pass ? '✓ lolos' : '✗ gagal'}</span>` : '<span class="s">tanpa cek</span>';
    c.innerHTML = `<img loading="lazy" src="${it.shot || ''}" alt="${it.id}"><div class="meta"><span class="t">${it.id}</span> · ${st}<div class="s">${new Date(it.mtime * 1000).toLocaleString('id-ID')}</div></div><div class="notes"></div>`;
    c.querySelector('.notes').textContent = it.notes || '';
    c.onclick = () => {
      if (cmpSel.includes(it.id)) cmpSel = cmpSel.filter(x => x !== it.id);
      else { cmpSel.push(it.id); if (cmpSel.length > 2) cmpSel.shift(); }
      if (cmpSel.length === 2) openCompare();
      renderIterations();
    };
    g.appendChild(c);
  });
}
function openCompare() {
  const [a, b] = cmpSel.map(id => iterations.find(x => x.id === id));
  $('#cmpA').src = a.shot; $('#cmpB').src = b.shot;
  $('#cmpAcap').textContent = a.id + (a.checklist?.smoke?.pass === false ? ' ✗' : '');
  $('#cmpBcap').textContent = b.id + (b.checklist?.smoke?.pass === false ? ' ✗' : '');
  $('#cmpOverlay').classList.add('show');
}
$('#btnCmpClose').onclick = () => { $('#cmpOverlay').classList.remove('show'); cmpSel = []; renderIterations(); };

// ── feedback ──
function renderFeedback(fb) {
  const el = $('#fbList'); el.innerHTML = '';
  const open = fb.filter(f => f.status === 'open').length;
  const badge = $('#fbBadge'); badge.style.display = open ? '' : 'none'; badge.textContent = open;
  [...fb].reverse().forEach((f, ri) => {
    const i = fb.length - 1 - ri;
    const d = document.createElement('div'); d.className = 'fb-item';
    d.innerHTML = `<div class="fb-meta"><span class="fb-status ${f.status}">${f.status === 'open' ? 'MENUNGGU AGENT' : 'SELESAI'}</span><span>${new Date(f.at * 1000).toLocaleString('id-ID')}${f.iteration ? ' · ' + f.iteration : ''}</span><button>✓ tandai selesai</button></div><div class="fb-text"></div>`;
    d.querySelector('.fb-text').textContent = f.text;
    d.querySelector('button').onclick = async () => {
      await fetch('/api/feedback/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: i }) });
      poll(true);
    };
    el.appendChild(d);
  });
}
$('#btnFbSend').onclick = async () => {
  const text = $('#fbText').value.trim(); if (!text) return;
  const latest = iterations.length ? iterations[iterations.length - 1].id : null;
  const res = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, iteration: latest }) });
  const j = await res.json();
  if (j.ok) { $('#fbText').value = ''; toast('Feedback terkirim — agent membacanya di putaran berikutnya'); poll(true); }
};

// ── polling sinkronisasi agent ──
async function poll(force = false) {
  try {
    const st = await (await fetch('/api/state?t=' + Date.now())).json();
    serverState = st;
    if (st.project) $('#projName').textContent = st.project;
    $('#contractText').textContent = st.contract || '(belum ada kontrak — agent menulis contract.md sebelum coding)';
    iterations = st.iterations || [];
    renderIterations(); fillCkSelect(); renderFeedback(st.feedback || []);
    const latest = iterations.length ? iterations[iterations.length - 1].id : '—';
    $('#iterBadge').textContent = `iterasi: ${latest}`;
    if (st.scene && (force || st.scene_mtime > lastMtime)) {
      if (dirty && !force && lastMtime > 0) {
        $('#dirtyBanner').classList.add('show');
      } else {
        const first = lastMtime === 0;
        lastMtime = st.scene_mtime;
        await rebuild(st.scene, first ? null : `Agent memperbarui scene (${latest})`);
        if (!first) clearDirty();
      }
    }
  } catch (e) { log('poll gagal: ' + e.message, 'err'); }
}
poll();
setInterval(() => poll(), 4000);
log('studio siap — menunggu scene dari agent…', 'ok');

// ══════════════════════════════════════════════════════════════
// LIVE AI AGENT CHAT — riwayat, pilih model, status job real-time
// ══════════════════════════════════════════════════════════════
const CHAT_MODEL_KEY = 'studio.chatModel';
let chatRunning = false, chatWasRunning = false, chatStatusLines = [];
let chatPollTimer = null, chatSignature = '', chatLoadedOnce = false;

function markAgentSeen() {
  if (!chatRunning) $('#agentBadge').style.display = 'none';
}
function fmtChatTime(ts) {
  if (!ts) return '';
  try { return new Date(ts * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 70; }

function renderChat(messages) {
  const log = $('#chatLog');
  const sig = JSON.stringify((messages || []).map(m => [m.role, m.at, m.text, m.iteration, !!m.error]));
  if (sig === chatSignature && chatLoadedOnce) return;
  const stay = sig === chatSignature ? true : nearBottom(log);
  chatSignature = sig; chatLoadedOnce = true;
  log.innerHTML = '';
  if (!messages || !messages.length) {
    const d = document.createElement('div');
    d.className = 'chat-empty';
    d.innerHTML = 'Belum ada percakapan.<br>Tulis permintaan seperti <b>“tambahkan gedung merah”</b> atau <b>“buat scene hutan siang”</b>.';
    log.appendChild(d);
    return;
  }
  messages.forEach(m => {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg ' + (m.role === 'user' ? 'user' : 'agent') + (m.error ? ' error' : '');
    const bub = document.createElement('div'); bub.className = 'bubble'; bub.textContent = m.text || '';
    const meta = document.createElement('div'); meta.className = 'meta';
    const who = document.createElement('span'); who.textContent = m.role === 'user' ? 'Kamu' : '🤖 Agent';
    meta.appendChild(who);
    if (m.at) { const t = document.createElement('span'); t.textContent = fmtChatTime(m.at); meta.appendChild(t); }
    if (m.model) { const mo = document.createElement('span'); mo.textContent = m.model; meta.appendChild(mo); }
    if (m.iteration) {
      const a = document.createElement('span'); a.className = 'iter-link'; a.textContent = m.iteration;
      a.title = 'Buka tab Iterasi';
      a.onclick = () => openTab('iterations');
      meta.appendChild(a);
    }
    wrap.appendChild(bub); wrap.appendChild(meta);
    log.appendChild(wrap);
  });
  if (stay) log.scrollTop = log.scrollHeight;
}

function updateChatStatus() {
  const bar = $('#chatStatus');
  const last = chatStatusLines[chatStatusLines.length - 1];
  if (chatRunning) {
    bar.classList.add('show');
    bar.querySelector('.txt').textContent = last ? last.text : 'menunggu agent…';
    $('#agentBadge').style.display = '';
    if (!bar.querySelector('.btnCancelJob')) {
      const cb = document.createElement('button');
      cb.className = 'btnCancelJob';
      cb.textContent = '✕ Batal';
      cb.style.cssText = 'margin-left:8px;flex:none;background:#3a2020;border-color:#e5534b;color:#ff9b95';
      cb.onclick = async () => {
        cb.disabled = true;
        try { await fetch('/api/chat/cancel', { method: 'POST' }); toast('Job dibatalkan'); } catch (e) {}
        pollChat();
      };
      bar.appendChild(cb);
    }
  } else {
    bar.classList.remove('show');
    $('#agentBadge').style.display = 'none';
    bar.querySelector('.btnCancelJob')?.remove();
  }
}

async function pollChat() {
  clearTimeout(chatPollTimer); chatPollTimer = null;
  try {
    const st = await (await fetch('/api/chat/state?t=' + Date.now())).json();
    chatStatusLines = st.status_lines || [];
    chatRunning = !!st.running;
    renderChat(st.messages || []);
    updateChatStatus();
    const canSend = !chatRunning && !!$('#chatText').value.trim() && !!$('#chatModel').value;
    $('#btnChatSend').disabled = !canSend;
    $('#chatModel').disabled = chatRunning;
    if (st.running) {
      chatWasRunning = true;
      chatPollTimer = setTimeout(pollChat, 2000);
    } else if (chatWasRunning) {
      chatWasRunning = false;
      if (st.error) toast('Agent selesai dengan error — cek tab Agent', 4500);
      else if (st.last_iteration) toast(`Scene diperbarui — ${st.last_iteration}`, 4500);
      log(st.error ? 'job agent selesai dengan error' : `job agent selesai: ${st.last_iteration || '-'}`,
        st.error ? 'err' : 'ok');
      poll(true);
      setTimeout(loadBackends, 400);
    }
  } catch (e) {
    chatPollTimer = setTimeout(pollChat, 3000);
  }
}

async function loadBackends() {
  const sel = $('#chatModel');
  try {
    const data = await (await fetch('/api/backends?t=' + Date.now())).json();
    const prev = sel.value || localStorage.getItem(CHAT_MODEL_KEY) || '';
    sel.innerHTML = '';
    let firstEnabled = null;
    (data.backends || []).forEach(b => {
      const og = document.createElement('optgroup');
      const suffix = b.available ? '' : (b.status === 'unconfigured' ? ' — terkunci' : ' — tidak tersedia');
      og.label = b.label + suffix;
      (b.models || []).forEach(m => {
        const o = document.createElement('option');
        o.value = m.value;
        o.textContent = m.label + (b.available ? '' : ' 🔒');
        if (!b.available) { o.disabled = true; o.title = b.reason || (b.status === 'unconfigured' ? 'perlu API_SERVER_KEY' : 'tidak tersedia'); }
        else if (!firstEnabled) firstEnabled = o.value;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    const usable = [...sel.options].filter(o => !o.disabled);
    if (prev && usable.some(o => o.value === prev)) sel.value = prev;
    else if (data.default_model && usable.some(o => o.value === data.default_model)) sel.value = data.default_model;
    else if (firstEnabled) sel.value = firstEnabled;
    if (!usable.length) {
      sel.innerHTML = '<option value="">tidak ada backend tersedia</option>';
      $('#btnChatSend').disabled = true;
    } else {
      $('#btnChatSend').disabled = chatRunning || !$('#chatText').value.trim();
    }
    log(`backend tersedia: ${(data.backends || []).filter(b => b.available).map(b => b.id).join(', ') || 'tidak ada'}`, 'dim');
  } catch (e) {
    sel.innerHTML = '<option value="">gagal memuat backend</option>';
    $('#btnChatSend').disabled = true;
    log('gagal memuat /api/backends: ' + e.message, 'err');
  }
}

function chatCanSend() {
  return !chatRunning && !!$('#chatModel').value && !!$('#chatText').value.trim();
}

async function sendChat() {
  const text = $('#chatText').value.trim();
  if (!text || chatRunning) return;
  const model = $('#chatModel').value;
  if (!model) { toast('Pilih model/backend dulu'); return; }
  localStorage.setItem(CHAT_MODEL_KEY, model);
  $('#btnChatSend').disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model, selection: selectedId || null }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) {
      $('#chatText').value = '';
      chatWasRunning = true;
      chatSignature = ''; chatLoadedOnce = false;
      pollChat();
      log('permintaan dikirim ke agent: ' + text.slice(0, 80), 'ok');
    } else if (res.status === 409) {
      toast('Agent masih sibuk — tunggu, atau klik ✕ Batal di bar status', 4500);
      chatWasRunning = true; pollChat();
    } else {
      toast('Gagal: ' + (j.error || ('HTTP ' + res.status)), 4000);
      $('#btnChatSend').disabled = !chatCanSend();
    }
  } catch (e) {
    toast('Gagal menghubungi server: ' + e.message, 4000);
    $('#btnChatSend').disabled = !chatCanSend();
  }
}

$('#btnChatSend').onclick = sendChat;
$('#btnChatRefresh').onclick = () => { loadBackends(); toast('Daftar backend dimuat ulang'); };
$('#chatText').addEventListener('input', () => {
  $('#btnChatSend').disabled = !chatCanSend();
});
$('#chatText').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (chatCanSend()) sendChat();
  }
});
$('#chatText').addEventListener('focus', () => {
  if (mqMobile.matches) {
    const b = $('#bottom');
    if (b.classList.contains('collapsed')) { b.classList.remove('collapsed'); $('#btnCollapse').textContent = '▾'; }
    setTimeout(() => { const l = $('#chatLog'); l.scrollTop = l.scrollHeight; }, 250);
  }
});
$('#chatModel').addEventListener('change', () => {
  if ($('#chatModel').value) localStorage.setItem(CHAT_MODEL_KEY, $('#chatModel').value);
});

// Probe layout (dipakai scripts/layout-probe.html untuk verifikasi responsif).
function updateLayoutProbe() {
  const rect = el => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const ol = $('#outliner'), ins = $('#inspector'), bot = $('#bottom'), vp = $('#viewportWrap');
  document.documentElement.dataset.probe = JSON.stringify({
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    topbar: rect($('#topbar')), viewport: rect(vp), canvas: rect(canvas),
    outliner: rect(ol), inspector: rect(ins), bottom: rect(bot),
    outlinerPos: getComputedStyle(ol).position, inspectorPos: getComputedStyle(ins).position,
    bottomCollapsed: bot.classList.contains('collapsed'),
    activeTab: document.querySelector('#tabs button.active')?.dataset.tab || null,
    chatVisible: $('#tab-agent').classList.contains('active'),
  });
}
window.__layoutProbe = updateLayoutProbe;
setTimeout(updateLayoutProbe, 1200);
setTimeout(updateLayoutProbe, 3500);
window.addEventListener('resize', () => setTimeout(updateLayoutProbe, 120));
window.addEventListener('orientationchange', () => setTimeout(updateLayoutProbe, 400));

loadBackends();
pollChat();
setInterval(() => { if (!chatRunning) pollChat(); }, 12000);

// Deep link: /?tab=agent|iterations|checklist|contract|console|feedback
const startTab = new URLSearchParams(location.search).get('tab');
if (startTab && document.querySelector(`#tabs button[data-tab="${startTab}"]`)) {
  setTimeout(() => openTab(startTab), 500);
}

// ── debug handle (verifikasi mekanika) ──
window.__studioDebug = {
  get handle() { return handle; },
  get powerOn() { return powerOn; },
  get animT() { return animT; },
  get playing() { return animPlaying; },
  step(dt) { animT += dt; applyAnimations(handle, animT, powerOn); if (handle?.capSystem) syncCaps(handle); if (handle?.composer) handle.composer.render(); else renderer.render(handle.scene, handle.camera); },
  stepPhys(n = 60) { for (let i = 0; i < n; i++) stepPhysics(handle, 1 / 60); },
  explode(f) { explodeFactor = f; lastExplode = f; applyExplode(handle, f); },
  measure(a, b) { addMeasurePoint(new THREE.Vector3(...a)); addMeasurePoint(new THREE.Vector3(...b)); },
  scrub(t) { const s = $('#tlSlider'); if (s) { s.value = t; s.dispatchEvent(new Event('input')); } },
  testDrag(id, dx) {
    const o = spec.objects.find(x => x.id === id); if (!o) return null;
    const before = { id: o.id, p: [...o.position], r: [...o.rotation], s: [...o.scale] };
    o.position[0] = +(o.position[0] + dx).toFixed(3);
    const m = handle.registry.get(id); if (m) m.position.x = o.position[0];
    const after = { id: o.id, p: [...o.position], r: [...o.rotation], s: [...o.scale] };
    HISTORY.splice(histIndex); HISTORY.push({ before, after }); histIndex = HISTORY.length;
    updateHistoryUI(); markDirty();
    return { before: before.p, after: after.p, history: HISTORY.length };
  },
  history() { return { n: HISTORY.length, i: histIndex }; },
  cine(t) { cinePlaying = true; orbit.enabled = false; cineT = t; const sm = sampleCameraPath(handle, cinePath, t); if (sm) { handle.camera.position.copy(sm.pos); handle.camera.lookAt(sm.target); handle.camera.fov = sm.fov; handle.camera.updateProjectionMatrix(); if (sm.explode !== null) { applyExplode(handle, sm.explode); lastExplode = sm.explode; } } if (handle.composer) handle.composer.render(); else renderer.render(handle.scene, handle.camera); return sm ? { pos: sm.pos.toArray().map(v => +v.toFixed(2)), fov: sm.fov, caption: sm.caption } : null; },
  bodyPos(id) { const b = handle?.bodyMap?.get(id); if (!b) return null; const t = b.translation(); return [t.x, t.y, t.z]; },
  setPower(v) { powerOn = v; updateVpControls(); },
};

// ── projek & export ──
const projPanel = $('#projPanel'), exportPanel = $('#exportPanel');
function closeMenus() { projPanel.classList.remove('show'); exportPanel.classList.remove('show'); }
$('#btnProjects').onclick = e => {
  e.stopPropagation();
  exportPanel.classList.remove('show');
  projPanel.classList.toggle('show');
  if (projPanel.classList.contains('show')) renderProjects();
};
$('#btnExport').onclick = e => {
  e.stopPropagation();
  projPanel.classList.remove('show');
  exportPanel.classList.toggle('show');
};
document.addEventListener('click', e => {
  if (!e.target.closest('.dropdown') && !e.target.closest('#btnProjects') && !e.target.closest('#btnExport')) closeMenus();
});

async function renderProjects() {
  try {
    const d = await (await fetch('/api/projects?t=' + Date.now())).json();
    $('#ddActiveName').textContent = d.active || '—';
    const el = $('#projList'); el.innerHTML = '';
    (d.projects || []).forEach(p => {
      const div = document.createElement('div'); div.className = 'proj-item';
      div.innerHTML = `<img loading="lazy" src="${p.thumb || ''}" alt=""><div class="pi-meta"><div class="pi-title"></div><div class="pi-sub">${p.objects} objek · ${p.iterations} iterasi</div></div><button>Muat</button>`;
      div.querySelector('.pi-title').textContent = p.title;
      div.querySelector('button').onclick = () => {
        if (confirm(`Muat projek "${p.title}"? Workspace saat ini diarsipkan otomatis.`)) projAction('/api/project/load', { name: p.name });
      };
      el.appendChild(div);
    });
    if (!(d.projects || []).length) el.innerHTML = '<div class="dd-note">Belum ada projek tersimpan.</div>';
  } catch (e) { $('#projList').innerHTML = '<div class="dd-note">Gagal memuat daftar projek.</div>'; }
}

async function projAction(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) {
      toast('Projek aktif: ' + j.project);
      closeMenus();
      selectedId = null; gizmo.detach();
      $('#saveName').value = ''; $('#newName').value = '';
      await poll(true); pollChat();
    } else toast('Gagal: ' + (j.error || 'HTTP ' + res.status), 4500);
  } catch (e) { toast('Gagal: ' + e.message, 4500); }
}
$('#btnProjSave').onclick = () => projAction('/api/project/save', { name: $('#saveName').value.trim() });
$('#btnProjNew').onclick = () => {
  const n = $('#newName').value.trim();
  if (!n) { toast('Isi nama projek baru dulu'); return; }
  if (confirm(`Buat projek baru "${n}"? Workspace saat ini diarsipkan otomatis.`)) projAction('/api/project/new', { name: n });
};

$('#btnExpHtml').onclick = () => { location.href = '/api/export?format=html'; toast('Mengunduh HTML mandiri…'); };
$('#btnExpZip').onclick = () => { location.href = '/api/export?format=zip'; toast('Mengunduh ZIP lengkap…'); };
$('#btnExpJson').onclick = () => { location.href = '/api/export?format=json'; toast('Mengunduh scene.json…'); };
$('#btnExpBom').onclick = () => { location.href = '/api/export?format=bom'; toast('Mengunduh BOM daftar part…'); };
$('#btnCheckFinal').onclick = async () => {
  toast('Vision menilai render terakhir…', 60000);
  try {
    const r = await fetch('/api/vision/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(x => x.json());
    const v = r.vision;
    if (!v) return toast('Vision tidak tersedia (model sibuk) — coba lagi', 6000);
    toast(`Cek Final ${r.iteration}: ${v.pass ? 'LULAS' : 'GAGAL'} · rata-rata ${v.avg.toFixed(1)}/10 · ${v.scores} — ${v.critique}`, 14000);
    const fb = document.getElementById('feedbackText'); if (fb) fb.value = `Vision ${r.iteration}: ${v.scores} (avg ${v.avg}) — ${v.critique}`;
  } catch (e) { toast('Cek final gagal: ' + e.message, 6000); }
};
const _btnExpVideo = $('#btnExpVideo');
if (_btnExpVideo) _btnExpVideo.onclick = async () => {
  try {
    const r = await fetch('/api/video/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fps: 24, w: 960, h: 540 }) }).then(x => x.json());
    if (!r.ok) return toast('Gagal memulai video: ' + (r.error || '?'));
    let p = $('#videoProgress');
    if (!p) { p = document.createElement('div'); p.id = 'videoProgress'; p.style.cssText = 'position:fixed;top:52px;left:50%;transform:translateX(-50%);background:rgba(22,24,29,.95);border:1px solid var(--accent);color:var(--text);padding:8px 16px;border-radius:8px;z-index:99;font-size:12px'; document.body.appendChild(p); }
    p.textContent = `🎬 Render 0/${r.total} frame…`;
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;width:288px;height:162px;right:10px;bottom:10px;z-index:98;border:1px solid var(--border);border-radius:8px;opacity:.9';
    f.src = r.url;
    document.body.appendChild(f);
    const poll = setInterval(async () => {
      try {
        const s = await fetch('/api/video/state?job=' + r.job).then(x => x.json());
        if (s.status === 'rendering') p.textContent = `🎬 Render ${s.frames}/${s.total} frame…`;
        else if (s.status === 'encoding') p.textContent = '🎬 Encoding MP4 (ffmpeg)…';
        else if (s.status === 'done') {
          clearInterval(poll); f.remove();
          p.innerHTML = `🎬 Video siap (${(s.size / 1048576).toFixed(1)} MB) — <a href="/api/video/file?job=${r.job}" style="color:var(--accent)">unduh MP4</a> <button onclick="this.parentNode.remove()" style="margin-left:8px;cursor:pointer">✕</button>`;
          toast('Video MP4 selesai!');
        } else if (s.status === 'error') { clearInterval(poll); f.remove(); p.textContent = '🎬 Gagal: ' + (s.error || '?'); }
      } catch (e) { /* polling sementara gagal — coba lagi */ }
    }, 2500);
  } catch (e) { toast('Video gagal: ' + e.message); }
};
$('#btnExpGlb').onclick = async () => {
  if (!spec) { toast('Scene belum dimuat'); return; }
  toast('Menyiapkan GLB…');
  try {
    const h = await buildScene(JSON.parse(JSON.stringify(spec)));
    const rm = [];
    h.scene.traverse(o => { if (o.userData?.isSky || o.isPoints) rm.push(o); });
    rm.forEach(o => o.parent?.remove(o));
    const exporter = new GLTFExporter();
    exporter.parse(h.scene, buf => {
      const blob = new Blob([buf], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (spec.meta?.name || 'scene').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.glb';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('GLB terunduh ✓');
      disposeHandle(h);
    }, err => { toast('Export GLB gagal: ' + (err?.message || err), 4500); disposeHandle(h); }, { binary: true });
  } catch (e) { toast('Export GLB gagal: ' + e.message, 4500); }
};
