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
const PORT    = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wired.db');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const ADMIN_USER = (process.env.ADMIN_USER || 'lain').toLowerCase();
// Email config (set via env vars or edit here)
const MAIL_HOST = process.env.MAIL_HOST || '';
const MAIL_PORT = parseInt(process.env.MAIL_PORT||'587');
const MAIL_USER = process.env.MAIL_USER || '';
const MAIL_PASS = process.env.MAIL_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || MAIL_USER;
const APP_URL   = process.env.APP_URL   || `http://localhost:${PORT}`;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Mailer ────────────────────────────────────────────────────────
let mailer = null;
if (MAIL_HOST && MAIL_USER && MAIL_PASS) {
  mailer = nodemailer.createTransport({ host:MAIL_HOST, port:MAIL_PORT, secure:MAIL_PORT===465, auth:{user:MAIL_USER,pass:MAIL_PASS} });
  mailer.verify().then(()=>console.log('  Mail: connected')).catch(e=>console.warn('  Mail: '+e.message));
} else {
  console.log('  Mail: not configured (2FA email disabled, TOTP still works)');
}

async function sendMail(to, subject, html) {
  if (!mailer) return false;
  try { await mailer.sendMail({ from:MAIL_FROM, to, subject, html }); return true; }
  catch(e) { console.error('Mail error:', e.message); return false; }
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
  CREATE TABLE IF NOT EXISTS totp_pending (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msg_ch  ON messages(channel_id, created);
  CREATE INDEX IF NOT EXISTS idx_sess_u  ON sessions(user_id);
`);

// Migrations for existing DBs
['banner','email','totp_secret','totp_enabled','is_banned','muted_until','image_url','reply_to_id','edited','deleted'].forEach(col => {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col} ${col.includes('_')||col==='email'||col==='banner'?'TEXT DEFAULT NULL':'INTEGER DEFAULT 0'}`); } catch {}
});
try { db.exec(`ALTER TABLE messages ADD COLUMN image_url TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0`); } catch {}

// Seed default server
if (!db.prepare('SELECT id FROM servers WHERE id=?').get('wired')) {
  db.prepare('INSERT INTO servers (id,name,owner) VALUES (?,?,?)').run('wired','The Wired','system');
  [['general','general','the place of general exchange',0],
   ['lain','lain','sightings of Lain in the Wired',1],
   ['protocol-7','protocol-7','discussion of Protocol 7',2],
   ['navi-tech','navi-tech','all things NAVI and hardware',3],
   ['kids','kids','children of the wired',4],
  ].forEach(([id,name,topic,pos])=>
    db.prepare('INSERT INTO channels (id,server_id,name,topic,position) VALUES (?,?,?,?,?)').run(id,'wired',name,topic,pos)
  );
}

