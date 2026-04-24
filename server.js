'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cron       = require('node-cron');
const path       = require('path');
const fs         = require('fs');

const { getAllPosts }                       = require('./scraper');
const { getHashtags, setHashtags, updateHashtags } = require('./hashtags');
const topics                               = require('./topics');

const app    = express();
const server = http.createServer(app);

const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const io = new Server(server, {
  path: `${BASE}/socket.io`,
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
const postCache    = new Map();
let   scrapeRunning = false;
let   activeTopic  = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setActiveTopic(topic) {
  activeTopic = topic;
  setHashtags(topic.hashtags);
  console.log(`[Topic] Active: "${topic.name}" (${topic.hashtags.length} hashtags)`);
}

function postsWithStatus() {
  const reviewed = activeTopic?.reviewedIds || {};
  return Array.from(postCache.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 300)
    .map(p => ({ ...p, reviewStatus: reviewed[p.id] || null }));
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
function broadcastAll() {
  io.emit('posts:update',    postsWithStatus());
  io.emit('hashtags:update', getHashtags());
  if (activeTopic) io.emit('topic:active', topics.summary(activeTopic));
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
    let added = 0;
    for (const post of newPosts) {
      if (!postCache.has(post.id)) added++;
      postCache.set(post.id, post);
    }
    if (postCache.size > 500) {
      const sorted = Array.from(postCache.entries())
        .sort((a, b) => b[1].timestamp - a[1].timestamp);
      postCache.clear();
      sorted.slice(0, 500).forEach(([k, v]) => postCache.set(k, v));
    }
    console.log(`[Scrape] Done in ${((Date.now()-t0)/1000).toFixed(1)}s – +${added} new, total: ${postCache.size}`);
    broadcastAll();
  } catch (err) {
    console.error('[Scrape] Error:', err.message);
  } finally {
    scrapeRunning = false;
  }
}

cron.schedule('*/3 * * * *', runScrape);

cron.schedule('0 * * * *', () => {
  if (!activeTopic) return;
  const updated = updateHashtags(Array.from(postCache.values()));
  activeTopic = topics.updateHashtags(activeTopic.id, updated);
  broadcastAll();
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Always send topic list so launcher can populate
  socket.emit('topics:list', topics.list().map(topics.summary));

  // If a topic is already active, send current state immediately
  if (activeTopic) {
    socket.emit('posts:update',    postsWithStatus());
    socket.emit('hashtags:update', getHashtags());
    socket.emit('topic:active',    topics.summary(activeTopic));
  }

  // ── Create new topic ───────────────────────────────────────────────────────
  socket.on('topic:create', ({ name, hashtags }, cb) => {
    const topic = topics.create(name, hashtags);
    postCache.clear();
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
    if (!sameId) postCache.clear();
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

  // ── Update hashtags for active topic ──────────────────────────────────────
  socket.on('topic:updateHashtags', ({ hashtags }) => {
    if (!activeTopic) return;
    activeTopic = topics.updateHashtags(activeTopic.id, hashtags);
    setHashtags(hashtags);
    io.emit('hashtags:update', getHashtags());
    io.emit('topic:active',    topics.summary(activeTopic));
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Dashboard listening on :${PORT}`);
  // Auto-resume most recent topic
  const existing = topics.list();
  if (existing.length > 0) {
    setActiveTopic(topics.load(existing[0].id));
    setTimeout(runScrape, 2000);
  }
});
