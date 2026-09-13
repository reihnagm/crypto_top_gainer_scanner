# Crypto Top Gainer Scanner

Scanner Node.js untuk memantau coin Top Gainers dari data CoinGecko, menyimpan
snapshot, menghitung kemunculan berulang, menilai momentum, dan mengirim alert Telegram.

Script ini **tidak melakukan auto-buy/auto-sell**. Output-nya adalah shortlist untuk dianalisis lagi.

## Algoritma

Universe default v2:

- Market rank maksimal 1.500
- Market cap minimal USD 5 juta
- Volume 24 jam minimal USD 1 juta untuk menghindari penalti
- Kenaikan 24 jam minimal 5%
- Diurutkan berdasarkan kenaikan 24 jam
- Mengambil Top 30

Konfigurasi ini mencakup coin sekitar rank #1000, termasuk profil data seperti
Akedo pada contoh pengguna. Rank 1.500 membutuhkan enam request `/coins/markets`
per scan karena satu halaman memuat maksimal 250 coin.

Scoring default:

- `+2`: masuk Top 10 gainer
- `+1`: masuk Top 11–30
- `+1`: perubahan 1 jam masih positif
- `+1`: volume bertambah minimal 5% dari snapshot sebelumnya
- `+1`: muncul minimal 3 kali pada hari yang sama
- `-2`: volume 24 jam di bawah USD 5 juta
- `-2`: kenaikan 24 jam ekstrem tetapi momentum/volume melemah
- `-1`: volume/market-cap mencapai batas abnormal yang dikonfigurasi

Alert dikirim jika score minimal 5 dan coin tidak sedang dalam cooldown alert.

## 1. Persyaratan

- Node.js 20 atau lebih baru
- npm
- CoinGecko Demo API key opsional
- Telegram bot opsional, tetapi disarankan

## 2. Instalasi

```bash
unzip crypto-top-gainer-scanner.zip
cd crypto-top-gainer-scanner

npm install
cp .env.example .env
```

## 3. Buat Telegram Bot

1. Buka Telegram dan chat `@BotFather`.
2. Jalankan `/newbot`.
3. Salin token bot ke `.env`:

```env
TELEGRAM_BOT_TOKEN=token_dari_botfather
```

4. Buka bot yang baru dibuat, tekan **Start**, lalu kirim satu pesan.
5. Ambil Chat ID:

```bash
npm run chatid
```

6. Salin `chatId` ke `.env`:

```env
TELEGRAM_CHAT_ID=123456789
```

## 4. CoinGecko API

Tanpa API key, script dapat mencoba endpoint public/keyless.

Untuk penggunaan yang lebih stabil, buat CoinGecko Demo API key dan isi:

```env
COINGECKO_API_KEY=api_key_kamu
```

## 5. Test satu kali

```bash
npm run scan
```

Pada scan pertama, fitur `volume naik` belum punya pembanding. Setelah beberapa siklus,
script mulai menghitung pertumbuhan volume dan kemunculan berulang.

## 6. Jalankan terus

```bash
npm start
```

Default scan setiap 30 menit:

```env
CRON_SCHEDULE=*/30 * * * *
```

Contoh setiap 15 menit:

```env
CRON_SCHEDULE=*/15 * * * *
```

Semakin sering scan, sesuaikan `MIN_APPEARANCES`. Untuk interval 15 menit,
nilai 4–6 lebih masuk akal daripada 3 agar sinyal tidak terlalu cepat.

## 7. Jalankan dengan PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Lihat log:

```bash
pm2 logs crypto-top-gainer-scanner
```

## 8. Jalankan dengan Docker

```bash
cp .env.example .env
# edit .env terlebih dahulu

docker compose up -d --build
docker compose logs -f
```

## Pengaturan yang disarankan

Lebih konservatif:

```env
MAX_MARKET_RANK=300
MIN_MARKET_CAP=50000000
MIN_VOLUME=5000000
MIN_APPEARANCES=4
ALERT_SCORE=5
EXTREME_PUMP_PERCENT=40
```

Default micro-cap v2:

```env
MAX_MARKET_RANK=1500
MIN_MARKET_CAP=5000000
MIN_VOLUME=1000000
MIN_APPEARANCES=3
ALERT_SCORE=5
EXTREME_PUMP_PERCENT=40
PAGE_DELAY_MS=700
```

Lebih agresif, tetapi jauh lebih banyak noise:

```env
MAX_MARKET_RANK=2000
MIN_MARKET_CAP=1000000
MIN_VOLUME=250000
MIN_APPEARANCES=2
ALERT_SCORE=4
PAGE_DELAY_MS=900
```

## Catatan penggunaan

- Top gainer bukan sinyal beli otomatis.
- Hindari mengejar candle yang sudah terlalu tinggi.
- Cek liquidity/order book di exchange yang digunakan.
- Uji dengan paper trading terlebih dahulu.
- Catat hasil setiap alert agar parameter dapat dievaluasi berdasarkan data, bukan perasaan.


## Perubahan v2

- Pagination dibuat dinamis berdasarkan `MAX_MARKET_RANK`.
- Default diperluas sampai rank 1.500.
- Default market cap diturunkan menjadi USD 5 juta.
- Default volume diturunkan menjadi USD 1 juta.
- Alert threshold dinaikkan menjadi 5 agar micro-cap tidak terlalu mudah lolos.
- Pump ekstrem mulai diperiksa dari 40%.
- Menambahkan rasio volume/market-cap dan penalti turnover abnormal.
- Request halaman dilakukan satu per satu dengan jeda untuk mengurangi error HTTP 429.

### Contoh interpretasi Akedo

Dengan contoh data market cap sekitar USD 13,28 juta, volume sekitar USD 19,47 juta,
rank sekitar #1001, dan perubahan 24 jam sekitar +201%, coin akan masuk scanner.
Namun perubahan 1 jam negatif dan pump ekstrem akan menurunkan score. Jadi coin bisa
muncul di terminal tanpa langsung menghasilkan sinyal Telegram. Ini perilaku yang
disengaja untuk menghindari entry ketika momentum mulai melemah.
