'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cron       = require('node-cron');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');

const { getAllPosts, getIgBlocked, setIgBlocked, reAuthInstagram } = require('./scraper');
const { getHashtags, setHashtags, updateHashtags, trackRemoval, approveSuggestion, getSuggestions } = require('./hashtags');
const topics = require('./topics');
const { addHashtagToGroup } = topics;

const app    = express();
const server = http.createServer(app);

const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const io = new Server(server, {
  path: `${BASE}/socket.io`,
});

// ─── Instagram session upload ─────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.post(`${BASE}/instagram/upload-session`, upload.single('session'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Geen bestand' });
    const raw  = req.file.buffer.toString('utf8');
    const json = JSON.parse(raw);

    // Accepteer zowel Playwright storageState als Cookie-Editor export
    let storageState;
    if (json.cookies !== undefined && json.origins !== undefined) {
      storageState = json; // al een Playwright storageState
    } else if (Array.isArray(json)) {
      // Cookie-Editor export → omzetten naar Playwright storageState
      storageState = {
        cookies: json.map(c => ({
          name:     c.name,
          value:    c.value,
          domain:   c.domain        || '.instagram.com',
          path:     c.path          || '/',
          expires:  c.expirationDate || c.expires || -1,
          httpOnly: c.httpOnly      || false,
          secure:   c.secure        || false,
          sameSite: c.sameSite      || 'Lax',
        })),
        origins: [],
      };
    } else {
      return res.status(400).json({ ok: false, error: 'Ongeldig formaat. Upload een Playwright storageState of Cookie-Editor JSON.' });
    }

    const sessDir = process.env.SESSIONS_DIR || './sessions';
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'instagram.json'), JSON.stringify(storageState, null, 2));

    setIgBlocked(false);
    io.emit('instagram:status', { blocked: false });
    console.log('[Instagram] Sessie bijgewerkt via upload');

    await reAuthInstagram();
    res.json({ ok: true });
  } catch (err) {
    console.error('[Instagram] Upload fout:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

if (BASE) {
  app.use(BASE, express.static(path.join(__dirname, 'public')));
  app.get(BASE, (req, res) => {
    const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8')
      .replace('</head>', `<script>window.__BASE="${BASE}";</script></head>`);
    res.send(html);
  });
  app.get(`${BASE}/`, (req, res) => res.redirect(BASE));
} else {
  app.use(express.static(path.join(__dirname, 'public')));
}

// ─── State ────────────────────────────────────────────────────────────────────
const SESSIONS_DIR   = process.env.SESSIONS_DIR || './sessions';
const CACHE_FILE     = path.join(SESSIONS_DIR, 'postcache.json');
const postCache      = new Map();
let   scrapeRunning  = false;
let   activeTopic    = null;
let   lastManualScrape = 0;

// ─── Cache persistence ────────────────────────────────────────────────────────
function saveCache() {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const arr = Array.from(postCache.values());
    fs.writeFileSync(CACHE_FILE, JSON.stringify(arr));
    console.log(`[Cache] Saved ${arr.length} posts to disk`);
  } catch (e) {
    console.error('[Cache] Save failed:', e.message);
  }
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    arr.forEach(p => postCache.set(p.id, p));
    const breakdown = arr.reduce((a, p) => { a[p.platform] = (a[p.platform]||0)+1; return a; }, {});
    console.log(`[Cache] Loaded ${postCache.size} posts from disk:`, JSON.stringify(breakdown));
  } catch (e) {
    console.error('[Cache] Load failed:', e.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setActiveTopic(topic) {
  activeTopic = topic;
  setHashtags(topic.hashtags);
  console.log(`[Topic] Active: "${topic.name}" (${topic.hashtags.length} hashtags)`);
}

function classifyGroup(post) {
  if (!activeTopic) return 'none';
  const setA = new Set(activeTopic.groupA?.hashtags || []);
  const setB = new Set(activeTopic.groupB?.hashtags || []);
  const tags = post.hashtags || [];
  const inA = tags.some(t => setA.has(t));
  const inB = tags.some(t => setB.has(t));
  if (inA && inB) return 'both';
  if (inA) return 'a';
  if (inB) return 'b';
  return 'none';
}

function postsWithStatus() {
  const reviewed = activeTopic?.reviewedIds || {};
  return Array.from(postCache.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 300)
    .map(p => ({ ...p, reviewStatus: reviewed[p.id] || null, group: classifyGroup(p) }));
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
function broadcastAll() {
  if (activeTopic) io.emit('topic:active', topics.summary(activeTopic));
  io.emit('hashtags:update',    getHashtags());
  io.emit('hashtags:suggestions', getSuggestions());
  io.emit('posts:update',       postsWithStatus());
  io.emit('instagram:status',   { blocked: getIgBlocked() });
}

// ─── Scrape cycle ─────────────────────────────────────────────────────────────
async function runScrape() {
  if (scrapeRunning || !activeTopic) return;
  scrapeRunning = true;
  const t0 = Date.now();
  try {
    const hashtags = getHashtags();
    console.log(`[Scrape] Starting – ${hashtags.length} hashtags`);
    const newPosts = await getAllPosts(hashtags);
    const activeTagSet = new Set(hashtags);
    let added = 0, skipped = 0;
    for (const post of newPosts) {
      const postTags = post.hashtags || [];
      if (!postTags.some(t => activeTagSet.has(t))) { skipped++; continue; }
      if (!postCache.has(post.id)) added++;
      postCache.set(post.id, post);
    }
    if (skipped > 0) console.log(`[Scrape] Skipped ${skipped} posts with no matching active hashtag`);
    if (postCache.size > 500) {
      const sorted = Array.from(postCache.entries())
        .sort((a, b) => b[1].timestamp - a[1].timestamp);
      postCache.clear();
      sorted.slice(0, 500).forEach(([k, v]) => postCache.set(k, v));
    }
    const breakdown = Array.from(postCache.values()).reduce((a, p) => { a[p.platform] = (a[p.platform]||0)+1; return a; }, {});
    console.log(`[Scrape] Done in ${((Date.now()-t0)/1000).toFixed(1)}s – +${added} new, total: ${postCache.size}`, JSON.stringify(breakdown));
    saveCache();
    broadcastAll();
    io.emit('scrape:done');
  } catch (err) {
    console.error('[Scrape] Error:', err.message);
  } finally {
    scrapeRunning = false;
  }
}

cron.schedule('*/3 * * * *', runScrape);

cron.schedule('0 * * * *', () => {
  if (!activeTopic) return;
  updateHashtags(Array.from(postCache.values()));
  io.emit('hashtags:suggestions', getSuggestions());
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Always send topic list so launcher can populate
  socket.emit('topics:list',    topics.list().map(topics.summary));
  socket.emit('instagram:status', { blocked: getIgBlocked() });

  // If a topic is already active, send current state immediately
  if (activeTopic) {
    socket.emit('topic:active',       topics.summary(activeTopic));
    socket.emit('hashtags:update',    getHashtags());
    socket.emit('hashtags:suggestions', getSuggestions());
    socket.emit('posts:update',       postsWithStatus());
  }

  // ── Create new topic ───────────────────────────────────────────────────────
  socket.on('topic:create', ({ name, groupA, groupB }, cb) => {
    const topic = topics.create(name, groupA, groupB);
    postCache.clear();
    saveCache();
    setActiveTopic(topic);
    io.emit('topics:list',    topics.list().map(topics.summary));
    io.emit('topic:active',   topics.summary(topic));
    io.emit('posts:update',   []);
    io.emit('hashtags:update', getHashtags());
    if (cb) cb({ ok: true, topic: topics.summary(topic) });
    setTimeout(runScrape, 500);
  });

  // ── Select existing topic ──────────────────────────────────────────────────
  socket.on('topic:select', ({ id }, cb) => {
    const topic = topics.load(id);
    if (!topic) { if (cb) cb({ ok: false, error: 'Not found' }); return; }
    const sameId = activeTopic?.id === id;
    if (!sameId) { postCache.clear(); saveCache(); }
    setActiveTopic(topic);
    io.emit('topics:list',    topics.list().map(topics.summary));
    io.emit('topic:active',   topics.summary(topic));
    io.emit('posts:update',   postsWithStatus());
    io.emit('hashtags:update', getHashtags());
    if (cb) cb({ ok: true, topic: topics.summary(topic) });
    if (!sameId) setTimeout(runScrape, 500);
  });

  // ── Mark post as reviewed ──────────────────────────────────────────────────
  socket.on('post:review', ({ postId, status }) => {
    if (!activeTopic) return;
    activeTopic = topics.markPost(activeTopic.id, postId, status);
    if (activeTopic) {
      io.emit('post:reviewed',  { postId, status });
      io.emit('topic:active',   topics.summary(activeTopic));
    }
  });

  // ── Update existing topic ──────────────────────────────────────────────────
  socket.on('topic:update', ({ id, name, groupA, groupB }, cb) => {
    const updated = topics.update(id, { name, groupA, groupB });
    if (!updated) { if (cb) cb({ ok: false }); return; }
    if (activeTopic?.id === id) {
      setActiveTopic(updated);
      io.emit('topic:active',   topics.summary(updated));
      io.emit('hashtags:update', getHashtags());
    }
    io.emit('topics:list', topics.list().map(topics.summary));
    if (cb) cb({ ok: true });
  });

  // ── Update hashtags for active topic ──────────────────────────────────────
  socket.on('topic:updateHashtags', ({ hashtags }) => {
    if (!activeTopic) return;

    // Track which tags the user manually removed so they won't be re-discovered
    const prevSet = new Set(getHashtags());
    const nextSet = new Set(hashtags);
    for (const t of prevSet) { if (!nextSet.has(t)) trackRemoval(t); }

    activeTopic = topics.updateHashtags(activeTopic.id, hashtags);
    setHashtags(hashtags);

    // Purge posts that no longer match any active hashtag
    const tagSet = new Set(hashtags);
    let purged = 0;
    for (const [id, post] of postCache.entries()) {
      const matches = (post.hashtags || []).some(t => tagSet.has(t));
      if (!matches) { postCache.delete(id); purged++; }
    }
    if (purged > 0) console.log(`[Hashtags] Purged ${purged} posts after hashtag removal`);
    if (purged > 0) saveCache();

    io.emit('hashtags:update', getHashtags());
    io.emit('posts:update',    postsWithStatus());
    io.emit('topic:active',    topics.summary(activeTopic));
  });

  // ── Hashtag suggestion approve / reject ──────────────────────────────────
  socket.on('hashtag:approve', ({ tag, group }) => {
    if (!activeTopic) return;
    approveSuggestion(tag);
    activeTopic = addHashtagToGroup(activeTopic.id, tag, group || 'a');
    io.emit('hashtags:update',      getHashtags());
    io.emit('hashtags:suggestions', getSuggestions());
    io.emit('topic:active',         topics.summary(activeTopic));
  });

  socket.on('hashtag:reject', ({ tag }) => {
    trackRemoval(tag);
    io.emit('hashtags:suggestions', getSuggestions());
  });

  socket.on('scrape:now', () => {
    const COOLDOWN = 90_000; // 90 seconds
    const elapsed  = Date.now() - lastManualScrape;
    if (elapsed < COOLDOWN) {
      socket.emit('scrape:cooldown', Math.ceil((COOLDOWN - elapsed) / 1000));
      return;
    }
    if (scrapeRunning) {
      socket.emit('scrape:cooldown', 0); // already running, just wait
      return;
    }
    lastManualScrape = Date.now();
    socket.emit('scrape:started');
    runScrape();
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Dashboard listening on :${PORT}`);
  // Load persisted post cache
  loadCache();
  // Auto-resume most recent topic
  const existing = topics.list();
  if (existing.length > 0) {
    setActiveTopic(topics.load(existing[0].id));
    // Remove any cached posts that don't match the active topic's hashtags
    const tagSet = new Set(getHashtags());
    let pruned = 0;
    for (const [id, post] of postCache.entries()) {
      if (!(post.hashtags || []).some(t => tagSet.has(t))) { postCache.delete(id); pruned++; }
    }
    if (pruned > 0) console.log(`[Cache] Pruned ${pruned} posts not matching active topic`);
    setTimeout(runScrape, 2000);
  }
});
