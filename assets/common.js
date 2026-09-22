/* ==========================================================================
   공통 유틸 — index.html / post.html 이 함께 사용
   (window.CONFIG 는 각 HTML 상단에서 정의)
   ========================================================================== */
(function () {
  'use strict';

  const C = window.CONFIG;
  const THEME_KEY = 'site-theme';
  const postsPrefix = C.postsPath.replace(/^\/+|\/+$/g, '');

  /* ---------- 테마 (라이트/다크) ---------- */

  const ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function initThemeToggle(btn) {
    if (!btn) return;
    const update = () => {
      const dark = currentTheme() === 'dark';
      // 버튼은 "눌렀을 때 바뀔 모드"를 보여줌
      btn.innerHTML = (dark ? ICON_SUN : ICON_MOON) +
        '<span class="label">' + (dark ? '라이트 모드' : '다크 모드') + '</span>';
      btn.setAttribute('aria-label', dark ? '라이트 모드로 전환' : '다크 모드로 전환');
      btn.setAttribute('aria-pressed', String(dark));
    };
    btn.addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 저장 불가 환경은 무시 */ }
      update();
    });
    update();
  }

  /* ---------- front matter ---------- */

  function parseFrontMatter(text) {
    text = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const m = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    if (!m) return { data: {}, body: text };
    const data = {};
    m[1].split('\n').forEach((line) => {
      const i = line.indexOf(':');
      if (i < 1) return;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      data[key] = value;
    });
    return { data, body: text.slice(m[0].length) };
  }

  /* ---------- 경로 / URL ---------- */

  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

  // raw.githubusercontent.com 은 API 요청 한도에 포함되지 않음
  function rawUrl(path) {
    return 'https://raw.githubusercontent.com/' +
      encodeURIComponent(C.owner) + '/' + encodeURIComponent(C.repo) + '/' +
      encPath(C.branch) + '/' + encPath(path);
  }

  // "posts/공부/리액트/글.md" -> "공부/리액트/글"
  function pathToSlug(path) {
    return path.slice(postsPrefix.length + 1).replace(/\.md$/i, '');
  }

  // "공부/리액트/글" -> "posts/공부/리액트/글.md"
  function slugToPath(slug) {
    return postsPrefix + '/' + slug + '.md';
  }

  function postHref(slug) {
    return 'post.html?slug=' + encPath(slug);
  }

  function folderHref(folderPath) {
    return folderPath ? 'index.html#folder=' + encodeURIComponent(folderPath) : 'index.html';
  }

  /* ---------- 로컬 캐시 ----------
     { checkedAt, files: [{ path, sha }], posts: { [path]: { sha, title, date, excerpt, body } } }
     - checkedAt : 마지막으로 트리 API 를 확인한 시각
     - sha       : git blob sha. 파일이 바뀌지 않았으면 본문을 다시 받지 않음            */

  const CACHE_KEY = 'site-cache:v1:' + C.owner + '/' + C.repo + '@' + C.branch + ':' + postsPrefix;

  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (c && Array.isArray(c.files) && c.posts && typeof c.posts === 'object') return c;
    } catch (e) { /* 무시 */ }
    return null;
  }

  function writeCache(c) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    } catch (e) {
      // 용량 초과 등 — 캐시 없이도 동작하므로 비우고 넘어감
      try { localStorage.removeItem(CACHE_KEY); } catch (_) { /* 무시 */ }
    }
  }

  // git blob sha1 = sha1("blob <바이트 수>\0" + 내용). 받은 파일이 트리의 sha 와 같은 버전인지 검증용
  async function gitBlobSha(buf) {
    if (!(window.crypto && crypto.subtle)) return null;
    const header = new TextEncoder().encode('blob ' + buf.byteLength + '\0');
    const all = new Uint8Array(header.length + buf.byteLength);
    all.set(header);
    all.set(new Uint8Array(buf), header.length);
    const digest = await crypto.subtle.digest('SHA-1', all);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* ---------- 표시용 ---------- */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatDate(s) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s || '');
    if (!m) return s || '';
    return m[1] + '년 ' + Number(m[2]) + '월 ' + Number(m[3]) + '일';
  }

  // 폴더 경로 배열 -> "공부 / 리액트" (linked=true 면 각 단계가 폴더 필터 링크)
  function crumbHtml(segments, linked) {
    return segments.map((seg, i) => {
      const label = escapeHtml(seg);
      if (!linked) return label;
      const href = folderHref(segments.slice(0, i + 1).join('/'));
      return '<a href="' + escapeHtml(href) + '">' + label + '</a>';
    }).join('<span class="sep" aria-hidden="true">/</span>');
  }

  /* ---------- 결정론적 흑백 썸네일 ---------- */

  // 문자열 -> 32bit 해시 (cyrb53 변형)
  function hashString(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h1 ^ h2) >>> 0;
  }

  // 시드 기반 난수 생성기 (mulberry32)
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 같은 제목 -> 항상 같은 SVG. 색은 currentColor + 투명도라 다크모드에서도 자연스러움
  function thumbnailSVG(seedText) {
    const r = mulberry32(hashString(String(seedText || '')));
    const W = 160, H = 120;
    const f = (n) => n.toFixed(1);
    const op = (min, span) => (min + r() * span).toFixed(2);
    const parts = [];
    const variant = Math.floor(r() * 4);

    if (variant === 0) {
      // 겹쳐진 원
      const n = 3 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        parts.push('<circle cx="' + f(r() * W) + '" cy="' + f(r() * H) + '" r="' + f(12 + r() * 46) +
          '" fill="currentColor" fill-opacity="' + op(0.07, 0.4) + '"/>');
      }
      parts.push('<circle cx="' + f(20 + r() * 120) + '" cy="' + f(20 + r() * 80) + '" r="' + f(4 + r() * 8) +
        '" fill="currentColor" fill-opacity="0.75"/>');
    } else if (variant === 1) {
      // 블록 그리드
      const cols = 2 + Math.floor(r() * 4), rows = 2 + Math.floor(r() * 3);
      const cw = W / cols, ch = H / rows;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const v = r();
          if (v < 0.35) continue;
          if (v > 0.88) {
            parts.push('<circle cx="' + f(x * cw + cw / 2) + '" cy="' + f(y * ch + ch / 2) + '" r="' +
              f(Math.min(cw, ch) * 0.38) + '" fill="currentColor" fill-opacity="' + op(0.25, 0.4) + '"/>');
          } else {
            parts.push('<rect x="' + f(x * cw) + '" y="' + f(y * ch) + '" width="' + f(cw) + '" height="' + f(ch) +
              '" fill="currentColor" fill-opacity="' + op(0.05, 0.35) + '"/>');
          }
        }
      }
    } else if (variant === 2) {
      // 기울어진 줄무늬 + 원 하나
      const angle = Math.floor(r() * 180);
      const n = 6 + Math.floor(r() * 10);
      const gap = 220 / n;
      const lines = [];
      for (let i = 0; i < n; i++) {
        const y = -50 + i * gap + r() * gap * 0.3;
        lines.push('<line x1="-60" y1="' + f(y) + '" x2="220" y2="' + f(y) + '" stroke="currentColor" stroke-width="' +
          f(0.8 + r() * 4) + '" stroke-opacity="' + op(0.12, 0.4) + '"/>');
      }
      parts.push('<g transform="rotate(' + angle + ' 80 60)">' + lines.join('') + '</g>');
      parts.push('<circle cx="' + f(30 + r() * 100) + '" cy="' + f(25 + r() * 70) + '" r="' + f(16 + r() * 22) +
        '" fill="currentColor" fill-opacity="' + op(0.2, 0.35) + '"/>');
    } else {
      // 동심원 호 + 수평선
      const cx = r() * W, cy = r() * H;
      const n = 4 + Math.floor(r() * 5);
      for (let i = 1; i <= n; i++) {
        parts.push('<circle cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f(i * (10 + r() * 6)) +
          '" fill="none" stroke="currentColor" stroke-width="' + f(0.8 + r() * 2.5) + '" stroke-opacity="' + op(0.15, 0.4) + '"/>');
      }
      const hy = 20 + r() * 80;
      parts.push('<rect x="0" y="' + f(hy) + '" width="' + W + '" height="' + f(6 + r() * 20) +
        '" fill="currentColor" fill-opacity="' + op(0.08, 0.2) + '"/>');
    }

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">' +
      '<rect class="thumb-bg" width="' + W + '" height="' + H + '"/>' + parts.join('') + '</svg>';
  }

  window.Site = {
    initThemeToggle,
    parseFrontMatter,
    rawUrl,
    pathToSlug,
    slugToPath,
    postHref,
    folderHref,
    escapeHtml,
    formatDate,
    crumbHtml,
    thumbnailSVG,
    readCache,
    writeCache,
    gitBlobSha,
    postsPrefix,
  };
})();