// ── Queries ───────────────────────────────────────────────────────
const Q = {
  userByName:   db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE'),
  userById:     db.prepare('SELECT * FROM users WHERE id=?'),
  allUsers:     db.prepare('SELECT * FROM users ORDER BY display'),
  createUser:   db.prepare('INSERT INTO users (id,username,pwd_hash,display,email) VALUES (?,?,?,?,?)'),
  updateProf:   db.prepare('UPDATE users SET display=?,bio=?,status=?,color=?,avatar=?,banner=? WHERE id=?'),
  updateAvatar: db.prepare('UPDATE users SET avatar=? WHERE id=?'),
  updateBanner: db.prepare('UPDATE users SET banner=? WHERE id=?'),
  updateEmail:  db.prepare('UPDATE users SET email=? WHERE id=?'),
  enableTOTP:   db.prepare('UPDATE users SET totp_secret=?,totp_enabled=1 WHERE id=?'),
  disableTOTP:  db.prepare('UPDATE users SET totp_secret=NULL,totp_enabled=0 WHERE id=?'),
  banUser:      db.prepare('UPDATE users SET is_banned=? WHERE username=? COLLATE NOCASE'),
  muteUser:     db.prepare('UPDATE users SET muted_until=? WHERE username=? COLLATE NOCASE'),
  createSess:   db.prepare('INSERT INTO sessions (token,user_id) VALUES (?,?)'),
  getSess:      db.prepare('SELECT * FROM sessions WHERE token=?'),
  delSess:      db.prepare('DELETE FROM sessions WHERE token=?'),
  delAllSess:   db.prepare('DELETE FROM sessions WHERE user_id=?'),
  getServers:   db.prepare('SELECT * FROM servers ORDER BY name'),
  getServer:    db.prepare('SELECT * FROM servers WHERE id=?'),
  getChannels:  db.prepare('SELECT * FROM channels WHERE server_id=? ORDER BY position,name'),
  getChannel:   db.prepare('SELECT * FROM channels WHERE id=?'),
  createChan:   db.prepare('INSERT INTO channels (id,server_id,name,topic,position) VALUES (?,?,?,?,?)'),
  delChan:      db.prepare('DELETE FROM channels WHERE id=? AND server_id=?'),
  getMsgs:      db.prepare(`SELECT m.*,u.display,u.username,u.color,u.avatar,
                             r.content AS reply_content, r.author_id AS reply_author_id,
                             ru.display AS reply_display
                             FROM messages m
                             JOIN users u ON m.author_id=u.id
                             LEFT JOIN messages r ON m.reply_to_id=r.id
                             LEFT JOIN users ru ON r.author_id=ru.id
                             WHERE m.channel_id=? AND m.deleted=0
                             ORDER BY m.created DESC LIMIT 100`),
  getMsgById:   db.prepare('SELECT * FROM messages WHERE id=?'),
  insertMsg:    db.prepare('INSERT INTO messages (id,channel_id,author_id,content,image_url,reply_to_id) VALUES (?,?,?,?,?,?)'),
  deleteMsg:    db.prepare('UPDATE messages SET deleted=1, content=\'[message deleted]\' WHERE id=?'),
  addPending:   db.prepare('INSERT OR REPLACE INTO totp_pending (token,user_id,expires) VALUES (?,?,?)'),
  getPending:   db.prepare('SELECT * FROM totp_pending WHERE token=?'),
  delPending:   db.prepare('DELETE FROM totp_pending WHERE token=?'),
  cleanPending: db.prepare('DELETE FROM totp_pending WHERE expires < ?'),
};
Q.cleanPending.run(Math.floor(Date.now()/1000));
db.prepare('DELETE FROM sessions WHERE created < (unixepoch() - 2592000)').run();

// ── Helpers ───────────────────────────────────────────────────────
function pub(u) {
  if (!u) return null;
  return { id:u.id, username:u.username, display:u.display, bio:u.bio,
           status:u.status, color:u.color, avatar:u.avatar, banner:u.banner,
           totp_enabled:!!u.totp_enabled, is_banned:!!u.is_banned,
           muted_until:u.muted_until||0,
           is_admin: u.username.toLowerCase()===ADMIN_USER };
}
function pubMsg(m) {
  return { id:m.id, channel_id:m.channel_id, author_id:m.author_id,
           content:m.deleted?'[message deleted]':m.content,
           image_url:m.deleted?null:m.image_url,
           reply_to_id:m.reply_to_id||null,
           reply_content:m.reply_content||null,
           reply_author_id:m.reply_author_id||null,
           reply_display:m.reply_display||null,
           edited:!!m.edited, deleted:!!m.deleted, created:m.created,
           username:m.username, display:m.display, color:m.color, avatar:m.avatar };
}

// ── Auth middleware ───────────────────────────────────────────────
function auth(req, res, next) {
  const tok = req.cookies?.wt;
  if (!tok) return res.status(401).json({ error: 'Not authenticated' });
  const sess = Q.getSess.get(tok);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  const user = Q.userById.get(sess.user_id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (user.is_banned) return res.status(403).json({ error: 'You have been banned from the Wired.' });
  req.user = user; req.token = tok; next();
}
function adminOnly(req, res, next) {
  if (req.user.username.toLowerCase() !== ADMIN_USER) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Multer ────────────────────────────────────────────────────────
const mkStorage = (prefix) => multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_, f, cb) => cb(null, prefix+'-'+uuid()+path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g,''))
});
const uploadAvatar = multer({ storage:mkStorage('av'), limits:{fileSize:3*1024*1024}, fileFilter:(_,f,cb)=>cb(null,f.mimetype.startsWith('image/')) });
const uploadBanner = multer({ storage:mkStorage('bn'), limits:{fileSize:5*1024*1024}, fileFilter:(_,f,cb)=>cb(null,f.mimetype.startsWith('image/')) });
const uploadImage  = multer({ storage:mkStorage('img'), limits:{fileSize:8*1024*1024}, fileFilter:(_,f,cb)=>cb(null,f.mimetype.startsWith('image/')) });

