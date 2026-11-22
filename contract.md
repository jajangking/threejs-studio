# Kontrak — Raket Nyamuk (perbaikan bedah)
Konsep: product hero raket berkepala bulat dengan rangkaian internal 3 grid + boost ~3 kV.
Assembly layered axis Z: depan(+1.8), jala(+0.9), otak(+0.35), tengah(0), pegangan(0), dalam(-0.5), baterai(-1.2), kabel(-1.6), belakang(-2.6).
Modul internal: otak=PCB+IC+kristal+jejak+baut+sirip+resistor+penyangga+saklar; dalam=trafo+inti+koil+kapasitor+pengali+jembatan+penyangga; baterai=sel+terminal+kabel plus/minus+karet+penyangga; kabel=tegangan+ground (segmen disebar lintas layer untuk efek jembatan saat explode); belakang=tiang frame.
Eksterior (frame-depan, frame-belakang, jala, gagang, nyamuk) tidak diubah.
Catatan jujur: kabel tetap kaku; kabel dinamis yang benar-benar membengkok dan menyambung saat explode memerlukan perubahan kode studio, bukan spec.
Acceptance: bedah keterpisahan/kelengkapan/keterbacaan/kerapian ≥8; smoke 8/8 tetap lolos; semua id unik tanpa duplikat.

## Kabel dinamis & capability
Kabel fleksibel didefinisikan di `spec.dynamicCables` (from/to `{id, at:[x,y,z]}`, color, radius, sag) — TubeGeometry dihitung ulang tiap `applyExplode`, tetap menyambung antar lapisan. Segmen kabel lama `hideOnExplode:true` (hilang saat bedah agar tidak dobel). Agent boleh membuat capability baru via alat `create_capability` / POST `/api/capability/install`: JS `export function install(handle, THREE)`, divalidasi `node --check` + larangan fetch/eval/import/shell/storage, lalu diaktifkan dengan menambahkan nama ke `spec.extensions` (dimuat builder via `loadExtensions`).
