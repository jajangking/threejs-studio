# Kontrak Scene — "Kota Malam Mini" (sinematik, final terverifikasi)

## Konsep
Diorama kota malam SINEMATIK. Mood: tenang, hidup, sedikit misterius.
Standar: bloom pada sumber cahaya, langit gradasi berbintang, detail arsitektur,
skala manusia (trotoar, mobil, crosswalk), material terbaca di bawah cahaya bulan.
Layout terverifikasi oklusi: gedung depan rendah (kios 2.1 m), belakang tinggi (hingga 8.5 m),
koridor jalan terbuka — mobil/orang/lampu terlihat langsung dari kamera.

## Daftar objek wajib
- 7 gedung kuadran (palet biru-abu/ungu gelap terbaca cahaya), setback + AC/tangki/panel surya di atap
- Gedung tertinggi berantena + lampu merah emisif
- 160 jendela individual instanced: ~55% menyala hangat #ffb45e (emissive 2.4), sisanya kaca gelap
- 6 lampu jalan (tiang + bola emisif 4.5 + point light 18/d11)
- 3 mobil parkir (merah/biru/kuning, skala 1.35) di area terbuka persimpangan
- 2 pejalan kaki di crosswalk (jaket cerah)
- 6 pohon, trotoar terangkat, 2 crosswalk, marka tebal
- Bulan besar emisif kiri atas (fog:false) + langit gradasi #04060e→#1c2a4a + 700 bintang
- 3 kelompok awan (sky:true, in-frame via vektor kamera)

## Palet
- Gedung: #33405e #3a3547 #2f3a52 #40384a #354560 #2c3345 #3d4257
- Cahaya hangat: #ffb45e (jendela), #ffc46b (lampu jalan)
- Bulan #e8efff; bintang #a8bcff; aksen antena #ff3b30
- Jalan #1c202b, ground #12151e, trotoar #262b36

## Kamera & framing
- Posisi [12.5, 8.5, 14], target [0, ~3.4, 0], FOV ~49 (dihitung dari NDC ujung antena <0.9)
- Kota ~33% frame (coverage subjek tanpa ground/langit); semua subjek utama in-frame & tidak terhalang

## Lighting & post
- Hemisphere #3a4a6e/#141824 0.6; moonlight #a8c0e8 1.2 dari [-14,18,-8] (shadow 1024 lembut, extent 26)
- Warm fill #ff9a4d 0.3 dari [10,4,12] (bounce sisi jendela)
- Bloom 0.55/0.5/0.72; exposure 1.15; ACES; fog #0d1424 near 24 far 85
- Tekstur prosedural concrete/asphalt dengan textureRepeat skala objek (jalan [24,1], ground [24,24])

## Acceptance criteria
A. TEKNIS: smoke 8/8 (termasuk objects_unoccluded).
B. ESTETIKA: vision rubrik ≥6 + verdict layak final. Tercapai iter-17:
   komposisi 8, detail 8, material 7, cahaya 9, atmosfer 8 — LAYAK FINAL.
C. Perubahan kecil: cukup smoke + oklusi (gerbang estetika dilewati).

## Riwayat
iter-01..04 blockout (ditolak user) → iter-05..17 upgrade estetika + fix oklusi →
iter-18..30 uji self-repair agent live (diff mode, vision gate, rollback).
Baseline terverifikasi: scene-final-backup.json (iter-17).
