# HANDOFF — Three.js Studio: Responsive UI + Live AI Agent Chat

Status: **selesai & teruji end-to-end**. Tidak ada dependensi baru (Python stdlib + Three.js vendor).

---

## 1. Ringkasan perubahan

### Fitur 1 — UI responsif (mobile / tablet / desktop)

| Breakpoint | Perilaku |
|---|---|
| Desktop ≥1024px | Layout lama dipertahankan: outliner 225px, inspector 280px, panel bawah 250px |
| Tablet 640–1023px | Outliner 180px & inspector 230px; label tombol topbar diringkas (ikon saja); panel bawah 250px |
| Mobile <640px | Viewport full-width; outliner & inspector jadi drawer slide-in; panel bawah jadi tab bar 45vh yang bisa dilipat; topbar compact |

Detail mobile:
- Tombol drawer **☰** (outliner) dan **🎚** (inspector) di topbar, plus backdrop gelap; klik backdrop / pilih objek / Esc menutup drawer.
- Panel bawah: default terlipat (46px) agar viewport jadi layar utama; ketuk tab untuk membuka (maks `45vh`), tombol **▾/▴** untuk melipat.
- Topbar: logo & badge iterasi disembunyikan, nama scene `text-overflow: ellipsis`, tombol gizmo **W/E/R tetap ada**, Simpan menjadi ikon **💾**. Frame/Grid/Muat disembunyikan di mobile (fitur desktop tetap utuh).
- Semua tombol topbar mobile = **40px** touch target.
- Canvas `touch-action:none`; OrbitControls tetap bisa orbit/zoom/pinch karena tidak ada overlay yang menutupi viewport.
- Tab Agent: area chat `flex` + scroll, textarea di atas keyboard (`interactive-widget=resizes-content`, safe-area inset).
- Deep link: `/?tab=agent|iterations|checklist|contract|console|feedback`.

Alat verifikasi headless (baru):
- `scripts/layout-probe.html?w=390&h=844` — mengukur `scrollWidth`, posisi panel/drawer, target sentuh, lalu menulis JSON ke `<pre id="out">`.
- `scripts/frame.html?w=390&h=844&tab=agent` — iframe ukuran viewport presisi untuk screenshot (Chromium headless punya lebar layout minimum ~500px).

### Fitur 2 — Live AI agent chat

Backend baru di `server.py` (stdlib: `urllib.request`, `threading`, `subprocess`, `json`):

| Endpoint | Fungsi |
|---|---|
| `POST /api/chat` `{text, model}` | Mulai job thread; balas `{ok, job_id, model}`; **409** jika masih ada job aktif |
| `GET /api/chat/state` | `{running, job_id, status_lines[], messages[], model, started_at, error, last_iteration}` |
| `GET /api/backends` | Daftar backend + model + status runtime (timeout 3 dtk) |

Loop agent per job:
1. Susun prompt: system prompt (Indonesia, schema lengkap) + `contract.md` + `scene.json` + feedback `open` + 6 pesan chat terakhir + permintaan user.
2. Panggil LLM, minta JSON murni `{reply, scene, contract, resolved_feedback}` (temperature 0.4, `max_tokens 20000`).
3. Parse toleran: buang code fence, cari objek JSON valid pertama.
4. Validasi spec (dict, `objects[]`/`lights[]`/`camera`, id unik, tipe objek/lampu dikenal, min. 1 lampu non-ambient) → **1× retry** dengan pesan error bila invalid.
5. Tulis `scene.json` (`meta.last_edit='agent'`, `meta.iteration=iter-NN`), `contract.md` (bila ada), resolve feedback.
6. Jalankan `python3 scripts/render.py iter-NN --notes "<reply>"` (timeout 150 dtk).
7. Bila smoke gagal → **1 ronde perbaikan** (kirim checklist gagal + errors ke LLM, tulis + render lagi; maks 2 ronde).
8. Append pesan agent ke `chat.json` (reply + ringkasan smoke + id iterasi) dan update `status_lines` real-time.

