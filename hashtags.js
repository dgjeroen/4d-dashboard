'use strict';

/**
 * Hashtag manager – hashtags come from the active topic, not a hardcoded seed.
 * setHashtags() is called by the server whenever a topic is activated.
 * getSuggestions() returns candidate tags for the user to approve or reject.
 *
 * A tag is suggested when it:
 *   1. Is not on the generic-spam blocklist
 *   2. Was not manually removed or rejected by the user
 *   3. Co-occurs with ≥2 posts that contain at least one seed tag
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

let activeSet    = new Set();
let removedSet   = new Set(); // manually removed or rejected – never suggest again
let suggestions  = new Map(); // tag → { count, seeds: Set<string> }

function setHashtags(tags) {
  activeSet   = new Set(tags);
  removedSet  = new Set();
  suggestions = new Map();
}

function getHashtags() {
  return Array.from(activeSet);
}

function getSuggestions() {
  return Array.from(suggestions.entries())
    .filter(([tag]) => !activeSet.has(tag) && !removedSet.has(tag))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([tag, { count }]) => ({ tag, count }));
}

/** Called by server when the user manually removes or rejects a hashtag. */
function trackRemoval(tag) {
  removedSet.add(tag);
  suggestions.delete(tag);
}

/** Called by server when the user approves a suggestion. */
function approveSuggestion(tag) {
  if (!removedSet.has(tag)) activeSet.add(tag);
  suggestions.delete(tag);
}

function updateHashtags(posts) {
  if (activeSet.size === 0) return getHashtags();

  const seedSet = new Set(activeSet);

  for (const post of posts) {
    const tags = post.hashtags || [];
    const seedsInPost = tags.filter(t => seedSet.has(t));
    if (seedsInPost.length === 0) continue;

    for (const tag of tags) {
      if (seedSet.has(tag))    continue;
      if (tag.length < 4)      continue;
      if (BLOCKLIST.has(tag))  continue;
      if (removedSet.has(tag)) continue;

      if (!suggestions.has(tag)) suggestions.set(tag, { count: 0, seeds: new Set() });
      const e = suggestions.get(tag);
      e.count++;
      seedsInPost.forEach(s => e.seeds.add(s));
    }
  }

  // Remove suggestions that are now in activeSet
  for (const tag of activeSet) suggestions.delete(tag);

  console.log(`[Hashtags] Active (${activeSet.size}): ${Array.from(activeSet).join(', ')}`);
  console.log(`[Hashtags] Suggestions (${getSuggestions().length}): ${getSuggestions().map(s => `#${s.tag}(${s.count})`).join(', ')}`);

  return getHashtags();
}

module.exports = { getHashtags, setHashtags, updateHashtags, trackRemoval, approveSuggestion, getSuggestions };
