// STUDIO REKAMAN — produksi: kamera sinematik, timeline, audio, video, interaktivitas.
// Scene dibaca dari workspace yang sama dengan Studio Design (shared core builder).
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { PointerLockControls } from '../vendor/PointerLockControls.js';
import {
  buildScene, makeRenderer, makeComposer, frameCamera, applyAnimations, stepPhysics, resetPhysics,
  applyExplode, compileCameraPath, sampleCameraPath, syncCaps,
  applyExplosion, startDrag, moveDrag, endDrag, makeAudio, updateAudio, audioClick,
} from './scene-builder.js';

const $ = s => document.querySelector(s);
const cv = $('#cv');
let handle = null, renderer = null, spec = null;
let animT = 0, animPlaying = true, powerOn = true, physAcc = 0;
let cinePath = null, cinePlaying = false, cineT = 0;
let audioOn = false, walkOn = false;
const keys = {};

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, ms);
}

async function boot() {
  const st0 = await (await fetch('/api/state?t=' + Date.now())).json();
  spec = st0.scene || {};
  $('#sceneName').textContent = spec.meta?.name || 'scene';
  if (handle) { /* rebuild */ }
  handle = await buildScene(spec);
  const stage = $('#stage');
  renderer = makeRenderer(cv, stage.clientWidth, stage.clientHeight, { exposure: spec.environment?.exposure ?? 1.1 });
  const composer = makeComposer(handle, renderer, stage.clientWidth, stage.clientHeight);
  handle.composer = composer;
  frameCamera(handle.camera, handle.target, handle.scene, orbit);
  // WAJIB: builder bikin kamera aspect=1 — tanpa ini gambar teregang/terpotong di viewport lebar
  handle.camera.aspect = stage.clientWidth / stage.clientHeight;
  handle.camera.updateProjectionMatrix();
  powerOn = spec.power?.default ?? true;
  animT = 0; physAcc = 0;
  cinePath = compileCameraPath(handle);
  cineT = 0;
  cinePlaying = !!(cinePath && cinePath.autoplay);
  orbit.object = handle.camera;
  orbit.enabled = !cinePlaying && !walkOn;
  if (audioOn) { const a = makeAudio(handle); if (a) a.ctx.resume(); }
  renderCinePanel(); renderShotPanel(); renderTimeline(); renderControls();
  addEventListener('resize', () => {
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
    if (composer) composer.setSize(stage.clientWidth, stage.clientHeight);
    handle.camera.aspect = stage.clientWidth / stage.clientHeight;
    handle.camera.updateProjectionMatrix();
  });
}

const orbit = new OrbitControls(handle?.camera || new THREE.PerspectiveCamera(), cv);
orbit.enableDamping = true;

// ── panel shot (daftar + jarak terukur) ──
function renderShotPanel() {
  const el = $('#shotPanel');
  el.innerHTML = '';
  if (!cinePath || cinePath.mode !== 'shots') return;
  const h = document.createElement('h3');
  h.textContent = `Shot list · ${cinePath.dur}s`;
  el.appendChild(h);
  cinePath.shots.forEach((s, i) => {
    const r = document.createElement('div');
    r.className = 'shot-row';
    r.innerHTML = `<span>${i + 1}. ${s.id || s.type}</span><span class="m">${s.dur}s${s.dist ? ' · ' + s.dist.toFixed(1) + 'm' : ''}</span>`;
    r.title = `${s.type} · fill ${Math.round((s.fill ?? 0.4) * 100)}%${s.caption ? '\n' + s.caption : ''}`;
    r.onclick = () => { cineT = s.t0 + 0.01; if (!cinePlaying) applyCinePose(cineT); };
    el.appendChild(r);
  });
}

function applyCinePose(t) {
  const sm = sampleCameraPath(handle, cinePath, t);
  if (!sm) return;
  handle.camera.position.copy(sm.pos);
  handle.camera.lookAt(sm.target);
  handle.camera.fov = sm.fov; handle.camera.updateProjectionMatrix();
  orbit.target.copy(sm.target);
  if (sm.explode !== null) applyExplode(handle, sm.explode);
  const cap = $('#cineCaption');
  cap.textContent = sm.caption || ''; cap.style.display = sm.caption ? 'block' : 'none';
  render();
}

