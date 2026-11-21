# Referensi teknis: kabel data USB-C ↔ USB-A

*Semua ukuran dalam millimeter. Agent menulis spec dalam meter (1 mm = 0,001 m).*

## Fakta konstruksi (urut dari luar ke dalam)
1. **Jaket luar** TPE/PVC, diameter 4,0–4,8 mm.
2. **Shield EMI**: anyangan tembaga + foil aluminium.
3. **Drain wire** menyentuh anyangan (biasanya polos/timah).
4. **Konduktor** AWG 24–28 berisolasi:
   - Vbus = merah
   - GND = hitam
   - D+ = hijau
   - D− = putih
   - CC = biru (wajib di USB-C, opsional di USB-A)
5. **Strain relief** ~20 mm di tiap ujung kabel.
6. **Ferrite bead** opsional dekat konektor.
7. Konduktor di dalam kabel **saling mengepang (helix)**, bukan lurus sejajar.

## Konektor USB-A
- Cangkang logam persegi panjang **12,0 × 7,0 × 4,5 mm**
- **4 pin datar**: Vbus, D−, D+, GND — spasi 2,5 mm
- Insulasi hitam + dua tab logam di dalam cangkang.

## Konektor USB-C
- Cangkang logam profil **rounded-rectangle 8,26 × 2,56 mm**, panjang ~6,7 mm
- **Lidah (tongue)** di tengah bukaan
- **24 kontak** dalam dua baris (12 atas + 12 bawah)
- Pin **CC1 / CC2** di samping (untuk negosiasi daya)
- Bukaan oval khas, bukan kotak.

## Aturan untuk agent
- Setiap bagian di atas harus punya objek dengan **id mengandung keyword** dari `required_parts` di file JSON (jacket, shield, drain, vbus, gnd, dplus, dminus, cc, strain, usb-a, usb-c, tongue, pin).
- 24 pin boleh dibuat dengan satu objek `instances` berisi 24 transform.
- Gerbang semantik akan menolak scene bila ada bagian wajib yang hilang — **detail teknis lebih penting daripada dekorasi**.
