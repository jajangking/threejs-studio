# Kontrak — Demo Fisika Rapier + Gelombang Cahaya

## Konsep
Bola bercahaya menggelinding menuruni ramp dan memicu gelombang emissive berurutan pada 9 domino (hangat→dingin) yang ditutup oleh tiang di ujung.

## Objek wajib
ramp + ramp-support-1/2/3 (fixed), bola (dynamic, sumber cahaya), domino-0..8 (dynamic, blink berjeda), tiang (finale). Seluruhnya tetap body fisik.

## Palet hex
#ffb45e sumber · #ff8a3d→#ffc95e→#ffe27a→#9ff0a0→#3ad4e8→#4aa8ff gradasi domino · #7f8cff finale · #49536a ramp · latar #0d1322.

## Kamera & cahaya
position [1,4,11] target [-0.5,1,0] fov 50 · hemi 0.9 · key #fff1d6 2.8 · fill #ffc98a 1.0 · bloom 0.6/0.5/0.55.

## Acceptance criteria
A. Smoke 8/8 pass.
B. Cahaya merambat dari bola hingga tiang tanpa mengubah fisika.
C. emissiveIntensity ≤5 pada semua objek.