// ── panel kontrol tur ──
function renderCinePanel() {
  const el = $('#vpCine');
  el.innerHTML = '';
  if (!cinePath) return;
  const play = document.createElement('button');
  const paint = () => { play.textContent = cinePlaying ? '⏹ Stop' : '🎥 Putar Tur'; play.classList.toggle('on', cinePlaying); };
  play.onclick = () => {
    cinePlaying = !cinePlaying;
    orbit.enabled = !cinePlaying && !walkOn;
    if (cinePlaying) cineT = 0;
    else { const sm = sampleCameraPath(handle, cinePath, cineT); if (sm) orbit.target.copy(sm.target); $('#cineCaption').style.display = 'none'; applyExplode(handle, 0); }
    paint(); renderTimeline();
  };
  paint();
  el.appendChild(play);
  if (cinePath.mode === 'shots') {
    cinePath.shots.forEach((s, i) => {
      const c = document.createElement('button');
      c.className = 'cine-chip';
      c.textContent = s.id || `${s.type} ${i + 1}`;
      c.onclick = () => { cineT = s.t0 + 0.01; if (!cinePlaying) applyCinePose(cineT); };
      el.appendChild(c);
    });
  }
  const info = document.createElement('span');
  info.id = 'cineShotInfo'; info.className = 'cine-info';
  el.appendChild(info);
}

// ── timeline ──
function renderTimeline() {
  const el = $('#vpTimeline');
  el.innerHTML = '';
  const hasTime = (handle.animations?.length || 0) > 0 || !!handle.physicsWorld || !!cinePath;
  if (!hasTime) return;
  const play = document.createElement('button');
  const paint = () => { play.textContent = animPlaying ? '⏸' : '▶'; };
  play.onclick = () => { animPlaying = !animPlaying; paint(); };
  paint();
  const t = document.createElement('span'); t.id = 'tlTime'; t.textContent = '0.0s';
  const s = document.createElement('input'); s.type = 'range'; s.id = 'tlSlider';
  s.min = 0; s.max = cinePath ? +cinePath.dur.toFixed(1) : 10; s.step = 0.05; s.value = 0;
  s.oninput = () => {
    animPlaying = false; paint();
    if (cinePath) { cineT = parseFloat(s.value); applyCinePose(cineT); t.textContent = cineT.toFixed(1) + 's'; return; }
    animT = parseFloat(s.value);
    if (handle.physicsWorld) { resetPhysics(handle); const n = Math.min(600, Math.round(animT * 60)); for (let i = 0; i < n; i++) stepPhysics(handle, 1 / 60); }
    applyAnimations(handle, animT, powerOn);
    t.textContent = animT.toFixed(1) + 's';
    render();
  };
  el.append(play, t, s);
}

// ── kontrol viewport: audio, jalan, fisika ──
function renderControls() {
  const el = $('#vpControls');
  el.innerHTML = '';
  const au = document.createElement('button');
  au.className = 'vp-ctl';
  au.textContent = audioOn ? '🔊 Suara' : '🔇 Suara';
  au.onclick = () => { audioOn = !audioOn; if (audioOn) { const a = makeAudio(handle); if (a) a.ctx.resume(); } au.textContent = audioOn ? '🔊 Suara' : '🔇 Suara'; au.classList.toggle('on', audioOn); };
  el.appendChild(au);
  const wk = document.createElement('button');
  wk.className = 'vp-ctl';
  wk.textContent = '🚶 Jalan';
  wk.onclick = () => { if (!walkOn) plc.lock(); else plc.unlock(); };
  el.appendChild(wk);
  if (handle.physicsWorld) {
    const pause = document.createElement('button');
    pause.className = 'vp-ctl';
    pause.textContent = '⏸ Fisika';
    pause.onclick = () => { animPlaying = !animPlaying; pause.textContent = animPlaying ? '⏸ Fisika' : '▶ Fisika'; };
    el.appendChild(pause);
    const rs = document.createElement('button');
    rs.className = 'vp-ctl'; rs.textContent = '↺ Reset';
    rs.onclick = () => { resetPhysics(handle); toast('Fisika di-reset'); };
    el.appendChild(rs);
    const ex = document.createElement('button');
    ex.className = 'vp-ctl'; ex.textContent = '💥';
    ex.title = 'Ledakan radial';
    ex.onclick = () => { const e = spec.explosion || {}; const n = applyExplosion(handle, e.center || [0, 1, 0], e.force ?? 8, e.radius ?? 5); toast(`💥 ${n} body terdorong`); };
    el.appendChild(ex);
  }
}

