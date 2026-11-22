# ESP32 Wi-Fi & Bluetooth SoC — Komponen 3D

ESP32 adalah keluarga SoC mikrokontroler low-cost berintegrasi Wi-Fi dan Bluetooth dari Espressif Systems, dirilis 6 September 2016 sebagai penerus ESP8266 [2]. Chip asli ESP32 menggunakan CPU Tensilica Xtensa LX6 varian single-core atau dual-core dengan frekuensi hingga 240 MHz, SRAM 520 KiB, ROM 448 KiB, dan tegangan 3.3 V DC [2][3]. Fitur integrable meliputi antenna switch, RF balun, power amplifier, low-noise receiver amplifier, filter, dan power-management module sehingga kebutuhan PCB eksternal minimal [1][2]. ESP32 diproduksi oleh TSMC dengan proses 40 nm dan dipakai pada rentang suhu industri –40°C sampai +125°C [2][1]. Paket fisik chip adalah QFN (quad-flat no-leads) dengan 49 pad total: 48 pad koneksi di sisi dan satu pad termal besar di bawah [2]. Varian ESP32 asli menyediakan 34 pin GPIO, 3 UART, 2 kontroler I2C, 2× ADC 12-bit, 2× DAC 8-bit, serta Wi-Fi 802.11 b/g/n dan Bluetooth 4.2 + BR/EDR LE [2]. Pada board development seperti ESP32 Dev Module, LED onboard tersambung ke GPIO 2 dan dapat dibuat berkedip 1 detik via kode Arduino [3]. Board dev juga menyediakan koneksi USB (data cable) dan chip USB-serial khusus yang memerlukan driver saat Komputer belum mendeteksi COM port [3]. Dimensi fisik pasti (mis. lebar QFN dan tinggi board) tidak tercantum di sumber [unverified].

## Komponen wajib
- Chip ESP32 (QFN body): ['qfn', 'chip', 'black epoxy', 'package', 'esp32-d0wdq6'] (min 1)
- Pad termal besar di bawah chip: ['thermal pad', 'exposed pad', 'ground', 'heatsink'] (min 1)
- 48 pad koneksi QFN di sekeliling chip: ['pads', 'leads', 'qfn pads', 'solder', '48 pads'] (min 48)
- Seksi RF: antenna switch, balun, PA, LNA, filter: ['rf', 'antenna', 'balun', 'power amplifier', 'lna', 'filter'] (min 1)
- PCB board development (mis. ESP32 Dev Module): ['pcb', 'dev module', 'development board', 'green solder mask'] (min 1)
- Konektor USB untuk daya dan upload program: ['usb', 'micro-usb', 'usb-c', 'data cable', 'upload'] (min 1)
- Header/pin GPIO (34 GPIO pada chip ESP32 asli): ['gpio', 'header pins', '34 gpio', 'breakout'] (min 2)
- LED onboard di GPIO 2 (kedip 1 Hz): ['led', 'gpio2', 'onboard led', 'blink'] (min 1)
- Tombol reset dan BOOT (BOOT diperlukan saat upload gagal): ['boot', 'reset', 'button', 'upload'] (min 2)
- Regulator 3.3 V DC: ['3.3v', 'regulator', 'ldo', 'power'] (min 1)

Sources:
[1] https://www.espressif.com/en/products/socs/esp32
[2] https://en.m.wikipedia.org/wiki/ESP32
[3] https://iotstarters.com/getting-started-with-esp32-beginners-guide
[4] https://www.amazon.com/esp32/s?k=esp32
