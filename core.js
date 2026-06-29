'use strict';

const LINUX_DO_ORIGIN = 'https://linux.do';

function normalizeUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, LINUX_DO_ORIGIN).href;
  } catch (_) {
    return null;
  }
}

function uniqueUrls(urls) {
  const seen = new Set();
  const result = [];
  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseReplyCount(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 0;
  const match = text.match(/([\d.]+)\s*([km万千]?)/i);
  if (!match) return 0;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return 0;
  const unit = match[2];
  if (unit === 'k' || unit === '千') return Math.round(number * 1000);
  if (unit === 'm') return Math.round(number * 1000000);
  if (unit === '万') return Math.round(number * 10000);
  return Math.round(number);
}

function extractTopicId(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  const match = normalized.match(/\/t\/(?:[^/]+\/)?(\d+)(?:\/\d+)?(?:[?#].*)?$/);
  return match ? match[1] : null;
}

function sortTopicCandidates(candidates, strategy) {
  const withIndex = candidates.map((candidate, index) => ({ ...candidate, index }));
  if (strategy === 'post') {
    withIndex.sort((a, b) => b.replyCount - a.replyCount || a.index - b.index);
  } else {
    withIndex.sort((a, b) => replyBucket(a.replyCount) - replyBucket(b.replyCount) || a.index - b.index);
  }
  return withIndex;
}

function replyBucket(replyCount) {
  if (replyCount <= 5) return 0;
  if (replyCount <= 15) return 1;
  if (replyCount <= 50) return 2;
  return 3;
}

function collectUnreadTopicUrls(doc, limit, strategy = 'topic') {
  const candidates = [];
  const explicitBadges = doc.querySelectorAll('a.badge.badge-notification.new-topic[href]');

  for (const badge of explicitBadges) {
    const row = badge.closest?.('.topic-list-item');
    candidates.push({
      url: badge.href || badge.getAttribute('href'),
      replyCount: parseReplyCount(row?.querySelector?.('.posts-map, .posts')?.textContent),
    });
  }

  if (candidates.length < limit && typeof doc.querySelectorAll === 'function') {
    const rows = doc.querySelectorAll('.topic-list-item.unseen-topic');
    for (const row of rows) {
      const link = row.querySelector?.('a.title[href], a.raw-topic-link[href], a[href*="/t/"]');
      if (link) {
        candidates.push({
          url: link.href || link.getAttribute('href'),
          replyCount: parseReplyCount(row.querySelector?.('.posts-map, .posts')?.textContent),
        });
      }
    }
  }

  return uniqueUrls(sortTopicCandidates(candidates, strategy).map((candidate) => candidate.url)).slice(0, limit);
}

function isTopicDone({ unreadCount, nearBottom, stableRounds }) {
  return unreadCount === 0 && nearBottom && stableRounds >= 2;
}

function parseVisiblePostNumber(progressText) {
  const match = String(progressText || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return {
    current: Number(match[1]),
    total: Number(match[2]),
  };
}

function isUnreadMarkerActive(marker, viewport = {}) {
  if (!marker) return false;
  const className = String(marker.className || '');
  if (className.split(/\s+/).includes('read')) return false;

  const style = marker.style || {};
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (Number(style.opacity) === 0) return false;

  const rect = typeof marker.getBoundingClientRect === 'function'
    ? marker.getBoundingClientRect()
    : { width: 1, height: 1 };
  const topMargin = Number.isFinite(viewport.topMargin) ? viewport.topMargin : 0;
  if (rect.y < topMargin) return false;
  return Boolean((rect.width || rect.height));
}

function isUnreadMarkerVisible(marker, viewport = {}) {
  if (!isUnreadMarkerActive(marker, viewport)) return false;
  const rect = typeof marker.getBoundingClientRect === 'function'
    ? marker.getBoundingClientRect()
    : { y: 0, width: 1, height: 1 };
  const topEdgeMargin = Number.isFinite(viewport.topEdgeMargin) ? viewport.topEdgeMargin : 0;
  const bottomEdgeMargin = Number.isFinite(viewport.bottomEdgeMargin) ? viewport.bottomEdgeMargin : 0;
  const height = Number.isFinite(viewport.height) ? viewport.height : 0;
  const markerHeight = Number.isFinite(rect.height) ? rect.height : 0;
  return rect.y >= topEdgeMargin && rect.y + markerHeight <= height - bottomEdgeMargin;
}

function randomDelayMs(minMs, maxMs) {
  const min = Math.max(0, Number(minMs));
  const max = Math.max(min, Number(maxMs));
  return Math.floor(min + Math.random() * (max - min + 1));
}

module.exports = {
  collectUnreadTopicUrls,
  extractTopicId,
  isTopicDone,
  isUnreadMarkerActive,
  isUnreadMarkerVisible,
  parseVisiblePostNumber,
  parseReplyCount,
  randomDelayMs,
  replyBucket,
  sortTopicCandidates,
};
