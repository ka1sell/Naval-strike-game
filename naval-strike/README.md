# Naval Strike — 6 Tim Realtime (Node.js + Socket.IO)

Battleship kuis multiplayer: 1 Admin/Juri (operator) + 6 Peserta, masing-masing di laptop terpisah, terhubung realtime lewat WebSocket.

## Cara Jalan Lokal

```bash
npm install
npm start
```

Buka `http://localhost:3000`:
- **Admin/Juri**: buka `/admin.html`, klik **"Buat Room Baru"** → muncul **kode room 6 karakter**.
- **Peserta**: buka `/player.html` di 6 device/tab berbeda, masukkan **kode room** + **nama tim**, lalu klik **Gabung**.

## Alur Permainan

1. **Lobby/Deploy** — Setiap peserta menempatkan 1 kapal (3 petak) di papan 8x8 miliknya. Admin melihat status "✅ sudah / ⏳ belum" untuk tiap peserta.
2. Setelah **6/6 peserta** menempatkan kapal, tombol **"⚔️ Semua Siap — Mulai Pertempuran"** aktif di panel admin.
3. **Battle** — Admin memilih tim yang menjawab kuis benar dengan klik **"Izinkan Tembak"**. Tim tersebut lalu memilih koordinat di papannya sendiri. Admin mengeksekusi tembakan (**"🎯 Eksekusi Tembakan"**), hasil hit/miss otomatis terdeteksi dan disiarkan ke semua peserta.
4. Permainan berakhir otomatis setelah **3 tim gugur** (kapal tenggelam, 3x kena).

## Sistem Poin (otomatis kecuali disebut manual)

| Kejadian | Poin |
|---|---|
| Poin awal | 500 |
| Jawaban kuis benar (tombol **+100**, manual oleh admin) | +100 |
| Jawaban kuis salah (tombol **-100**, manual oleh admin) | -100 |
| Berhasil menemukan posisi kapal lawan (hit) | +100 (otomatis) |
| Gugur ke-1 / ke-2 / ke-3 (kapal tenggelam) | -200 / -150 / -100 (otomatis) |
| Survive dengan 1 / 2 / 3 nyawa saat game selesai | +75 / +150 / +200 (otomatis, dihitung saat game over) |

Game otomatis berakhir setelah 3 tim gugur, dan leaderboard final + bonus survive langsung dihitung.

## Reconnect

Jika peserta refresh / koneksi putus, browser menyimpan kode room & nama tim di `localStorage` dan otomatis bergabung kembali ke slot yang sama. Admin juga otomatis reconnect ke room yang sama setelah refresh (kode room disimpan di `localStorage`).

## Deploy ke Railway

1. Push folder ini ke repo GitHub.
2. Di Railway: **New Project → Deploy from GitHub repo**.
3. Railway otomatis mendeteksi `package.json`, menjalankan `npm install` lalu `npm start`.
4. Railway menyediakan env var `PORT` otomatis — server sudah mengikuti `process.env.PORT`.
5. Setelah deploy, akses domain Railway, lalu:
   - Operator/juri buka `https://<domain>/admin.html`
   - 6 peserta buka `https://<domain>/player.html` di laptop masing-masing.

## Struktur File

```
.
├── package.json
├── server.js          # backend Express + Socket.IO, state game & logika poin
└── public/
    ├── index.html      # landing pilih Admin / Peserta
    ├── admin.html      # dashboard juri
    └── player.html     # tampilan peserta
```

## Catatan

- Papan 8x8, kapal sepanjang 3 petak, posisi antar tim boleh tumpang tindih (sesuai versi awal).
- State game disimpan **in-memory** di server — jika server restart, semua room/skor hilang. Untuk lomba sekali jalan ini cukup; jika perlu persistensi, bisa ditambah database (mis. Redis/SQLite) di langkah berikutnya.