Backend model:
- **router** (default): `http://127.0.0.1:8645/v1/chat/completions` tanpa auth. Daftar model dari `/v1/models` (hanya `:free`). Karena model free sering kena rate-limit (mis. qwen `429 fair-share`), adapter melakukan **dua gelombang**: `qwen/qwen4-max:free` + `meituan/longcat-2.5:free` lebih dulu (mampu output scene besar), lalu model free lain bila keduanya gagal. Respons valid pertama menang.
- **opencode**: HTTP v2 lokal `http://127.0.0.1:49374` (Basic auth `opencode:<password dari ~/.config/opencode/service.json>`). Alur: `POST /api/session` → `POST /api/session/{id}/prompt` → `POST /api/experimental/session/{id}/wait` → `GET /api/session/{id}/message`. Server dihidupkan otomatis via `opencode service start` bila mati. Timeout 120 dtk. Teruji: `big-pickle` → `"halo"`.
- **hermes**: `http://127.0.0.1:8642/v1/chat/completions` + `Authorization: Bearer <API_SERVER_KEY>` (env atau `.env` di root). Tidak ada key di mesin ini → status **`unconfigured`**, opsi terkunci 🔒 dengan tooltip “perlu API_SERVER_KEY”.

Frontend:
- Tab baru **🤖 Agent** di panel bawah.
- Bubble user/agent + timestamp + model + badge iterasi yang bisa diklik → membuka tab Iterasi.
- Textarea: Enter kirim, Shift+Enter baris baru; tombol Kirim disabled saat job berjalan.
- Dropdown backend/model dari `/api/backends`; pilihan disimpan di `localStorage` (`studio.chatModel`); backend tidak tersedia dinonaktifkan.
- Poll `/api/chat/state` tiap **2 detik** saat running; spinner + status line terakhir; setelah selesai toast “Scene diperbarui — iter-NN” dan `/api/state` dimuat ulang segera.
- Riwayat chat persisten di `chat.json`.

---

## 2. File yang berubah / ditambah

| File | Perubahan |
|---|---|
| `server.py` | + chat job, 3 endpoint baru, adapter router/opencode/hermes, validasi spec, render + repair loop, backend discovery |
| `index.html` | + CSS responsif (drawer, tab bar, touch target), topbar compact, tab & panel Agent, `?tab=` deep link |
| `js/studio.js` | + drawer mobile, chat (render/kirim/poll/backends/localStorage), toast, probe layout, deep link; fitur lama tidak diubah |
| `scripts/layout-probe.html` | **baru** — alat ukur layout headless |
| `scripts/frame.html` | **baru** — wrapper screenshot viewport presisi |
| `chat.json` | **baru** — riwayat chat persisten |
| `iterations/iter-03/` | **baru** — hasil job agent (shot.png, checklist.json, notes.md) |
| `iterations/iter-verify/` | **baru** — hasil verifikasi smoke test |
| `HANDOFF-DONE.md` | dokumen ini |

Tidak disentuh: `vendor/`, `utils/`, `js/scene-builder.js`, `render.html`, `scripts/render.py`, port, `iterations/iter-01|02`.

---

## 3. Hasil test (dijalankan sendiri)

### 3.1 Smoke test scene demo
```
$ python3 scripts/render.py iter-verify
iter=iter-verify waktu=7.2s ok=True smoke=7/7 pass=True coverage=0.418 lum=12.2
EXIT=0
```

### 3.2 Server + API
```
$ curl -s localhost:8091/api/health          → {"ok": true}
$ GET /api/state                              → scene, scene_mtime, contract, iterations, feedback, server_time
$ POST /api/scene {scene}                     → {"ok": true, "saved": "scene.json"}
$ GET /api/backends                           → router ready · opencode ready · hermes unconfigured
$ GET /api/chat/state                         → riwayat chat + status job
```