// ── interaktivitas: onClick, shift-drag, walk ──
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downXY = null, dragPlane = null;
const dragVec = new THREE.Vector3();
function findSpec(id) { return (spec.objects || []).find(x => x.id === id); }
function clickAction(o) {
  const act = o?.onClick; if (!act) return;
  if (act.action === 'power') { powerOn = !powerOn; audioClick(handle); toast(powerOn ? '⚡ Nyala' : '⏻ Mati'); }
  else if (act.action === 'impulse') { const b = handle.bodyMap?.get(o.id); if (b && act.impulse) b.applyImpulse({ x: act.impulse[0], y: act.impulse[1], z: act.impulse[2] }, true); }
  else if (act.action === 'explode') { const n = applyExplosion(handle, act.center || o.position || [0, 1, 0], act.force ?? 8, act.radius ?? 5); toast(`💥 ${n} body`); }
  else if (act.action === 'toggle') { const m = handle.registry.get(o.id); if (m) m.visible = !m.visible; }
}
function pick(e) {
  const r = cv.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, handle.camera);
  const meshes = (spec.objects || []).map(o => handle.registry.get(o.id)).filter(m => m && m.visible !== false);
  const hits = ray.intersectObjects(meshes, true);
  if (!hits.length) return null;
  let o = hits[0].object;
  while (o && !o.userData.specId) o = o.parent;
  return { id: o?.userData.specId, point: hits[0].point };
}
cv.addEventListener('pointerdown', e => {
  downXY = [e.clientX, e.clientY];
  if (e.shiftKey && handle.physicsWorld && !cinePlaying && !walkOn) {
    const h = pick(e);
    if (h?.id && startDrag(handle, h.id, h.point)) {
      const cd = new THREE.Vector3(); handle.camera.getWorldDirection(cd);
      dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cd, h.point);
      orbit.enabled = false;
    }
  }
});
cv.addEventListener('pointermove', e => {
  if (handle?.drag && dragPlane) {
    const r = cv.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, handle.camera);
    if (ray.ray.intersectPlane(dragPlane, dragVec)) moveDrag(handle, dragVec);
  }
});
cv.addEventListener('pointerup', e => {
  if (handle?.drag) { endDrag(handle); dragPlane = null; if (!cinePlaying && !walkOn) orbit.enabled = true; downXY = null; return; }
  if (!downXY || walkOn) return;
  const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
  downXY = null;
  if (moved > 5 || e.button !== 0) return;
  const h = pick(e);
  if (h?.id) clickAction(findSpec(h.id));
});
const plc = new PointerLockControls(handle?.camera || new THREE.PerspectiveCamera(), cv);
addEventListener('keydown', e => { keys[e.code] = true; });
addEventListener('keyup', e => { keys[e.code] = false; });
plc.addEventListener('lock', () => { walkOn = true; orbit.enabled = false; if (handle) handle.camera.position.y = 1.7; toast('WASD jalan · ESC keluar'); });
plc.addEventListener('unlock', () => { walkOn = false; if (!cinePlaying) orbit.enabled = true; });

