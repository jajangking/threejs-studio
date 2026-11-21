# ⬢ Three.js Studio

Workspace 3D mirip Blender di browser + **AI agent live** yang membangun scene Three.js dari prompt, dengan **pipeline self-repair terverifikasi** — bukan sekadar generate kode buta.

Dibangun untuk sandbox Linux (instabox) tanpa GPU: rendering headless via Chromium + SwiftShader.

## Fitur

- **Viewport 3D** — OrbitControls, gizmo transform (W/E/R), frame otomatis (F), picking, grid
- **Outliner + Inspector** — edit posisi/rotasi/skala/material/lampu langsung, simpan ke spec
- **🤖 Agent live** — prompt di web → LLM menghasilkan *diff* scene → merge → render headless → smoke test → gerbang estetika vision → perbaikan otomatis (maks 2 ronde) → rollback bila repair merusak
- **🖼 Galeri iterasi** — setiap putaran agent tersimpan (screenshot + checklist + catatan); klik dua kartu untuk bandingkan berdampingan
- **✅ Smoke test 8 cek** — error build, objek terbangun, lighting, frame tidak hitam, coverage subjek, framing, frustum, **oklusi raycast** (subjek utama tidak terhalang)
- **📋 Kontrak scene** — spesifikasi tertulis (objek wajib, palet hex, kamera, lighting, acceptance criteria) sebelum coding
- **💬 Feedback** — catatan user dibaca agent di putaran berikutnya
- **📁 Manajemen projek** — baru / simpan / muat, auto-arsip workspace
- **⬇ Export** — HTML mandiri (satu file, buka di browser mana pun), ZIP lengkap, scene.json, GLB
- **📱 Responsive** — desktop layout penuh; mobile viewport full-width + drawer

## Quickstart

```bash
# butuh: python3, chromium, node (opsional)
python3 server.py            # serve di 0.0.0.0:8091
# buka http://localhost:8091
```

Render headless satu iterasi:

```bash
python3 scripts/render.py iter-01 --notes "catatan"
# → iterations/iter-01/{shot.png,checklist.json,notes.md}
# exit 0 = smoke pass, 2 = gagal
```

Chromium headless **wajib** flag: `--no-sandbox --disable-dev-shm-usage --no-proxy-server --enable-unsafe-swiftshader` (tanpa GPU + sandbox mem-proxy localhost).

## Arsitektur

```
scene.json (single source of truth)
   ├── js/scene-builder.js  → dipakai viewport studio DAN renderer headless
   │                          (spec sama = gambar sama)
   ├── render.html + scripts/render.py → screenshot + smoke test
   └── server.py → API state/scene/feedback/chat/projects/export
                   + job agent (LLM → diff → merge → render → smoke → vision → repair)
```

**Spec JSON**: objek primitif (box/sphere/cylinder/…), `instances` (InstancedMesh ratusan jendela 1 draw call), `sky` (gradasi shader), `stars`, `gltf`; material PBR + emissive + tekstur prosedural (concrete/asphalt); post-processing bloom; fog; satuan meter.

**Backend model agent** (dropdown di tab Agent):
- Router OpenAI-compatible lokal (model `:free`) — default, fallback berjenjang
- OpenCode server lokal (v2 API)
- Hermes gateway (perlu `API_SERVER_KEY` di `.env`)

**Pengaman job**: watchdog, tombol batal, zombie-guard, rollback ke iterasi lolos terakhir, validasi spec retry.

## Pipeline kualitas

```
KONTRAK → SPEC → RENDER → SMOKE (8 cek) → VISION (rubrik 5 dimensi) → ITERASI → EXPORT
```

Smoke pass ≠ layak final. Gerbang vision menilai komposisi/detail/material/cahaya/atmosfer; skor noisy ditangani ambang longgar + rollback. Edit kecil (≤15 objek, tanpa ubah lighting/kamera) melewati gerbang estetika demi kecepatan (~1 menit end-to-end).

## API ringkas

| Endpoint | Fungsi |
|---|---|
| `GET /api/state` | scene + kontrak + iterasi + feedback + projek aktif |
| `POST /api/scene` | simpan edit user |
| `POST /api/chat` · `GET /api/chat/state` · `POST /api/chat/cancel` | agent live |
| `GET /api/backends` | model tersedia |
| `GET /api/projects` · `POST /api/project/{new,save,load}` | manajemen projek |
| `GET /api/export?format=html\|zip\|json` | export |
| `POST /api/feedback` · `POST /api/feedback/resolve` | feedback user |

## Lisensi

MIT
