'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cron       = require('node-cron');
const path       = require('path');

const { getAllPosts }          = require('./scraper');
const { getHashtags, updateHashtags } = require('./hashtags');

const app    = express();
const server = http.createServer(app);

// BASE_PATH lets the app run at /4d (nginx sub-path) or / (subdomain).
// Set via environment: BASE_PATH=/4d
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const io = new Server(server, {
  path: `${BASE}/socket.io`,
});

const fs = require('fs');

if (BASE) {
  app.use(BASE, express.static(path.join(__dirname, 'public')));

  // Inject __BASE into index.html so the frontend can build the socket.io path
  app.get(BASE, (req, res) => {
    const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8')
      .replace('</head>', `<script>window.__BASE="${BASE}";</script></head>`);
    res.send(html);
  });
  app.get(`${BASE}/`, (req, res) => res.redirect(BASE));
} else {
  app.use(express.static(path.join(__dirname, 'public')));
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
const postCache = new Map(); // id → post
let   scrapeRunning = false;

function broadcastAll() {
  const posts = Array.from(postCache.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 300);

  io.emit('posts:update',    posts);
  io.emit('hashtags:update', getHashtags());
}

// ─── Scrape cycle ─────────────────────────────────────────────────────────────
async function runScrape() {
  if (scrapeRunning) return;
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

    // Trim to 500 most recent
    if (postCache.size > 500) {
      const sorted = Array.from(postCache.entries())
        .sort((a, b) => b[1].timestamp - a[1].timestamp);
      postCache.clear();
      sorted.slice(0, 500).forEach(([k, v]) => postCache.set(k, v));
    }

    console.log(
      `[Scrape] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      ` – +${added} new, total: ${postCache.size}`
    );

    broadcastAll();
  } catch (err) {
    console.error('[Scrape] Error:', err.message);
  } finally {
    scrapeRunning = false;
  }
}

// Every 3 minutes
cron.schedule('*/3 * * * *', runScrape);

// Hourly hashtag discovery
cron.schedule('0 * * * *', () => {
  updateHashtags(Array.from(postCache.values()));
  broadcastAll();
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  const posts = Array.from(postCache.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 300);

  socket.emit('posts:update',    posts);
  socket.emit('hashtags:update', getHashtags());

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Dashboard listening on :${PORT}`);
  setTimeout(runScrape, 2000); // initial scrape
});
