'use strict';

/**
 * Scraper – Instagram & TikTok via Playwright network interception.
 *
 * Strategy: launch a real Chromium browser (stealth mode) and intercept
 * the internal API calls each platform makes when loading a hashtag page.
 * This avoids constructing encrypted/signed request params manually and
 * is far more resilient to anti-bot changes.
 *
 * Sessions are persisted to ./sessions/<platform>.json so cookies survive
 * container restarts. On first run the browser opens as a guest; if
 * Instagram/TikTok require a login you can copy a valid session JSON there.
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs            = require('fs');

chromium.use(StealthPlugin());

const SESSIONS_DIR = './sessions';
const TIMEOUT      = 30_000;

let sharedBrowser = null;
let igBlocked     = false;

function getIgBlocked()  { return igBlocked; }
function setIgBlocked(v) { igBlocked = v; }

// ─── Browser / context management ────────────────────────────────────────────

async function getBrowser() {
  if (sharedBrowser?.isConnected()) return sharedBrowser;

  // Playwright-extra needs the executablePath when running inside Docker
  const fs2 = require('fs');
  const candidates = [
    '/ms-playwright/chromium-1117/chrome-linux/chrome',
    '/ms-playwright/chromium-1161/chrome-linux/chrome',
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  ].filter(Boolean);
  const executablePath = candidates.find(p => fs2.existsSync(p));
  if (!executablePath) throw new Error('Chromium not found. Candidates: ' + candidates.join(', '));
  console.log(`[Browser] Using Chromium at: ${executablePath}`);

  sharedBrowser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  sharedBrowser.on('disconnected', () => { sharedBrowser = null; });
  return sharedBrowser;
}

async function createContext(platform) {
  const browser     = await getBrowser();
  const sessionFile = `${SESSIONS_DIR}/${platform}.json`;
  return browser.newContext({
    storageState: fs.existsSync(sessionFile) ? sessionFile : undefined,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    viewport:   { width: 1280, height: 900 },
    locale:     'nl-NL',
    timezoneId: 'Europe/Amsterdam',
  });
}

async function saveSession(ctx, platform) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    await ctx.storageState({ path: `${SESSIONS_DIR}/${platform}.json` });
  } catch { /* non-fatal */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractHashtags(text = '') {
  return (text.match(/#[\w\u00C0-\u024F]+/g) || [])
    .map(h => h.slice(1).toLowerCase());
}

// ─── Instagram ────────────────────────────────────────────────────────────────

function parseInstagramMedia(media) {
  const user = media.user || {};
  const code = media.code || media.shortcode || '';
  return {
    id:        `ig_${media.pk || media.id}`,
    platform:  'instagram',
    author:    user.username || 'unknown',
    authorUrl: `https://www.instagram.com/${user.username}/`,
    caption:   media.caption?.text || '',
    imageUrl:
      media.image_versions2?.candidates?.[0]?.url ||
      media.thumbnail_src ||
      media.display_url ||
      '',
    postUrl:   `https://www.instagram.com/p/${code}/`,
    likes:     media.like_count || media.edge_liked_by?.count || 0,
    timestamp: (media.taken_at || media.taken_at_timestamp || 0) * 1000,
    hashtags:  extractHashtags(media.caption?.text),
  };
}

// ─── Instagram (direct HTTP) ──────────────────────────────────────────────────

function igGet(urlStr, cookieStr, csrfToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const options = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers:  {
        'Accept':           '*/*',
        'Accept-Language':  'nl-NL,nl;q=0.9',
        'Cookie':           cookieStr,
        'Referer':          'https://www.instagram.com/',
        'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'X-CSRFToken':      csrfToken,
        'X-IG-App-ID':      '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
      },
    };
    https.get(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          igBlocked = true;
          reject(new Error(`HTTP ${res.statusCode} – geblokkeerd`));
          return;
        }
        if (res.statusCode === 302 || res.statusCode === 301) {
          const loc = res.headers.location || '';
          if (loc.includes('/challenge/') || loc.includes('/accounts/login')) {
            igBlocked = true;
            reject(new Error(`Redirect naar ${loc} – geblokkeerd`));
          } else {
            reject(new Error(`Redirect naar ${loc}`));
          }
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error(`Geen JSON: ${body.slice(0, 80)}`)); }
      });
    }).on('error', reject);
  });
}

