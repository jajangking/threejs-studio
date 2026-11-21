# Kontrak — jam dinding kuarsa

## Konsep
Jam dinding klasik bernuansa interior modern dengan mesin kuarsa bertenaga baterai AA. Tampilan luar tetap utuh; modul kuarsa terlihat lewat Bedah/exploded view dan tur kamera.

## Objek wajib
- Dinding, papan-bawah, casing-jam, wajah-jam, bezel, lintasan-menit, penanda-jam, jarum-jam/menit/detik, pusat-jam.
- Modul kuarsa: penopang-mesin, baterai-aa, pcb-kuarsa, kristal-kuarsa, kumparan-motor, rotor-stepper.
- Rangkaian roda gigi kuarsa: gir-detik-kuarsa, gir-menit-kuarsa, gir-jam-kuarsa.
- Dekor: rak, pot, tanaman, bingkai, lukisan.

## Palet hex
- Dinding #26303c, casing #2b2119, wajah #f2e9d8, bezel #c9a227.
- PCB #1d6b46, baterai #1f2328/#d7b24a, kristal #cfd6de, kumparan tembaga #b87333, logam #8a8f96/#707782.
- Roda gigi kuningan #c9a227/#b08d57/#d4af37, jarum detik #c0392b.

## Kamera
Default [0,2.6,6] → [0,2.5,0], fov 45. Tur 5 shot: establish, reveal exploded modul kuarsa, closeup kristal, closeup rotor/roda gigi, pullback.

## Lighting
Hemisphere #9fb4d8/#242a35 0.55; key #fff0d6 2.3 dari [6,9,7] shadow; fill #8fb3ff 0.45; bloom 0.25/0.5/0.9.

## Acceptance criteria
A. Smoke 8/8 lolos; tampilan default jam utuh.
B. Mesin kuarsa terbaca lewat Bedah/exploded dan tur kamera.
C. Ada baterai, kristal kuarsa, kumparan/rotor stepper, dan roda gigi penerus jarum.
D. Tidak ada komponen mekanis pegas/bandul/escapement yang tersisa.
