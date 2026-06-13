# The Wired 2.0
### Real-time multi-user chat — いとをひく

---

## Quick Start (Local / LAN)

### Step 1 — Install Node.js
Download and install from **https://nodejs.org** (choose the LTS version).
This is the only thing you need to install.

### Step 2 — Run the server

**Windows:** Double-click `START_WINDOWS.bat`

**Mac / Linux:** Open Terminal in this folder and run:
```
chmod +x START_MAC_LINUX.sh
./START_MAC_LINUX.sh
```

### Step 3 — Open in browser
Go to **http://localhost:3000**

### Step 4 — Share with friends on the same WiFi
The startup script shows a **Network address** like `http://192.168.1.x:3000`.
Anyone on the same WiFi can open that address and join.

---

## Share With Friends Over the Internet

To let anyone in the world connect, you need to expose your server.
Here are three free options — pick one:

---

### Option A — Cloudflare Tunnel (Easiest, no account needed for temp links)
1. Download cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. Start your Wired server first (Step 2 above)
3. In a second terminal window run:
   ```
   cloudflared tunnel --url http://localhost:3000
   ```
4. It gives you a public URL like `https://something.trycloudflare.com`
5. Share that link — it works as long as both terminals are running

---

### Option B — Deploy Free on Railway (Permanent, always online)
Railway gives you a free permanent server.

1. Make a free account at **https://railway.app**
2. Install Railway CLI:
   ```
   npm install -g @railway/cli
   ```
3. In the wired folder, run:
   ```
   railway login
   railway init
   railway up
   ```
4. Railway gives you a permanent URL like `https://wired-production.up.railway.app`
5. Share that link with anyone

---

### Option C — Deploy Free on Render
1. Make a free account at **https://render.com**
2. Push the wired folder to a GitHub repo
3. On Render: New → Web Service → connect your repo
4. Set:
   - Build command: `npm install`
   - Start command: `node server.js`
5. Render gives you a free permanent URL

---

## Configuration

You can set these environment variables to customize the server:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port to run on |
| `SESSION_SECRET` | random | Secret for sessions (set this for production!) |
| `DB_PATH` | `./wired.db` | Where to store the database |

**Example (Windows):**
```
set SESSION_SECRET=mysecretkey123
set PORT=8080
node server.js
```

**Example (Mac/Linux):**
```
SESSION_SECRET=mysecretkey123 PORT=8080 node server.js
```

---

## Features

- ✅ Real-time messaging with WebSockets
- ✅ Persistent accounts (SQLite database)
- ✅ Profile customization (display name, bio, status, banner color, avatar)
- ✅ Create and delete channels
- ✅ Online/offline member list
- ✅ Typing indicators
- ✅ Message history (last 100 per channel)
- ✅ Session persistence (stay logged in)
- ✅ Avatar image uploads
- ✅ Full Wired / Serial Experiments Lain aesthetic

---

## File Structure

```
wired/
├── server.js          ← The server (Node.js + Express + WebSockets)
├── package.json       ← Dependencies
├── wired.db           ← SQLite database (created on first run)
├── public/
│   ├── index.html     ← The entire frontend
│   └── uploads/       ← User avatar images
├── START_WINDOWS.bat
├── START_MAC_LINUX.sh
└── README.md
```

---

## Backup Your Data

Your messages and accounts are stored in `wired.db`.
Copy that file to back everything up.
To restore, just put it back in the same folder.

---

*No matter where you go, everyone's connected.*
