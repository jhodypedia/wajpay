// server.js
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const qrcode = require('qrcode');
const pino = require('pino');
const logger = pino({ level: 'info' });

// Baileys imports (per docs)
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('baileys');

// MySQL promise pool
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'changeme123';
const AUTH_BASE = path.join(__dirname, 'auth_info');

if (!fs.existsSync(AUTH_BASE)) fs.mkdirSync(AUTH_BASE, { recursive: true });

// init DB pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'wa_bot',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ensure tables exist (safe-create)
(async function ensureTables(){
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(150) NOT NULL UNIQUE,
        user_id VARCHAR(150) DEFAULT NULL,
        phone_number VARCHAR(50) DEFAULT NULL,
        status ENUM('loading','qr_received','connected','disconnected','logged_out') DEFAULT 'loading',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } finally {
    conn.release();
  }
})().catch(err => logger.error('ensureTables err', err));

// helper DB operations
const sessionStore = {
  async upsert(sessionId, { user_id=null, phone=null, status='loading' } = {}) {
    const conn = await pool.getConnection();
    try {
      await conn.query(`
        INSERT INTO sessions (session_id, user_id, phone_number, status)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), phone_number=VALUES(phone_number), status=VALUES(status), updated_at=CURRENT_TIMESTAMP
      `, [sessionId, user_id, phone, status]);
    } finally { conn.release(); }
  },
  async updateStatus(sessionId, status) {
    const conn = await pool.getConnection();
    try {
      await conn.query(`UPDATE sessions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE session_id=?`, [status, sessionId]);
    } finally { conn.release(); }
  },
  async setPhone(sessionId, phone) {
    const conn = await pool.getConnection();
    try {
      await conn.query(`UPDATE sessions SET phone_number=?, updated_at=CURRENT_TIMESTAMP WHERE session_id=?`, [phone, sessionId]);
    } finally { conn.release(); }
  },
  async list() {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`SELECT * FROM sessions ORDER BY updated_at DESC`);
      return rows;
    } finally { conn.release(); }
  },
  async delete(sessionId) {
    const conn = await pool.getConnection();
    try {
      await conn.query(`DELETE FROM sessions WHERE session_id=?`, [sessionId]);
    } finally { conn.release(); }
  }
};

const messageStore = {
  async insert({ sessionId=null, direction='in', from=null, to=null, text=null, media_type=null }) {
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO messages (session_id, direction, from_who, to_who, text, media_type) VALUES (?, ?, ?, ?, ?, ?)`,
        [sessionId, direction, from, to, text, media_type]
      );
    } finally { conn.release(); }
  },
  async list(limit = 200) {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`, [limit]);
      return rows;
    } finally { conn.release(); }
  }
};

// Express + Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// multer for uploads (images/documents)
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

// in-memory active sessions
const SESSIONS = {}; // sessionId -> { sock, lastQr, createdAt }

