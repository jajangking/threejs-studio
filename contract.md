# Kontrak — kabel data charger (teardown)

## Konsep
Kabel USB-C braided premium digelung di atas tikar studio gelap. Selain tampilan luar, kini setiap lapisan dalam tersedia sebagai objek nyata: anyaman → 4 kawat berinsulasi (VBus/GND/D−/D+) → isolasi → PCB → pin tembaga, siap dibedah.

## Objek wajib
- desk-mat; cable-braid (instances anyam).
- kawat-vbus / kawat-gnd / kawat-dminus / kawat-dplus: 4 instances kawat mengikuti spline kabel (radius 0.013 m), tertanam di dalam anyaman.
- connector-a/b: group berisi boot, 4 ridge, shell, seam, tip, insert, LED + kawat-vbus/gnd/dminus/dplus, isolasi, pcb, pin-1..4.
- cable-ring-a-1/2, cable-ring-b-1/2: cincin logam aksen.

## Palet hex
Anyam #1c2633 · Karet #161d28 / ridge #26303e · Aluminium #c4ccd6 / seam #7b8794 · Tip #6d7a88 · LED emissive #37e6ff · Kawat #d9474f / #232830 / #cfd6df / #35b06f · Isolasi #3a3026 · PCB #1c6b4d · Pin #e0b64a · Tikar #1a2331 · Ground #141924 · Background #080b12

## Kamera & lighting
Posisi [5.8,7.2,8.8], target [0,0.2,0], fov 45. Hemi #93a9cc 0.9; key #fff0da 2.4 + bayangan; fill #6f8fd0 0.8; rim #b9ccff 1.25; exposure 1.2; bloom 0.55/0.5/0.78.

## Cara bedah (panel 🔬 Bedah bawaan studio)
Exploded slider atau preset 25/50/75% untuk memisah shell & kawat; Section (sumbu X/Y/Z + posisi potong + Caps) mis. sumbu Y posisi 0.10 membelah kabel menyingkap 4 kawat; X-ray untuk melihat kawat tembaga di dalam housing; Isolasi + Label nama untuk membaca tiap kawat.

## Acceptance criteria
A. Smoke 8/8 lolos; kawat tersembunyi saat normal (tanpa duplikat visual).
B. Saat Section/Explode/X-ray, 4 kawat + PCB + pin terbaca jelas dengan warna berbeda.
C. Konektor tetap solid tertutup di tampilan default; LED menyala dengan bloom.
