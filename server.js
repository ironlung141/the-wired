'use strict';
const http         = require('http');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const express      = require('express');
const WebSocket    = require('ws');
const Database     = require('better-sqlite3');
const bcrypt       = require('bcryptjs');
const cookieParser = require('cookie-parser');
const multer       = require('multer');
const { v4: uuid } = require('uuid');
const nodemailer   = require('nodemailer');
const speakeasy    = require('speakeasy');
const QRCode       = require('qrcode');

// ── Config ────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const DB_PATH    = process.env.DB_PATH || path.join(__dirname, 'wired.db');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const ADMIN_USER = (process.env.ADMIN_USER || 'lain').toLowerCase();
const MAIL_HOST  = process.env.MAIL_HOST || '';
const MAIL_PORT  = parseInt(process.env.MAIL_PORT || '587');
const MAIL_USER  = process.env.MAIL_USER || '';
const MAIL_PASS  = process.env.MAIL_PASS || '';
const MAIL_FROM  = process.env.MAIL_FROM || MAIL_USER;
const APP_URL    = process.env.APP_URL   || `http://localhost:${PORT}`;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Mailer ────────────────────────────────────────────────────────
let mailer = null;
if (MAIL_HOST && MAIL_USER && MAIL_PASS) {
  mailer = nodemailer.createTransport({
    host: MAIL_HOST, port: MAIL_PORT,
    secure: MAIL_PORT === 465,
    auth: { user: MAIL_USER, pass: MAIL_PASS }
  });
  mailer.verify()
    .then(() => console.log('  Mail: connected'))
    .catch(e => console.warn('  Mail warning:', e.message));
} else {
  console.log('  Mail: not configured (set MAIL_HOST, MAIL_USER, MAIL_PASS env vars to enable)');
}

async function sendMail(to, subject, html) {
  if (!mailer) return false;
  try { await mailer.sendMail({ from: MAIL_FROM, to, subject, html }); return true; }
  catch (e) { console.error('Mail error:', e.message); return false; }
}

