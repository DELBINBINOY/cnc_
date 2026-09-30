const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL;
const DB_PATH = process.env.DB_PATH || (isProduction ? '/tmp/caffeine-n-connect-db.json' : path.join(__dirname, 'data', 'db.json'));
const empty = { users: [], services: [], portfolio: [], conversations: [], messages: [], communities: [], communityMembers: [], communityMessages: [], reviews: [] };
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
}) : null;

async function initDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

function ensureDbFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
}

function loadJson() {
  try {
    ensureDbFile();
    return { ...empty, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
  } catch {
    return structuredClone ? structuredClone(empty) : JSON.parse(JSON.stringify(empty));
  }
}

function saveJson(data) {
  ensureDbFile();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

async function load() {
  if (!pool) return loadJson();
  const result = await pool.query("SELECT value FROM app_state WHERE key = 'main'");
  if (result.rows.length) return result.rows[0].value;
  const initial = structuredClone ? structuredClone(empty) : JSON.parse(JSON.stringify(empty));
  await save(initial);
  return initial;
}

async function save(data) {
  if (!pool) {
    saveJson(data);
    return;
  }
  await pool.query(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES ('main', $1, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [data]
  );
}

function id(array) {
  return array.length ? Math.max(...array.map((item) => item.id)) + 1 : 1;
}

function now() {
  return new Date().toISOString();
}

const sess = session({
  secret: process.env.SESSION_SECRET || 'hackathon-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 86400000,
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
  },
});

app.use(sess);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
  filename: (_, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const auth = (req, res, next) => (req.session.userId ? next() : res.status(401).json({ error: 'Login required' }));
const safeUser = (user) => {
  if (!user) return null;
  const { password, ...rest } = user;
  return rest;
};

app.post('/api/signup', async (req, res) => {
  const data = await load();
  const { name, email, password, department = '', semester = '' } = req.body;

  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
  if (data.users.some((user) => user.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const user = {
    id: id(data.users),
    name,
    email: String(email).toLowerCase(),
    password: await bcrypt.hash(password, 10),
    department,
    semester,
    bio: '',
    skills: [],
    createdAt: now(),
  };

  data.users.push(user);
  await save(data);
  req.session.userId = user.id;
  res.json(safeUser(user));
});

app.post('/api/login', async (req, res) => {
  const data = await load();
  const user = data.users.find((entry) => entry.email === String(req.body.email || '').toLowerCase());

  if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  req.session.userId = user.id;
  res.json(safeUser(user));
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', auth, async (req, res) => {
  const data = await load();
  res.json(safeUser(data.users.find((user) => user.id === req.session.userId)));
});

app.put('/api/me', auth, async (req, res) => {
  const data = await load();
  const user = data.users.find((entry) => entry.id === req.session.userId);

  ['name', 'department', 'semester', 'bio'].forEach((key) => {
    if (req.body[key] !== undefined) user[key] = req.body[key];
  });

  if (req.body.skills !== undefined) {
    user.skills = Array.isArray(req.body.skills)
      ? req.body.skills
      : String(req.body.skills).split(',').map((skill) => skill.trim()).filter(Boolean);
  }

  await save(data);
  res.json(safeUser(user));
});

app.get('/api/users', auth, async (req, res) => {
  const data = await load();
  const q = String(req.query.q || '').toLowerCase();
  res.json(
    data.users
      .filter((user) => user.id !== req.session.userId && (!q || [user.name, user.department, user.semester, ...(user.skills || [])].join(' ').toLowerCase().includes(q)))
      .map((user) => profile(data, user))
  );
});

function profile(data, user) {
  const reviews = data.reviews.filter((review) => review.userId === user.id);
  const rating = reviews.length ? reviews.reduce((sum, item) => sum + item.rating, 0) / reviews.length : null;
  return {
    ...safeUser(user),
    rating: rating ? +rating.toFixed(1) : null,
    reviewCount: reviews.length,
    services: data.services.filter((service) => service.userId === user.id),
    portfolio: data.portfolio.filter((item) => item.userId === user.id),
  };
}

app.get('/api/users/:id', auth, async (req, res) => {
  const data = await load();
  const user = data.users.find((entry) => entry.id === +req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(profile(data, user));
});

app.post('/api/portfolio', auth, async (req, res) => {
  const data = await load();
  const item = {
    id: id(data.portfolio),
    userId: req.session.userId,
    title: req.body.title,
    description: req.body.description || '',
    link: req.body.link || '',
    createdAt: now(),
  };
  data.portfolio.push(item);
  await save(data);
  res.json(item);
});

app.delete('/api/portfolio/:id', auth, async (req, res) => {
  const data = await load();
  const item = data.portfolio.find((entry) => entry.id === +req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
  data.portfolio = data.portfolio.filter((entry) => entry.id !== item.id);
  await save(data);
  res.json({ ok: true });
});

app.get('/api/services', auth, async (req, res) => {
  const data = await load();
  const q = String(req.query.q || '').toLowerCase();
  const dept = String(req.query.department || '').toLowerCase();

  let rows = data.services
    .map((service) => ({ ...service, user: safeUser(data.users.find((user) => user.id === service.userId)) }))
    .filter((service) => {
      const hay = [service.title, service.category, service.description, (service.skills || []).join(' '), service.user?.name].join(' ').toLowerCase();
      return (!q || hay.includes(q)) && (!dept || service.user?.department?.toLowerCase() === dept);
    });

  if (q) {
    rows = rows
      .map((service) => ({
        ...service,
        matchScore: Math.round(
          (q.split(/\s+/).filter((word) => [service.title, service.description, (service.skills || []).join(' ')].join(' ').toLowerCase().includes(word)).length /
            Math.max(1, q.split(/\s+/).length)) * 100
        ),
      }))
      .sort((a, b) => b.matchScore - a.matchScore);
  }

  res.json(rows);
});

app.post('/api/services', auth, async (req, res) => {
  const data = await load();
  const service = {
    id: id(data.services),
    userId: req.session.userId,
    title: req.body.title,
    category: req.body.category || '',
    description: req.body.description || '',
    skills: Array.isArray(req.body.skills)
      ? req.body.skills
      : String(req.body.skills || '').split(',').map((skill) => skill.trim()).filter(Boolean),
    availability: req.body.availability || 'Active',
    createdAt: now(),
  };

  if (!service.title) return res.status(400).json({ error: 'Title required' });

  data.services.push(service);
  await save(data);
  res.json(service);
});

app.put('/api/services/:id', auth, async (req, res) => {
  const data = await load();
  const service = data.services.find((entry) => entry.id === +req.params.id);
  if (!service) return res.status(404).json({ error: 'Not found' });
  if (service.userId !== req.session.userId) return res.status(403).json({ error: 'You can edit only your services' });

  ['title', 'category', 'description', 'availability'].forEach((key) => {
    if (req.body[key] !== undefined) service[key] = req.body[key];
  });

  if (req.body.skills !== undefined) {
    service.skills = Array.isArray(req.body.skills)
      ? req.body.skills
      : String(req.body.skills).split(',').map((skill) => skill.trim()).filter(Boolean);
  }

  await save(data);
  res.json(service);
});

app.delete('/api/services/:id', auth, async (req, res) => {
  const data = await load();
  const service = data.services.find((entry) => entry.id === +req.params.id);
  if (!service) return res.status(404).json({ error: 'Not found' });
  if (service.userId !== req.session.userId) return res.status(403).json({ error: 'You can delete only your services' });
  data.services = data.services.filter((entry) => entry.id !== service.id);
  await save(data);
  res.json({ ok: true });
});

app.post('/api/reviews', auth, async (req, res) => {
  const data = await load();
  const userId = +req.body.userId;
  const rating = Math.max(1, Math.min(5, +req.body.rating));

  if (userId === req.session.userId) return res.status(400).json({ error: 'Cannot review yourself' });

  const review = {
    id: id(data.reviews),
    userId,
    reviewerId: req.session.userId,
    rating,
    comment: req.body.comment || '',
    createdAt: now(),
  };

  data.reviews.push(review);
  await save(data);
  res.json(review);
});

function convoView(data, conversation, userId) {
  const otherId = conversation.members.find((member) => member !== userId);
  const other = safeUser(data.users.find((user) => user.id === otherId));
  const messages = data.messages.filter((message) => message.conversationId === conversation.id && !message.deletedAt);
  const last = messages.at(-1);
  const unread = messages.filter((message) => message.senderId !== userId && !message.readBy.includes(userId)).length;
  return { ...conversation, other, last, unread };
}

app.get('/api/conversations', auth, async (req, res) => {
  const data = await load();
  res.json(
    data.conversations
      .filter((conversation) => conversation.members.includes(req.session.userId))
      .map((conversation) => convoView(data, conversation, req.session.userId))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  );
});

app.post('/api/conversations', auth, async (req, res) => {
  const data = await load();
  const other = +req.body.userId;

  if (other === req.session.userId) return res.status(400).json({ error: 'Cannot message yourself' });

  let conversation = data.conversations.find(
    (entry) =>
      entry.members.length === 2 &&
      entry.members.includes(req.session.userId) &&
      entry.members.includes(other) &&
      (+entry.serviceId || 0) === (+req.body.serviceId || 0)
  );

  if (!conversation) {
    conversation = {
      id: id(data.conversations),
      members: [req.session.userId, other],
      serviceId: req.body.serviceId ? +req.body.serviceId : null,
      createdAt: now(),
      updatedAt: now(),
    };
    data.conversations.push(conversation);
    await save(data);
  }

  res.json(convoView(data, conversation, req.session.userId));
});

app.get('/api/conversations/:id/messages', auth, async (req, res) => {
  const data = await load();
  const conversation = data.conversations.find((entry) => entry.id === +req.params.id && entry.members.includes(req.session.userId));
  if (!conversation) return res.status(403).json({ error: 'Forbidden' });

  data.messages
    .filter((message) => message.conversationId === conversation.id && message.senderId !== req.session.userId && !message.readBy.includes(req.session.userId))
    .forEach((message) => message.readBy.push(req.session.userId));

  await save(data);
  res.json(
    data.messages
      .filter((message) => message.conversationId === conversation.id)
      .map((message) => ({ ...message, sender: safeUser(data.users.find((user) => user.id === message.senderId)) }))
  );
});

app.post('/api/conversations/:id/messages', auth, upload.single('attachment'), async (req, res) => {
  const data = await load();
  const conversation = data.conversations.find((entry) => entry.id === +req.params.id && entry.members.includes(req.session.userId));
  if (!conversation) return res.status(403).json({ error: 'Forbidden' });

  const message = {
    id: id(data.messages),
    conversationId: conversation.id,
    senderId: req.session.userId,
    body: req.body.body || '',
    replyTo: req.body.replyTo ? +req.body.replyTo : null,
    attachment: req.file ? '/uploads/' + req.file.filename : null,
    attachmentName: req.file?.originalname || null,
    readBy: [req.session.userId],
    createdAt: now(),
    editedAt: null,
    deletedAt: null,
  };

  if (!message.body && !message.attachment) return res.status(400).json({ error: 'Message or attachment required' });

  data.messages.push(message);
  conversation.updatedAt = now();
  await save(data);
  io.to('c' + conversation.id).emit('message:new', message);
  res.json(message);
});

app.put('/api/messages/:id', auth, async (req, res) => {
  const data = await load();
  const message = data.messages.find((entry) => entry.id === +req.params.id);
  if (!message) return res.status(404).json({ error: 'Not found' });
  if (message.senderId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

  message.body = req.body.body ?? message.body;
  message.editedAt = now();
  await save(data);
  io.to('c' + message.conversationId).emit('message:updated', message);
  res.json(message);
});

app.delete('/api/messages/:id', auth, async (req, res) => {
  const data = await load();
  const message = data.messages.find((entry) => entry.id === +req.params.id);
  if (!message) return res.status(404).json({ error: 'Not found' });
  if (message.senderId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

  message.body = '';
  message.attachment = null;
  message.deletedAt = now();
  await save(data);
  io.to('c' + message.conversationId).emit('message:deleted', { id: message.id });
  res.json({ ok: true });
});

app.get('/api/communities', auth, async (req, res) => {
  const data = await load();
  res.json(
    data.communities.map((community) => ({
      ...community,
      members: data.communityMembers.filter((member) => member.communityId === community.id).length,
      joined: data.communityMembers.some((member) => member.communityId === community.id && member.userId === req.session.userId),
    }))
  );
});

app.post('/api/communities', auth, async (req, res) => {
  const data = await load();
  const community = {
    id: id(data.communities),
    name: req.body.name,
    description: req.body.description || '',
    ownerId: req.session.userId,
    createdAt: now(),
  };

  data.communities.push(community);
  data.communityMembers.push({ id: id(data.communityMembers), communityId: community.id, userId: req.session.userId });
  await save(data);
  res.json(community);
});

app.post('/api/communities/:id/join', auth, async (req, res) => {
  const data = await load();
  const communityId = +req.params.id;
  if (!data.communityMembers.some((member) => member.communityId === communityId && member.userId === req.session.userId)) {
    data.communityMembers.push({ id: id(data.communityMembers), communityId: communityId, userId: req.session.userId });
  }
  await save(data);
  res.json({ ok: true });
});

app.get('/api/communities/:id/messages', auth, async (req, res) => {
  const data = await load();
  const communityId = +req.params.id;

  if (!data.communityMembers.some((member) => member.communityId === communityId && member.userId === req.session.userId)) {
    return res.status(403).json({ error: 'Join community first' });
  }

  res.json(
    data.communityMessages
      .filter((message) => message.communityId === communityId)
      .map((message) => ({ ...message, sender: safeUser(data.users.find((user) => user.id === message.senderId)) }))
  );
});

app.post('/api/communities/:id/messages', auth, async (req, res) => {
  const data = await load();
  const communityId = +req.params.id;

  if (!data.communityMembers.some((member) => member.communityId === communityId && member.userId === req.session.userId)) {
    return res.status(403).json({ error: 'Join community first' });
  }

  const message = {
    id: id(data.communityMessages),
    communityId,
    senderId: req.session.userId,
    body: req.body.body,
    createdAt: now(),
  };

  data.communityMessages.push(message);
  await save(data);
  io.to('g' + communityId).emit('community:new', message);
  res.json(message);
});

io.engine.use(sess);
io.on('connection', (socket) => {
  if (!socket.request.session?.userId) return socket.disconnect();
  socket.on('join:conversation', (id) => socket.join('c' + id));
  socket.on('join:community', (id) => socket.join('g' + id));
});

if (pool) initDatabase().catch((error) => console.error('Database init failed:', error));

if (require.main === module) server.listen(PORT, () => console.log(`Caffeine n Connect running at http://localhost:${PORT}`));

module.exports = app;
