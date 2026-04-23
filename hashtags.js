'use strict';

/**
 * Hashtag manager.
 *
 * Starts from a fixed seed set. Every hour the server calls updateHashtags()
 * with the current post cache. Any hashtag that co-occurs with a seed tag in
 * ≥3 posts is added to the active set (capped at 30 total).
 */

const SEED = [
  '4daagse',
  'nijmeegsevierdaagse',
  'vierdaagse',
  'vierdaagsefeesten',
  '4daagsefeesten',
  'nijmegen',
  'vierdaagse2025',
];

const SEED_SET = new Set(SEED);
let activeSet  = new Set(SEED);

function getHashtags() {
  return Array.from(activeSet);
}

/**
 * Analyse co-occurring hashtags in posts and promote frequent ones.
 * @param {Array} posts  - current post cache
 * @returns {string[]}   - updated hashtag list
 */
function updateHashtags(posts) {
  const coOccurrences = new Map();

  for (const post of posts) {
    const tags = post.hashtags || [];
    const hasSeed = tags.some(t => activeSet.has(t));
    if (!hasSeed) continue;

    for (const tag of tags) {
      // Skip seeds, very short tags, and tags that look like noise
      if (SEED_SET.has(tag) || tag.length < 4) continue;
      coOccurrences.set(tag, (coOccurrences.get(tag) || 0) + 1);
    }
  }

  for (const [tag, count] of coOccurrences.entries()) {
    if (count >= 3 && !activeSet.has(tag)) {
      console.log(`[Hashtags] New: #${tag} (in ${count} posts)`);
      activeSet.add(tag);
    }
  }

  // Cap at 30: seeds always kept, extras sorted by co-occurrence
  if (activeSet.size > 30) {
    const extras = Array.from(activeSet)
      .filter(t => !SEED_SET.has(t))
      .sort((a, b) => (coOccurrences.get(b) || 0) - (coOccurrences.get(a) || 0));

    activeSet = new Set([...SEED, ...extras.slice(0, 30 - SEED.length)]);
  }

  console.log(`[Hashtags] Active (${activeSet.size}): ${Array.from(activeSet).join(', ')}`);
  return getHashtags();
}

module.exports = { getHashtags, updateHashtags };