### 3.3 Test utama agent end-to-end (router)
Request:
```bash
curl -s -X POST localhost:8091/api/chat -H 'Content-Type: application/json' \
  -d '{"text":"tambahkan satu gedung berwarna merah tua di posisi [8,0,-8], tinggi 4","model":"qwen/qwen4-max:free"}'
```
Hasil (job `job-1795238357066`, selesai ~2 menit):
```
05:19:17 job dimulai · model qwen/qwen4-max:free
05:19:17 memanggil model: qwen/qwen4-max:free, meituan/longcat-2.5:free
05:21:19 respons dari meituan/longcat-2.5:free (fallback dari qwen/qwen4-max:free)
05:21:19 validasi spec OK (71 objek, 6 lampu)
05:21:19 menulis scene.json + contract.md · iter-03
05:21:22 smoke iter-03: 7/7 ✓
05:21:22 selesai · iter-03 · smoke PASS
```
Verifikasi artefak:
- `scene.json`: `meta.last_edit="agent"`, `meta.iteration="iter-03"`, 71 objek (+4 dari 67).
- Objek baru: `gedung-5` / **“Gedung Merah”**, `box`, posisi `[8, 2, -8]` (tinggi 4 → pusat y=2), material `#5a1616`, roughness 0.85; plus 3 strip jendela.
- `iterations/iter-03/`: `shot.png`, `checklist.json` (smoke **7/7 pass**), `notes.md` berisi reply agent.
- `chat.json`: pesan user + balasan agent `"Saya menambahkan satu gedung merah tua setinggi 4 m … Smoke 7/7 lolos ✓ · iterasi iter-03"`.

Catatan: qwen free sedang kena rate-limit `429 fair-share` saat test, sehingga fallback otomatis ke longcat. Mekanisme fallback ini memang bagian dari desain agar job tidak gagal.

### 3.4 Responsif — pengukuran headless
Probe 390×844 (iframe viewport presisi):
```
innerWidth 390 · scrollWidth 390 · overflowX 0
topbar 390×46 · viewport 390×752 · canvas 390×752
outliner fixed (drawer) · inspector fixed (drawer)
bottom collapsed 46px; saat tab Agent dibuka 390×380 (45vh)
drawer outliner terbuka x=0 (on-screen) → backdrop menutup → off-screen
chatInput 374×50 terlihat · tombol Kirim terlihat
touch target minimum 40px · topbarRightEdge 383 (<390)
```
Probe tablet 768×1024: outliner 180, inspector 230, viewport 358, overflow 0.
Probe desktop 1440×900: outliner 225, inspector 280, viewport 935, bottom 250, overflow 0.

Screenshot (tersimpan):
- `/data/home/.hermes/cache/scratch/mobile.png` — **390×844**
- `/data/home/.hermes/cache/scratch/desktop.png` — **1440×900**
- `/data/home/.hermes/cache/scratch/mobile-agent.png` — chat Agent di mobile
- `/data/home/.hermes/cache/scratch/desktop-agent.png` — chat Agent di desktop

### 3.5 Adapter lain
```
opencode: call_opencode('big-pickle', 'Balas satu kata: halo') → "halo"
hermes  : status "unconfigured", reason "perlu API_SERVER_KEY"
```

---

## 4. Cara menjalankan

```bash
cd /data/workspace/threejs-studio
nohup python3 server.py > server.log 2>&1 &
# buka http://127.0.0.1:8091/
```

- Model default: `qwen/qwen4-max:free` (dropdown: router free / opencode free / hermes terkunci).
- Hermes: set `API_SERVER_KEY=...` di environment atau file `.env` di root studio, lalu restart server.
- Render manual: `python3 scripts/render.py iter-NN --notes "catatan"`.

## 5. Batasan / catatan

- Job agent memproses satu per satu (409 saat sibuk); request LLM untuk model free bisa memakan 1–3 menit tergantung antrean provider.
- Output scene penuh ~4–5k token; model dengan limit output kecil (mis. solar-mini4) bisa memotong JSON, karena itu longcat dijadikan pendamping utama qwen dan model kecil hanya fallback terakhir.
- `iterations/iter-verify` adalah iterasi verifikasi tambahan (bukan hasil agent) dan sengaja dipertahankan sebagai bukti smoke test.
