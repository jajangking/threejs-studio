# Kontrak — Raket Nyamuk Bulat (Mekanisme Dalam)

## Konsep
Product hero raket nyamuk listrik berkepala bulat. Model layered sumbu-Z menyingkap rangkaian dalam: baterai Li-ion 18650 (3,7 V / 2000 mAh), PCB otak MCU + IC, trafo boost ke ~1,2 kV dengan inti ferit, kapasitor, saklar, dan jalur kabel merah/hitam/tegangan-tinggi. Jala kawat melingkar bermuatan biru diapit dua frame torus.

## Objek wajib
alas; raket (group, layer depan/tengah/dalam/belakang): frame-depan, frame-belakang, jala-melingkar, pegangan, gagang-karet, ridges-1..4, cincin-leher, tombol-daya, led-daya, otak-pcb, ic-utama, saklar, batre-liion, trafo-boost, inti-ferit, kapasitor, kabel-merah, kabel-hitam, kabel-tegangan; nyamuk (badan, 2 sayap, mata).

## Palet hex
Oranye #ff9f1c/#f7931e, karet #15171d, krom #c9d2dc, kawat #9fc4e6 + emissive #1e63ff, merah #e53935, hijau #00e676, PCB #1b5e3c, tembaga #c8793a, kabel HV #ffb45e, langit #050810–#1b2740, alas #2b3140.

## Kamera
Posisi [3.8,2.5,6.2], target [0,1.45,0], fov 45. Tur crane → orbit → zoom → dolly(explode) → zoom → crane dengan loop.

## Lighting
Hemisphere #7f95c7 0,6; directional key #fff4e0 2,2 + shadow; fill #6fa8ff 0,8; rim #00d0ff 1,0; bloom 0,6/0,5/0,72.

## Acceptance criteria
A. Smoke 8/8 lolos (terang, subjek 2-70% frame, semua objek terlihat). B. Kepala bulat, jala biru menyala, tombol onClick mematikan daya. C. Shot explode menyingkap baterai/otak/trafo; tur tidak memotong subjek.
