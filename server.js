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

const PORT    = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wired.db');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Database ──────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id       TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    pwd_hash TEXT NOT NULL,
    display  TEXT NOT NULL,
    bio      TEXT DEFAULT '',
    status   TEXT DEFAULT 'connected to the wired',
    color    TEXT DEFAULT '#2a0d15',
    avatar   TEXT DEFAULT NULL,
    created  INTEGER DEFAULT (unixepoch())
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
    id         TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id  TEXT NOT NULL REFERENCES users(id),
    content    TEXT NOT NULL,
    created    INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_msg_ch ON messages(channel_id, created);
`);

// Seed default server + channels
if (!db.prepare('SELECT id FROM servers WHERE id=?').get('wired')) {
  db.prepare('INSERT INTO servers (id,name,owner) VALUES (?,?,?)').run('wired','The Wired','system');
  [
    ['general',    'general',     'the place of general exchange',      0],
    ['lain',       'lain',        'sightings of Lain in the Wired',     1],
    ['protocol-7', 'protocol-7',  'discussion of Protocol 7',           2],
    ['navi-tech',  'navi-tech',   'all things NAVI and hardware',       3],
    ['kids',       'kids',        'children of the wired',              4],
  ].forEach(([id,name,topic,pos]) =>
    db.prepare('INSERT INTO channels (id,server_id,name,topic,position) VALUES (?,?,?,?,?)').run(id,'wired',name,topic,pos)
  );
}

// ── Prepared queries ──────────────────────────────────────────────
const Q = {
  userByName:  db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE'),
  userById:    db.prepare('SELECT * FROM users WHERE id=?'),
  allUsers:    db.prepare('SELECT * FROM users ORDER BY display'),
  createUser:  db.prepare('INSERT INTO users (id,username,pwd_hash,display) VALUES (?,?,?,?)'),
  updateProf:  db.prepare('UPDATE users SET display=?,bio=?,status=?,color=?,avatar=? WHERE id=?'),
  updateAvatar:db.prepare('UPDATE users SET avatar=? WHERE id=?'),
  createSess:  db.prepare('INSERT INTO sessions (token,user_id) VALUES (?,?)'),
  getSess:     db.prepare('SELECT * FROM sessions WHERE token=?'),
  delSess:     db.prepare('DELETE FROM sessions WHERE token=?'),
  getServers:  db.prepare('SELECT * FROM servers ORDER BY name'),
  getServer:   db.prepare('SELECT * FROM servers WHERE id=?'),
  getChannels: db.prepare('SELECT * FROM channels WHERE server_id=? ORDER BY position,name'),
  getChannel:  db.prepare('SELECT * FROM channels WHERE id=?'),
  createChan:  db.prepare('INSERT INTO channels (id,server_id,name,topic,position) VALUES (?,?,?,?,?)'),
  delChan:     db.prepare('DELETE FROM channels WHERE id=? AND server_id=?'),
  getMsgs:     db.prepare(`SELECT m.*,u.display,u.username,u.color,u.avatar
                            FROM messages m JOIN users u ON m.author_id=u.id
                            WHERE m.channel_id=? ORDER BY m.created DESC LIMIT 100`),
  insertMsg:   db.prepare('INSERT INTO messages (id,channel_id,author_id,content) VALUES (?,?,?,?)'),
  delOldSess:  db.prepare('DELETE FROM sessions WHERE created < (unixepoch() - 2592000)'),
};

// Cleanup old sessions on startup
Q.delOldSess.run();

// ── Auth middleware ───────────────────────────────────────────────
function auth(req, res, next) {
  const tok = req.cookies?.wt;
  if (!tok) return res.status(401).json({ error: 'Not authenticated' });
  const sess = Q.getSess.get(tok);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  req.user  = Q.userById.get(sess.user_id);
  req.token = tok;
  if (!req.user) return res.status(401).json({ error: 'User not found' });
  next();
}

// ── Multer ────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_, f, cb) => cb(null, uuid() + path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g,''))
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_, f, cb) => cb(null, f.mimetype.startsWith('image/'))
});

// ── Express ───────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function pub(u) {
  return u ? { id:u.id, username:u.username, display:u.display, bio:u.bio, status:u.status, color:u.color, avatar:u.avatar } : null;
}
function pubMsg(m) {
  return { id:m.id, channel_id:m.channel_id, author_id:m.author_id, content:m.content,
           created:m.created, username:m.username, display:m.display, color:m.color, avatar:m.avatar };
}

// Auth
app.post('/api/signup', (req, res) => {
  let { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  username = username.toLowerCase().trim().replace(/[^a-z0-9_\-.]/g,'_').slice(0,32);
  if (username.length < 3) return res.status(400).json({ error: 'Username must be 3–32 characters' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Password must be 4+ characters' });
  if (Q.userByName.get(username)) return res.status(409).json({ error: 'That handle is already taken' });
  const id = uuid();
  Q.createUser.run(id, username, bcrypt.hashSync(String(password), 10), username);
  const token = crypto.randomBytes(32).toString('hex');
  Q.createSess.run(token, id);
  res.cookie('wt', token, { httpOnly:true, sameSite:'lax', maxAge:30*24*3600*1000 });
  const user = Q.userById.get(id);
  broadcast({ type:'user_join', user:pub(user) });
  res.json({ ok:true, user:pub(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const user = Q.userByName.get(String(username).trim());
  if (!user) return res.status(401).json({ error: 'Node not found in the Wired' });
  if (!bcrypt.compareSync(String(password), user.pwd_hash)) return res.status(401).json({ error: 'Wrong password' });
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

app.get('/api/me', auth, (req, res) => res.json({ user:pub(req.user) }));

app.get('/api/users', auth, (req, res) => res.json({ users: Q.allUsers.all().map(pub) }));

// Profile
app.patch('/api/profile', auth, (req, res) => {
  const u = req.user;
  const display  = (req.body?.display  || u.display).slice(0,32);
  const bio      = (req.body?.bio      ?? u.bio    ).slice(0,200);
  const status   = (req.body?.status   ?? u.status ).slice(0,80);
  const color    = req.body?.color || u.color;
  Q.updateProf.run(display, bio, status, color, u.avatar, u.id);
  const updated = Q.userById.get(u.id);
  broadcast({ type:'user_update', user:pub(updated) });
  res.json({ ok:true, user:pub(updated) });
});

app.post('/api/avatar', auth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const url = '/uploads/' + req.file.filename;
  const old = req.user.avatar;
  if (old) fs.unlink(path.join(UPLOAD_DIR, path.basename(old)), ()=>{});
  Q.updateAvatar.run(url, req.user.id);
  const updated = Q.userById.get(req.user.id);
  broadcast({ type:'user_update', user:pub(updated) });
  res.json({ ok:true, avatar:url });
});

// Servers
app.get('/api/servers', auth, (req, res) => {
  const servers = Q.getServers.all().map(s => ({ ...s, channels: Q.getChannels.all(s.id) }));
  res.json({ servers });
});

// Channels
app.post('/api/servers/:sid/channels', auth, (req, res) => {
  const sv = Q.getServer.get(req.params.sid);
  if (!sv) return res.status(404).json({ error: 'Server not found' });
  let name = (req.body?.name||'').toLowerCase().trim().replace(/[^a-z0-9\-_]/g,'-').replace(/^-+|-+$/g,'').slice(0,32);
  if (!name) return res.status(400).json({ error: 'Invalid channel name' });
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
  if (req.params.cid === 'general') return res.status(403).json({ error: 'Cannot delete #general' });
  Q.delChan.run(req.params.cid, req.params.sid);
  broadcast({ type:'channel_delete', server_id:req.params.sid, channel_id:req.params.cid });
  res.json({ ok:true });
});

// Messages
app.get('/api/channels/:cid/messages', auth, (req, res) => {
  res.json({ messages: Q.getMsgs.all(req.params.cid).reverse().map(pubMsg) });
});

// ── WebSocket ─────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
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
  // Parse cookie from upgrade request
  const cookies = Object.fromEntries(
    (req.headers.cookie||'').split(';').map(c=>{
      const [k,...v]=c.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    })
  );
  const sess = Q.getSess.get(cookies.wt||'');
  if (!sess) { ws.close(4001,'Unauthenticated'); return; }
  const user = Q.userById.get(sess.user_id);
  if (!user) { ws.close(4001,'User not found'); return; }

  clients.set(ws, { user });

  // Welcome this client
  sendTo(ws, { type:'hello', user:pub(user) });
  sendTo(ws, { type:'online', users:[...clients.values()].map(c=>pub(c.user)) });
  // Tell everyone else
  broadcast({ type:'presence', user:pub(user), online:true }, ws);

  ws.on('message', raw => {
    let msg; try { msg=JSON.parse(raw); } catch { return; }
    const ctx = clients.get(ws);
    if (!ctx) return;
    // Always use fresh user data for display info
    const freshUser = Q.userById.get(ctx.user.id);
    if (!freshUser) return;

    if (msg.type === 'message') {
      const { channel_id, content } = msg;
      if (!channel_id || typeof content !== 'string') return;
      const text = content.trim().slice(0, 2000);
      if (!text) return;
      if (!Q.getChannel.get(channel_id)) return;
      const id = uuid();
      Q.insertMsg.run(id, channel_id, freshUser.id, text);
      const payload = {
        type: 'message',
        message: { id, channel_id, content:text, created:Math.floor(Date.now()/1000),
          author_id:freshUser.id, username:freshUser.username, display:freshUser.display,
          color:freshUser.color, avatar:freshUser.avatar }
      };
      const data = JSON.stringify(payload);
      for (const [c] of clients) if (c.readyState===WebSocket.OPEN) c.send(data);
    }

    if (msg.type === 'typing') {
      if (msg.channel_id) broadcast({ type:'typing', channel_id:msg.channel_id, user:pub(freshUser) }, ws);
    }
  });

  ws.on('close', () => {
    const ctx = clients.get(ws);
    if (ctx) broadcast({ type:'presence', user:pub(ctx.user), online:false });
    clients.delete(ws);
  });

  ws.on('error', () => { clients.delete(ws); });
});

// ── Start ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const line = '═'.repeat(40);
  console.log(`\n╔${line}╗`);
  console.log(`║${'  The Wired 2.0 — いとをひく  '.padStart(28).padEnd(40)}║`);
  console.log(`╚${line}╝`);
  console.log(`\n  http://localhost:${PORT}\n`);
});
