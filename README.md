# WhatsApp Pairing Website

A modern, dark-themed web app that generates WhatsApp **pairing codes** using
[Baileys](https://github.com/WhiskeySockets/Baileys), Express, and Socket.IO —
with a QR-code fallback and automatic reconnect.

## Features

- Clean dark UI with neon-green accents and glassmorphism cards
- Fully responsive (mobile + desktop)
- Phone number input with country code
- Live status updates: Connecting → Waiting for Pair → Connected → Error
- Pairing code display, with QR code shown only if a pairing code can't be issued
- Auto-reconnect with capped backoff if the connection drops
- Per-session auth files stored under `/session/<sessionId>/`, never served publicly

## Project Structure

```
whatsapp-pairing/
├── public/
│   ├── css/
│   │   └── style.css       # Dark neon glassmorphism styling
│   └── js/
│       └── script.js       # Client-side Socket.IO logic
├── views/
│   └── index.html          # Main pairing page
├── session/                # Per-session Baileys auth state (auto-created)
├── server.js                # Express + Baileys + Socket.IO backend
├── package.json
└── README.md
```

## Requirements

- Node.js **18+**
- npm

## Installation

```bash
npm install
```

## Running the app

```bash
npm start
```

Then open your browser at:

```
http://localhost:3000
```

For development with auto-restart on file changes:

```bash
npm run dev
```

## How it works

1. Enter your WhatsApp number **with country code, digits only** (e.g. `94771234567`).
2. Click **Generate Pair Code**.
3. Within a couple of seconds, an 8-character pairing code appears.
4. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device →
   Link with phone number instead**, then enter the code.
5. Once WhatsApp confirms the link, the page updates to a "Device Linked
   Successfully" state automatically.

If WhatsApp cannot issue a pairing code for some reason, the app automatically
falls back to displaying a scannable QR code instead.

## Notes on security

- Each pairing attempt gets its own session folder under `/session/`, which
  contains sensitive WhatsApp Web credentials. This folder is **not** served
  as a static asset and should never be committed to version control (already
  covered by `.gitignore`).
- If a session is logged out from the phone, its auth files are automatically
  deleted from disk.
- For production use, put this behind HTTPS and restrict the Socket.IO CORS
  origin in `server.js` to your actual domain.

## License

MIT