function extractPostsFromIgData(data) {
  const posts = [];

  // Helper: parse sections array
  function parseSections(sections) {
    for (const section of (sections || [])) {
      for (const item of (section.layout_content?.medias || [])) {
        if (item?.media) posts.push(parseInstagramMedia(item.media));
        else if (item?.pk)  posts.push(parseInstagramMedia(item));
      }
    }
  }

  // v1 tags/web_info: data.data.top.sections + data.data.recent.sections
  parseSections(data?.data?.top?.sections);
  parseSections(data?.data?.recent?.sections);

  // sections at top level (v1 tags API)
  parseSections(data.sections);

  // media_grid.sections
  parseSections(data.media_grid?.sections);

  // data.hashtag GraphQL edges
  for (const edge of (data?.data?.hashtag?.edge_hashtag_to_media?.edges || [])) {
    if (edge?.node) posts.push(parseInstagramMedia(edge.node));
  }

  // fetch__XDTTagInfo
  const tagInfo = data?.data?.fetch__XDTTagInfo;
  if (tagInfo) {
    for (const edge of (tagInfo.edge_hashtag_to_media?.edges || [])) {
      if (edge?.node) posts.push(parseInstagramMedia(edge.node));
    }
    for (const edge of (tagInfo.edge_hashtag_to_top_posts?.edges || [])) {
      if (edge?.node) posts.push(parseInstagramMedia(edge.node));
    }
    parseSections(tagInfo.media_grid?.sections);
  }

  // xdt_fbsearch__top_serp_graphql
  const topSerp = data?.data?.xdt_fbsearch__top_serp_graphql;
  if (topSerp) {
    for (const edge of (topSerp.edges || [])) {
      for (const item of (edge?.node?.items || [])) {
        if (item?.pk) posts.push(parseInstagramMedia(item));
      }
      parseSections(edge?.node?.media_grid?.sections);
    }
  }

  return posts;
}

async function scrapeInstagram(hashtag) {
  if (igBlocked) {
    console.log(`[Instagram] Overgeslagen (geblokkeerd) – #${hashtag}`);
    return [];
  }

  const sessionFile = `${SESSIONS_DIR}/instagram.json`;
  if (!fs.existsSync(sessionFile)) {
    console.warn(`[Instagram] Geen sessiebestand – upload cookies via het dashboard`);
    igBlocked = true;
    return [];
  }

  let cookieStr, csrfToken;
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const igCookies = (session.cookies || []).filter(c => c.domain?.includes('instagram.com'));
    cookieStr = igCookies.map(c => `${c.name}=${c.value}`).join('; ');
    csrfToken = igCookies.find(c => c.name === 'csrftoken')?.value || '';
  } catch (err) {
    console.warn(`[Instagram] Sessie lezen mislukt: ${err.message}`);
    return [];
  }

  const posts = [];
  const endpoints = [
    `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(hashtag)}`,
    `https://i.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(hashtag)}`,
  ];

  for (const url of endpoints) {
    try {
      const data = await igGet(url, cookieStr, csrfToken);
      const found = extractPostsFromIgData(data);
      posts.push(...found);
      console.log(`[Instagram] #${hashtag} → ${found.length} posts via ${url.slice(30, 90)}`);
      if (found.length > 0) break;
    } catch (err) {
      console.warn(`[Instagram] #${hashtag} ${url.slice(30, 70)}: ${err.message}`);
      if (igBlocked) break;
    }
  }

  return posts;
}

// ─── TikTok ───────────────────────────────────────────────────────────────────

function parseTikTokItem(item) {
  const author = item.author || {};
  const video  = item.video  || {};
  const id     = item.id || item.aweme_id || '';
  return {
    id:        `tt_${id}`,
    platform:  'tiktok',
    author:    author.uniqueId || author.nickname || 'unknown',
    authorUrl: `https://www.tiktok.com/@${author.uniqueId || ''}`,
    caption:   item.desc || '',
    imageUrl:  video.cover || video.originCover || video.dynamicCover || '',
    postUrl:   `https://www.tiktok.com/@${author.uniqueId}/video/${id}`,
    likes:     item.stats?.diggCount || item.statistics?.digg_count || 0,
    timestamp: (item.createTime || item.create_time || 0) * 1000,
    hashtags:  extractHashtags(item.desc),
  };
}

