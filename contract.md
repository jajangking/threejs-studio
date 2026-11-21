# Kontrak — jam dinding (mesin mekanis)

## Konsep
Jam dinding klasik bernuansa interior modern. Di balik wajah krem tersimpan mesin mekanis nyata: tong per penggerak, kereta roda gigi, jangkar escapement, dan bandul pengatur waktu.

## Objek wajib
- dinding, papan-bawah, casing-jam, wajah-jam, bezel, lintasan-menit, penanda-jam (12 instancing).
- jarum-jam / jarum-menit / jarum-detik + pusat-jam (mekanika permukaan).
- platina, barel-per (+ drum, gigi, poros): sumber tenaga pegas pada tong bergigi (going barrel).
- roda-tengah, roda-ketiga, roda-keempat, roda-jalan: kereta roda; pasangan gigi-pinion berlawanan arah, laju naik menuju escape.
- jangkar dua palet + garpu: mengunci/melepas satu gigi roda-jalan per ayunan (detak tik-tok).
- bandul batang + bob: osilasi periode tetap, tersambung ke jangkar lewat garpu (periode sama 1,2 s).
- roda-menit + roda-jam: motion work 12:1 (cannon pinion → roda menit → roda jam) sehingga jarum jam = 1/12 laju jarum menit.
- rak, pot, tanaman, bingkai, lukisan: penyeimbang komposisi tiga lapis.

## Palet hex
- Dinding #26303c, papan bawah #1b222b, latar #151b24
- Casing #2b2119, wajah #f2e9d8, bezel/pusat #c9a227 / #d4af37
- Kuningan mesin #b08d57 / #c9a227 / #d4af37, baja #7c8794 / #9aa4b2
- Penanda #2b2620, jarum #23201c, jarum detik #c0392b
- Kayu #5a4632, pot #a8613f, daun #3f7a4a, bingkai #3b2f24, lukisan #6a8fa8

## Kamera
Default [0,2.6,6] → [0,2.5,0], fov 45 (wajah utuh). Tur 6 shot: establish → exploded reveal → closeup roda tengah → jangkar/escape → bandul → pull back, masing-masing berkaption.

## Lighting
Hemisphere #9fb4d8 / #242a35 0.55; key #fff0d6 2.3 dari [6,9,7] + shadow; fill #8fb3ff 0.45 dari [-6,4,5]; bloom 0.25/0.5/0.9.

## Acceptance criteria
A. Smoke 8/8 lolos; tampilan default tetap jam utuh dan mesin tersembunyi seperti jam asli.
B. Mesin terbaca melalui Bedah exploded/cutaway dan tur kamera; semua roda, jangkar, bandul terlihat.
C. Arah putar roda berselang-seling, laju naik ke roda-jalan, jangkar dan bandul sinkron, jarum jam = 1/12 jarum menit.
D. Tidak ada komponen rekaan; semua bagian mengikuti mekanika jam mekanis yang sebenarnya.