// ── Express app ───────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit:'2mb' }));
app.use(cookieParser());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ════ AUTH ROUTES ════
app.post('/api/signup', async (req, res) => {
  let { username, password, email } = req.body||{};
  if (!username||!password) return res.status(400).json({ error:'Missing fields' });
  username = username.toLowerCase().trim().replace(/[^a-z0-9_\-.]/g,'_').slice(0,32);
  if (username.length<3) return res.status(400).json({ error:'Username must be 3–32 chars' });
  if (String(password).length<4) return res.status(400).json({ error:'Password must be 4+ chars' });
  if (Q.userByName.get(username)) return res.status(409).json({ error:'That handle is already taken' });
  const id = uuid();
  Q.createUser.run(id, username, bcrypt.hashSync(String(password),10), username, email||null);
  const user = Q.userById.get(id);
  const token = crypto.randomBytes(32).toString('hex');
  Q.createSess.run(token, id);
  res.cookie('wt', token, { httpOnly:true, sameSite:'lax', maxAge:30*24*3600*1000 });
  broadcast({ type:'user_join', user:pub(user) });
  res.json({ ok:true, user:pub(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body||{};
  if (!username||!password) return res.status(400).json({ error:'Missing fields' });
  const user = Q.userByName.get(String(username).trim());
  if (!user) return res.status(401).json({ error:'Node not found in the Wired' });
  if (user.is_banned) return res.status(403).json({ error:'You have been banned from the Wired.' });
  if (!bcrypt.compareSync(String(password), user.pwd_hash)) return res.status(401).json({ error:'Wrong password' });
  // Check TOTP
  if (user.totp_enabled) {
    const pendingToken = crypto.randomBytes(24).toString('hex');
    Q.addPending.run(pendingToken, user.id, Math.floor(Date.now()/1000)+600);
    return res.json({ ok:false, requires2fa:true, pendingToken });
  }
  const token = crypto.randomBytes(32).toString('hex');
  Q.createSess.run(token, user.id);
  res.cookie('wt', token, { httpOnly:true, sameSite:'lax', maxAge:30*24*3600*1000 });
  res.json({ ok:true, user:pub(user) });
});

app.post('/api/login/2fa', (req, res) => {
  const { pendingToken, code } = req.body||{};
  if (!pendingToken||!code) return res.status(400).json({ error:'Missing fields' });
  Q.cleanPending.run(Math.floor(Date.now()/1000));
  const pending = Q.getPending.get(pendingToken);
  if (!pending) return res.status(401).json({ error:'Token expired or invalid. Please log in again.' });
  const user = Q.userById.get(pending.user_id);
  if (!user) return res.status(401).json({ error:'User not found' });
  const valid = speakeasy.totp.verify({ secret:user.totp_secret, encoding:'base32', token:String(code).replace(/\s/g,''), window:2 });
  if (!valid) return res.status(401).json({ error:'Invalid 2FA code' });
  Q.delPending.run(pendingToken);
  const token = crypto.randomBytes(32).toString('hex');
  Q.createSess.run(token, user.id);
  res.cookie('wt', token, { httpOnly:true, sameSite:'lax', maxAge:30*24*3600*1000 });
  res.json({ ok:true, user:pub(user) });
});

app.post('/api/logout', auth, (req, res) => {
  Q.delSess.run(req.token);
  res.clearCookie('wt');
  res.json({ ok:true });
});

app.get('/api/me', auth, (req,res) => res.json({ user:pub(req.user) }));
app.get('/api/users', auth, (req,res) => res.json({ users:Q.allUsers.all().map(pub) }));

// ════ PROFILE ════
app.patch('/api/profile', auth, (req, res) => {
  const u = req.user;
  const display = (req.body?.display||u.display).slice(0,32);
  const bio     = (req.body?.bio??u.bio).slice(0,300);
  const status  = (req.body?.status??u.status).slice(0,80);
  const color   = req.body?.color||u.color;
  Q.updateProf.run(display, bio, status, color, u.avatar, u.banner, u.id);
  const updated = Q.userById.get(u.id);
  broadcast({ type:'user_update', user:pub(updated) });
  res.json({ ok:true, user:pub(updated) });
});

app.post('/api/avatar', auth, uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error:'No image' });
  const url = '/uploads/'+req.file.filename;
  if (req.user.avatar) fs.unlink(path.join(UPLOAD_DIR, path.basename(req.user.avatar)), ()=>{});
  Q.updateAvatar.run(url, req.user.id);
  const updated = Q.userById.get(req.user.id);
  broadcast({ type:'user_update', user:pub(updated) });
  res.json({ ok:true, avatar:url });
});

