# Kontrak Scene v3 — "Kota Siang Mini" (sinematik)

## Konsep
Diorama kota SIANG cerah — kelanjutan scene malam (permintaan user: "buat jadi siang").
Mood: cerah, hidup, hangat. Standar kualitas sama dengan v2: detail arsitektur, skala manusia,
material terbaca, komposisi 3 lapis, bayangan tajam matahari.

## Daftar objek wajib
- 8 gedung (palet biru-abu/ungu, terbaca di bawah matahari), setback + detail atap (AC/tangki/antena)
- ±200 jendela individual instanced — siang: kaca gelap reflektif (metalness .6 roughness .15), lampu mati
- 6 lampu jalan (tiang + bola, siang tidak menyala)
- 3 mobil parkir + trotoar + 2 crosswalk + marka putih terang
- Matahari emisif kiri atas + langit gradasi (#1e5fa8 → #a8cfe8)
- Jalan #333a46, ground #2a2f38, trotoar #3d4450

## Kamera & framing
- Posisi [13, 6.5, 15], target [0, 3.8, 0], FOV 49 (dihitung dari NDC ujung antena 0.882)
- Kota 40–80% frame; matahari kiri atas; semua objek utama in-frame

## Lighting & post
- Hemisphere #bcd8f0/#3a4030 0.9; sun directional #fff2d8 2.2 (shadow 2048, extent 26)
- Warm fill 0.12; point light jalan intensity 0 (mati)
- Bloom strength 0.25 threshold 0.9 (halo matahari halus); exposure 1.0; ACES
- Fog haze #b8d4e8 near 30 far 95

## Acceptance criteria
A. TEKNIS (smoke): 7/7 pass — perlu tapi tidak cukup. Acuan coverage = warna fog (sRGB!).
B. ESTETIKA (vision rubrik ≥ baik): komposisi 3 lapis; detail atap/jendela/mobil terbaca;
   material tidak flat; bayangan matahari terlihat; langit gradasi cerah bukan polos.
C. Vision verdict "layak final".

## Riwayat
- v1 malam (iter-01..04): lolos teknis tapi estetika kurang (kritik user + vision).
- v2 malam sinematik (iter-05..07): bloom, langit gradasi+bintang, jendela individual, detail atap, skala manusia.
- v3 siang (iter-08): konversi permintaan user.
