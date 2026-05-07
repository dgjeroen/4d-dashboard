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
let igDebugInfo   = {
  finalUrl: '',
  pageTitle: '',
  domPostLinks: 0,
  bodySnippet: '',
  authWall: false,
};

function getIgBlocked()  { return igBlocked; }
function setIgBlocked(v) { igBlocked = v; }
function getIgDebugInfo() { return igDebugInfo; }

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

// ─── Instagram (Playwright browser) ──────────────────────────────────────────

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Gedeelde browser instantie voor Instagram (wordt hergebruikt tussen hashtags)
let igBrowser = null;
let igBrowserUses = 0;

async function getIgBrowser() {
  if (igBrowser?.isConnected()) return igBrowser;
  const fs2 = require('fs');
  const candidates = [
    '/ms-playwright/chromium-1117/chrome-linux/chrome',
    '/ms-playwright/chromium-1161/chrome-linux/chrome',
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  ].filter(Boolean);
  const executablePath = candidates.find(p => fs2.existsSync(p));
  if (!executablePath) throw new Error('Chromium niet gevonden');
  igBrowser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  igBrowser.on('disconnected', () => { igBrowser = null; igBrowserUses = 0; });
  igBrowserUses = 0;
  return igBrowser;
}

function extractPostsFromIgData(data) {
  const posts = [];

  function parseSections(sections) {
    for (const section of (sections || [])) {
      for (const item of (section.layout_content?.medias || [])) {
        if (item?.media) posts.push(parseInstagramMedia(item.media));
        else if (item?.pk) posts.push(parseInstagramMedia(item));
      }
    }
  }

  parseSections(data?.data?.top?.sections);
  parseSections(data?.data?.recent?.sections);
  parseSections(data.sections);
  parseSections(data.media_grid?.sections);

  for (const edge of (data?.data?.hashtag?.edge_hashtag_to_media?.edges || [])) {
    if (edge?.node) posts.push(parseInstagramMedia(edge.node));
  }
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

async function extractPostsFromIgDom(page) {
  try {
    return await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const anchors = Array.from(document.querySelectorAll('a[href*="/p/"]'));

      for (const anchor of anchors) {
        const href = anchor.getAttribute('href') || '';
        const match = href.match(/\/p\/([^/?#]+)/);
        if (!match) continue;
        const shortcode = match[1];
        if (seen.has(shortcode)) continue;
        seen.add(shortcode);

        const img = anchor.querySelector('img');
        const timeEl = anchor.querySelector('time') || anchor.parentElement?.querySelector('time');
        const caption = img?.getAttribute('alt') || '';
        const dateTime = timeEl?.getAttribute('datetime');
        const timestamp = dateTime ? new Date(dateTime).getTime() : Date.now();

        results.push({
          id: `ig_dom_${shortcode}`,
          platform: 'instagram',
          author: 'unknown',
          authorUrl: 'https://www.instagram.com/',
          caption,
          imageUrl: img?.getAttribute('src') || '',
          postUrl: href.startsWith('http') ? href : `https://www.instagram.com${href}`,
          likes: 0,
          timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
          hashtags: (caption.match(/#[\w\u00C0-\u024F]+/g) || []).map(h => h.slice(1).toLowerCase()),
        });
      }

      return results;
    });
  } catch {
    return [];
  }
}

async function humanScroll(page) {
  // Scroll in stappen naar beneden, met kleine variaties
  const steps = rand(3, 6);
  for (let i = 0; i < steps; i++) {
    await page.evaluate((dy) => window.scrollBy(0, dy), rand(200, 450));
    await page.waitForTimeout(rand(400, 1200));
  }
}

async function looksLikeInstagramAuthWall(page) {
  const url = page.url();
  if (url.includes('/challenge/') || url.includes('/accounts/login')) return true;

  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const hasLoginInput = Boolean(
        document.querySelector('input[name="username"], input[name="password"]')
      );
      const authHints = [
        'log in',
        'login',
        'inloggen',
        'meld je aan',
        'sign up',
        'sign in',
        'continue as',
        'continueer als',
      ];
      const hasAuthText = authHints.some(hint => text.includes(hint));
      const loginLinks = Array.from(document.querySelectorAll('a[href], button'))
        .some(el => ((el.getAttribute('href') || '') + ' ' + (el.textContent || '')).toLowerCase().includes('login')
          || ((el.getAttribute('href') || '') + ' ' + (el.textContent || '')).toLowerCase().includes('log in')
          || ((el.getAttribute('href') || '') + ' ' + (el.textContent || '')).toLowerCase().includes('inloggen'));
      return hasLoginInput || (hasAuthText && loginLinks);
    });
  } catch {
    return false;
  }
}

async function inspectInstagramPage(page) {
  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        pageTitle: document.title || '',
        domPostLinks: document.querySelectorAll('a[href*="/p/"]').length,
        bodySnippet: text.slice(0, 240),
      };
    });
  } catch {
    return { pageTitle: '', domPostLinks: 0, bodySnippet: '' };
  }
}