// ── Database ──────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL COLLATE NOCASE,
    pwd_hash     TEXT NOT NULL,
    display      TEXT NOT NULL,
    bio          TEXT DEFAULT '',
    status       TEXT DEFAULT 'connected to the wired',
    color        TEXT DEFAULT '#2a0d15',
    avatar       TEXT DEFAULT NULL,
    banner       TEXT DEFAULT NULL,
    email        TEXT DEFAULT NULL,
    totp_secret  TEXT DEFAULT NULL,
    totp_enabled INTEGER DEFAULT 0,
    is_banned    INTEGER DEFAULT 0,
    muted_until  INTEGER DEFAULT 0,
    created      INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS servers (
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    owner   TEXT NOT NULL,
    created INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS channels (
    id        TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    topic     TEXT DEFAULT '',
    position  INTEGER DEFAULT 0,
    created   INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id   TEXT NOT NULL REFERENCES users(id),
    content     TEXT NOT NULL,
    image_url   TEXT DEFAULT NULL,
    reply_to_id TEXT DEFAULT NULL,
    edited      INTEGER DEFAULT 0,
    deleted     INTEGER DEFAULT 0,
    created     INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created INTEGER DEFAULT (unixepoch())
  );

  /* totp_setup: stores secret while user is confirming 2FA setup */
  CREATE TABLE IF NOT EXISTS totp_setup (
    user_id TEXT PRIMARY KEY,
    secret  TEXT NOT NULL,
    expires INTEGER NOT NULL
  );

  /* login_pending: issued after password ok, before 2FA code */
  CREATE TABLE IF NOT EXISTS login_pending (
    token   TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_msg_ch ON messages(channel_id, created);
  CREATE INDEX IF NOT EXISTS idx_sess_u ON sessions(user_id);
`);

// Safe migrations for existing databases
const migrations = [
  `ALTER TABLE users ADD COLUMN banner TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN email TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN totp_secret TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN muted_until INTEGER DEFAULT 0`,
  `ALTER TABLE messages ADD COLUMN image_url TEXT DEFAULT NULL`,
  `ALTER TABLE messages ADD COLUMN reply_to_id TEXT DEFAULT NULL`,
  `ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0`,
  `ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0`,
];
migrations.forEach(sql => { try { db.exec(sql); } catch (_) {} });

// Seed default server
if (!db.prepare('SELECT id FROM servers WHERE id=?').get('wired')) {
  db.prepare('INSERT INTO servers (id,name,owner) VALUES (?,?,?)').run('wired', 'The Wired', 'system');
  [
    ['general',   'general',    'the place of general exchange',      0],
    ['lain',      'lain',       'sightings of Lain in the Wired',     1],
    ['protocol-7','protocol-7', 'discussion of Protocol 7',           2],
    ['navi-tech', 'navi-tech',  'all things NAVI and hardware',       3],
    ['kids',      'kids',       'children of the wired',              4],
  ].forEach(([id, name, topic, pos]) =>
    db.prepare('INSERT INTO channels (id,server_id,name,topic,position) VALUES (?,?,?,?,?)').run(id, 'wired', name, topic, pos)
  );
}

// Cleanup stale records on startup
db.prepare('DELETE FROM sessions WHERE created < (unixepoch() - 2592000)').run();
db.prepare('DELETE FROM totp_setup WHERE expires < ?').run(Math.floor(Date.now() / 1000));
db.prepare('DELETE FROM login_pending WHERE expires < ?').run(Math.floor(Date.now() / 1000));

// ── Prepared statements ───────────────────────────────────────────
const Q = {
  userByName:    db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE'),
  userById:      db.prepare('SELECT * FROM users WHERE id=?'),
  allUsers:      db.prepare('SELECT * FROM users ORDER BY display'),
  createUser:    db.prepare('INSERT INTO users (id,username,pwd_hash,display,email) VALUES (?,?,?,?,?)'),
  updateProf:    db.prepare('UPDATE users SET display=?,bio=?,status=?,color=?,avatar=?,banner=? WHERE id=?'),
  updateAvatar:  db.prepare('UPDATE users SET avatar=? WHERE id=?'),
  updateBanner:  db.prepare('UPDATE users SET banner=? WHERE id=?'),
  enableTOTP:    db.prepare('UPDATE users SET totp_secret=?,totp_enabled=1 WHERE id=?'),
  disableTOTP:   db.prepare('UPDATE users SET totp_secret=NULL,totp_enabled=0 WHERE id=?'),
  banUser:       db.prepare('UPDATE users SET is_banned=? WHERE username=? COLLATE NOCASE'),
  muteUser:      db.prepare('UPDATE users SET muted_until=? WHERE username=? COLLATE NOCASE'),
  createSess:    db.prepare('INSERT INTO sessions (token,user_id) VALUES (?,?)'),
  getSess:       db.prepare('SELECT * FROM sessions WHERE token=?'),
  delSess:       db.prepare('DELETE FROM sessions WHERE token=?'),
  delAllSess:    db.prepare('DELETE FROM sessions WHERE user_id=?'),
  getServers:    db.prepare('SELECT * FROM servers ORDER BY name'),
  getServer:     db.prepare('SELECT * FROM servers WHERE id=?'),
  getChannels:   db.prepare('SELECT * FROM channels WHERE server_id=? ORDER BY position,name'),
  getChannel:    db.prepare('SELECT * FROM channels WHERE id=?'),
  createChan:    db.prepare('INSERT INTO channels (id,server_id,name,topic,position) VALUES (?,?,?,?,?)'),
  delChan:       db.prepare('DELETE FROM channels WHERE id=? AND server_id=?'),
  getMsgs:       db.prepare(`
    SELECT m.*, u.display, u.username, u.color, u.avatar,
           r.content AS reply_content, r.author_id AS reply_author_id,
           ru.display AS reply_display
    FROM messages m
    JOIN users u ON m.author_id = u.id
    LEFT JOIN messages r ON m.reply_to_id = r.id
    LEFT JOIN users ru ON r.author_id = ru.id
    WHERE m.channel_id=? AND m.deleted=0
    ORDER BY m.created DESC LIMIT 100
  `),
  getMsgById:    db.prepare('SELECT * FROM messages WHERE id=?'),
  insertMsg:     db.prepare('INSERT INTO messages (id,channel_id,author_id,content,image_url,reply_to_id) VALUES (?,?,?,?,?,?)'),
  softDeleteMsg: db.prepare("UPDATE messages SET deleted=1, content='[message deleted]', image_url=NULL WHERE id=?"),

  // 2FA setup (while user is confirming the code)
  setTotpSetup:  db.prepare('INSERT OR REPLACE INTO totp_setup (user_id,secret,expires) VALUES (?,?,?)'),
  getTotpSetup:  db.prepare('SELECT * FROM totp_setup WHERE user_id=?'),
  delTotpSetup:  db.prepare('DELETE FROM totp_setup WHERE user_id=?'),

  // Login pending (2FA check at login time)
  setLoginPending: db.prepare('INSERT OR REPLACE INTO login_pending (token,user_id,expires) VALUES (?,?,?)'),
  getLoginPending: db.prepare('SELECT * FROM login_pending WHERE token=?'),
  delLoginPending: db.prepare('DELETE FROM login_pending WHERE token=?'),
};

// ── Helpers ───────────────────────────────────────────────────────
function pub(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, display: u.display,
    bio: u.bio, status: u.status, color: u.color,
    avatar: u.avatar, banner: u.banner,
    totp_enabled: !!u.totp_enabled,
    is_banned: !!u.is_banned,
    muted_until: u.muted_until || 0,
    is_admin: u.username.toLowerCase() === ADMIN_USER,
  };
}

function pubMsg(m) {
  return {
    id: m.id, channel_id: m.channel_id, author_id: m.author_id,
    content: m.deleted ? '[message deleted]' : m.content,
    image_url: m.deleted ? null : m.image_url,
    reply_to_id: m.reply_to_id || null,
    reply_content: m.reply_content || null,
    reply_author_id: m.reply_author_id || null,
    reply_display: m.reply_display || null,
    edited: !!m.edited, deleted: !!m.deleted, created: m.created,
    username: m.username, display: m.display, color: m.color, avatar: m.avatar,
  };
}

function verifyTOTP(secret, code) {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token: String(code).replace(/\s/g, ''),
    window: 2, // allow ±2 time steps (±60 seconds)
  });
}

function now() { return Math.floor(Date.now() / 1000); }

// ── Auth middleware ───────────────────────────────────────────────
function authMW(req, res, next) {
  const tok = req.cookies?.wt;
  if (!tok) return res.status(401).json({ error: 'Not authenticated' });
  const sess = Q.getSess.get(tok);
  if (!sess) return res.status(401).json({ error: 'Session expired — please log in again' });
  const user = Q.userById.get(sess.user_id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (user.is_banned) return res.status(403).json({ error: 'You have been banned from the Wired.' });
  req.user = user; req.token = tok; next();
}

function adminMW(req, res, next) {
  if (req.user.username.toLowerCase() !== ADMIN_USER)
    return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Multer ────────────────────────────────────────────────────────
function mkUpload(prefix, maxMB) {
  return multer({
    storage: multer.diskStorage({
      destination: UPLOAD_DIR,
      filename: (_, f, cb) => {
        const ext = path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
        cb(null, `${prefix}-${uuid()}${ext}`);
      },
    }),
    limits: { fileSize: maxMB * 1024 * 1024 },
    fileFilter: (_, f, cb) => cb(null, f.mimetype.startsWith('image/')),
  });
}
const uploadAvatar = mkUpload('av', 3);
const uploadBanner = mkUpload('bn', 5);
const uploadImage  = mkUpload('img', 8);

// ── Express ───────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════
app.post('/api/signup', (req, res) => {
  let { username, password, email } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  username = username.toLowerCase().trim().replace(/[^a-z0-9_\-.]/g, '_').slice(0, 32);
  if (username.length < 3) return res.status(400).json({ error: 'Username must be 3–32 characters' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Password must be 4+ characters' });
  if (Q.userByName.get(username)) return res.status(409).json({ error: 'That handle is already taken' });
  const id = uuid();
  Q.createUser.run(id, username, bcrypt.hashSync(String(password), 10), username, email || null);
  const user = Q.userById.get(id);
  const token = crypto.randomBytes(32).toString('hex');
  Q.createSess.run(token, id);
  res.cookie('wt', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  broadcast({ type: 'user_join', user: pub(user) });
  res.json({ ok: true, user: pub(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const user = Q.userByName.get(String(username).trim());
  if (!user) return res.status(401).json({ error: 'Node not found in the Wired' });
  if (user.is_banned) return res.status(403).json({ error: 'You have been banned from the Wired.' });
  if (!bcrypt.compareSync(String(password), user.pwd_hash))
    return res.status(401).json({ error: 'Wrong password' });

  if (user.totp_enabled) {
    // Issue a short-lived pending token; client must verify TOTP before getting a session
    const pending = crypto.randomBytes(28).toString('hex');
    Q.setLoginPending.run(pending, user.id, now() + 600); // 10 min
    return res.json({ ok: false, requires2fa: true, pendingToken: pending });
  }

  const token = crypto.randomBytes(32).toString('hex');
  Q.createSess.run(token, user.id);
  res.cookie('wt', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ ok: true, user: pub(user) });
});

app.post('/api/login/2fa', (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code)
    return res.status(400).json({ error: 'Missing pendingToken or code' });

  // Clean expired
  db.prepare('DELETE FROM login_pending WHERE expires < ?').run(now());

  const pending = Q.getLoginPending.get(pendingToken);
  if (!pending)
    return res.status(401).json({ error: 'Session expired — please log in again' });

  const user = Q.userById.get(pending.user_id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!user.totp_secret) return res.status(400).json({ error: '2FA not set up on this account' });

  const valid = verifyTOTP(user.totp_secret, code);
  if (!valid) return res.status(401).json({ error: 'Invalid 2FA code — check your app and try again' });

  Q.delLoginPending.run(pendingToken);
  const token = crypto.randomBytes(32).toString('hex');
  Q.createSess.run(token, user.id);
  res.cookie('wt', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ ok: true, user: pub(user) });
});

app.post('/api/logout', authMW, (req, res) => {
  Q.delSess.run(req.token);
  res.clearCookie('wt');
  res.json({ ok: true });
});

app.get('/api/me',    authMW, (req, res) => res.json({ user: pub(req.user) }));
app.get('/api/users', authMW, (req, res) => res.json({ users: Q.allUsers.all().map(pub) }));

// ════════════════════════════════════════════════════════════════
// PROFILE
// ════════════════════════════════════════════════════════════════
app.patch('/api/profile', authMW, (req, res) => {
  const u = req.user;
  const display = (req.body?.display || u.display).slice(0, 32);
  const bio     = (req.body?.bio     ?? u.bio    ).slice(0, 300);
  const status  = (req.body?.status  ?? u.status ).slice(0, 80);
  const color   =  req.body?.color   || u.color;
  Q.updateProf.run(display, bio, status, color, u.avatar, u.banner, u.id);
  const updated = Q.userById.get(u.id);
  broadcast({ type: 'user_update', user: pub(updated) });
  res.json({ ok: true, user: pub(updated) });
});

app.post('/api/avatar', authMW, uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const url = '/uploads/' + req.file.filename;
  if (req.user.avatar) fs.unlink(path.join(UPLOAD_DIR, path.basename(req.user.avatar)), () => {});
  Q.updateAvatar.run(url, req.user.id);
  const updated = Q.userById.get(req.user.id);
  broadcast({ type: 'user_update', user: pub(updated) });
  res.json({ ok: true, avatar: url });
});

app.post('/api/banner', authMW, uploadBanner.single('banner'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const url = '/uploads/' + req.file.filename;
  if (req.user.banner) fs.unlink(path.join(UPLOAD_DIR, path.basename(req.user.banner)), () => {});
  Q.updateBanner.run(url, req.user.id);
  const updated = Q.userById.get(req.user.id);
  broadcast({ type: 'user_update', user: pub(updated) });
  res.json({ ok: true, banner: url });
});

app.post('/api/upload/image', authMW, uploadImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  res.json({ ok: true, url: '/uploads/' + req.file.filename });
});

// ════════════════════════════════════════════════════════════════
// 2FA — SETUP (called from settings while already logged in)
// ════════════════════════════════════════════════════════════════
app.post('/api/2fa/setup', authMW, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({
      name: `TheWired(${req.user.username})`,
      length: 20,
    });
    // Store ONLY the base32 secret; expires in 10 minutes
    Q.setTotpSetup.run(req.user.id, secret.base32, now() + 600);
    const qr = await QRCode.toDataURL(secret.otpauth_url);
    res.json({ ok: true, secret: secret.base32, qr });
  } catch (e) {
    console.error('2FA setup error:', e);
    res.status(500).json({ error: 'Failed to generate 2FA secret' });
  }
});

// ════════════════════════════════════════════════════════════════
// 2FA — ENABLE (user confirms the code from their authenticator)
// ════════════════════════════════════════════════════════════════
app.post('/api/2fa/enable', authMW, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Missing code' });

  // Clean expired setup sessions
  db.prepare('DELETE FROM totp_setup WHERE expires < ?').run(now());

  const setup = Q.getTotpSetup.get(req.user.id);
  if (!setup) return res.status(400).json({ error: 'Setup session expired — click "Enable 2FA" again' });

  const valid = verifyTOTP(setup.secret, code);
  if (!valid) return res.status(401).json({ error: 'Invalid code — make sure your phone\'s clock is correct and try again' });

  // Save secret to user, mark 2FA enabled
  Q.enableTOTP.run(setup.secret, req.user.id);
  Q.delTotpSetup.run(req.user.id);

  const updated = Q.userById.get(req.user.id);
  res.json({ ok: true, user: pub(updated) });
});

// ════════════════════════════════════════════════════════════════
// 2FA — DISABLE
// ════════════════════════════════════════════════════════════════
app.post('/api/2fa/disable', authMW, (req, res) => {
  const { password, code } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!bcrypt.compareSync(String(password), req.user.pwd_hash))
    return res.status(401).json({ error: 'Wrong password' });
  if (req.user.totp_enabled) {
    if (!code) return res.status(400).json({ error: '2FA code required' });
    const valid = verifyTOTP(req.user.totp_secret, code);
    if (!valid) return res.status(401).json({ error: 'Invalid 2FA code' });
  }
  Q.disableTOTP.run(req.user.id);
  const updated = Q.userById.get(req.user.id);
  res.json({ ok: true, user: pub(updated) });
});

// ════════════════════════════════════════════════════════════════
// SERVERS / CHANNELS
// ════════════════════════════════════════════════════════════════
app.get('/api/servers', authMW, (req, res) => {
  res.json({ servers: Q.getServers.all().map(s => ({ ...s, channels: Q.getChannels.all(s.id) })) });
});

app.post('/api/servers/:sid/channels', authMW, (req, res) => {
  const sv = Q.getServer.get(req.params.sid);
  if (!sv) return res.status(404).json({ error: 'Server not found' });
  let name = (req.body?.name || '').toLowerCase().trim()
    .replace(/[^a-z0-9\-_]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!name) return res.status(400).json({ error: 'Invalid channel name' });
  const topic = (req.body?.topic || '').slice(0, 80);
  const existing = Q.getChannels.all(req.params.sid).find(c => c.name === name);
  if (existing) return res.json({ ok: true, channel: existing });
  const id  = `${name}-${Date.now()}`;
  const pos = Q.getChannels.all(req.params.sid).length;
  Q.createChan.run(id, req.params.sid, name, topic, pos);
  const ch = Q.getChannel.get(id);
  broadcast({ type: 'channel_create', server_id: req.params.sid, channel: ch });
  res.json({ ok: true, channel: ch });
});

app.delete('/api/servers/:sid/channels/:cid', authMW, (req, res) => {
  if (req.params.cid === 'general')
    return res.status(403).json({ error: 'Cannot delete #general' });
  Q.delChan.run(req.params.cid, req.params.sid);
  broadcast({ type: 'channel_delete', server_id: req.params.sid, channel_id: req.params.cid });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// MESSAGES
// ════════════════════════════════════════════════════════════════
app.get('/api/channels/:cid/messages', authMW, (req, res) => {
  res.json({ messages: Q.getMsgs.all(req.params.cid).reverse().map(pubMsg) });
});

app.delete('/api/messages/:mid', authMW, (req, res) => {
  const msg = Q.getMsgById.get(req.params.mid);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const isAdmin = req.user.username.toLowerCase() === ADMIN_USER;
  if (msg.author_id !== req.user.id && !isAdmin)
    return res.status(403).json({ error: 'Cannot delete someone else\'s message' });
  Q.softDeleteMsg.run(msg.id);
  broadcast({ type: 'message_delete', message_id: msg.id, channel_id: msg.channel_id });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// ADMIN
// ════════════════════════════════════════════════════════════════
app.post('/api/admin/ban', authMW, adminMW, (req, res) => {
  const { username, banned } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Missing username' });
  if (username.toLowerCase() === ADMIN_USER)
    return res.status(403).json({ error: 'Cannot ban the admin' });
  Q.banUser.run(banned ? 1 : 0, username);
  const user = Q.userByName.get(username);
  if (user) {
    if (banned) Q.delAllSess.run(user.id);
    broadcast({ type: 'user_update', user: pub(user) });
    if (banned) broadcast({ type: 'user_banned', username: user.username });
  }
  res.json({ ok: true });
});

app.post('/api/admin/mute', authMW, adminMW, (req, res) => {
  const { username, minutes } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Missing username' });
  const until = minutes > 0 ? now() + (minutes * 60) : 0;
  Q.muteUser.run(until, username);
  const user = Q.userByName.get(username);
  if (user) broadcast({ type: 'user_update', user: pub(user) });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// WEBSOCKET
// ════════════════════════════════════════════════════════════════
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const clients = new Map(); // ws -> { user }

function broadcast(payload, excludeWs) {
  const data = JSON.stringify(payload);
  for (const [ws] of clients) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
function sendTo(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws, req) => {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    })
  );
  const sess = Q.getSess.get(cookies.wt || '');
  if (!sess) { ws.close(4001, 'Unauthenticated'); return; }
  const user = Q.userById.get(sess.user_id);
  if (!user || user.is_banned) { ws.close(4003, 'Banned'); return; }

  clients.set(ws, { user });
  sendTo(ws, { type: 'hello', user: pub(user) });
  sendTo(ws, { type: 'online', users: [...clients.values()].map(c => pub(c.user)) });
  broadcast({ type: 'presence', user: pub(user), online: true }, ws);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const ctx = clients.get(ws);
    if (!ctx) return;
    const freshUser = Q.userById.get(ctx.user.id);
    if (!freshUser || freshUser.is_banned) return;

    if (msg.type === 'message') {
      const { channel_id, content, image_url, reply_to_id } = msg;
      if (!channel_id) return;
      const text = (content || '').trim().slice(0, 2000);
      if (!text && !image_url) return;
      if (!Q.getChannel.get(channel_id)) return;
      if (freshUser.muted_until > now()) {
        const until = new Date(freshUser.muted_until * 1000).toLocaleTimeString();
        sendTo(ws, { type: 'error', message: `You are muted until ${until}` });
        return;
      }
      const id = uuid();
      Q.insertMsg.run(id, channel_id, freshUser.id, text || '', image_url || null, reply_to_id || null);
      // Fetch with joined reply info
      const rows = Q.getMsgs.all(channel_id);
      const full = rows.find(m => m.id === id);
      const payload = {
        type: 'message',
        message: full ? pubMsg(full) : {
          id, channel_id, content: text, image_url: image_url || null,
          reply_to_id: reply_to_id || null, reply_content: null, reply_display: null,
          created: now(), author_id: freshUser.id, username: freshUser.username,
          display: freshUser.display, color: freshUser.color, avatar: freshUser.avatar,
          edited: false, deleted: false,
        },
      };
      const data = JSON.stringify(payload);
      for (const [c] of clients) if (c.readyState === WebSocket.OPEN) c.send(data);
    }

    if (msg.type === 'typing') {
      if (msg.channel_id) broadcast({ type: 'typing', channel_id: msg.channel_id, user: pub(freshUser) }, ws);
    }
  });

  ws.on('close', () => {
    const ctx = clients.get(ws);
    if (ctx) broadcast({ type: 'presence', user: pub(ctx.user), online: false });
    clients.delete(ws);
  });

  ws.on('error', () => clients.delete(ws));
});

// ── Start ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const w = 44;
  console.log(`\n╔${'═'.repeat(w)}╗`);
  console.log(`║${'  The Wired 2.0 — いとをひく  '.padEnd(w)}║`);
  console.log(`╚${'═'.repeat(w)}╝`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Admin: ${ADMIN_USER}`);
  console.log(`  DB: ${DB_PATH}\n`);
});
