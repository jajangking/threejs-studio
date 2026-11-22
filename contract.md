# Kontrak — Raket Nyamuk (jala tiga grid & kontak nyamuk)
Konsep: product hero raket berkepala bulat dengan rangkaian internal 3 grid + boost ~3 kV.
Assembly layered axis Z: cangkang(+2.5), keypad(+1.35), depan(+1.8), jala(+0.9), otak(+0.35), tengah(0), pegangan(0), dalam(-0.5), baterai(-1.2), kabel(-1.6), belakang(-2.6).
Grid jala: jala-melingkar = grid tengah HV berkedip di z=0; jala-luar-depan (z=+0.06) dan jala-luar-belakang (z=-0.06) = grid luar dibumikan, keduanya layer jala dan mengikuti osilasi raket.
Nyamuk (badan/sayap kiri/sayap kanan/mata) berada di layer jala, badannya diposisikan menjembatani grid tengah dan grid luar depan; busur-kontak + titik-kontak-tengah + titik-kontak-luar menandai busur listrik saat serangga menyentuh kedua grid sekaligus.
Modul internal: otak=PCB+IC+kristal+jejak+baut+sirip+resistor+penyangga+saklar; dalam=trafo+inti+koil+kapasitor+pengali(dioda+kapasitor)+jembatan+penyangga; baterai=sel 18650+terminal+rel+pegas+landasan+label spesifikasi+kabel plus/minus+karet; kabel=tegangan+ground (dynamicCablesTubeGeometry saat explode); belakang=tiang frame.
Teardown: cangkang depan polikarbonat transparan + gasket; keypad silikon dengan tombol ON/OFF, lensa LED, dan legend ON/OFF + CHARGE 5V; semua internalOnly berada di grup raket-detail.
Perbaikan teknis: objek instances wajib memakai field transforms di root spec (bukan instances.transforms).
Acceptance: bedah keterpisahan/kelengkapan/keterbacaan/kerapian ≥8; smoke 8/8 tetap lolos; semua id unik tanpa duplikat.

## Grid tiga lapis & shot makro (edit manual)
Jala tengah `jala-melingkar` di z=0; `jala-luar-depan` z=+0.14; `jala-luar-belakang` z=-0.14 (sebelumnya ±0,06 terlalu rapat untuk terbaca). Nyamuk di z=+0,07 (di antara grid tengah & depan), titik kontak tengah z=0,004 & luar z=0,136, busur kontak z=0,07. Shot `cameraPath`: `establish-raket` (orbit) + `makro-grid` (dolly dari [2.6,2.6,0.9] ke [1.1,2.45,0.35], target nyamuk-badan) — render `scripts/render.py --time 8`. Jangan rapatkan grid lagi: visi tidak bisa membedakan tiga lapis bila <0,1 m.
