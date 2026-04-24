'use strict';

/**
 * Topic manager – one JSON file per topic in ./sessions/.
 * Each topic stores: id, name, hashtags, reviewedIds {postId → 'used'|'skipped'}, timestamps.
 */

const fs   = require('fs');
const path = require('path');

const DIR    = process.env.SESSIONS_DIR || './sessions';
const PREFIX = 'topic-';

const DEFAULT_HASHTAGS = [
  '4daagse', 'nijmeegsevierdaagse', 'vierdaagse',
  'vierdaagsefeesten', '4daagsefeesten', 'nijmegen', 'vierdaagse2025',
];

function topicFile(id) { return path.join(DIR, `${PREFIX}${id}.json`); }

function list() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    return fs.readdirSync(DIR)
      .filter(f => f.startsWith(PREFIX) && f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  } catch { return []; }
}

function load(id) {
  try { return JSON.parse(fs.readFileSync(topicFile(id), 'utf8')); } catch { return null; }
}

function save(topic) {
  fs.mkdirSync(DIR, { recursive: true });
  topic.lastActiveAt = Date.now();
  fs.writeFileSync(topicFile(topic.id), JSON.stringify(topic, null, 2));
  return topic;
}

function create(name, hashtags = DEFAULT_HASHTAGS) {
  const id = Date.now().toString(36);
  return save({
    id, name,
    hashtags: [...hashtags],
    reviewedIds: {},
    createdAt:    Date.now(),
    lastActiveAt: Date.now(),
  });
}

function markPost(topicId, postId, status) {
  const t = load(topicId);
  if (!t) return null;
  if (status === null) {
    delete t.reviewedIds[postId];
  } else {
    t.reviewedIds[postId] = status; // 'used' | 'skipped'
  }
  return save(t);
}

function updateHashtags(topicId, hashtags) {
  const t = load(topicId);
  if (!t) return null;
  t.hashtags = hashtags;
  return save(t);
}

function summary(t) {
  return {
    id:           t.id,
    name:         t.name,
    hashtags:     t.hashtags,
    reviewedCount: Object.keys(t.reviewedIds || {}).length,
    createdAt:    t.createdAt,
    lastActiveAt: t.lastActiveAt,
  };
}

module.exports = { list, load, save, create, markPost, updateHashtags, summary, DEFAULT_HASHTAGS };
