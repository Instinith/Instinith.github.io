/* ==========================================================================
   post.html — slug 로 글 하나를 읽어 마크다운을 렌더링
   ========================================================================== */
(async function () {
  'use strict';

  const C = window.CONFIG;
  const S = window.Site;
  const esc = S.escapeHtml;
  const $article = document.getElementById('article');

  S.initThemeToggle(document.getElementById('theme-toggle'));

  const slug = (new URLSearchParams(location.search).get('slug') || '')
    .trim().replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '');

  if (!slug || slug.split('/').some((s) => !s || s === '.' || s === '..')) {
    showNotice('어떤 글을 열어야 할지 모르겠어요',
      '주소에 글 정보(slug)가 없거나 올바르지 않아요. 목록에서 글을 다시 선택해 주세요.');
    return;
  }

  const path = S.slugToPath(slug);
  const fileUrl = S.rawUrl(path);
  const segments = slug.split('/');
  const folder = segments.slice(0, -1);

  // 목록 페이지에서 저장해 둔 글이 있으면 네트워크를 기다리지 않고 먼저 표시
  const cache = S.readCache();
  const cached = cache && cache.posts[path];
  let shownKey = null;
  if (cached) render(cached, cached.body);

  let text;
  try {
    const res = await fetch(fileUrl);
    if (res.status === 404) {
      console.error('[post] 파일이 없습니다:', path);
      showNotice('글을 찾을 수 없어요',
        '<code>' + esc(path) + '</code> 파일이 없어요. 글이 옮겨졌거나 이름이 바뀌었을 수 있어요. ' +
        '방금 올린 글이라면 GitHub 반영까지 몇 분 걸릴 수 있으니 잠시 후 새로고침해 보세요.');
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
  } catch (e) {
    if (shownKey) {
      console.warn('[post] 최신 버전을 확인하지 못해 저장된 글을 보여줍니다:', e);
      return;
    }
    console.error('[post] 글을 불러오지 못했습니다:', e);
    showNotice('글을 불러오지 못했어요', '인터넷 연결을 확인하고 잠시 후 다시 시도해 주세요.', true);
    return;
  }

  const { data, body } = S.parseFrontMatter(text);
  render(data, body); // 저장본과 내용이 같으면 다시 그리지 않음

  /* ---------- helpers ---------- */

  function render(data, body) {
    const key = JSON.stringify([data.title || '', data.date || '', body]);
    if (key === shownKey) return;
    shownKey = key;

    const title = data.title || segments[segments.length - 1];
    if (data.excerpt) {
      const meta = document.querySelector('meta[name="description"]');
      if (meta) meta.setAttribute('content', data.excerpt);
    }

    $article.innerHTML =
      '<header class="post-header">' +
      (folder.length ? '<nav class="crumb" aria-label="폴더 경로">' + S.crumbHtml(folder, true) + '</nav>' : '') +
      '<h1 class="post-title">' + esc(title) + '</h1>' +
      (data.date ? '<p class="post-meta"><time datetime="' + esc(data.date) + '">' + esc(S.formatDate(data.date)) + '</time></p>' : '') +
      '</header>' +
      '<div class="prose">' + renderMarkdown(body) + '</div>' +
      '<footer class="post-footer"><a class="back-link" href="index.html">← 목록으로 돌아가기</a></footer>';

    fixRelativeUrls($article.querySelector('.prose'));
  }

  function renderMarkdown(md) {
    if (window.marked && typeof window.marked.parse === 'function') {
      let html = window.marked.parse(md, { gfm: true });
      if (window.DOMPurify) html = window.DOMPurify.sanitize(html);
      return html;
    }
    // 마크다운 라이브러리를 못 불러온 경우에도 내용은 읽을 수 있게
    console.warn('[post] marked 를 불러오지 못해 원문을 그대로 표시합니다.');
    return '<pre class="plain">' + esc(md) + '</pre>';
  }

  function isRelative(url) {
    return !!url && !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(url);
  }

  // 글 안의 상대경로 이미지/링크를 저장소 기준으로 바로잡기
  function fixRelativeUrls(root) {
    if (!root) return;
    const postsRoot = decodeURIComponent(new URL(S.rawUrl(S.postsPrefix + '/_')).pathname).slice(0, -1);

    root.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (isRelative(src)) img.setAttribute('src', new URL(src, fileUrl).href);
      img.setAttribute('loading', 'lazy');
    });

    root.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (isRelative(href) && /\.md(#.*)?$/i.test(href)) {
        const abs = new URL(href, fileUrl);
        const p = decodeURIComponent(abs.pathname);
        if (p.startsWith(postsRoot)) {
          a.setAttribute('href', S.postHref(p.slice(postsRoot.length).replace(/\.md$/i, '')) + abs.hash);
          return;
        }
      }
      if (/^https?:\/\//i.test(href) && new URL(href).host !== location.host) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  function showNotice(title, bodyHtml, retry) {
    $article.innerHTML =
      '<div class="notice" role="alert">' +
      '<p class="notice-title">' + esc(title) + '</p>' +
      '<p>' + bodyHtml + '</p>' +
      (retry ? '<button type="button" class="btn" onclick="location.reload()">다시 시도</button> ' : '') +
      '<a class="btn" href="index.html">목록으로</a>' +
      '</div>';
  }
})();
