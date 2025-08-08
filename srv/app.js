// app.js
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const qrcode = require('qrcode');
const pino = require('pino');
const rateLimit = require('express-rate-limit');
const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const mysql = require('mysql2/promise');
const { useMySQLAuthState, clearSession } = require('./mysql-auth'); // implementasi mysql-auth.js kita
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Configuration
 */
const PORT = process.env.PORT || 3000;
const AUTH_BASE = path.join(__dirname, 'auth_info'); // (fallback storage, not used when using mysql-auth)
if (!fs.existsSync(AUTH_BASE)) fs.mkdirSync(AUTH_BASE, { recursive: true });

/**
 * Init DB (auto-create DB + tables if needed)
 */
const DB_NAME = process.env.DB_NAME || 'whatsapp';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASS = process.env.DB_PASS || '';
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || 3306;

let pool;
async function initDB() {
  // create DB if not exists (connect without database)
  const admin = await mysql.createConnection({ host: DB_HOST, user: DB_USER, password: DB_PASS, port: DB_PORT });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
  await admin.end();

  pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_CONN_LIMIT || '10', 10),
    queueLimit: 0
  });

  // ensure tables
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(150) NOT NULL UNIQUE,
        phone_number VARCHAR(80) DEFAULT NULL,
        status ENUM('loading','qr_received','connected','disconnected','logged_out') DEFAULT 'loading',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(150) DEFAULT NULL,
        direction ENUM('in','out') NOT NULL,
        from_who VARCHAR(150) DEFAULT NULL,
        to_who VARCHAR(150) DEFAULT NULL,
        text TEXT,
        media_type VARCHAR(50) DEFAULT NULL,
        media_base64 LONGTEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } finally {
    conn.release();
  }
  logger.info('DB initialized');
}

/**
 * Helpers: session DB helpers
 */
const sessionStore = {
  async upsert(sessionId, { phone=null, status='loading' } = {}) {
    const conn = await pool.getConnection();
    try {
      await conn.query(`
        INSERT INTO sessions (session_id, phone_number, status)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE phone_number=VALUES(phone_number), status=VALUES(status), updated_at=CURRENT_TIMESTAMP
      `, [sessionId, phone, status]);
    } finally { conn.release(); }
  },
  async updateStatus(sessionId, status) {
    const conn = await pool.getConnection();
    try {
      await conn.query(`UPDATE sessions SET status=? WHERE session_id=?`, [status, sessionId]);
    } finally { conn.release(); }
  },
  async list() {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`SELECT * FROM sessions ORDER BY updated_at DESC`);
      return rows;
    } finally { conn.release(); }
  }
};

const messageStore = {
  async insert({ sessionId=null, direction='in', from=null, to=null, text=null, media_type=null, media_base64=null }) {
    const conn = await pool.getConnection();
    try {
      await conn.query(`INSERT INTO messages (session_id, direction, from_who, to_who, text, media_type, media_base64) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, direction, from, to, text, media_type, media_base64]);
    } finally { conn.release(); }
  },
  async history(sessionId, limit=100) {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?`, [sessionId, limit]);
      return rows;
    } finally { conn.release(); }
  }
};

/**
 * Express + Socket.IO setup
 */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// multer for uploads
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

// rate limiter for REST API
app.use('/api/', rateLimit({
  windowMs: (parseInt(process.env.RATE_WINDOW_MINUTES || '1', 10) * 60 * 1000),
  max: parseInt(process.env.RATE_MAX_REQUESTS || '120', 10)
}));

/**
 * In-memory active sessions
 * SESSIONS[sessionId] = { sock, lastQr, createdAt, contactsCached }
 */
const SESSIONS = {};

/**
 * format jid helper
 */
function formatJid(numberOrJid) {
  if (!numberOrJid) throw new Error('missing number/jid');
  let s = String(numberOrJid).trim();
  if (s.endsWith('@s.whatsapp.net') || s.endsWith('@g.us')) return s;
  s = s.replace(/[^0-9]/g,'');
  return `${s}@s.whatsapp.net`;
}

/**
 * Start Baileys session using useMySQLAuthState
 * - creates sock
 * - handles connection updates
 * - handles messages, contacts, presence, etc
 */
