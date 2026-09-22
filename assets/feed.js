/* ==========================================================================
   index.html — 폴더 트리 + 검색 + 최신순 피드 + 최근 글/통계

   로딩 순서
   1) localStorage 에 저장된 목록이 있으면 네트워크를 기다리지 않고 바로 그림
   2) 마지막 확인이 5분 이내면 끝 (API 호출 0회). 단, 새로고침(F5)은 항상 다시 확인
   3) 트리 API 1회 호출 → sha 가 달라진 글만 raw.githubusercontent.com 에서 다시 받음
   ========================================================================== */
(function () {
  'use strict';

  const C = window.CONFIG;
  const S = window.Site;
  const esc = S.escapeHtml;

  const els = {
    tree: document.getElementById('tree'),
    feed: document.getElementById('feed'),
    feedHead: document.getElementById('feed-head'),
    search: document.getElementById('search-input'),
    recent: document.getElementById('recent'),
    stats: document.getElementById('stats'),
    empty: null,
  };

  const state = {
    posts: [],
    cards: [],         // posts 와 같은 순서의 카드 요소
    signature: null,   // 현재 그려진 목록의 식별값 (바뀐 게 없으면 다시 그리지 않음)
    root: null,        // 폴더 트리 (로드 완료 전엔 null)
    folder: '',        // 현재 선택된 폴더 경로 ('' = 전체)
    query: '',
    collapsed: new Set(),
  };

  S.initThemeToggle(document.getElementById('theme-toggle'));
  readHash();

  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = els.search.value.trim().toLowerCase();
      renderFeed();
    }, 120);
  });
  els.tree.addEventListener('click', onTreeClick);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="retry"]')) load();
    if (e.target.closest('[data-action="show-all"]')) { e.preventDefault(); selectFolder(''); }
  });
  window.addEventListener('popstate', () => {
    readHash();
    updateTreeActive();
    renderFeed();
  });

  /* ---------- 데이터 로드 ---------- */

  async function load() {
    const cache = S.readCache();
    const cacheComplete = !!cache && cache.files.every((f) => cache.posts[f.path]);
    let shown = false;

    if (cacheComplete) {
      setPosts(cache.files, cache.files.map((f) => cache.posts[f.path]));
      shown = true;
    } else {
      showLoading();
    }

    if (shown && Date.now() - (cache.checkedAt || 0) < RECHECK_MS && !isReload()) return;

    let tree;
    try {
      tree = await fetchTree();
    } catch (err) {
      if (shown) {
        console.warn('[feed] 최신 목록을 확인하지 못해 저장된 목록을 보여줍니다:', err);
        return;
      }
      console.error('[feed] 글 목록을 불러오지 못했습니다:', err);
      renderError(err);
      return;
    }

    const files = tree.files;
    const old = (cache && cache.posts) || {};
    const entries = await Promise.all(files.map((f) => loadEntry(f, old[f.path])));

    const next = { checkedAt: Date.now(), files, posts: {} };
    entries.forEach((e, i) => { if (e.verified) next.posts[files[i].path] = e.data; });
    S.writeCache(next);

    setPosts(files, entries.map((e) => e.data));
  }

  class LoadError extends Error {
    constructor(kind, message, resetAt) {
      super(message || kind);
      this.kind = kind;
      this.resetAt = resetAt;
    }
  }

  // 이 시간 안에 다시 들어오면(글 보고 목록으로 돌아오기 등) API 를 호출하지 않음
  const RECHECK_MS = 5 * 60 * 1000;

  function isReload() {
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    return !!nav && nav.type === 'reload';
  }

  // GitHub API 호출은 이 함수의 딱 1번뿐. tree_sha 자리에 브랜치 이름을 그대로 사용.
  async function fetchTree() {
    const url = 'https://api.github.com/repos/' +
      encodeURIComponent(C.owner) + '/' + encodeURIComponent(C.repo) +
      '/git/trees/' + C.branch.split('/').map(encodeURIComponent).join('/') + '?recursive=1';

    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    } catch (e) {
      throw new LoadError('network', e.message);
    }

    if (!res.ok) {
      if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        throw new LoadError('ratelimit', 'rate limit exceeded', reset || null);
      }
      if (res.status === 404) throw new LoadError('notfound', 'HTTP 404');
      if (res.status === 409) return { files: [] }; // 커밋이 하나도 없는 빈 저장소
      throw new LoadError('http', 'HTTP ' + res.status);
    }

    const data = await res.json();
    const prefix = S.postsPrefix + '/';
    const files = (data.tree || [])
      .filter((item) => item.type === 'blob' && item.path.startsWith(prefix) && /\.md$/i.test(item.path))
      .map((item) => ({ path: item.path, sha: item.sha }));
    return { files };
  }

  // 본문은 raw.githubusercontent.com 에서 (API 한도와 무관). sha 가 같으면 저장본 재사용.
  async function loadEntry(file, cached) {
    if (cached && cached.sha === file.sha) return { data: cached, verified: true };
    try {
      const res = await fetch(S.rawUrl(file.path));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const { data, body } = S.parseFrontMatter(new TextDecoder().decode(buf));
      const entry = { sha: file.sha, title: data.title || '', date: data.date || '', excerpt: data.excerpt || '', body };
      // 푸시 직후엔 raw CDN 이 이전 버전을 줄 수 있음 → sha 가 맞을 때만 저장
      const sha = await S.gitBlobSha(buf).catch(() => null);
      return { data: entry, verified: sha === file.sha };
    } catch (e) {
      console.warn('[feed] 글을 읽지 못했습니다:', file.path, e);
      return { data: null, verified: false };
    }
  }

  function toPost(path, entry) {
    const slug = S.pathToSlug(path);
    const segments = slug.split('/');
    const fileName = segments[segments.length - 1];
    const e = entry || {};
    const post = {
      slug,
      folder: segments.slice(0, -1),
      title: e.title || fileName,
      date: e.date || '',
      excerpt: entry ? e.excerpt : '이 글의 내용을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
      body: e.body || '',
    };
    post.folderPath = post.folder.join('/');
    post.titleLower = post.title.toLowerCase();
    post.bodyLower = post.body.toLowerCase();
    return post;
  }

  function byDateDesc(a, b) {
    return (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title, 'ko');
  }

  function setPosts(files, entries) {
    const signature = files.map((f, i) => f.path + ':' + f.sha + ':' + (entries[i] ? 1 : 0)).join('|');
    if (signature === state.signature) return;
    state.signature = signature;
    state.posts = files.map((f, i) => toPost(f.path, entries[i])).sort(byDateDesc);
    state.root = buildTree(state.posts);
    renderTree();
    buildCards();
    renderFeed();
    renderSidebar();
  }

  function showLoading() {
    state.root = null;
    state.signature = null;
    els.feed.innerHTML = '<div class="loading" role="status">글 목록을 불러오는 중…</div>';
    els.tree.innerHTML = '<p class="side-placeholder">불러오는 중…</p>';
    els.feedHead.innerHTML = '';
  }

  /* ---------- 폴더 트리 ---------- */

  function buildTree(posts) {
    const root = { name: '', path: '', children: new Map(), count: 0 };
    posts.forEach((p) => {
      root.count++;
      let node = root;
      p.folder.forEach((seg) => {
        if (!node.children.has(seg)) {
          node.children.set(seg, {
            name: seg,
            path: node.path ? node.path + '/' + seg : seg,
            children: new Map(),
            count: 0,
          });
        }
        node = node.children.get(seg);
        node.count++;
      });
    });
    return root;
  }

  const sortedChildren = (node) =>
    Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  const CHEVRON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderTree() {
    if (!state.root) return;
    const allActive = state.folder === '';
    let html = '<ul class="tree" role="list">' +
      '<li class="tree-all"><div class="tree-row">' +
      '<button type="button" class="tree-item" data-folder="" aria-current="' + allActive + '">' +
      '<span class="name">전체 보기</span><span class="count">' + state.root.count + '</span></button>' +
      '</div></li>';
    html += sortedChildren(state.root).map((n) => nodeHtml(n, 0)).join('');
    html += '</ul>';
    els.tree.innerHTML = html;
  }

  function nodeHtml(node, depth) {
    const kids = sortedChildren(node);
    const hasKids = kids.length > 0;
    const collapsed = state.collapsed.has(node.path);
    const active = state.folder === node.path;
    const p = esc(node.path);
    return '<li class="tree-node' + (collapsed ? ' is-collapsed' : '') + '">' +
      '<div class="tree-row" style="--depth:' + depth + '">' +
      (hasKids
        ? '<button type="button" class="tree-toggle" data-toggle="' + p + '" aria-expanded="' + !collapsed +
          '" aria-label="' + esc(node.name) + ' 하위 폴더 ' + (collapsed ? '펼치기' : '접기') + '">' + CHEVRON + '</button>'
        : '<span class="tree-toggle-spacer"></span>') +
      '<button type="button" class="tree-item" data-folder="' + p + '" aria-current="' + active + '" title="' + p + '">' +
      '<span class="name">' + esc(node.name) + '</span><span class="count">' + node.count + '</span></button>' +
      '</div>' +
      (hasKids ? '<ul role="list">' + kids.map((k) => nodeHtml(k, depth + 1)).join('') + '</ul>' : '') +
      '</li>';
  }

  // 트리를 다시 그리지 않고 선택 표시만 갱신
  function updateTreeActive() {
    els.tree.querySelectorAll('.tree-item').forEach((btn) => {
      btn.setAttribute('aria-current', String(btn.getAttribute('data-folder') === state.folder));
    });
  }

  function onTreeClick(e) {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const path = toggle.getAttribute('data-toggle');
      const li = toggle.closest('.tree-node');
      const collapsed = li.classList.toggle('is-collapsed');
      if (collapsed) state.collapsed.add(path); else state.collapsed.delete(path);
      const name = li.querySelector('.name').textContent;
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', name + ' 하위 폴더 ' + (collapsed ? '펼치기' : '접기'));
      return;
    }
    const item = e.target.closest('[data-folder]');
    if (item) {
      selectFolder(item.getAttribute('data-folder'));
      if (window.matchMedia('(max-width: 900px)').matches) {
        document.getElementById('main').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  function selectFolder(folder) {
    if (folder === state.folder) return;
    state.folder = folder;
    const url = folder ? '#folder=' + encodeURIComponent(folder) : location.pathname + location.search;
    history.pushState(null, '', url);
    updateTreeActive();
    renderFeed();
  }

  function readHash() {
    const m = /^#folder=(.*)$/.exec(location.hash);
    let folder = '';
    if (m) {
      try { folder = decodeURIComponent(m[1]); } catch (e) { folder = ''; }
    }
    state.folder = folder.replace(/^\/+|\/+$/g, '');
  }

  /* ---------- 피드 ---------- */

  function inFolder(post) {
    if (!state.folder) return true;
    return post.folderPath === state.folder || post.folderPath.startsWith(state.folder + '/');
  }

  // 검색 대상: 제목 + 본문 (state.query 는 이미 소문자)
  function matchesQuery(post) {
    const q = state.query;
    return !q || post.titleLower.includes(q) || post.bodyLower.includes(q);
  }

  // 카드는 목록이 바뀔 때만 한 번 만들고, 폴더/검색 변경 시엔 보이기/숨기기만
  function buildCards() {
    els.feed.innerHTML = state.posts.map(cardHtml).join('') + '<div id="feed-empty"></div>';
    state.cards = Array.from(els.feed.querySelectorAll('.card'));
    els.empty = document.getElementById('feed-empty');
  }

  function renderFeed() {
    if (!state.root) return;

    let count = 0;
    state.posts.forEach((p, i) => {
      const show = inFolder(p) && matchesQuery(p);
      state.cards[i].hidden = !show;
      if (show) count++;
    });

    const titleHtml = state.folder
      ? '<span class="crumb">' + S.crumbHtml(state.folder.split('/'), false) + '</span>'
      : '전체 글';
    els.feedHead.innerHTML =
      '<h1 class="feed-title">' + titleHtml + '</h1>' +
      '<p class="feed-count">' + count + '개의 글</p>';

    if (state.posts.length === 0) {
      els.empty.innerHTML =
        '<div class="notice">' +
        '<p class="notice-title">아직 작성된 글이 없어요</p>' +
        '<p>저장소의 <code>' + esc(S.postsPrefix) + '/</code> 폴더 안에 마크다운(<code>.md</code>) 파일을 추가하면 여기에 최신순으로 나타납니다. ' +
        '폴더를 만들어 넣으면 왼쪽 폴더 목록에도 자동으로 생겨요.</p>' +
        '<pre>' + esc(S.postsPrefix) + '/공부/리액트/첫-글.md\n\n---\ntitle: 글 제목\ndate: 2026-01-01\nexcerpt: 목록에 보일 한두 문장 요약\n---\n\n본문을 마크다운으로 씁니다.</pre>' +
        '</div>';
    } else if (count === 0) {
      els.empty.innerHTML = state.query
        ? '<div class="notice"><p class="notice-title">검색 결과가 없어요</p>' +
          '<p>“' + esc(els.search.value.trim()) + '”에 맞는 글을 ' + (state.folder ? '이 폴더에서 ' : '') +
          '찾지 못했어요. 다른 단어로 검색해 보거나 ' +
          (state.folder ? '<a href="index.html" data-action="show-all">전체 글</a>에서 찾아보세요.' : '철자를 확인해 보세요.') + '</p></div>'
        : '<div class="notice"><p class="notice-title">이 폴더에는 글이 없어요</p>' +
          '<p>“' + esc(state.folder) + '” 폴더를 찾을 수 없거나 아직 글이 없습니다. ' +
          '<a href="index.html" data-action="show-all">전체 글 보기</a></p></div>';
    } else {
      els.empty.innerHTML = '';
    }
  }

  function cardHtml(p) {
    const crumb = p.folder.length ? '<span class="crumb">' + S.crumbHtml(p.folder, false) + '</span>' : '';
    const date = p.date ? '<time datetime="' + esc(p.date) + '">' + esc(S.formatDate(p.date)) + '</time>' : '';
    const meta = [crumb, date].filter(Boolean).join('<span class="dot" aria-hidden="true">·</span>');
    return '<article class="card">' +
      '<a class="card-link" href="' + esc(S.postHref(p.slug)) + '">' +
      '<div class="thumb">' + S.thumbnailSVG(p.title) + '</div>' +
      '<div class="card-body">' +
      (meta ? '<div class="card-meta">' + meta + '</div>' : '') +
      '<h2 class="card-title">' + esc(p.title) + '</h2>' +
      (p.excerpt ? '<p class="card-excerpt">' + esc(p.excerpt) + '</p>' : '') +
      '</div></a></article>';
  }

  function renderError(err) {
    let title = '글 목록을 불러오지 못했어요';
    let body = '잠시 후 다시 시도해 주세요.';
    if (err.kind === 'ratelimit') {
      title = 'GitHub API 요청 한도에 잠시 걸렸어요';
      const when = err.resetAt
        ? new Date(err.resetAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ' 이후에'
        : '잠시 후';
      body = '로그인하지 않은 방문자는 GitHub API를 시간당 60번까지만 호출할 수 있어요. ' + when + ' 다시 시도해 주세요.';
    } else if (err.kind === 'notfound') {
      title = '저장소나 브랜치를 찾을 수 없어요';
      body = '<code>' + esc(C.owner + '/' + C.repo) + '</code> 저장소의 <code>' + esc(C.branch) +
        '</code> 브랜치를 찾지 못했습니다. 페이지 상단 CONFIG 값이 맞는지, 저장소가 공개(public) 상태인지 확인해 주세요.';
    } else if (err.kind === 'network') {
      body = '인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
    } else if (err.message) {
      body = 'GitHub 응답에 문제가 있었어요 (' + esc(err.message) + '). 잠시 후 다시 시도해 주세요.';
    }
    state.root = null;
    state.signature = null;
    els.feedHead.innerHTML = '';
    els.feed.innerHTML =
      '<div class="notice" role="alert">' +
      '<p class="notice-title">' + title + '</p>' +
      '<p>' + body + '</p>' +
      '<button type="button" class="btn" data-action="retry">다시 시도</button>' +
      '</div>';
    els.tree.innerHTML = '<p class="side-placeholder">폴더를 불러오지 못했어요.</p>';
    els.recent.innerHTML = '<li class="side-placeholder">—</li>';
    renderStats(0, '—');
  }

  /* ---------- 오른쪽 사이드바 ---------- */

  function renderSidebar() {
    const recent = state.posts.slice(0, 8);
    els.recent.innerHTML = recent.length
      ? recent.map((p) =>
          '<li><a href="' + esc(S.postHref(p.slug)) + '">' + esc(p.title) +
          (p.date ? '<time datetime="' + esc(p.date) + '">' + esc(S.formatDate(p.date)) + '</time>' : '') +
          '</a></li>').join('')
      : '<li class="side-placeholder">아직 글이 없어요.</li>';

    const latest = state.posts.map((p) => p.date).filter(Boolean).sort().pop();
    renderStats(state.posts.length, latest ? S.formatDate(latest) : '—');
  }

  function renderStats(posts, updated) {
    els.stats.innerHTML =
      '<div><dt>전체 글</dt><dd>' + posts + '개</dd></div>' +
      '<div><dt>마지막 업데이트</dt><dd>' + esc(updated) + '</dd></div>';
  }

  // 모든 상수/함수가 정의된 뒤에 시작 (저장된 목록은 첫 await 전에 동기적으로 그려지기 때문)
  load();
})();
