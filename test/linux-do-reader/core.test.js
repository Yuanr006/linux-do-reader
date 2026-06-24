const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectUnreadTopicUrls,
  extractTopicId,
  isTopicDone,
  isUnreadMarkerActive,
  parseVisiblePostNumber,
  parseReplyCount,
  randomDelayMs,
} = require('../../scripts/linux-do-reader/core');

function makeDocument(html, rows = []) {
  const nodes = [];

  const makeNode = (attrs, className = '', title = '') => ({
    className,
    href: attrs.href || '',
    title,
    dataset: {},
    getAttribute(name) {
      return attrs[name] || null;
    },
    closest(selector) {
      if (selector === '.topic-list-item' && this.row) return this.row;
      return null;
    },
  });

  for (const match of html.matchAll(/<a([^>]*)>/g)) {
    const attrs = Object.fromEntries(
      [...match[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
    );
    nodes.push(makeNode(attrs, attrs.class || '', attrs.title || ''));
  }

  return {
    querySelectorAll(selector) {
      if (selector === 'a.badge.badge-notification.new-topic[href]') {
        return nodes.filter((node) => (
          node.href
          && node.className.includes('badge-notification')
          && node.className.includes('new-topic')
        ));
      }
      if (selector === '.topic-list-item.unseen-topic') {
        return rows;
      }
      return [];
    },
  };
}

function makeRow(url, replyText) {
  return {
    querySelector(selector) {
      if (selector.includes('.posts')) {
        return { textContent: replyText };
      }
      if (selector.includes('a')) {
        return { href: url, getAttribute: () => url };
      }
      return null;
    },
  };
}

test('collectUnreadTopicUrls returns unique new-topic links up to the limit', () => {
  const doc = makeDocument(`
    <a class="badge badge-notification new-topic" href="https://linux.do/t/topic/1/1"></a>
    <a class="badge badge-notification new-topic" href="https://linux.do/t/topic/1/1"></a>
    <a class="badge badge-notification new-topic" href="/t/topic/2/1"></a>
  `);

  assert.deepEqual(collectUnreadTopicUrls(doc, 2), [
    'https://linux.do/t/topic/1/1',
    'https://linux.do/t/topic/2/1',
  ]);
});

test('collectUnreadTopicUrls keeps latest order within low-reply buckets for topic strategy', () => {
  const doc = makeDocument('', [
    makeRow('/t/topic/1/1', '4'),
    makeRow('/t/topic/2/1', '2'),
    makeRow('/t/topic/3/1', '10'),
  ]);

  assert.deepEqual(collectUnreadTopicUrls(doc, 3, 'topic'), [
    'https://linux.do/t/topic/1/1',
    'https://linux.do/t/topic/2/1',
    'https://linux.do/t/topic/3/1',
  ]);
});

test('collectUnreadTopicUrls sorts high replies first for post strategy', () => {
  const doc = makeDocument('', [
    makeRow('/t/topic/1/1', '30'),
    makeRow('/t/topic/2/1', '2'),
    makeRow('/t/topic/3/1', '1.2k'),
  ]);

  assert.deepEqual(collectUnreadTopicUrls(doc, 3, 'post'), [
    'https://linux.do/t/topic/3/1',
    'https://linux.do/t/topic/1/1',
    'https://linux.do/t/topic/2/1',
  ]);
});

test('parseReplyCount supports compact count units', () => {
  assert.equal(parseReplyCount('1.2k'), 1200);
  assert.equal(parseReplyCount('2万'), 20000);
  assert.equal(parseReplyCount('15'), 15);
});

test('extractTopicId parses topic URLs with optional post numbers', () => {
  assert.equal(extractTopicId('https://linux.do/t/topic/2467255/61'), '2467255');
  assert.equal(extractTopicId('/t/topic/2467255'), '2467255');
  assert.equal(extractTopicId('https://linux.do/latest'), null);
});

test('isTopicDone is false while unread markers remain and true at bottom without markers', () => {
  assert.equal(isTopicDone({ unreadCount: 1, nearBottom: true, stableRounds: 3 }), false);
  assert.equal(isTopicDone({ unreadCount: 0, nearBottom: false, stableRounds: 3 }), false);
  assert.equal(isTopicDone({ unreadCount: 0, nearBottom: true, stableRounds: 2 }), true);
});

test('isUnreadMarkerActive ignores markers already marked read or hidden', () => {
  assert.equal(isUnreadMarkerActive({
    className: 'read-state',
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => ({ width: 9, height: 17 }),
  }), true);

  assert.equal(isUnreadMarkerActive({
    className: 'read-state read',
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => ({ width: 9, height: 17 }),
  }), false);

  assert.equal(isUnreadMarkerActive({
    className: 'read-state',
    style: { display: 'block', visibility: 'hidden', opacity: '0' },
    getBoundingClientRect: () => ({ width: 9, height: 17 }),
  }), false);
});

test('isUnreadMarkerActive ignores active markers far above the viewport', () => {
  assert.equal(isUnreadMarkerActive({
    className: 'read-state',
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => ({ width: 9, height: 17, y: -900 }),
  }, { topMargin: -200 }), false);

  assert.equal(isUnreadMarkerActive({
    className: 'read-state',
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => ({ width: 9, height: 17, y: 80 }),
  }, { topMargin: -200 }), true);
});

test('parseVisiblePostNumber parses timeline progress', () => {
  assert.deepEqual(parseVisiblePostNumber('6 / 35'), { current: 6, total: 35 });
  assert.deepEqual(parseVisiblePostNumber(' 12 / 1200 '), { current: 12, total: 1200 });
  assert.equal(parseVisiblePostNumber(''), null);
});

test('randomDelayMs stays within configured bounds', () => {
  for (let i = 0; i < 100; i += 1) {
    const delay = randomDelayMs(1000, 3000);
    assert.ok(delay >= 1000);
    assert.ok(delay <= 3000);
  }
});
