# Kontrak — Remote Kontrol Teardown

## Konsep
Remote kontrol inframerah modern ditampilkan sebagai diagram exploded technis dengan 4 lapis: keypad & tombol (depan), casing faceplate transparan, membrane + kontak karbon, PCB hijau berisi komponen elektronik, serta casing belakang berisi dua baterai AA dan pegas terminal. Subjek menjadi pusat perhatian di atas panggung gelap dengan pencahayaan produk.

## Objek wajib
- Casing depan transparan + jendela IR merah + emblem.
- Keypad lengkap: tombol daya (merah, onClick power), input, mute, volume, channel, guide, d-pad + OK, menu/back/home, empat tombol warna, 12 tombol angka (instances), dan tombol media.
- Membrane silikon + 12 kontak karbon (instances).
- PCB + MCU + 16 pin (instances) + memory IC + kristal + IR LED (blink) + indicator LED (blink) + buzzer + kapasitor/resistor/jejak tembaga (instances).
- Casing belakang + kompartemen + 2 baterai AA + tutup kuning + 2 pegas + 4 sekrup (instances) + label.
- Panggung silinder dengan rim emissive.

## Palet hex
- Casing depan: #2a3550/30% · Casing belakang: #2a2d35 · PCB: #1f7a4a
- Keypad: #cdd1d8 · Daya: #c0392b · Warna: #d63a3c/#2ea655/#d8b431/#3a76cf
- Emas (pin/kontak): #d4af37 · IR: #ff2a10 · Latar: #0a0e18 · Panggung: #151922

## Kamera & pencahayaan
- Kamera [2.6,2.4,6.4], target [0,1.9,0], fov 46 — Three-quarter hero, subjek ~50% frame.
- Hemi #4a5a80 0.65; key directional hangat #fff0d8 2.2 (shadow); fill biru #4f7fff point 16; rim oranye #ff9a5c 0.8.
- Bloom 0.5/0.5/0.75, fog gelap near14 far46, exposure 1.15.

## Interaksi
- Saklar daya mematikan LED IR & indikator; slider mengatur periode kedip; toggle mengaktifkan LED IR.
- Tombol daya bisa diklik di viewport/export. Alat Bedah bawaan (exploded, potong, X-ray, isolasi, label) untuk memeriksa tiap lapis.

## Acceptance criteria
A. Smoke 8/8 lolos (terang, subjek 2-70% frame, semua objek terlihat).
B. Dalaman terbaca jelas: PCB, MCU, IR LED, baterai dan pegas tampak dari kamera.
C. Palet kontras, tidak ada material abu default,Emissive ≤5.