// helper: ensureAuthDir(sessionId)
function authDir(sessionId) {
  const dir = path.join(AUTH_BASE, String(sessionId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// helper: format jid
function formatJid(numberOrJid) {
  if (!numberOrJid) throw new Error('missing number/jid');
  let s = String(numberOrJid).trim();
  if (s.endsWith('@s.whatsapp.net') || s.endsWith('@g.us')) return s;
  s = s.replace(/[^0-9]/g,'');
  return `${s}@s.whatsapp.net`;
}

// start or restore a Baileys session for sessionId
async function startBaileysSession(sessionId, socketClient=null) {
  // if already running, return existing
  if (SESSIONS[sessionId] && SESSIONS[sessionId].sock) return SESSIONS[sessionId].sock;

  await sessionStore.upsert(sessionId, { status: 'loading' });
  const authFolder = authDir(sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2,2323,9] }));

  const sock = makeWASocket({ auth: state, version, printQRInTerminal: false });
  SESSIONS[sessionId] = { sock, lastQr: null, createdAt: Date.now() };

  // save creds when updated
  sock.ev.on('creds.update', saveCreds);

  // connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrData = await qrcode.toDataURL(qr);
      SESSIONS[sessionId].lastQr = qrData;
      // emit only to requesting client if available
      if (socketClient) socketClient.emit('qr', { id: sessionId, qr: qrData });
      // also broadcast session status
      io.emit('session', { id: sessionId, status: 'qr_received' });
      await sessionStore.updateStatus(sessionId, 'qr_received');
    }

    if (connection === 'open') {
      logger.info(`[${sessionId}] connected`);
      try {
        const me = sock.user; // may contain id
        const phone = me?.id?.split(':')[0];
        if (phone) await sessionStore.setPhone(sessionId, phone);
      } catch(e){}
      io.emit('ready', { id: sessionId, user: sock.user });
      io.emit('session', { id: sessionId, status: 'connected' });
      await sessionStore.updateStatus(sessionId, 'connected');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      logger.info(`[${sessionId}] connection closed code=${code}`);
      if (code === DisconnectReason.loggedOut) {
        // logged out: clean memory and mark DB
        await sessionStore.updateStatus(sessionId, 'logged_out');
        io.emit('session', { id: sessionId, status: 'logged_out' });
        delete SESSIONS[sessionId];
        // NOTE: do not delete auth files automatically — let admin choose
      } else {
        await sessionStore.updateStatus(sessionId, 'disconnected');
        io.emit('session', { id: sessionId, status: 'disconnected' });
        // try reconnect after short delay
        setTimeout(() => startBaileysSession(sessionId, socketClient).catch(logger.error), 3000);
      }
    }
  });

  // message listener
  sock.ev.on('messages.upsert', async (m) => {
    const messages = m.messages || [];
    if (!messages.length) return;
    const msg = messages[0];
    if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

    let text = '';
    if (msg.message.conversation) text = msg.message.conversation;
    else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
    else if (msg.message.imageMessage?.caption) text = msg.message.imageMessage.caption;

    // store incoming message
    await messageStore.insert({ sessionId, direction: 'in', from: msg.key.remoteJid, to: sock.user?.id || null, text });

    // emit to frontends
    io.emit('message', { id: sessionId, from: msg.key.remoteJid, text });
  });

  return sock;
}

// Socket.IO handlers
io.on('connection', (socket) => {
  logger.info('Socket client connected');

  // FE requests start-session
  socket.on('start-session', async ({ sessionId }) => {
    try {
      if (!sessionId) sessionId = 'main';
      await startBaileysSession(sessionId, socket);
      await sessionStore.upsert(sessionId, { status: 'loading' });
      socket.emit('session', { id: sessionId, status: 'loading' });
      // also send current sessions list
      const list = await sessionStore.list();
      socket.emit('sessions-list', list);
    } catch (err) {
      logger.error('start-session err', err);
      socket.emit('error', err?.message || String(err));
    }
  });

  socket.on('request-qr', async ({ sessionId }) => {
    try {
      if (!sessionId) sessionId = 'main';
      const s = SESSIONS[sessionId];
      if (s && s.lastQr) {
        socket.emit('qr', { id: sessionId, qr: s.lastQr });
      } else {
        // start session to generate qr
        await startBaileysSession(sessionId, socket);
      }
    } catch (err) {
      socket.emit('error', err?.message || String(err));
    }
  });

  socket.on('send-message', async ({ sessionId, to, message }) => {
    try {
      if (!sessionId) sessionId = 'main';
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error', 'session not active');
      const jid = formatJid(to);
      await s.sock.sendMessage(jid, { text: message });
      await messageStore.insert({ sessionId, direction: 'out', from: s.sock.user?.id || null, to: jid, text: message });
      socket.emit('message-sent', { id: sessionId, to: jid, message });
      io.emit('message-sent', { id: sessionId, to: jid, message });
    } catch (err) {
      logger.error('send-message err', err);
      socket.emit('error', err?.message || String(err));
    }
  });

  socket.on('broadcast', async ({ sessionId, numbers, message }) => {
    try {
      if (!sessionId) sessionId = 'main';
      const s = SESSIONS[sessionId];
      if (!s || !s.sock) return socket.emit('error', 'session not active');
      const total = numbers.length || 0;
      let success = 0;
      for (let i=0;i<numbers.length;i++){
        const to = numbers[i];
        const jid = formatJid(to);
        try {
          await s.sock.sendMessage(jid, { text: message });
          await messageStore.insert({ sessionId, direction: 'out', from: s.sock.user?.id || null, to: jid, text: message });
          success++;
          socket.emit('broadcast-status', { id: sessionId, to: jid, status: 'sent', idx: i+1, total });
        } catch (e) {
          socket.emit('broadcast-status', { id: sessionId, to: jid, status: 'error', idx: i+1, total, error: e.message });
        }
      }
      socket.emit('broadcast-complete', { id: sessionId, total, success });
    } catch (err) {
      socket.emit('error', err?.message || String(err));
    }
  });

  socket.on('logout', async ({ sessionId }) => {
    try {
      if (!sessionId) sessionId = 'main';
      const s = SESSIONS[sessionId];
      if (s && s.sock) {
        try { await s.sock.logout(); } catch(e){}
        delete SESSIONS[sessionId];
      }
      await sessionStore.updateStatus(sessionId, 'logged_out');
      socket.emit('logged-out', { id: sessionId });
      io.emit('session', { id: sessionId, status: 'logged_out' });
    } catch (err) {
      socket.emit('error', err?.message || String(err));
    }
  });

  socket.on('list-sessions', async () => {
    try {
      const rows = await sessionStore.list();
      socket.emit('sessions-list', rows);
    } catch (err) {
      socket.emit('error', err?.message || String(err));
    }
  });

  socket.on('refresh-status', async () => {
    try {
      const rows = await sessionStore.list();
      rows.forEach(r => socket.emit('session', { id: r.session_id, status: r.status, phone_number: r.phone_number }));
    } catch (err) {
      socket.emit('error', err?.message || String(err));
    }
  });

  socket.on('disconnect', () => {
    logger.info('Socket client disconnected');
  });
});

