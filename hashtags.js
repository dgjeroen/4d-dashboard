'use strict';

/**
 * Hashtag manager – hashtags come from the active topic, not a hardcoded seed.
 * setHashtags() is called by the server whenever a topic is activated.
 * updateHashtags() discovers new co-occurring tags and returns the updated list.
 */

let activeSet = new Set();

function setHashtags(tags) {
  activeSet = new Set(tags);
}

function getHashtags() {
  return Array.from(activeSet);
}

function updateHashtags(posts) {
  if (activeSet.size === 0) return getHashtags();

  const coOccurrences = new Map();
  const seedSet = new Set(activeSet); // snapshot of current set as "seed"

  for (const post of posts) {
    const tags = post.hashtags || [];
    const hasSeed = tags.some(t => seedSet.has(t));
    if (!hasSeed) continue;

    for (const tag of tags) {
      if (seedSet.has(tag) || tag.length < 4) continue;
      coOccurrences.set(tag, (coOccurrences.get(tag) || 0) + 1);
    }
  }

  for (const [tag, count] of coOccurrences.entries()) {
    if (count >= 3 && !activeSet.has(tag)) {
      console.log(`[Hashtags] New: #${tag} (in ${count} posts)`);
      activeSet.add(tag);
    }
  }

  // Cap at 30
  if (activeSet.size > 30) {
    const sorted = Array.from(activeSet)
      .sort((a, b) => (coOccurrences.get(b) || 0) - (coOccurrences.get(a) || 0));
    activeSet = new Set(sorted.slice(0, 30));
  }

  console.log(`[Hashtags] Active (${activeSet.size}): ${Array.from(activeSet).join(', ')}`);
  return getHashtags();
}

module.exports = { getHashtags, setHashtags, updateHashtags };
