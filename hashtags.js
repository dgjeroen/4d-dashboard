'use strict';

/**
 * Hashtag manager – hashtags come from the active topic, not a hardcoded seed.
 * setHashtags() is called by the server whenever a topic is activated.
 * updateHashtags() discovers contextually relevant co-occurring tags.
 *
 * A tag is only auto-added when it:
 *   1. Is not on the generic-spam blocklist
 *   2. Was not manually removed by the user this session
 *   3. Co-occurs with ≥3 posts AND ≥2 *different* seed tags (context check)
 */

const BLOCKLIST = new Set([
  'fyp','foryou','foryoupage','fy','fypシ','fypシ゚viral',
  'viral','trending','trend','goviral',
  'reels','reelsinstagram','reel','reelvideo',
  'explorepage','explore','instagood','instagram','tiktok',
  'follow','followme','followforfollow','like','likes','likeforlikes',
  'video','photo','content','parati','xyzbca','xybca','xyzcba','xyzabc',
  'shorts','youtube','fun','funny','meme','memes','edit','edits',
  'love','life','happy','cool','wow','amazing','cute',
]);

let activeSet  = new Set();
let removedSet = new Set(); // manually removed – never auto-rediscover

function setHashtags(tags) {
  activeSet  = new Set(tags);
  removedSet = new Set(); // fresh topic → reset removal history
}

function getHashtags() {
  return Array.from(activeSet);
}

/** Called by server when the user manually removes a hashtag. */
function trackRemoval(tag) {
  removedSet.add(tag);
}

function updateHashtags(posts) {
  if (activeSet.size === 0) return getHashtags();

  const seedSet = new Set(activeSet);
  const coOcc   = new Map(); // tag → { count, seeds: Set<string> }

  for (const post of posts) {
    const tags = post.hashtags || [];
    const seedsInPost = tags.filter(t => seedSet.has(t));
    if (seedsInPost.length === 0) continue;

    for (const tag of tags) {
      if (seedSet.has(tag))    continue; // already tracked
      if (tag.length < 4)      continue; // too short
      if (BLOCKLIST.has(tag))  continue; // generic spam
      if (removedSet.has(tag)) continue; // manually removed

      if (!coOcc.has(tag)) coOcc.set(tag, { count: 0, seeds: new Set() });
      const e = coOcc.get(tag);
      e.count++;
      seedsInPost.forEach(s => e.seeds.add(s));
    }
  }

  for (const [tag, { count, seeds }] of coOcc.entries()) {
    // Must appear in ≥3 posts AND co-occur with ≥2 different seed tags (context filter)
    if (count >= 3 && seeds.size >= 2 && !activeSet.has(tag)) {
      console.log(`[Hashtags] New: #${tag} (posts:${count}, seed-variety:${seeds.size})`);
      activeSet.add(tag);
    }
  }

  // Cap at 30 – keep highest co-occurrence count
  if (activeSet.size > 30) {
    const sorted = Array.from(activeSet)
      .sort((a, b) => (coOcc.get(b)?.count || 0) - (coOcc.get(a)?.count || 0));
    activeSet = new Set(sorted.slice(0, 30));
  }

  console.log(`[Hashtags] Active (${activeSet.size}): ${Array.from(activeSet).join(', ')}`);
  return getHashtags();
}

module.exports = { getHashtags, setHashtags, updateHashtags, trackRemoval };
