// ==UserScript==
// @name         LINUX DO 阅读助手
// @namespace    https://linux.do/
// @version      0.3.1
// @description  以可控节奏打开未读话题并滚动阅读，帮助把实际浏览过的内容标记为已读。
// @match        https://linux.do/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG_KEY = 'linuxDoReaderConfig';
  const STATE_KEY = 'linuxDoReaderState';
  const READ_TOPIC_IDS_KEY = 'linuxDoReaderReadTopicIds';
  const DEFAULT_CONFIG = {
    maxTopics: 10,
    maxPostsPerTopic: -1,
    minDelayMs: 1200,
    maxDelayMs: 2000,
    scrollRatio: 0.78,
    maxStableRounds: 2,
    maxRoundsPerTopic: 260,
    minTopicCooldownMs: 3000,
    maxTopicCooldownMs: 8000,
    priority: 'topic',
    initialReadDelayMs: 2500,
    unreadTopMargin: -200,
    likeMainPost: false,
  };

  function normalizeUrl(href) {
    if (!href) return null;
    try {
      return new URL(href, location.origin).href;
    } catch (_) {
      return null;
    }
  }

  function loadJson(key, fallback) {
    try {
      return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') };
    } catch (_) {
      return { ...fallback };
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function randomDelayMs(minMs, maxMs) {
    const min = Math.max(0, Number(minMs));
    const max = Math.max(min, Number(maxMs));
    return Math.floor(min + Math.random() * (max - min + 1));
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

  function getReadTopicIds() {
    try {
      const ids = JSON.parse(localStorage.getItem(READ_TOPIC_IDS_KEY) || '[]');
      return Array.isArray(ids) ? ids : [];
    } catch (_) {
      return [];
    }
  }

  function rememberReadTopicId(url, explicitId) {
    const id = explicitId || extractTopicId(url);
    if (!id) return;
    const ids = getReadTopicIds().filter(Boolean);
    const next = Array.from(new Set([...ids, id])).slice(-1000);
    localStorage.setItem(READ_TOPIC_IDS_KEY, JSON.stringify(next));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getState() {
    return loadJson(STATE_KEY, {
      running: false,
      startedAt: 0,
      visited: [],
      queue: [],
      count: 0,
      currentTopicId: null,
      status: '空闲',
    });
  }

  function setState(patch) {
    const next = { ...getState(), ...patch };
    saveJson(STATE_KEY, next);
    renderPanel();
    return next;
  }

  function stopReader(message) {
    setState({ running: false, status: message || '已停止' });
  }

  function collectUnreadTopicUrls(limit, priority) {
    const candidates = [];

    for (const badge of document.querySelectorAll('a.badge.badge-notification.new-topic[href]')) {
      const row = badge.closest('.topic-list-item');
      candidates.push({
        url: badge.href || badge.getAttribute('href'),
        replyCount: parseReplyCount(row?.querySelector('.posts-map, .posts')?.textContent),
      });
    }

    if (candidates.length < limit) {
      for (const row of document.querySelectorAll('.topic-list-item.unseen-topic')) {
        const link = row.querySelector('a.title[href], a.raw-topic-link[href], a[href*="/t/"]');
        if (link) {
          candidates.push({
            url: link.href || link.getAttribute('href'),
            replyCount: parseReplyCount(row.querySelector('.posts-map, .posts')?.textContent),
          });
        }
      }
    }

    candidates.forEach((candidate, index) => {
      candidate.index = index;
    });
    candidates.sort((a, b) => {
      if (priority === 'post') return b.replyCount - a.replyCount || a.index - b.index;
      return replyBucket(a.replyCount) - replyBucket(b.replyCount) || a.index - b.index;
    });

    const seen = new Set();
    const result = [];
    for (const candidate of candidates) {
      const normalized = normalizeUrl(candidate.url);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
      if (result.length >= limit) break;
    }
    return result;
  }

  function collectHotTopicUrls(limit) {
    const readIds = new Set(getReadTopicIds());
    const candidates = [];

    for (const row of document.querySelectorAll('.topic-list-item')) {
      const link = row.querySelector('a.title[href], a.raw-topic-link[href], a[href*="/t/"]');
      const url = link?.href || link?.getAttribute('href');
      const topicId = extractTopicId(url);
      if (!url || !topicId || readIds.has(topicId)) continue;

      candidates.push({
        url,
        topicId,
        replyCount: parseReplyCount(row.querySelector('.posts-map, .posts')?.textContent),
      });
    }

    candidates.sort((a, b) => b.replyCount - a.replyCount);
    return candidates.slice(0, limit).map((candidate) => normalizeUrl(candidate.url)).filter(Boolean);
  }

  function isTopicPage() {
    return /^\/t\//.test(location.pathname);
  }

  function isHotPage() {
    return location.pathname === '/hot';
  }

  function nearBottom() {
    const doc = document.documentElement;
    return window.scrollY + window.innerHeight >= doc.scrollHeight - 80;
  }

  function unreadPostCount() {
    return Array.from(document.querySelectorAll('.read-state')).filter(isUnreadMarkerActive).length;
  }

  function isUnreadMarkerActive(marker) {
    if (!marker) return false;
    if (marker.classList.contains('read')) return false;

    const style = getComputedStyle(marker);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }

    const rect = marker.getBoundingClientRect();
    if (rect.y < loadJson(CONFIG_KEY, DEFAULT_CONFIG).unreadTopMargin) return false;
    return Boolean(rect.width || rect.height);
  }

  function visiblePostProgress() {
    const text = document.querySelector('.timeline-replies')?.textContent?.trim();
    return text || '';
  }

  function parseVisiblePostNumber(progressText) {
    const match = String(progressText || '').match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return null;
    return {
      current: Number(match[1]),
      total: Number(match[2]),
    };
  }

  async function likeMainPostIfEnabled(config) {
    if (!config.likeMainPost) return false;
    const mainPost = document.querySelector('article#post_1, article.boxed');
    const button = mainPost?.querySelector('button.btn-toggle-reaction-like[title="点赞此帖子"]');
    if (!button || button.disabled) return false;

    button.click();
    await sleep(600);
    return true;
  }

  function startReader() {
    const config = loadJson(CONFIG_KEY, DEFAULT_CONFIG);
    saveJson(CONFIG_KEY, config);

    const state = {
      running: true,
      startedAt: Date.now(),
      visited: [],
      queue: [],
      count: 0,
      currentTopicId: null,
      status: '启动中',
    };
    saveJson(STATE_KEY, state);
    renderPanel();
    void tick();
  }

  function openNextTopic() {
    const config = loadJson(CONFIG_KEY, DEFAULT_CONFIG);
    const state = getState();
    if (!state.running) return;
    if (state.count >= config.maxTopics) {
      stopReader(`完成：已读 ${state.count} 个话题`);
      return;
    }

    let queue = [...state.queue];
    if (queue.length === 0) {
      queue = (config.priority === 'post'
        ? collectHotTopicUrls(config.maxTopics - state.count)
        : collectUnreadTopicUrls(config.maxTopics - state.count, config.priority))
        .filter((url) => !state.visited.includes(url));
    }

    if (queue.length === 0) {
      stopReader(`完成：没有找到新的未读话题，已读 ${state.count} 个`);
      return;
    }

    const nextUrl = queue.shift();
    setState({
      queue,
      currentTopicId: extractTopicId(nextUrl),
      status: `打开话题 ${state.count + 1}/${config.maxTopics}，策略：${config.priority === 'post' ? '帖子优先' : '话题优先'}`,
    });
    location.assign(nextUrl);
  }

  async function readCurrentTopic() {
    const config = loadJson(CONFIG_KEY, DEFAULT_CONFIG);
    let state = getState();
    const currentUrl = normalizeUrl(location.href);
    let stableRounds = 0;
    let lastHeight = 0;

    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    await sleep(config.initialReadDelayMs);
    const likedMainPost = await likeMainPostIfEnabled(config);

    for (let round = 0; round < config.maxRoundsPerTopic; round += 1) {
      state = getState();
      if (!state.running) return;

      const unread = unreadPostCount();
      const progress = visiblePostProgress();
      const postProgress = parseVisiblePostNumber(progress);
      setState({
        status: `阅读中 ${state.count + 1}/${config.maxTopics} ${progress} 未读标记:${unread}${likedMainPost ? ' 已点赞主帖' : ''}`,
      });

      const docHeight = document.documentElement.scrollHeight;
      if (config.maxPostsPerTopic > 0 && postProgress && postProgress.current >= config.maxPostsPerTopic) {
        setState({
          status: `达到每话题 ${config.maxPostsPerTopic} 帖上限，准备返回主页`,
        });
        break;
      }

      if (nearBottom() && unread === 0 && stableRounds >= config.maxStableRounds) break;

      if (nearBottom() && docHeight === lastHeight) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
      }
      lastHeight = docHeight;

      window.scrollBy({
        top: Math.max(260, Math.floor(window.innerHeight * config.scrollRatio)),
        left: 0,
        behavior: 'smooth',
      });
      await sleep(randomDelayMs(config.minDelayMs, config.maxDelayMs));
    }

    state = getState();
    if (!state.running) return;

    const visited = Array.from(new Set([...state.visited, currentUrl].filter(Boolean)));
    rememberReadTopicId(currentUrl, state.currentTopicId);
    const cooldownMs = randomDelayMs(config.minTopicCooldownMs, config.maxTopicCooldownMs);
    setState({
      visited,
      count: state.count + 1,
      currentTopicId: null,
      status: `话题已读完，冷却 ${Math.round(cooldownMs / 1000)} 秒后返回主页`,
    });

    await sleep(cooldownMs);
    location.assign('https://linux.do/latest');
  }

  async function tick() {
    await sleep(800);
    const state = getState();
    if (!state.running) return;

    if (isTopicPage()) {
      await readCurrentTopic();
      return;
    }

    const config = loadJson(CONFIG_KEY, DEFAULT_CONFIG);
    if (config.priority === 'post' && !isHotPage()) {
      setState({ status: '帖子优先：打开热门话题列表' });
      location.assign('https://linux.do/hot');
      return;
    }

    openNextTopic();
  }

  function numberInput(label, key, value, width) {
    const min = key === 'maxPostsPerTopic' ? -1 : 1;
    return `
      <label style="display:flex;align-items:center;gap:6px;justify-content:space-between;">
        <span>${label}</span>
        <input data-ldr-config="${key}" type="number" value="${value}" min="${min}"
          style="width:${width || 72}px;box-sizing:border-box;border:1px solid #b9c2cf;border-radius:4px;padding:3px 5px;">
      </label>
    `;
  }

  function prioritySelect(value) {
    return `
      <label style="display:flex;align-items:center;gap:6px;justify-content:space-between;">
        <span>优先策略</span>
        <select data-ldr-config="priority"
          style="width:104px;box-sizing:border-box;border:1px solid #b9c2cf;border-radius:4px;padding:3px 5px;background:#fff;">
          <option value="topic" ${value === 'topic' ? 'selected' : ''}>话题优先</option>
          <option value="post" ${value === 'post' ? 'selected' : ''}>帖子优先</option>
        </select>
      </label>
    `;
  }

  function checkboxInput(label, key, checked) {
    return `
      <label style="display:flex;align-items:center;gap:6px;justify-content:space-between;">
        <span>${label}</span>
        <input data-ldr-config="${key}" type="checkbox" ${checked ? 'checked' : ''}
          style="width:16px;height:16px;">
      </label>
    `;
  }

  function replyBucket(replyCount) {
    if (replyCount <= 5) return 0;
    if (replyCount <= 15) return 1;
    if (replyCount <= 50) return 2;
    return 3;
  }

  function renderPanel() {
    const config = loadJson(CONFIG_KEY, DEFAULT_CONFIG);
    const state = getState();
    let panel = document.getElementById('linux-do-reader-panel');

    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'linux-do-reader-panel';
      panel.style.cssText = [
        'position:fixed',
        'right:16px',
        'bottom:16px',
        'z-index:99999',
        'width:248px',
        'font-size:13px',
        'line-height:1.35',
        'color:#1f2937',
        'background:#ffffff',
        'border:1px solid #cad3df',
        'box-shadow:0 8px 24px rgba(15,23,42,.18)',
        'border-radius:8px',
        'padding:10px',
        'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      ].join(';');
      document.body.appendChild(panel);
    }

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <strong>LINUX DO 阅读助手</strong>
        <span style="color:${state.running ? '#1473e6' : '#64748b'}">${state.running ? '运行中' : '空闲'}</span>
      </div>
      <div style="display:grid;gap:6px;margin-bottom:8px;">
        ${prioritySelect(config.priority)}
        ${checkboxInput('主帖点赞', 'likeMainPost', config.likeMainPost)}
        ${numberInput('话题上限', 'maxTopics', config.maxTopics)}
        ${numberInput('每话题最多帖子', 'maxPostsPerTopic', config.maxPostsPerTopic, 88)}
        ${numberInput('主帖停留(ms)', 'initialReadDelayMs', config.initialReadDelayMs, 88)}
        ${numberInput('最短停留(ms)', 'minDelayMs', config.minDelayMs, 88)}
        ${numberInput('最长停留(ms)', 'maxDelayMs', config.maxDelayMs, 88)}
        ${numberInput('冷却最短(ms)', 'minTopicCooldownMs', config.minTopicCooldownMs, 88)}
        ${numberInput('冷却最长(ms)', 'maxTopicCooldownMs', config.maxTopicCooldownMs, 88)}
      </div>
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <button data-ldr-action="start" style="flex:1;border:0;border-radius:5px;background:#1473e6;color:#fff;padding:6px 8px;cursor:pointer;">开始</button>
        <button data-ldr-action="stop" style="flex:1;border:1px solid #b9c2cf;border-radius:5px;background:#fff;color:#1f2937;padding:6px 8px;cursor:pointer;">停止</button>
      </div>
      <button data-ldr-action="clear-read" style="width:100%;border:1px solid #d7dde6;border-radius:5px;background:#fff;color:#475569;padding:5px 8px;cursor:pointer;margin-bottom:8px;">清空已读记录</button>
      <button data-ldr-action="reset-config" style="width:100%;border:1px solid #d7dde6;border-radius:5px;background:#fff;color:#475569;padding:5px 8px;cursor:pointer;margin-bottom:8px;">重置设置</button>
      <div style="color:#475569;word-break:break-word;">${state.status || '空闲'}</div>
    `;

    for (const input of panel.querySelectorAll('[data-ldr-config]')) {
      const saveConfig = () => {
        const nextConfig = loadJson(CONFIG_KEY, DEFAULT_CONFIG);
        if (input.type === 'number') {
          nextConfig[input.dataset.ldrConfig] = Number(input.value);
        } else if (input.type === 'checkbox') {
          nextConfig[input.dataset.ldrConfig] = input.checked;
        } else {
          nextConfig[input.dataset.ldrConfig] = input.value;
        }
        saveJson(CONFIG_KEY, nextConfig);
      };
      input.addEventListener('input', saveConfig);
      input.addEventListener('change', saveConfig);
    }

    panel.querySelector('[data-ldr-action="start"]').addEventListener('click', startReader);
    panel.querySelector('[data-ldr-action="stop"]').addEventListener('click', () => stopReader('手动停止'));
    panel.querySelector('[data-ldr-action="clear-read"]').addEventListener('click', () => {
      localStorage.removeItem(READ_TOPIC_IDS_KEY);
      setState({ status: '已清空热门话题已读记录' });
    });
    panel.querySelector('[data-ldr-action="reset-config"]').addEventListener('click', () => {
      saveJson(CONFIG_KEY, DEFAULT_CONFIG);
      setState({ status: '已恢复默认设置' });
    });
  }

  renderPanel();

  if (getState().running) {
    void tick();
  }
}());