app.post('/api/banner', auth, uploadBanner.single('banner'), (req, res) => {
  if (!req.file) return res.status(400).json({ error:'No image' });
  const url = '/uploads/'+req.file.filename;
  if (req.user.banner) fs.unlink(path.join(UPLOAD_DIR, path.basename(req.user.banner)), ()=>{});
  Q.updateBanner.run(url, req.user.id);
  const updated = Q.userById.get(req.user.id);
  broadcast({ type:'user_update', user:pub(updated) });
  res.json({ ok:true, banner:url });
});

// Image upload for messages
app.post('/api/upload/image', auth, uploadImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error:'No image' });
  res.json({ ok:true, url:'/uploads/'+req.file.filename });
});

// ════ 2FA / TOTP ════
app.post('/api/2fa/setup', auth, async (req, res) => {
  const secret = speakeasy.generateSecret({ name:`TheWired:${req.user.username}`, length:20 });
  // temporarily store in pending table
  Q.addPending.run('setup:'+req.user.id, JSON.stringify({secret:secret.base32}), Math.floor(Date.now()/1000)+600);
  const qr = await QRCode.toDataURL(secret.otpauth_url);
  res.json({ ok:true, secret:secret.base32, qr });
});

app.post('/api/2fa/enable', auth, (req, res) => {
  const { code } = req.body||{};
  const row = Q.getPending.get('setup:'+req.user.id);
  if (!row) return res.status(400).json({ error:'Setup session expired. Start again.' });
  const { secret } = JSON.parse(row.token||'{}') || {};
  // row.token is actually the second column in our schema — let me fix:
  // We stored it in token column — get it differently
  const data = db.prepare('SELECT * FROM totp_pending WHERE token=?').get('setup:'+req.user.id);
  const parsed = JSON.parse(data ? data.user_id : '{}'); // We abused user_id field - fix below
  // Correct: token='setup:uid', user_id=JSON
  const secretB32 = JSON.parse(db.prepare('SELECT user_id FROM totp_pending WHERE token=?').get('setup:'+req.user.id)?.user_id||'{}')?.secret
    || secret;
  if (!secretB32) return res.status(400).json({ error:'Setup session expired' });
  const valid = speakeasy.totp.verify({ secret:secretB32, encoding:'base32', token:String(code).replace(/\s/g,''), window:2 });
  if (!valid) return res.status(401).json({ error:'Invalid code — try again' });
  Q.enableTOTP.run(secretB32, req.user.id);
  Q.delPending.run('setup:'+req.user.id);
  res.json({ ok:true });
});

app.post('/api/2fa/disable', auth, (req, res) => {
  const { code, password } = req.body||{};
  if (!bcrypt.compareSync(String(password||''), req.user.pwd_hash)) return res.status(401).json({ error:'Wrong password' });
  if (req.user.totp_enabled) {
    const valid = speakeasy.totp.verify({ secret:req.user.totp_secret, encoding:'base32', token:String(code||'').replace(/\s/g,''), window:2 });
    if (!valid) return res.status(401).json({ error:'Invalid 2FA code' });
  }
  Q.disableTOTP.run(req.user.id);
  res.json({ ok:true });
});

// Redo 2FA setup with correct storage
app.post('/api/2fa/setup', auth, async (req, res) => {
  const secret = speakeasy.generateSecret({ name:`TheWired(${req.user.username})`, length:20 });
  db.prepare('INSERT OR REPLACE INTO totp_pending (token,user_id,expires) VALUES (?,?,?)').run(
    'setup:'+req.user.id, JSON.stringify({secret:secret.base32}), Math.floor(Date.now()/1000)+600
  );
  const qr = await QRCode.toDataURL(secret.otpauth_url);
  res.json({ ok:true, secret:secret.base32, qr });
});