// ── Agent AI (backend sama dengan Studio Design) ──
let agentRunning = false, agentPollH = null, agentModelsLoaded = false;
function adLog(messages) {
  const el = $('#adLog');
  if (!el) return;
  const list = (messages || []).slice(-12);
  el.innerHTML = list.map(m => {
    const role = m.role === 'user' ? 'user' : 'agent';
    const txt = String(m.text || '').slice(0, 600).replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;');
    return `<div class="ad-msg ${role}"><span class="ad-meta">${role === 'user' ? 'Bang' : 'Agent'}</span>${txt}</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}
async function adPoll() {
  try {
    const st = await (await fetch('/api/chat/state?t=' + Date.now())).json();
    adLog(st.messages || []);
    agentRunning = !!st.running;
    const lastLine = (st.status_lines || []).slice(-1)[0];
    $('#adStatus').textContent = agentRunning ? (lastLine ? lastLine.text : (st.status || 'agent bekerja…')) : (st.messages?.length ? 'siap' : 'belum ada percakapan');
    if (lastLine) $('#adStatus').title = (st.status_lines || []).map(x => x.time + ' ' + x.text).join('\n');
    $('#adSend').disabled = agentRunning || !$('#adText').value.trim();
    if (agentRunning) agentPollH = setTimeout(adPoll, 3000);
    else if (agentPollH) { clearTimeout(agentPollH); agentPollH = null; toast('Agent selesai — scene akan termuat ulang bila berubah'); }
  } catch (e) { $('#adStatus').textContent = 'polling gagal: ' + e.message; if (agentRunning) agentPollH = setTimeout(adPoll, 4000); }
}
async function adLoadModels() {
  if (agentModelsLoaded) return;
  agentModelsLoaded = true;
  try {
    const d = await (await fetch('/api/backends')).json();
    const sel = $('#adModel');
    sel.innerHTML = '';
    let first = null;
    (d.backends || []).forEach(b => {
      const og = document.createElement('optgroup');
      og.label = b.label + (b.available ? '' : ' — tidak tersedia');
      (b.models || []).forEach(m => {
        const o = document.createElement('option');
        o.value = m.value; o.textContent = m.label + (b.available ? '' : ' 🔒');
        if (!b.available) o.disabled = true; else if (!first) first = o.value;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    const prev = localStorage.getItem('studio.chatModel');
    const usable = [...sel.options].filter(o => !o.disabled);
    sel.value = (prev && usable.some(o => o.value === prev)) ? prev : (d.default_model || first || '');
  } catch (e) { $('#adModel').innerHTML = '<option value="">backend gagal dimuat</option>'; }
}
async function adSend() {
  const text = $('#adText').value.trim();
  const model = $('#adModel').value;
  if (!text || !model || agentRunning) return;
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model, scope: 'production' }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { $('#adText').value = ''; agentRunning = true; adPoll(); }
    else if (r.status === 409) { agentRunning = true; adPoll(); toast('Agent masih sibuk — tunggu sebentar'); }
    else toast('Gagal: ' + (j.error || r.status));
  } catch (e) { toast('Gagal menghubungi agent: ' + e.message); }
}
$('#btnAgentDrawer').onclick = async () => { document.body.classList.toggle('agent-open'); if (document.body.classList.contains('agent-open')) { await adLoadModels(); adPoll(); } };
$('#adClose').onclick = () => document.body.classList.remove('agent-open');
$('#adSend').onclick = adSend;
$('#adText').addEventListener('input', () => { $('#adSend').disabled = agentRunning || !$('#adText').value.trim(); });
$('#adText').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); adSend(); } });
document.querySelectorAll('.ad-chip').forEach(c => c.onclick = () => { $('#adText').value = c.textContent; $('#adText').focus(); $('#adSend').disabled = !$('#adModel').value; });

// ── Skills: preset produksi ala After Effects (HANYA cameraPath) ──
function skSubject() {
  const objs = (handle.spec.objects || []).filter(o =>
    !['sky', 'stars', '__ground'].includes(o.type) && !/backdrop|ground|desk-mat/i.test(o.id || ''));
  const box = new THREE.Box3();
  for (const o of objs.slice(0, 40)) {
    const m = handle.registry.get(o.id);
    if (!m) continue;
    m.updateWorldMatrix(true, false);
    box.expandByObject(m);
  }
  const c = box.isEmpty() ? new THREE.Vector3(0, 1.5, 0) : box.getCenter(new THREE.Vector3());
  const s = box.isEmpty() ? new THREE.Vector3(2, 2, 2) : box.getSize(new THREE.Vector3());
  return { id: objs[0]?.id || null, c, r: Math.max(2, Math.max(s.x, s.y, s.z) * 0.7) };
}
function skApply(cp, label) {
  handle.spec.cameraPath = cp;
  cinePath = compileCameraPath(handle);
  cineT = 0; cinePlaying = true; orbit.enabled = false;
  renderCinePanel(); renderShotPanel(); renderTimeline();
  toast(`${label} aktif — ${(cp?.shots || []).length} shot`);
}
const SKILL_PRESETS = {
  orbit: () => { const { c, r } = skSubject(); return skApply({ loop: true, autoplay: true, shots: [
    { id: 'hero', type: 'orbit', target: c.toArray(), radius: r * 1.4, height: r * 0.45, sweep: 360, duration: 12, fov: 50, caption: 'Tampilan menyeluruh — subjek berputar 360°' }] }, '🔄 Orbit Hero'); },
  reveal: () => { const { c, r, id } = skSubject(); return skApply({ loop: false, autoplay: true, shots: [
    { id: 'establish', type: 'orbit', target: c.toArray(), radius: r * 1.5, height: r * 0.4, sweep: 70, duration: 5, caption: 'Perkenalan subjek dalam lingkungan' },
    { id: 'detail', type: 'zoom', target: id || c.toArray(), framing: id ? { object: id, fill: 0.6 } : null, fromDistance: r * 2, duration: 4, fov: 40, caption: 'Detail pada komponen utama' },
    { id: 'pullback', type: 'dolly', from: c.clone().add(new THREE.Vector3(r, r * 0.4, r)).toArray(), to: c.clone().add(new THREE.Vector3(r * 2, r, r * 2)).toArray(), target: c.toArray(), duration: 4, caption: 'Menjauh — konteks keseluruhan' }] }, '🎬 Product Reveal'); },
  teardown: () => { const { c, r } = skSubject(); return skApply({ loop: false, autoplay: true, shots: [
    { id: 'utuh', type: 'orbit', target: c.toArray(), radius: r * 1.4, height: r * 0.4, sweep: 60, duration: 4, caption: 'Keadaan terakit utuh' },
    { id: 'bedah', type: 'orbit', target: c.toArray(), radius: r * 1.5, height: r * 0.5, sweep: 110, duration: 6, explode: [0, 0.75], caption: 'Lapisan dalam terbuka saat komponen luar menjauh' },
    { id: 'tutup', type: 'dolly', from: c.clone().add(new THREE.Vector3(r, r * 0.4, r)).toArray(), to: c.clone().add(new THREE.Vector3(r * 1.8, r * 0.8, r * 1.8)).toArray(), target: c.toArray(), duration: 4, caption: 'Rangkuman konstruksi' }] }, '🔬 Teardown Tour'); },
  'cara-kerja': () => { const { c, r } = skSubject(); const moving = (handle.animations || []).slice(0, 4);
    const shots = (moving.length ? moving.map((a, i) => ({ id: `bagian-${i + 1}`, type: 'orbit', target: a.id, framing: { object: a.id, fill: 0.5 }, height: r * 0.2, sweep: 90, duration: 4, caption: `${a.id} — mekanisme aktif dalam sistem` })) : [
      { id: 'utama', type: 'orbit', target: c.toArray(), radius: r * 1.4, height: r * 0.4, sweep: 120, duration: 6, caption: 'Bagian utama bekerja' }]);
    return skApply({ loop: true, autoplay: true, shots }, '⚙️ Cara Kerja'); },
  whip: () => { const { c, r } = skSubject(); return skApply({ loop: false, autoplay: true, shots: [
    { id: 'whip', type: 'path', points: [c.clone().add(new THREE.Vector3(-r * 2.5, r * 0.5, r)).toArray(), c.clone().add(new THREE.Vector3(0, r * 0.3, r * 1.2)).toArray(), c.clone().add(new THREE.Vector3(r * 2.5, r * 0.5, r)).toArray()], target: c.toArray(), duration: 2.5, fov: 55, caption: 'Sapuan cepat — transisi dinamis' }] }, '💨 Whip Pan'); },
  'dolly-zoom': () => { const { c, r, id } = skSubject(); return skApply({ loop: false, autoplay: true, shots: [
    { id: 'dolly-zoom', type: 'zoom', target: id || c.toArray(), fromDistance: r * 2.4, toDistance: r * 0.85, direction: [0.6, 0.3, 1], duration: 5, fov: 45, caption: 'Dolly zoom — kedalaman terasa berubah' }] }, '🎯 Dolly Zoom'); },
  loop: () => { const { c, r } = skSubject(); return skApply({ loop: true, autoplay: true, shots: [
    { id: 'loop', type: 'orbit', target: c.toArray(), radius: r * 1.3, height: r * 0.35, sweep: 360, duration: 15, fov: 50, caption: 'Hero loop — putaran tanpa henti' }] }, '🔁 Hero Loop'); },
  clear: () => { handle.spec.cameraPath = null; cinePath = null; cinePlaying = false; orbit.enabled = true;
    renderCinePanel(); renderShotPanel(); renderTimeline(); $('#cineCaption').style.display = 'none'; toast('Tur dihapus — kamera kembali bebas'); },
};
$('#btnSkills').onclick = () => document.body.classList.toggle('skills-open');
$('#skClose').onclick = () => document.body.classList.remove('skills-open');
document.querySelectorAll('[data-skill]').forEach(b => b.onclick = () => SKILL_PRESETS[b.dataset.skill]?.());
$('#skCaptionSet').onclick = () => {
  const txt = $('#skCaption').value.trim(); if (!txt || !cinePath?.shots?.length) return toast('Pilih preset tur dulu');
  let s = cinePath.shots[0];
  if (cinePath.mode === 'shots') {
    const idx = cinePath.shots.findIndex(x => cineT >= x.t0 && cineT < x.t0 + x.dur);
    if (idx >= 0) s = cinePath.shots[idx];
  }
  s.caption = txt;
  if (handle.spec.cameraPath?.shots) {
    const t = handle.spec.cameraPath.shots[s.i ?? cinePath.shots.indexOf(s)];
    if (t) t.caption = txt;
  }
  toast('Narasi diterapkan pada shot aktif');
};
$('#skSave').onclick = async () => {
  try {
    const r = await fetch('/api/camerapath', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cameraPath: handle.spec.cameraPath }) }).then(x => x.json());
    toast(r.ok ? `Tur tersimpan (${r.shots} shot) — Studio Design melihat versi yang sama` : 'Gagal menyimpan tur');
  } catch (e) { toast('Gagal: ' + e.message); }
};
$('#skVideo').onclick = () => $('#btnVideo').click();
$('#skHtml').onclick = () => $('#btnExportHtml').click();

// ── video MP4 ──
$('#btnVideo').onclick = async () => {
  try {
    const r = await fetch('/api/video/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fps: 24, w: 960, h: 540 }) }).then(x => x.json());
    if (!r.ok) return toast('Gagal: ' + (r.error || '?'));
    const p = $('#videoProgress');
    p.style.display = 'block';
    p.textContent = `🎬 Render 0/${r.total} frame…`;
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;width:288px;height:162px;right:10px;bottom:44px;z-index:98;border:1px solid var(--border);border-radius:8px;opacity:.9';
    f.src = r.url;
    document.body.appendChild(f);
    const poll = setInterval(async () => {
      try {
        const s = await fetch('/api/video/state?job=' + r.job).then(x => x.json());
        if (s.status === 'rendering') p.textContent = `🎬 Render ${s.frames}/${s.total} frame…`;
        else if (s.status === 'encoding') p.textContent = '🎬 Encoding MP4…';
        else if (s.status === 'done') {
          clearInterval(poll); f.remove();
          p.innerHTML = `🎬 Siap (${(s.size / 1048576).toFixed(1)} MB) — <a href="/api/video/file?job=${r.job}">unduh MP4</a> <button onclick="this.parentNode.style.display='none'" style="margin-left:8px;cursor:pointer">✕</button>`;
          toast('Video MP4 selesai!');
        } else if (s.status === 'error') { clearInterval(poll); f.remove(); p.textContent = '🎬 Gagal: ' + (s.error || '?'); }
      } catch (e) { /* retry */ }
    }, 2500);
  } catch (e) { toast('Video gagal: ' + e.message); }
};
$('#btnExportHtml').onclick = () => { location.href = '/api/export?format=html'; toast('Mengunduh HTML interaktif…'); };

// ── loop ──
function render() {
  if (handle?.composer) handle.composer.render();
  else renderer.render(handle.scene, handle.camera);
}
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!handle) return;
  if (walkOn) {
    const sp = 3.5 * dt;
    if (keys['KeyW']) plc.moveForward(sp);
    if (keys['KeyS']) plc.moveForward(-sp);
    if (keys['KeyA']) plc.moveRight(-sp);
    if (keys['KeyD']) plc.moveRight(sp);
    handle.camera.position.y = 1.7;
  }
  if (cinePlaying && cinePath) {
    cineT += dt;
    const sm = sampleCameraPath(handle, cinePath, cineT);
    if (sm) {
      handle.camera.position.copy(sm.pos);
      handle.camera.lookAt(sm.target);
      if (Math.abs(handle.camera.fov - sm.fov) > 0.01) { handle.camera.fov = sm.fov; handle.camera.updateProjectionMatrix(); }
      orbit.target.copy(sm.target);
      if (sm.explode !== null) applyExplode(handle, sm.explode);
      const cap = $('#cineCaption');
      cap.textContent = sm.caption || ''; cap.style.display = sm.caption ? 'block' : 'none';
      const si = $('#cineShotInfo');
      if (si && sm.shot) si.textContent = `${sm.shot.type} #${sm.shot.i + 1}${sm.shot.dist ? ' · ' + sm.shot.dist.toFixed(1) + 'm · fill ' + Math.round(sm.shot.fill * 100) + '%' : ''}`;
      document.querySelectorAll('.cine-chip').forEach((c, i) => c.classList.toggle('on', i === sm.shotIndex));
    }
    const tl = $('#tlSlider');
    if (tl && document.activeElement !== tl) { tl.value = (cineT % cinePath.dur).toFixed(2); $('#tlTime').textContent = (cineT % cinePath.dur).toFixed(1) + 's'; }
  }
  if (animPlaying) {
    animT += dt;
    if (handle.physicsWorld && !cinePlaying) {
      physAcc += dt;
      let n = 0;
      while (physAcc >= 1 / 60 && n < 4) { stepPhysics(handle, 1 / 60); physAcc -= 1 / 60; n++; }
    }
  }
  if (handle.animations?.length) applyAnimations(handle, animT, powerOn);
  if (handle.powerTriggered) { handle.powerTriggered = false; powerOn = !powerOn; audioClick(handle); toast('⚡ Trigger: power berubah'); }
  if (audioOn && handle.audio) {
    const spin = handle.animations?.find(a => a.anim.type === 'spin');
    const spd = spin ? ((handle.overrides?.[spin.id]?.speed ?? spin.anim.speed ?? 10) / 10) : 1;
    updateAudio(handle, powerOn, spd);
  }
  if (handle.capSystem) syncCaps(handle);
  if (!cinePlaying && !walkOn) orbit.update();
  render();
}

window.__rekamanDebug = {
  get handle() { return handle; },
  get camera() { return handle?.camera; },
  get aspect() { return handle?.camera.aspect; },
};
boot().then(() => {
  orbit.object = handle.camera;
  plc.camera = handle.camera;
  requestAnimationFrame(loop);
}).catch(e => toast('Boot gagal: ' + e.message, 8000));

// refresh scene bila Design mengubah (poll ringan)
setInterval(async () => {
  try {
    const st = await (await fetch('/api/state')).json();
    const it = st.scene?.meta?.iteration;
    if (it && handle && it !== handle.spec.meta?.iteration && !cinePlaying) {
      await boot();
      toast('Scene diperbarui dari Studio Design');
    }
  } catch (e) { /* abaikan */ }
}, 8000);