async function scrapeTikTok(hashtag) {
  const ctx  = await createContext('tiktok');
  const page = await ctx.newPage();
  const posts = [];

  page.on('response', async (res) => {
    if (!res.ok()) return;
    if (!res.url().includes('tiktok.com/api/')) return;
    try {
      const data = await res.json();
      for (const item of (data.itemList || data.aweme_list || [])) {
        posts.push(parseTikTokItem(item));
      }
    } catch { /* ignore */ }
  });

  try {
    await page.goto(
      `https://www.tiktok.com/tag/${encodeURIComponent(hashtag)}`,
      { waitUntil: 'domcontentloaded', timeout: TIMEOUT }
    );
    await page.waitForTimeout(5_000);
    // Scroll to trigger additional API calls
    await page.evaluate(() => window.scrollTo(0, 800));
    await page.waitForTimeout(2_000);
    await saveSession(ctx, 'tiktok');
  } catch (err) {
    console.warn(`[TikTok] #${hashtag}: ${err.message}`);
  } finally {
    await page.close();
    await ctx.close();
  }

  return posts;
}

// ─── Bluesky ─────────────────────────────────────────────────────────────────

const https = require('https');

function bskyGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Geen JSON (response begint met: ${body.slice(0, 60)})`)); }
      });
    }).on('error', reject);
  });
}

function parseBskyPost(post) {
  const author  = post.author || {};
  const record  = post.record || {};
  const embed   = post.embed  || {};
  const imageUrl =
    embed?.thumbnail?.fullsize ||
    embed?.images?.[0]?.fullsize ||
    embed?.media?.images?.[0]?.fullsize ||
    '';
  const uri = post.uri || '';
  // at://did:plc:xxx/app.bsky.feed.post/rkey → https://bsky.app/profile/handle/post/rkey
  const rkey = uri.split('/').pop();
  return {
    id:        `bsky_${post.cid || rkey}`,
    platform:  'bluesky',
    author:    author.handle || 'unknown',
    authorUrl: `https://bsky.app/profile/${author.handle}`,
    caption:   record.text || '',
    imageUrl,
    postUrl:   `https://bsky.app/profile/${author.handle}/post/${rkey}`,
    likes:     post.likeCount || 0,
    timestamp: new Date(record.createdAt || 0).getTime(),
    hashtags:  extractHashtags(record.text),
  };
}

async function scrapeBluesky(hashtag) {
  const posts = [];
  try {
    const q   = encodeURIComponent(`#${hashtag}`);
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${q}&limit=25&sort=latest`;
    const data = await bskyGet(url);
    for (const post of (data.posts || [])) {
      posts.push(parseBskyPost(post));
    }
    console.log(`[Bluesky] #${hashtag} → ${posts.length} posts`);
  } catch (err) {
    console.warn(`[Bluesky] #${hashtag}: ${err.message}`);
  }
  return posts;
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function getAllPosts(hashtags) {
  const results = [];

  for (const tag of hashtags) {
    const tagLower = tag.toLowerCase();
    const [ig, tt, bsky] = await Promise.allSettled([
      scrapeInstagram(tag),
      scrapeTikTok(tag),
      scrapeBluesky(tag),
    ]);
    if (ig.status === 'fulfilled') {
      ig.value.forEach(p => { if (!p.hashtags.includes(tagLower)) p.hashtags.push(tagLower); });
      results.push(...ig.value);
    }
    if (tt.status === 'fulfilled') {
      tt.value.forEach(p => { if (!p.hashtags.includes(tagLower)) p.hashtags.push(tagLower); });
      results.push(...tt.value);
    }
    if (bsky.status === 'fulfilled') {
      bsky.value.forEach(p => { if (!p.hashtags.includes(tagLower)) p.hashtags.push(tagLower); });
      results.push(...bsky.value);
    }

    // Brief pause between hashtags to reduce rate-limit risk
    await new Promise(r => setTimeout(r, 1_500));
  }

  // Deduplicate by id
  const seen = new Set();
  return results.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

async function reAuthInstagram() {
  if (sharedBrowser) {
    try { await sharedBrowser.close(); } catch {}
    sharedBrowser = null;
  }
  igBlocked = false;
  console.log('[Instagram] Browser herstart na sessie-update');
}

module.exports = { getAllPosts, getIgBlocked, setIgBlocked, reAuthInstagram };
