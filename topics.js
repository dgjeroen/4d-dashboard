'use strict';

const fs   = require('fs');
const path = require('path');

const DIR    = process.env.SESSIONS_DIR || './sessions';
const PREFIX = 'topic-';

const DEFAULT_GROUP_A = {
  name:     'Vierdaagse',
  hashtags: ['4daagse','nijmeegsevierdaagse','vierdaagse','nijmegen','vierdaagse2025'],
};
const DEFAULT_GROUP_B = {
  name:     'Feesten',
  hashtags: ['vierdaagsefeesten','4daagsefeesten'],
};

function topicFile(id) { return path.join(DIR, `${PREFIX}${id}.json`); }

function _normalize(t) {
  // Backward compat: old topics had flat `hashtags` without groups
  if (!t.groupA) {
    t.groupA = { name: 'Groep A', hashtags: t.hashtags || [] };
    t.groupB = { name: 'Groep B', hashtags: [] };
  }
  if (!t.hashtags || !t.hashtags.length) {
    t.hashtags = [...new Set([...(t.groupA.hashtags||[]), ...(t.groupB.hashtags||[])])];
  }
  return t;
}

function list() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    return fs.readdirSync(DIR)
      .filter(f => f.startsWith(PREFIX) && f.endsWith('.json'))
      .map(f => { try { return _normalize(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  } catch { return []; }
}

function load(id) {
  try { return _normalize(JSON.parse(fs.readFileSync(topicFile(id), 'utf8'))); } catch { return null; }
}

function save(topic) {
  fs.mkdirSync(DIR, { recursive: true });
  topic.lastActiveAt = Date.now();
  fs.writeFileSync(topicFile(topic.id), JSON.stringify(topic, null, 2));
  return topic;
}

function create(name, groupA, groupB) {
  const id = Date.now().toString(36);
  const gA = { name: groupA?.name || DEFAULT_GROUP_A.name, hashtags: groupA?.hashtags || [...DEFAULT_GROUP_A.hashtags] };
  const gB = { name: groupB?.name || DEFAULT_GROUP_B.name, hashtags: groupB?.hashtags || [...DEFAULT_GROUP_B.hashtags] };
  const allHashtags = [...new Set([...gA.hashtags, ...gB.hashtags])];
  return save({ id, name, groupA: gA, groupB: gB, hashtags: allHashtags, reviewedIds: {}, createdAt: Date.now(), lastActiveAt: Date.now() });
}

function markPost(topicId, postId, status) {
  const t = load(topicId);
  if (!t) return null;
  if (status === null) delete t.reviewedIds[postId];
  else t.reviewedIds[postId] = status;
  return save(t);
}

function updateHashtags(topicId, hashtags) {
  const t = load(topicId);
  if (!t) return null;
  // Only update the combined list; groups stay intact
  t.hashtags = hashtags;
  return save(t);
}

function summary(t) {
  return {
    id:            t.id,
    name:          t.name,
    groupA:        { name: t.groupA?.name || 'Groep A', hashtags: t.groupA?.hashtags || [] },
    groupB:        { name: t.groupB?.name || 'Groep B', hashtags: t.groupB?.hashtags || [] },
    hashtags:      t.hashtags || [],
    reviewedCount: Object.keys(t.reviewedIds || {}).length,
    createdAt:     t.createdAt,
    lastActiveAt:  t.lastActiveAt,
  };
}

module.exports = { list, load, save, create, markPost, updateHashtags, summary, DEFAULT_GROUP_A, DEFAULT_GROUP_B };