app.post('/api/2fa/enable', auth, (req, res) => {
  const { code } = req.body||{};
  const row = db.prepare('SELECT user_id FROM totp_pending WHERE token=?').get('setup:'+req.user.id);
  if (!row) return res.status(400).json({ error:'Setup session expired. Start again.' });
  let secretB32; try { secretB32 = JSON.parse(row.user_id).secret; } catch { return res.status(400).json({ error:'Corrupted setup' }); }
  const valid = speakeasy.totp.verify({ secret:secretB32, encoding:'base32', token:String(code).replace(/\s/g,''), window:2 });
  if (!valid) return res.status(401).json({ error:'Invalid code — check your authenticator app' });
  Q.enableTOTP.run(secretB32, req.user.id);
  Q.delPending.run('setup:'+req.user.id);
  const updated = Q.userById.get(req.user.id);
  res.json({ ok:true, user:pub(updated) });
});

app.post('/api/2fa/disable', auth, (req, res) => {
  const { code, password } = req.body||{};
  if (!bcrypt.compareSync(String(password||''), req.user.pwd_hash)) return res.status(401).json({ error:'Wrong password' });
  if (req.user.totp_enabled) {
    const valid = speakeasy.totp.verify({ secret:req.user.totp_secret, encoding:'base32', token:String(code||'').replace(/\s/g,''), window:2 });
    if (!valid) return res.status(401).json({ error:'Invalid 2FA code' });
  }
  Q.disableTOTP.run(req.user.id);
  const updated = Q.userById.get(req.user.id);
  res.json({ ok:true, user:pub(updated) });
});

// ════ SERVERS / CHANNELS ════
app.get('/api/servers', auth, (req, res) => {
  const servers = Q.getServers.all().map(s => ({ ...s, channels:Q.getChannels.all(s.id) }));
  res.json({ servers });
});

app.post('/api/servers/:sid/channels', auth, (req, res) => {
  const sv = Q.getServer.get(req.params.sid);
  if (!sv) return res.status(404).json({ error:'Server not found' });
  let name = (req.body?.name||'').toLowerCase().trim().replace(/[^a-z0-9\-_]/g,'-').replace(/^-+|-+$/g,'').slice(0,32);
  if (!name) return res.status(400).json({ error:'Invalid channel name' });
  const topic = (req.body?.topic||'').slice(0,80);
  const existing = Q.getChannels.all(req.params.sid).find(c=>c.name===name);
  if (existing) return res.json({ ok:true, channel:existing });
  const id = `${name}-${Date.now()}`;
  const pos = Q.getChannels.all(req.params.sid).length;
  Q.createChan.run(id, req.params.sid, name, topic, pos);
  const ch = Q.getChannel.get(id);
  broadcast({ type:'channel_create', server_id:req.params.sid, channel:ch });
  res.json({ ok:true, channel:ch });
});

app.delete('/api/servers/:sid/channels/:cid', auth, (req, res) => {
  if (req.params.cid==='general') return res.status(403).json({ error:'Cannot delete #general' });
  Q.delChan.run(req.params.cid, req.params.sid);
  broadcast({ type:'channel_delete', server_id:req.params.sid, channel_id:req.params.cid });
  res.json({ ok:true });
});

// ════ MESSAGES ════
app.get('/api/channels/:cid/messages', auth, (req, res) => {
  res.json({ messages: Q.getMsgs.all(req.params.cid).reverse().map(pubMsg) });
});

app.delete('/api/messages/:mid', auth, (req, res) => {
  const msg = Q.getMsgById.get(req.params.mid);
  if (!msg) return res.status(404).json({ error:'Message not found' });
  const isAdmin = req.user.username.toLowerCase()===ADMIN_USER;
  if (msg.author_id!==req.user.id && !isAdmin) return res.status(403).json({ error:'Not your message' });
  Q.deleteMsg.run(msg.id);
  broadcast({ type:'message_delete', message_id:msg.id, channel_id:msg.channel_id });
  res.json({ ok:true });
});

