# Kontrak — Gelombang Pemadaman Cahaya

## Konsep
Bola, sembilan domino, dan tiang menyala sejak awal; cahayanya padam berurutan mengikuti rantai tumbukan dari bola hingga ujung.

## Objek wajib
bola, domino-0..8, tiang, ramp + ramp-support-1/2/3 (seluruhnya tetap body fisik).

## Palet hex
#ffb45e sumber · #ff8a3d→#ffc95e→#ffe27a→#9ff0a0→#3ad4e8→#4aa8ff gradasi domino · #7f8cff finale · latar #0d1322.

## Kamera & cahaya
position [1,4,11] target [-0.5,1,0] fov 50 · hemi 0.9 · key #fff1d6 2.8 · fill #ffc98a 1.0 · bloom 0.6/0.5/0.55.

## Acceptance criteria
A. Smoke 8/8 lolos. B. Pemadaman berurutan dari bola ke tiang mengikuti delay tumbukan. C. emissiveIntensity ≤5.