async function startBaileysSession(sessionId, socketClient=null) {
  if (SESSIONS[sessionId] && SESSIONS[sessionId].sock) return SESSIONS[sessionId].sock;

  await sessionStore.upsert(sessionId, { status: 'loading' });

  // useMySQLAuthState provided by mysql-auth.js
  const { state, saveCreds } = await useMySQLAuthState(pool, sessionId);

  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [4, 0, 0] }));

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: Browsers.macOS('WhatsAppBot')
  });

  SESSIONS[sessionId] = { sock, lastQr: null, createdAt: Date.now(), contacts: {} };

  // persist creds
  sock.ev.on('creds.update', saveCreds);

  // connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrData = await qrcode.toDataURL(qr);
        SESSIONS[sessionId].lastQr = qrData;
        if (socketClient) socketClient.emit('qr', { sessionId, qr: qrData });
        io.emit('session', { id: sessionId, status: 'qr_received' });
        await sessionStore.updateStatus(sessionId, 'qr_received');
      } catch(e){}
    }

    if (connection === 'open') {
      logger.info(`[${sessionId}] connected`);
      // try set phone from sock.user
      try {
        const me = sock.user || {};
        const phone = me?.id?.split(':')[0];
        if (phone) await sessionStore.upsert(sessionId, { phone, status: 'connected' });
      } catch(e){}
      io.emit('session', { id: sessionId, status: 'connected' });
      await sessionStore.updateStatus(sessionId, 'connected');
      io.emit('session-connected', { sessionId, user: sock.user });

      // send contacts snapshot
      try {
        const contacts = Object.values(sock.store.contacts || {}).map(c => ({
          id: c.id, name: c.name || c.notify || null
        }));
        SESSIONS[sessionId].contacts = contacts;
        io.emit('contact-list', { sessionId, contacts });
      } catch(e){}
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      logger.info(`[${sessionId}] connection closed code=${code}`);
      if (code === DisconnectReason.loggedOut) {
        await sessionStore.updateStatus(sessionId, 'logged_out');
        io.emit('session', { id: sessionId, status: 'logged_out' });
        delete SESSIONS[sessionId];
        io.emit('log', `[${sessionId}] logged_out`);
      } else {
        await sessionStore.updateStatus(sessionId, 'disconnected');
        io.emit('session', { id: sessionId, status: 'disconnected' });
        io.emit('log', `[${sessionId}] disconnected - will attempt reconnect in 3s`);
        setTimeout(() => startBaileysSession(sessionId).catch(logger.error), 3000);
      }
    }
  });

  // messages listener — saves and emits
  sock.ev.on('messages.upsert', async (m) => {
    const messages = m.messages || [];
    for (const msg of messages) {
      if (!msg.message || msg.key?.remoteJid === 'status@broadcast') continue;

      // extract text if any
      let text = '';
      if (msg.message.conversation) text = msg.message.conversation;
      else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
      else if (msg.message.imageMessage?.caption) text = msg.message.imageMessage.caption;

      // save to DB
      await messageStore.insert({
        sessionId,
        direction: msg.key.fromMe ? 'out' : 'in',
        from: msg.key.remoteJid,
        to: sock.user?.id || null,
        text,
        media_type: msg.message?.imageMessage ? 'image' : (msg.message?.documentMessage ? 'document' : null)
      });

      // emit to frontends
      io.emit('message', { sessionId, from: msg.key.remoteJid, text, key: msg.key });
    }
  });

  // contacts update
  sock.ev.on('contacts.update', (contacts) => {
    // contacts: array of contact objects
    SESSIONS[sessionId].contacts = Object.values(sock.store.contacts || {});
    io.emit('contact-list', { sessionId, contacts: SESSIONS[sessionId].contacts.map(c => ({ id: c.id, name: c.name || c.notify })) });
  });

  // group updates
  sock.ev.on('groups.update', (updates) => {
    io.emit('groups-update', { sessionId, updates });
  });

  // presence updates
  sock.ev.on('presence.update', (pres) => {
    io.emit('presence', { sessionId, presence: pres });
  });

  // connection states, battery, etc
  sock.ev.on('connection.update', (u) => {
    io.emit('connection.update', { sessionId, update: u });
  });

  return sock;
}

/**
 * Socket.IO handlers for frontend
 */