// ════ ADMIN ════
app.post('/api/admin/ban', auth, adminOnly, (req, res) => {
  const { username, banned } = req.body||{};
  if (!username) return res.status(400).json({ error:'Missing username' });
  if (username.toLowerCase()===ADMIN_USER) return res.status(403).json({ error:'Cannot ban admin' });
  Q.banUser.run(banned?1:0, username);
  const user = Q.userByName.get(username);
  if (user) {
    if (banned) Q.delAllSess.run(user.id);
    broadcast({ type:'user_update', user:pub(user) });
    if (banned) broadcast({ type:'user_banned', username:user.username });
  }
  res.json({ ok:true });
});

app.post('/api/admin/mute', auth, adminOnly, (req, res) => {
  const { username, minutes } = req.body||{};
  if (!username) return res.status(400).json({ error:'Missing username' });
  const until = minutes>0 ? Math.floor(Date.now()/1000)+(minutes*60) : 0;
  Q.muteUser.run(until, username);
  const user = Q.userByName.get(username);
  if (user) broadcast({ type:'user_update', user:pub(user) });
  res.json({ ok:true });
});

// ── WebSocket ─────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

function broadcast(payload, excludeWs) {
  const data = JSON.stringify(payload);
  for (const [ws] of clients) if (ws!==excludeWs && ws.readyState===WebSocket.OPEN) ws.send(data);
}
function sendTo(ws, payload) { if (ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(payload)); }

wss.on('connection', (ws, req) => {
  const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(c=>{const[k,...v]=c.trim().split('=');return[k,decodeURIComponent(v.join('='))]}));
  const sess = Q.getSess.get(cookies.wt||'');
  if (!sess) { ws.close(4001,'Unauth'); return; }
  const user = Q.userById.get(sess.user_id);
  if (!user||user.is_banned) { ws.close(4001,'Banned'); return; }

  clients.set(ws, { user });
  sendTo(ws, { type:'hello', user:pub(user) });
  sendTo(ws, { type:'online', users:[...clients.values()].map(c=>pub(c.user)) });
  broadcast({ type:'presence', user:pub(user), online:true }, ws);

  ws.on('message', raw => {
    let msg; try { msg=JSON.parse(raw); } catch { return; }
    const ctx = clients.get(ws); if (!ctx) return;
    const freshUser = Q.userById.get(ctx.user.id);
    if (!freshUser||freshUser.is_banned) return;

    if (msg.type==='message') {
      const { channel_id, content, image_url, reply_to_id } = msg;
      if (!channel_id) return;
      const text = (content||'').trim().slice(0,2000);
      if (!text && !image_url) return;
      if (!Q.getChannel.get(channel_id)) return;
      // Check mute
      if (freshUser.muted_until > Math.floor(Date.now()/1000)) {
        sendTo(ws, { type:'error', message:`You are muted until ${new Date(freshUser.muted_until*1000).toLocaleTimeString()}` });
        return;
      }
      const id = uuid();
      Q.insertMsg.run(id, channel_id, freshUser.id, text||'', image_url||null, reply_to_id||null);
      // fetch with join for reply info
      const full = Q.getMsgs.all(channel_id).find(m=>m.id===id);
      const payload = { type:'message', message: full ? pubMsg(full) : {
        id, channel_id, content:text, image_url:image_url||null,
        reply_to_id:reply_to_id||null, reply_content:null, reply_display:null,
        created:Math.floor(Date.now()/1000), author_id:freshUser.id,
        username:freshUser.username, display:freshUser.display,
        color:freshUser.color, avatar:freshUser.avatar, edited:false, deleted:false
      }};
      const data = JSON.stringify(payload);
      for (const [c] of clients) if (c.readyState===WebSocket.OPEN) c.send(data);
    }

    if (msg.type==='typing') {
      if (msg.channel_id) broadcast({ type:'typing', channel_id:msg.channel_id, user:pub(freshUser) }, ws);
    }
  });

  ws.on('close', () => { const ctx=clients.get(ws); if(ctx) broadcast({type:'presence',user:pub(ctx.user),online:false}); clients.delete(ws); });
  ws.on('error', () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`\n╔${'═'.repeat(44)}╗`);
  console.log(`║${'  The Wired 2.0 — いとをひく'.padEnd(44)}║`);
  console.log(`╚${'═'.repeat(44)}╝`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Admin: ${ADMIN_USER}`);
  console.log(`  DB: ${DB_PATH}\n`);
});