// REST endpoints (protected)
function requireApiKey(req, res, next){
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== (process.env.API_KEY || API_KEY)) return res.status(401).json({ error: 'invalid api key' });
  next();
}

app.get('/api/sessions', requireApiKey, async (req, res) => {
  try {
    const rows = await sessionStore.list();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message || String(err) }); }
});

app.post('/api/send', requireApiKey, async (req, res) => {
  try {
    const { sessionId='main', to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'to and message required' });
    const s = SESSIONS[sessionId];
    if (!s || !s.sock) return res.status(404).json({ error: 'session not active' });
    const jid = formatJid(to);
    await s.sock.sendMessage(jid, { text: message });
    await messageStore.insert({ sessionId, direction: 'out', from: s.sock.user?.id || null, to: jid, text: message });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message || String(err) }); }
});

// upload and send image (multipart form field: file)
app.post('/api/send-image', requireApiKey, upload.single('file'), async (req, res) => {
  try {
    const sessionId = req.body.sessionId || 'main';
    const to = req.body.to;
    const caption = req.body.caption || '';
    if (!to || !req.file) return res.status(400).json({ error: 'to and file required' });
    const s = SESSIONS[sessionId];
    if (!s || !s.sock) return res.status(404).json({ error: 'session not active' });

    const filePath = req.file.path;
    const buffer = fs.readFileSync(filePath);
    const mime = req.file.mimetype || 'image/jpeg';

    // send image
    await s.sock.sendMessage(formatJid(to), { image: buffer, caption });
    await messageStore.insert({ sessionId, direction: 'out', from: s.sock.user?.id || null, to: formatJid(to), text: caption, media_type: 'image' });

    // cleanup uploaded file
    fs.unlinkSync(filePath);

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message || String(err) }); }
});

app.get('/api/messages', requireApiKey, async (req, res) => {
  try {
    const rows = await messageStore.list(500);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message || String(err) }); }
});

// default route: serve login page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// start server
server.listen(PORT, () => {
  logger.info(`Server listening on http://localhost:${PORT}`);
  logger.info(`API_KEY: set via .env (current: ${process.env.API_KEY || API_KEY})`);
});