io.on('connection', (socket) => {
  logger.info('Socket client connected');

  // start or restore session
  socket.on('start-session', async ({ sessionId } = {}) => {
    try {
      if (!sessionId) sessionId = 'main';
      io.emit('log', `start-session requested: ${sessionId}`);
      await startBaileysSession(sessionId, socket);
      await sessionStore.upsert(sessionId, { status: 'loading' });
      socket.emit('session', { id: sessionId, status: 'loading' });
      const list = await sessionStore.list();
      socket.emit('sessions-list', list);
    } catch (err) {
      logger.error('start-session err', err);
      socket.emit('error-message', err?.message || String(err));
    }
  });

  socket.on('request-qr', ({ sessionId='main' } = {}) => {
    try {
      const s = SESSIONS[sessionId];
      if (s && s.lastQr) socket.emit('qr', { sessionId, qr: s.lastQr });
      else startBaileysSession(sessionId, socket).catch(e => socket.emit('error-message', String(e)));
    } catch (e) { socket.emit('error-message', String(e)); }
  });

  // send text message
  socket.on('send-message', async ({ sessionId='main', to, message }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      const jid = formatJid(to);
      await s.sock.sendMessage(jid, { text: message });
      await messageStore.insert({ sessionId, direction: 'out', from: s.sock.user?.id || null, to: jid, text: message });
      socket.emit('success-message', 'Message sent');
    } catch (err) {
      logger.error('send-message err', err);
      socket.emit('error-message', err?.message || String(err));
    }
  });

  // send media file (from client multipart)
  socket.on('send-media', async ({ sessionId='main', to, mime, base64 }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      const buffer = Buffer.from(base64, 'base64');
      await s.sock.sendMessage(formatJid(to), { [mime.startsWith('image/') ? 'image' : 'document']: buffer });
      await messageStore.insert({ sessionId, direction: 'out', from: s.sock.user?.id || null, to: formatJid(to), text: null, media_type: mime, media_base64: base64 });
      socket.emit('success-message', 'Media sent');
    } catch (err) {
      socket.emit('error-message', err?.message || String(err));
    }
  });

  // download media from message (client asks to download by message key)
  socket.on('download-media', async ({ sessionId='main', key }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      // need to fetch message from store
      const msg = await s.sock.loadMessage(key);
      if (!msg) return socket.emit('error-message', 'message not found');
      const media = msg.message?.imageMessage || msg.message?.documentMessage || msg.message?.videoMessage;
      if (!media) return socket.emit('error-message', 'no media');
      const stream = await s.sock.decryptMedia(media);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      socket.emit('download-media-result', { sessionId, data: buffer.toString('base64'), mime: media.mimetype || 'application/octet-stream' });
    } catch (err) {
      socket.emit('error-message', err?.message || String(err));
    }
  });

  // broadcast - send to multiple numbers
  socket.on('broadcast', async ({ sessionId='main', numbers=[], message='' }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      for (let i=0;i<numbers.length;i++){
        const to = numbers[i];
        const jid = formatJid(to);
        try {
          await s.sock.sendMessage(jid, { text: message });
          await messageStore.insert({ sessionId, direction: 'out', from: s.sock.user?.id || null, to: jid, text: message });
          socket.emit('broadcast-status', { id: sessionId, to: jid, status: 'sent', idx: i+1, total: numbers.length });
        } catch (e) {
          socket.emit('broadcast-status', { id: sessionId, to: jid, status: 'error', idx: i+1, total: numbers.length, error: e.message });
        }
      }
      socket.emit('broadcast-complete', { id: sessionId, total: numbers.length });
    } catch (err) {
      socket.emit('error-message', err?.message || String(err));
    }
  });

  // get chat/message history from DB
  socket.on('get-history', async ({ sessionId='main', limit=200 }) => {
    try {
      const rows = await messageStore.history(sessionId, limit);
      // send in chronological order
      socket.emit('message-history', rows.reverse());
    } catch (err) {
      socket.emit('error-message', err?.message || String(err));
    }
  });

  // get contacts
  socket.on('get-contacts', ({ sessionId='main' } = {}) => {
    const s = SESSIONS[sessionId];
    if (!s || !s.sock) return socket.emit('contact-list', []);
    const contacts = Object.values(s.sock.store.contacts || {}).map(c => ({ id: c.id, name: c.name || c.notify || c.id }));
    socket.emit('contact-list', contacts);
  });

  // get groups (from store)
  socket.on('get-groups', ({ sessionId='main' } = {}) => {
    const s = SESSIONS[sessionId];
    if (!s || !s.sock) return socket.emit('groups-list', []);
    const groups = Object.values(s.sock.store.chats || {}).filter(c => c.id?.endsWith('@g.us')).map(g => ({ id: g.id, name: g.name || g.subject }));
    socket.emit('groups-list', groups);
  });

  // group create
  socket.on('create-group', async ({ sessionId='main', subject, participants=[] }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      const res = await s.sock.groupCreate(subject, participants.map(p => formatJid(p)));
      socket.emit('group-created', res);
    } catch (err) { socket.emit('error-message', err?.message || String(err)); }
  });

  // add participants
  socket.on('group-add', async ({ sessionId='main', groupJid, participants=[] }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      await s.sock.groupAdd(groupJid, participants.map(p => formatJid(p)));
      socket.emit('success-message', 'participants added');
    } catch (err) { socket.emit('error-message', err?.message || String(err)); }
  });

  // promote / demote
  socket.on('group-promote', async ({ sessionId='main', groupJid, participant }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      await s.sock.groupMakeAdmin(groupJid, [formatJid(participant)]);
      socket.emit('success-message', 'promoted');
    } catch (err) { socket.emit('error-message', err?.message || String(err)); }
  });
  socket.on('group-demote', async ({ sessionId='main', groupJid, participant }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      await s.sock.groupDemoteAdmin(groupJid, [formatJid(participant)]);
      socket.emit('success-message', 'demoted');
    } catch (err) { socket.emit('error-message', err?.message || String(err)); }
  });

  // presence (typing / composing)
  socket.on('send-presence', async ({ sessionId='main', to, type='composing' }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      await s.sock.sendPresenceUpdate(type, formatJid(to));
    } catch (err) { socket.emit('error-message', err?.message || String(err)); }
  });

  // block/unblock
  socket.on('block', async ({ sessionId='main', jid }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      await s.sock.updateBlockStatus(formatJid(jid), 'block');
      socket.emit('success-message', 'Blocked');
    } catch (err) { socket.emit('error-message', err?.message || String(err)); }
  });
  socket.on('unblock', async ({ sessionId='main', jid }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      await s.sock.updateBlockStatus(formatJid(jid), 'unblock');
      socket.emit('success-message', 'Unblocked');
    } catch (err) { socket.emit('error-message', err?.message || String(err)); }
  });

  // get profile picture & vcard
  socket.on('get-profile', async ({ sessionId='main', jid }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      const ppUrl = await s.sock.profilePictureUrl(formatJid(jid)).catch(()=>null);
      const vcard = s.sock.store?.contacts?.[formatJid(jid)] || null;
      socket.emit('profile', { jid, ppUrl, vcard });
    } catch (err) { socket.emit('error-message', err?.message || String(err)); }
  });

  // mark as read
  socket.on('mark-read', async ({ sessionId='main', jid }) => {
    try {
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error-message', 'session not active');
      await s.sock.sendReadReceipt(formatJid(jid));
      socket.emit('success-message', 'Marked as read');
    } catch (err) { socket.emit('error-message', err?.message || String(err)); }
  });

  // logout session
  socket.on('logout-session', async ({ sessionId='main' } = {}) => {
    try {
      const s = SESSIONS[sessionId];
      if (s && s.sock) {
        try { await s.sock.logout(); } catch(e){/*ignore*/ }
        delete SESSIONS[sessionId];
      }
      await sessionStore.updateStatus(sessionId, 'logged_out');
      // optionally clear mysql-auth creds
      try { await clearSession(pool, sessionId); } catch(e){ /* ignore */ }
      socket.emit('success-message', 'Logged out');
      io.emit('session', { id: sessionId, status: 'logged_out' });
    } catch (err) {
      socket.emit('error-message', err?.message || String(err));
    }
  });

  socket.on('list-sessions', async () => {
    try {
      const list = await sessionStore.list();
      socket.emit('sessions-list', list);
    } catch (err) {
      socket.emit('error-message', err?.message || String(err));
    }
  });
});

