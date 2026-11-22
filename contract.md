# Kontrak — Raket Nyamuk Bulat (Mekanisme Dalam)

## Konsep
Product hero raket nyamuk listrik berkepala bulat. Model layered sumbu-Z menyingkap baterai Li-ion 18650 (3,7 V / 2000 mAh), PCB otak MCU + IC, trafo boost ~1,2 kV dengan inti ferit, kapasitor + jembatan dioda, saklar, dan jalur kabel yang benar-benar tersambung antar komponen. Jala tiga grid: tengah berpotensial tinggi, dua luar dibumikan.

## Objek wajib
alas; raket (group): frame-depan, frame-belakang, jala-melingkar, pegangan, gagang-karet, ridges-1..4, cincin-leher, tombol-daya, led-daya, otak-pcb, ic-utama, saklar, batre-liion, trafo-boost, inti-ferit, kapasitor, jembatan-dioda; nyamuk (badan, 2 sayap, mata).

## Topologi kabel (perbaikan)
- kabel-merah + kabel-merah-2: terminal + baterai → saklar → otak-pcb
- kabel-hitam + kabel-hitam-2: terminal − baterai → ground otak-pcb
- kabel-pcb-trafo, kabel-kapasitor: PCB → trafo-boost / kapasitor (oscilator & dropper)
- kabel-tegangan, -2, -3: PCB/trafo → cincin-leher → pusat jala-melingkar
- kabel-ground-depan, kabel-ground-belakang: frame luar → gagang
- Semua id unik; tidak ada duplikat kabel-merah/hitam/tegangan.

## Palet hex
Oranye #ff9f1c/#f7931e, karet #15171d, krom #c9d2dc, kawat #9fc4e6 + emissive #1e63ff, merah #e53935, hijau #00e676, PCB #1b5e3c, tembaga #c8793a, kabel HV #ffb45e, kabel ground #6b7280, langit #050810–#1b2740, alas #2b3140.

## Kamera
Posisi [3.8,2.5,6.2], target [0,1.45,0], fov 45. Tur crane → orbit → zoom → dolly(explode) → zoom baterai/kabel → zoom trafo → crane dengan loop.

## Lighting
Hemisphere #7f95c7 0,6; directional key #fff4e0 2,2 + shadow; fill #6fa8ff 0,8; rim #00d0ff 1,0; bloom 0,6/0,5/0,72.

## Acceptance criteria
A. Smoke 8/8 lolos. B. Kepala bulat, jala biru menyala, tombol onClick mematikan daya. C. Setiap ujung kabel menempel ke komponen yang dimaksud, tanpa id duplikat. D. Shot explode menyingkap baterai/otak/trafo beserta jalurnya.

## Detail internal (edit manual, 55 komponen dalam group raket)
Modul dalam ditandai `internalOnly:true` — TIDAK terlihat saat scene rapat, otomatis muncul saat `applyExplode(factor>0.02)`. Jangan hapus flag ini.
- Dua cincin frame torus (depan layer `depan` offset 1,7; belakang layer `tengah` offset 0,35) + 4 tiang penyambung.
- Jala melingkar (instances) layer `jala`.
- Modul: PCB 0,26×0,018×0,30 + IC + kristal + jejak tembaga (8) + baut (4) + resistor (6) + sirip pendingin (6).
- Daya: baterai Li-ion Ø0,15×0,34 + terminal + jembatan dioda.
- Tegangan tinggi: trafo torus + inti ferit + kumparan (6) + kapasitor + kapasitor besar.
- Harness 17 segmen kabel merah/hitam/oranye/abu menghubungkan baterai → saklar → PCB → trafo → jala; karet kabel (2).
- Penyangga modul (4) mengikat komponen ke poros gagang.
Gerbang bedah: `SKOR` rata-rata ≥6 & VERDICT BEDAH LAYAK; smoke 8/8 harus tetap lolos.
