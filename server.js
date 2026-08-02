/**
 * =============================================================
 *  WhatsApp Pairing Website - server.js
 * =============================================================
 *  A Node.js + Express backend that uses the Baileys library to
 *  generate WhatsApp "pairing codes" (the 8-character link code
 *  used instead of scanning a QR, introduced by WhatsApp Web).
 *
 *  Flow:
 *   1. Client submits a phone number (with country code) via the
 *      web UI.
 *   2. Server creates a fresh Baileys socket for that "session".
 *   3. Server requests a pairing code from WhatsApp for that
 *      phone number and pushes it to the client in real time via
 *      Socket.IO.
 *   4. If a pairing code cannot be issued, the server falls back
 *      to emitting a QR code (as a data URL) instead.
 *   5. Connection status updates (connecting / waiting / open /
 *      closed / error) are streamed to the client live.
 *   6. If the connection drops unexpectedly (not a manual logout)
 *      the server automatically attempts to reconnect using the
 *      same saved credentials.
 *
 *  Auth credentials for every session are persisted under
 *  ./session/<sessionId>/ using Baileys' multi-file auth state,
 *  so a session can survive a server restart.
 * =============================================================
 */

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const express = require('express');
const { Server: SocketIOServer } = require('socket.io');
const QRCode = require('qrcode');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

// -------------------------------------------------------------
// Basic app / server setup
// -------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }, // adjust in production to your own domain
});

const PORT = process.env.PORT || 3000;

// Directory where all per-session Baileys credentials are stored.
// Keeping this outside of /public means it is never served to the
// browser, which is important because these files contain the
// WhatsApp session secrets.
const SESSION_ROOT = path.join(__dirname, 'session');
if (!fs.existsSync(SESSION_ROOT)) {
  fs.mkdirSync(SESSION_ROOT, { recursive: true });
}

// A quiet logger for Baileys internals (set to 'debug' while
// troubleshooting connection issues).
const baileysLogger = pino({ level: 'silent' });

// Keep track of active sockets/sessions in memory so we can clean
// up, avoid duplicate connections, and manage reconnect attempts
// per session.
/** @type {Map<string, { sock: any, reconnectAttempts: number, manualClose: boolean }>} */
const activeSessions = new Map();

const MAX_RECONNECT_ATTEMPTS = 5;

// -------------------------------------------------------------
// Static file serving
// -------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Serve the main pairing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeSessions: activeSessions.size });
});

// -------------------------------------------------------------
// Helper: sanitize a phone number to digits only (E.164 style,
// no leading +). Baileys expects just the digit string.
// -------------------------------------------------------------
function sanitizePhoneNumber(rawNumber) {
  if (!rawNumber || typeof rawNumber !== 'string') return null;
  const digitsOnly = rawNumber.replace(/[^0-9]/g, '');
  // A real WhatsApp number is generally between 8 and 15 digits
  if (digitsOnly.length < 8 || digitsOnly.length > 15) return null;
  return digitsOnly;
}

// -------------------------------------------------------------
// Helper: generate a short unique session id for each pairing
// attempt so multiple users/tabs can pair independently.
// -------------------------------------------------------------
function createSessionId() {
  return crypto.randomBytes(8).toString('hex');
}

