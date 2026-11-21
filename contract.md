# Kontrak — kabel data charger

## Konsep
Kabel data/charger USB-C premium dengan anyaman braided gelap, digelung bebas di atas tikar meja studio. Fokus pada detail konektor: housing aluminium, strain relief berusuk, tip logam, dan LED aksen biru. Suasana studio gelap sinematik dengan tiga lapis komposisi.

## Objek wajib
- desk-mat: tikar meja silindris sebagai foreground.
- cable-braid: instances segmen silinder mengikuti spline, radius 0.06 m.
- cable-ring-a/b: cincin logam aksen dekat konektor.
- connector-a, connector-b: group berisi boot karet + 4 ridge + shell aluminium + seam + tip + insert + LED emissive.

## Palet hex
- Kabel anyam: #1c2633
- Karet boot: #161d28, ridge #26303e
- Aluminium shell: #c4ccd6, seam #7b8794
- Tip gunmetal: #6d7a88, insert #090c12
- LED: emissive #37e6ff
- Tikar: #1a2331, ground #141924, background #080b12

## Kamera
Posisi [7.5,9.5,11.5], target [0,0.2,0], fov 45 — pandangan atas miring, seluruh gelungan dan kedua konektor masuk frame.

## Lighting
Hemisphere #93a9cc intensity 0.9; key directional hangat #fff0da 2.4 dari [7,11,6] dengan bayangan; fill #6f8fd0 0.9; rim #b9ccff 1.1; exposure 1.25; bloom 0.55/0.5/0.75.

## Acceptance criteria
A. Smoke 8/8 lolos (terang, subjek 2-70% frame, semua objek terlihat).
B. Konektor terbaca detail, kabel mulus tanpa jump, LED menyala dengan bloom.
C. Gerbang estetika vision ≥6 dan verdict layak final.