async function scrapeInstagram(hashtag, igCtx) {
  if (igBlocked) {
    console.log(`[Instagram] Overgeslagen (geblokkeerd) – #${hashtag}`);
    return [];
  }

  const tagUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag)}/`;
  const posts = [];

  igDebugInfo = {
    ...igDebugInfo,
    finalUrl: tagUrl,
    pageTitle: '',
    domPostLinks: 0,
    bodySnippet: '',
    authWall: false,
  };

  // Hergebruik de meegegeven context (gedeeld over hashtags)
  const page = await igCtx.newPage();

  page.on('response', async (res) => {
    const url = res.url();
    if (!res.ok() || !url.includes('instagram.com')) return;
    const isRelevant =
      url.includes('/api/v1/tags/') ||
      url.includes('graphql/query') ||
      url.includes('/api/graphql') ||
      url.includes('fbsearch') ||
      url.includes('/api/v1/search/') ||
      url.includes('web/search/');
    if (!isRelevant) return;
    try {
      const data  = await res.json();
      const before = posts.length;
      extractPostsFromIgData(data).forEach(p => posts.push(p));
      const added = posts.length - before;
      if (added > 0) console.log(`[Instagram] +${added} posts via ${url.slice(26, 90)}`);
    } catch { /* non-JSON */ }
  });

  try {
    await page.goto(tagUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    const finalUrl = page.url();
    console.log(`[Instagram] #${hashtag} → ${finalUrl.slice(0, 80)}`);

    let pageInfo = await inspectInstagramPage(page);
    igDebugInfo = {
      ...igDebugInfo,
      finalUrl,
      pageTitle: pageInfo.pageTitle,
      domPostLinks: pageInfo.domPostLinks,
      bodySnippet: pageInfo.bodySnippet,
      authWall: false,
    };

    if (await looksLikeInstagramAuthWall(page)) {
      igDebugInfo.authWall = true;
      console.warn(`[Instagram] Geblokkeerd – sessie NIET overschreven`);
      igBlocked = true;
      return posts;
    }

    // Menselijk scrollgedrag
    await page.waitForTimeout(rand(1500, 3000));
    await humanScroll(page);
    await page.waitForTimeout(rand(1000, 2500));

    pageInfo = await inspectInstagramPage(page);
    igDebugInfo = {
      ...igDebugInfo,
      finalUrl: page.url(),
      pageTitle: pageInfo.pageTitle,
      domPostLinks: pageInfo.domPostLinks,
      bodySnippet: pageInfo.bodySnippet,
    };

    if (posts.length === 0) {
      const domPosts = await extractPostsFromIgDom(page);
      if (domPosts.length > 0) {
        posts.push(...domPosts);
        console.log(`[Instagram] +${domPosts.length} posts via DOM fallback`);
      }
    }

    if (posts.length === 0 && await looksLikeInstagramAuthWall(page)) {
      igDebugInfo.authWall = true;
      console.warn(`[Instagram] Login-wall gedetecteerd zonder API-responses – sessie ongeldig`);
      igBlocked = true;
      return posts;
    }

    // Opslaan alleen als niet geblokkeerd
    await saveSession(igCtx, 'instagram');
  } catch (err) {
    let pageTitle = '';
    let bodySnippet = '';
    let finalUrl = tagUrl;
    try { finalUrl = page.url() || tagUrl; } catch {}
    try { pageTitle = await page.title(); } catch {}
    try {
      bodySnippet = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240));
    } catch {}
    igDebugInfo = {
      ...igDebugInfo,
      finalUrl,
      pageTitle,
      domPostLinks: 0,
      bodySnippet: bodySnippet || err.message,
    };
    console.warn(`[Instagram] #${hashtag}: ${err.message}`);
  } finally {
    await page.close();
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

let bskyToken     = null;
let bskyTokenExp  = 0;

function bskyRequest(urlStr, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Geen JSON: ${body.slice(0, 60)}`)); }
      });
    }).on('error', reject);
  });
}

function bskyPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let resp = '';
      res.on('data', d => resp += d);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${resp.slice(0, 80)}`)); return; }
        try { resolve(JSON.parse(resp)); }
        catch (e) { reject(new Error(`Geen JSON`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getBskyToken() {
  if (bskyToken && Date.now() < bskyTokenExp) return bskyToken;
  const id  = process.env.BSKY_IDENTIFIER;
  const pwd = process.env.BSKY_APP_PASSWORD;
  if (!id || !pwd) return null;
  try {
    const res = await bskyPost('bsky.social', '/xrpc/com.atproto.server.createSession',
      { identifier: id, password: pwd });
    bskyToken    = res.accessJwt;
    bskyTokenExp = Date.now() + 90 * 60 * 1000; // 90 min
    console.log('[Bluesky] Ingelogd als', res.handle);
    return bskyToken;
  } catch (err) {
    console.warn('[Bluesky] Login mislukt:', err.message);
    return null;
  }
}

function parseBskyPost(post) {
  const author  = post.author || {};
  const record  = post.record || {};
  const embed   = post.embed  || {};
  const imageUrl =
    // video embed: thumbnail is direct een string URL
    (typeof embed?.thumbnail === 'string' ? embed.thumbnail : null) ||
    embed?.thumbnail?.fullsize ||
    embed?.thumbnail?.thumb ||
    // images embed
    embed?.images?.[0]?.fullsize ||
    embed?.images?.[0]?.thumb ||
    // nested media (recordWithMedia)
    embed?.media?.images?.[0]?.fullsize ||
    embed?.media?.images?.[0]?.thumb ||
    // video in recordWithMedia
    (typeof embed?.media?.thumbnail === 'string' ? embed.media.thumbnail : null) ||
    embed?.media?.thumbnail?.fullsize ||
    embed?.media?.thumbnail?.thumb ||
    // external link preview
    embed?.external?.thumb?.fullsize ||
    embed?.external?.thumb ||
    // record embed with thumbnail
    embed?.record?.embeds?.[0]?.thumbnail?.fullsize ||
    embed?.record?.embeds?.[0]?.images?.[0]?.fullsize ||
    '';
  const uri  = post.uri || '';
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

async function scrapeBluesky(queryStr, label) {
  const posts = [];
  try {
    const token = await getBskyToken();
    if (!token) {
      console.warn('[Bluesky] Geen credentials – stel BSKY_IDENTIFIER en BSKY_APP_PASSWORD in');
      return posts;
    }
    const q    = encodeURIComponent(queryStr);
    const url  = `https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${q}&limit=25&sort=latest`;
    const data = await bskyRequest(url, token);
    for (const post of (data.posts || [])) {
      posts.push(parseBskyPost(post));
    }
    console.log(`[Bluesky] ${label} → ${posts.length} posts`);
  } catch (err) {
    console.warn(`[Bluesky] ${label}: ${err.message}`);
  }
  return posts;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// ─── Public API ───────────────────────────────────────────────────────────────

function dedup(results) {
  const seen = new Set();
  return results.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

function stampTag(posts, tagLower) {
  // Instagram hashtag pages only show posts that genuinely belong to that tag,
  // but the API sometimes returns an empty caption — ensure the tag is present
  // so the server-side activeTagSet filter doesn't wrongly discard the post.
  // For TikTok this function is intentionally NOT called (TikTok shows
  // algorithmically related posts that may not actually carry the hashtag).
  posts.forEach(p => { if (!p.hashtags.includes(tagLower)) p.hashtags.push(tagLower); });
}

async function getInstagramPosts(hashtags) {
  const results = [];
  if (igBlocked) return results;

  let igCtx = null;
  try {
    const browser = await getIgBrowser();
    igCtx = await browser.newContext({
      storageState: fs.existsSync(`${SESSIONS_DIR}/instagram.json`) ? `${SESSIONS_DIR}/instagram.json` : undefined,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport:  { width: 1280, height: 900 },
      locale:    'nl-NL',
      timezoneId:'Europe/Amsterdam',
    });
    igBrowserUses++;
  } catch (err) {
    console.warn('[Instagram] Browser starten mislukt:', err.message);
    return results;
  }

  for (let i = 0; i < hashtags.length; i++) {
    const tag = hashtags[i];
    if (igBlocked) break;

    // Elke 3-4 hashtags: kort bezoek aan Instagram-homepage
    if (i > 0 && i % rand(3, 4) === 0) {
      console.log('[Instagram] Tussenstop: homepage bezoek');
      const homePage = await igCtx.newPage();
      try {
        await homePage.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await homePage.waitForTimeout(rand(3000, 7000));
        await humanScroll(homePage);
        await homePage.waitForTimeout(rand(1000, 3000));
      } catch { /* non-fatal */ } finally { await homePage.close(); }
    }

    const posts = await scrapeInstagram(tag, igCtx);
    stampTag(posts, tag.toLowerCase());
    results.push(...posts);

    if (i < hashtags.length - 1 && !igBlocked) {
      const pause = rand(8_000, 20_000);
      console.log(`[Instagram] Pauze ${(pause/1000).toFixed(0)}s…`);
      await new Promise(r => setTimeout(r, pause));
    }
  }

  try { await igCtx.close(); } catch {}
  return dedup(results);
}

async function getTikTokPosts(hashtags) {
  const results = [];
  for (const tag of hashtags) {
    const posts = await scrapeTikTok(tag);
    // stampTag intentionally omitted: TikTok shows algorithmically related
    // posts that may not carry the hashtag in their caption. Only posts that
    // genuinely contain the hashtag are allowed through.
    results.push(...posts);
    await new Promise(r => setTimeout(r, 1_500));
  }
  return dedup(results);
}

async function getBskyPosts(hashtags, combos = []) {
  const results = [];
  for (const tag of hashtags) {
    const posts = await scrapeBluesky(`#${tag}`, `#${tag}`);
    stampTag(posts, tag.toLowerCase());
    results.push(...posts);
  }
  // Zoek ook op combinaties (levert posts op die alleen door de AND te vinden zijn)
  for (const [a, b] of combos) {
    const posts = await scrapeBluesky(`#${a} #${b}`, `#${a}+#${b}`);
    results.push(...posts);
  }
  return dedup(results);
}

// Behoud voor backwards compat
async function getAllPosts(hashtags) {
  const [ig, tt, bsky] = await Promise.allSettled([
    getInstagramPosts(hashtags),
    getTikTokPosts(hashtags),
    getBskyPosts(hashtags),
  ]);
  return dedup([
    ...(ig.status   === 'fulfilled' ? ig.value   : []),
    ...(tt.status   === 'fulfilled' ? tt.value   : []),
    ...(bsky.status === 'fulfilled' ? bsky.value : []),
  ]);
}

async function reAuthInstagram() {
  if (igBrowser) {
    try { await igBrowser.close(); } catch {}
    igBrowser = null;
  }
  igBlocked = false;
  console.log('[Instagram] Browser herstart na sessie-update');
}

module.exports = { getAllPosts, getInstagramPosts, getTikTokPosts, getBskyPosts, getIgBlocked, setIgBlocked, reAuthInstagram, getIgDebugInfo };