// -------------------------------------------------------------
// Core: start (or restart) a Baileys connection for a session
// and wire up all the events back to the requesting client via
// Socket.IO.
// -------------------------------------------------------------
async function startWhatsAppSession({ sessionId, phoneNumber, clientSocket, isReconnect = false }) {
  const sessionFolder = path.join(SESSION_ROOT, sessionId);
  if (!fs.existsSync(sessionFolder)) {
    fs.mkdirSync(sessionFolder, { recursive: true });
  }

  try {
    // Load (or create) the persisted auth state for this session
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

    // Always try to use the latest supported WhatsApp Web protocol version
    const { version } = await fetchLatestBaileysVersion();

    if (!isReconnect) {
      clientSocket.emit('status', {
        state: 'connecting',
        message: 'Connecting to WhatsApp servers...',
      });
    }

    const sock = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false, // we handle QR ourselves and send it to the browser
      browser: ['WhatsApp Pairing Website', 'Chrome', '1.0.0'],
    });

    // Track this session so we can manage reconnects / cleanup
    activeSessions.set(sessionId, {
      sock,
      reconnectAttempts: 0,
      manualClose: false,
    });

    // If this is a brand-new (unregistered) session and the phone
    // number is present, request a pairing code instead of a QR.
    // Baileys requires the socket to be created first, then a short
    // delay before requesting the code reliably.
    if (!state.creds.registered && phoneNumber && !isReconnect) {
      // Small delay to let the socket initialize its connection
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          clientSocket.emit('pair-code', {
            code,
            formatted: code.match(/.{1,4}/g)?.join('-') || code,
          });
          clientSocket.emit('status', {
            state: 'waiting_for_pair',
            message: 'Enter this code in WhatsApp > Linked Devices > Link with phone number.',
          });
        } catch (err) {
          console.error(`[${sessionId}] Failed to request pairing code:`, err.message);
          clientSocket.emit('status', {
            state: 'error',
            message: 'Could not generate a pairing code. Falling back to QR code.',
          });
          // The 'connection.update' handler below will still emit a
          // QR code automatically if WhatsApp sends one instead.
        }
      }, 1500);
    }

    // ---------------------------------------------------------
    // Persist credentials whenever Baileys updates them
    // ---------------------------------------------------------
    sock.ev.on('creds.update', saveCreds);

    // ---------------------------------------------------------
    // Handle connection lifecycle events
    // ---------------------------------------------------------
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Fallback: only used if pairing code isn't available/requested
      // (e.g. no phone number supplied) and WhatsApp issues a QR.
      if (qr && (!phoneNumber || state.creds.registered === false)) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            margin: 1,
            width: 320,
            color: { dark: '#00ff9c', light: '#00000000' },
          });
          clientSocket.emit('qr-code', { qrDataUrl });
          clientSocket.emit('status', {
            state: 'waiting_for_pair',
            message: 'Scan the QR code with WhatsApp to connect.',
          });
        } catch (err) {
          console.error(`[${sessionId}] Failed to render QR code:`, err.message);
        }
      }

      if (connection === 'connecting') {
        clientSocket.emit('status', {
          state: 'connecting',
          message: 'Establishing connection with WhatsApp...',
        });
      }

      if (connection === 'open') {
        const session = activeSessions.get(sessionId);
        if (session) session.reconnectAttempts = 0;

        clientSocket.emit('status', {
          state: 'connected',
          message: 'Successfully connected to WhatsApp!',
        });
        clientSocket.emit('connected', {
          user: sock.user || null,
        });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const session = activeSessions.get(sessionId);

        if (isLoggedOut || session?.manualClose) {
          // Session is no longer valid - remove stored credentials
          // so a fresh pairing code is requested next time.
          clientSocket.emit('status', {
            state: 'error',
            message: 'Session logged out. Please generate a new pairing code.',
          });
          activeSessions.delete(sessionId);
          fs.rm(sessionFolder, { recursive: true, force: true }, () => {});
          return;
        }

        // -----------------------------------------------------
        // Auto-reconnect logic with a simple capped backoff
        // -----------------------------------------------------
        if (session && session.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          session.reconnectAttempts += 1;
          const delayMs = Math.min(session.reconnectAttempts * 2000, 10000);

          clientSocket.emit('status', {
            state: 'connecting',
            message: `Connection lost. Reconnecting (attempt ${session.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`,
          });

          setTimeout(() => {
            startWhatsAppSession({
              sessionId,
              phoneNumber,
              clientSocket,
              isReconnect: true,
            }).catch((err) => {
              console.error(`[${sessionId}] Reconnect failed:`, err.message);
              clientSocket.emit('status', {
                state: 'error',
                message: 'Reconnect failed. Please try generating a new code.',
              });
            });
          }, delayMs);
        } else {
          clientSocket.emit('status', {
            state: 'error',
            message: 'Unable to reconnect after multiple attempts. Please start again.',
          });
          activeSessions.delete(sessionId);
        }
      }
    });

    return sock;
  } catch (err) {
    console.error(`[${sessionId}] Fatal error starting session:`, err);
    clientSocket.emit('status', {
      state: 'error',
      message: 'Unexpected server error while starting the WhatsApp session.',
    });
    throw err;
  }
}

// -------------------------------------------------------------
// Socket.IO: real-time communication with the browser
// -------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Client asks the server to generate a pairing code for a number
  socket.on('generate-pair-code', async (payload) => {
    try {
      const rawNumber = payload && payload.phoneNumber;
      const phoneNumber = sanitizePhoneNumber(rawNumber);

      if (!phoneNumber) {
        socket.emit('status', {
          state: 'error',
          message: 'Please enter a valid phone number including the country code.',
        });
        return;
      }

      const sessionId = createSessionId();
      // Remember the session id on the socket so the client can
      // reference it later if needed (e.g. manual disconnect).
      socket.data.sessionId = sessionId;

      await startWhatsAppSession({ sessionId, phoneNumber, clientSocket: socket });
    } catch (err) {
      console.error('Error handling generate-pair-code:', err.message);
      socket.emit('status', {
        state: 'error',
        message: 'Something went wrong while generating the pairing code.',
      });
    }
  });

  // Client explicitly wants to cancel/disconnect their session
  socket.on('cancel-session', () => {
    const sessionId = socket.data.sessionId;
    const session = activeSessions.get(sessionId);
    if (session) {
      session.manualClose = true;
      try {
        session.sock.end(undefined);
      } catch (_) {
        /* ignore */
      }
      activeSessions.delete(sessionId);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    // Note: we intentionally do NOT tear down the WhatsApp session
    // here, since the user may just have refreshed the page and
    // the pairing/connection should keep progressing in the
    // background until it succeeds or fails.
  });
});

// -------------------------------------------------------------
// Global error handlers so the process doesn't crash silently
// -------------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// -------------------------------------------------------------
// Start the HTTP server
// -------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`WhatsApp Pairing Website running at http://localhost:${PORT}`);
});