/**
 * REST: some helpful endpoints (protected with simple api_key)
 */
const API_KEY = process.env.API_KEY || 'changeme123';
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'invalid api key' });
  next();
}

app.get('/api/sessions', requireApiKey, async (req,res) => {
  const rows = await sessionStore.list();
  res.json(rows);
});

app.get('/api/messages', requireApiKey, async (req,res) => {
  const rows = await messageStore.history(req.query.sessionId || 'main', parseInt(req.query.limit || '200', 10));
  res.json(rows);
});

// upload + send media via REST (multipart)
app.post('/api/send-media', requireApiKey, upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    const sessionId = req.body.sessionId || 'main';
    const to = req.body.to;
    if (!filePath || !to) return res.status(400).json({ error: 'file and to required' });
    const s = SESSIONS[sessionId];
    if (!s || !s.sock) return res.status(404).json({ error: 'session not active' });
    const buffer = fs.readFileSync(filePath);
    await s.sock.sendMessage(formatJid(to), { document: buffer });
    await messageStore.insert({ sessionId, direction: 'out', from: s.sock.user?.id || null, to: formatJid(to), text: null, media_type: req.file.mimetype, media_base64: buffer.toString('base64') });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  } finally {
    if (filePath && fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch(e){}
  }
});

/**
 * Start server after DB init
 */
(async () => {
  try {
    await initDB();
    server.listen(PORT, () => {
      logger.info(`Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    logger.error('Fatal startup error:', err);
    process.exit(1);
  }
})();
