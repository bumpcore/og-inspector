const $ = (id) => document.getElementById(id);

const state = {
  tab: null,
  source: 'raw',
  results: { raw: null, dom: null },
  renderId: 0,
};

const imageCache = new Map();

// ---------- DOM helper (page content is untrusted: never use innerHTML) ----------

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function safeHref(url) {
  return /^https?:\/\//i.test(url || '') ? url : null;
}

// ---------- Fetching ----------

async function fetchRaw(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'follow' });
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  const html = /html|xml/i.test(contentType) || !contentType ? await res.text() : '';
  return { html, status: res.status, finalUrl: res.url, contentType };
}

async function readDom(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ html: document.documentElement.outerHTML, url: location.href }),
  });
  return { html: injection.result.html, finalUrl: injection.result.url, status: null };
}

function probeImage(url) {
  if (!imageCache.has(url)) imageCache.set(url, doProbeImage(url));
  return imageCache.get(url);
}

async function doProbeImage(url) {
  const out = { url };
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    out.status = res.status;
    out.finalUrl = res.url;
    out.type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (res.ok) {
      const blob = await res.blob();
      out.bytes = blob.size;
      out.type ||= blob.type;
      out.src = URL.createObjectURL(blob);
    }
  } catch (err) {
    out.fetchError = err.message || String(err);
  }
  try {
    const img = await loadImg(out.src || url);
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
    out.src ||= url;
  } catch {
    out.decodeError = true;
  }
  return out;
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ---------- Parsing ----------

function parseMeta(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tags = [];
  for (const m of doc.querySelectorAll('meta')) {
    const key = m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop');
    const value = m.getAttribute('content');
    if (key && value != null) tags.push({ key: key.trim(), lkey: key.trim().toLowerCase(), value: value.trim() });
  }
  const linkHref = (sel) => doc.querySelector(sel)?.getAttribute('href') || null;
  const meta = {
    pageUrl,
    tags,
    title: doc.querySelector('title')?.textContent.trim() || '',
    canonical: linkHref('link[rel~="canonical" i]'),
    icon: linkHref('link[rel~="icon" i]') || linkHref('link[rel="apple-touch-icon" i]'),
    get: (k) => tags.find((t) => t.lkey === k)?.value || '',
    all: (k) => tags.filter((t) => t.lkey === k).map((t) => t.value),
  };
  return meta;
}

function abs(url, base) {
  if (!url) return '';
  try {
    return new URL(url, base).href;
  } catch {
    return '';
  }
}

function resolveCard(meta) {
  const g = meta.get;
  const base = meta.pageUrl;
  const ogImageRaw = g('og:image') || g('og:image:url') || g('og:image:secure_url');
  const twImageRaw = g('twitter:image') || g('twitter:image:src');
  const title = g('og:title') || meta.title;
  const description = g('og:description') || g('description');
  const image = abs(ogImageRaw || twImageRaw, base);
  const url = abs(g('og:url') || meta.canonical, base) || base;
  return {
    title,
    description,
    siteName: g('og:site_name'),
    url,
    host: hostOf(url),
    image,
    ogImageRaw,
    imageAlt: g('og:image:alt') || g('twitter:image:alt'),
    themeColor: g('theme-color'),
    icon: abs(meta.icon || '/favicon.ico', base),
    tw: {
      card: g('twitter:card').toLowerCase(),
      title: g('twitter:title') || title,
      description: g('twitter:description') || description,
      image: abs(twImageRaw || ogImageRaw, base),
    },
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------- Checks ----------

function runChecks(meta, card, img, twImg, source) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const g = meta.get;
  const raw = state.results.raw;
  const dom = state.results.dom;

  if (source === 'raw') {
    if (raw?.error) add('error', `Crawler fetch failed: ${raw.error}`);
    else if (raw && raw.status !== 200) add('error', `Crawlers get HTTP ${raw.status} for this URL.`);
  }

  if (!g('og:title')) add(meta.title ? 'warn' : 'error', meta.title ? 'og:title missing, falling back to <title>.' : 'og:title missing.');
  if (!g('og:description')) add('warn', g('description') ? 'og:description missing, falling back to meta description.' : 'og:description missing.');
  if (!card.ogImageRaw) add(card.image ? 'warn' : 'error', card.image ? 'og:image missing, only twitter:image is set.' : 'og:image missing: no image will be shown.');
  if (!g('og:url')) add('info', 'og:url missing.');
  if (!g('og:type')) add('info', 'og:type missing (defaults to "website").');
  if (!card.tw.card) add('info', 'twitter:card missing: X falls back to the small "summary" card.');

  if (card.ogImageRaw) {
    if (!/^https?:\/\//i.test(card.ogImageRaw)) add('warn', 'og:image is not an absolute URL. Many crawlers will ignore it.');
    else if (/^http:\/\//i.test(card.ogImageRaw)) add('warn', 'og:image uses http. Use https.');
    if (meta.all('og:image').length > 1) add('info', `${meta.all('og:image').length} og:image tags; most platforms use the first.`);
  }

  if (img) imageChecks(img, 'og:image', add, card);
  if (twImg && twImg !== img) imageChecks(twImg, 'twitter:image', add, card);

  if (img?.width && card.ogImageRaw) {
    const dw = parseInt(g('og:image:width'), 10);
    const dh = parseInt(g('og:image:height'), 10);
    if (dw && dh && (dw !== img.width || dh !== img.height)) {
      add('warn', `og:image:width/height say ${dw}×${dh}, actual image is ${img.width}×${img.height}.`);
    }
  }
  if (card.image && !card.imageAlt) add('info', 'og:image:alt missing.');

  if (card.title.length > 70) add('info', `Title is ${card.title.length} chars; likely truncated.`);
  if (card.description.length > 200) add('info', `Description is ${card.description.length} chars; likely truncated.`);

  if (source === 'raw' && raw?.html && dom?.html) {
    const domMeta = parseMeta(dom.html, dom.finalUrl);
    for (const key of ['og:title', 'og:description', 'og:image', 'twitter:card', 'twitter:image']) {
      const a = g(key);
      const b = domMeta.get(key);
      if (!a && b) add('warn', `${key} only exists after JavaScript runs. Crawlers won't see it.`);
      else if (a && b && a !== b) add('info', `${key} is changed by JavaScript; crawlers see the original.`);
    }
  }

  if (!out.some((c) => c.level === 'error' || c.level === 'warn')) add('ok', 'No problems found.');
  const order = { error: 0, warn: 1, info: 2, ok: 3 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

function imageChecks(img, label, add, card) {
  if (img.fetchError) add('error', `${label} could not be fetched (${img.fetchError}).`);
  else if (img.status && img.status !== 200) add('error', `${label} returns HTTP ${img.status}.`);
  if (img.decodeError && !img.fetchError) add('error', `${label} did not decode as an image.`);
  if (img.type) {
    if (img.type.includes('svg')) add('error', `${label} is SVG; most platforms don't render SVG previews.`);
    else if (!img.type.startsWith('image/')) add('error', `${label} is served as "${img.type}", not an image.`);
  }
  if (img.bytes > 8 * 1024 * 1024) add('error', `${label} is ${fmtBytes(img.bytes)}; Facebook's limit is 8 MB.`);
  else if (img.bytes > 5 * 1024 * 1024) add('warn', `${label} is ${fmtBytes(img.bytes)}; X's limit is 5 MB.`);
  if (img.width && img.height) {
    const ratio = img.width / img.height;
    if (img.width < 200 || img.height < 200) add('error', `${label} is ${img.width}×${img.height}; minimum is 200×200.`);
    else if (img.width < 600 || img.height < 315) add('warn', `${label} is ${img.width}×${img.height}; below 600×315 most platforms show a small thumbnail.`);
    const wantsSquare = label === 'twitter:image' ? card.tw.card !== 'summary_large_image' : false;
    if (!wantsSquare && Math.abs(ratio - 1.91) > 0.15) add('warn', `${label} ratio is ${fmtRatio(img.width, img.height)}; large cards are 1.91:1 (1200×630) and will crop it.`);
  }
}

// ---------- Previews ----------

function previewImage(img, cls, alt) {
  if (!img?.src || img.decodeError) return h('div', { class: `${cls} noimg` }, 'No image');
  return h('img', { class: cls, src: img.src, alt: alt || '' });
}

function previewFacebook(card, img) {
  return h('div', { class: 'pv fb' },
    card.image && previewImage(img, 'pv-img wide', card.imageAlt),
    h('div', { class: 'fb-body' },
      h('div', { class: 'fb-host' }, card.host.toUpperCase()),
      h('div', { class: 'fb-title clamp2' }, card.title),
      card.description && h('div', { class: 'fb-desc clamp1' }, card.description)));
}

function previewX(card, img) {
  const tw = card.tw;
  if (tw.card === 'summary_large_image' && tw.image) {
    return h('div', { class: 'pv x' },
      h('div', { class: 'x-large' },
        previewImage(img, 'pv-img wide', card.imageAlt),
        h('span', { class: 'x-overlay' }, tw.title)),
      h('div', { class: 'x-from' }, `From ${card.host}`));
  }
  return h('div', { class: 'pv x x-summary' },
    tw.image ? previewImage(img, 'x-thumb') : h('div', { class: 'x-thumb noimg' }, '▤'),
    h('div', { class: 'x-body' },
      h('div', { class: 'x-host' }, card.host),
      h('div', { class: 'x-title clamp1' }, tw.title),
      tw.description && h('div', { class: 'x-desc clamp2' }, tw.description)));
}

function previewLinkedIn(card, img) {
  return h('div', { class: 'pv li' },
    card.image && previewImage(img, 'pv-img wide', card.imageAlt),
    h('div', { class: 'li-body' },
      h('div', { class: 'li-title clamp2' }, card.title),
      h('div', { class: 'li-host' }, card.host)));
}

function previewDiscord(card, img) {
  const large = card.tw.card === 'summary_large_image';
  const el = h('div', { class: `pv dc${large ? '' : ' dc-thumb'}` },
    h('div', { class: 'dc-text' },
      card.siteName && h('div', { class: 'dc-site' }, card.siteName),
      h('div', { class: 'dc-title' }, card.title),
      card.description && h('div', { class: 'dc-desc clamp3' }, card.description),
      large && card.image && previewImage(img, 'pv-img dc-img', card.imageAlt)),
    !large && card.image && previewImage(img, 'dc-small'));
  if (card.themeColor) el.style.borderLeftColor = card.themeColor;
  return el;
}

function previewSlack(card, img) {
  const large = card.tw.card === 'summary_large_image';
  return h('div', { class: 'pv sl' },
    h('div', { class: 'sl-main' },
      h('div', { class: 'sl-site' },
        h('img', { class: 'sl-icon', src: card.icon, alt: '', onerror: (e) => e.target.remove() }),
        card.siteName || card.host),
      h('div', { class: 'sl-title' }, card.title),
      card.description && h('div', { class: 'sl-desc clamp3' }, card.description),
      large && card.image && previewImage(img, 'pv-img sl-img', card.imageAlt)),
    !large && card.image && previewImage(img, 'sl-small'));
}

function previewWhatsApp(card, img) {
  return h('div', { class: 'pv wa' },
    card.image && previewImage(img, 'pv-img wide', card.imageAlt),
    h('div', { class: 'wa-body' },
      h('div', { class: 'wa-title clamp2' }, card.title),
      card.description && h('div', { class: 'wa-desc clamp2' }, card.description),
      h('div', { class: 'wa-host' }, card.host)));
}

// ---------- Rendering ----------

function showStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('error', isError);
}

function setSections(visible) {
  for (const id of ['image-section', 'checks-section', 'previews-section', 'tags-section']) $(id).hidden = !visible;
}

async function render() {
  const id = ++state.renderId;
  const result = state.results[state.source];
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.source === state.source));

  if (!result?.html) {
    setSections(false);
    showStatus(result?.error ? `Could not read page: ${result.error}` : 'Nothing to show.', true);
    return;
  }

  const meta = parseMeta(result.html, result.finalUrl || state.tab.url);
  const card = resolveCard(meta);
  showStatus(card.image ? 'Loading image…' : '');
  renderTags(meta);
  $('tags-section').hidden = false;

  const [img, twImg] = await Promise.all([
    card.image ? probeImage(card.image) : null,
    card.tw.image && card.tw.image !== card.image ? probeImage(card.tw.image) : null,
  ]);
  if (id !== state.renderId) return;

  showStatus('');
  renderImage(card, img);
  renderChecks(runChecks(meta, card, img, twImg, state.source));
  renderPreviews(card, img, twImg || img);
  setSections(true);
  $('image-section').hidden = !card.image;
}

function renderImage(card, img) {
  const frame = $('image-frame');
  const stats = $('image-stats');
  frame.replaceChildren();
  stats.replaceChildren();
  if (!img) return;
  frame.append(previewImage(img, 'main-img', card.imageAlt));

  const rows = [];
  if (img.width) rows.push(['Size', `${img.width} × ${img.height}`], ['Ratio', fmtRatio(img.width, img.height)]);
  if (img.bytes != null) rows.push(['File', fmtBytes(img.bytes)]);
  if (img.type) rows.push(['Type', img.type]);
  if (img.status) rows.push(['HTTP', String(img.status)]);
  if (img.fetchError) rows.push(['Error', img.fetchError]);
  for (const [k, v] of rows) stats.append(h('dt', {}, k), h('dd', {}, v));
  stats.append(h('dt', {}, 'URL'), h('dd', {}, h('a', { href: safeHref(card.image), target: '_blank', rel: 'noreferrer', class: 'url' }, card.image)));
}

function renderChecks(checks) {
  const icons = { error: '✕', warn: '!', info: 'i', ok: '✓' };
  $('checks').replaceChildren(...checks.map((c) =>
    h('li', { class: `check ${c.level}` }, h('span', { class: 'badge' }, icons[c.level]), h('span', {}, c.text))));
  const count = (lvl) => checks.filter((c) => c.level === lvl).length;
  const counts = $('check-counts');
  counts.replaceChildren();
  if (count('error')) counts.append(h('span', { class: 'pill error' }, `${count('error')} error${count('error') > 1 ? 's' : ''}`));
  if (count('warn')) counts.append(h('span', { class: 'pill warn' }, `${count('warn')} warning${count('warn') > 1 ? 's' : ''}`));
}

function renderPreviews(card, img, twImg) {
  const items = [
    ['Facebook', previewFacebook(card, img)],
    [`X · ${card.tw.card || 'summary (fallback)'}`, previewX(card, twImg)],
    ['LinkedIn', previewLinkedIn(card, img)],
    ['Discord', previewDiscord(card, img)],
    ['Slack', previewSlack(card, img)],
    ['WhatsApp', previewWhatsApp(card, img)],
  ];
  $('previews').replaceChildren(...items.map(([label, el]) =>
    h('div', { class: 'pv-wrap' }, h('div', { class: 'pv-label' }, label), el)));
}

const TAG_PREFIXES = ['og:', 'twitter:', 'fb:', 'article:', 'profile:', 'book:', 'music:', 'video:'];
const TAG_NAMES = ['description', 'theme-color'];

function renderTags(meta) {
  const rows = [['<title>', meta.title]];
  if (meta.canonical) rows.push(['canonical', meta.canonical]);
  for (const t of meta.tags) {
    if (TAG_PREFIXES.some((p) => t.lkey.startsWith(p)) || TAG_NAMES.includes(t.lkey)) rows.push([t.key, t.value]);
  }
  $('tags').replaceChildren(...rows.map(([k, v]) => {
    const href = /^(https?:)?\/\/|^\//i.test(v) ? safeHref(abs(v, meta.pageUrl)) : null;
    return h('tr', {},
      h('th', {}, k),
      h('td', {}, href ? h('a', { href, target: '_blank', rel: 'noreferrer' }, v) : v || h('em', {}, 'empty')));
  }));
  $('copy-tags').onclick = async () => {
    await navigator.clipboard.writeText(rows.map(([k, v]) => `${k}\t${v}`).join('\n'));
    $('copy-tags').textContent = 'copied';
    setTimeout(() => ($('copy-tags').textContent = 'copy'), 1200);
  };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtRatio(w, h) {
  return `${(w / h).toFixed(2)}:1`;
}

// ---------- Boot ----------

async function load() {
  const tab = state.tab;
  setSections(false);
  showStatus('Reading page…');
  imageCache.clear();

  const [raw, dom] = await Promise.allSettled([fetchRaw(tab.url), readDom(tab.id)]);
  state.results.raw = raw.status === 'fulfilled' ? raw.value : { error: raw.reason?.message || String(raw.reason) };
  state.results.dom = dom.status === 'fulfilled' ? dom.value : { error: dom.reason?.message || String(dom.reason) };

  $('src-raw').disabled = !state.results.raw.html;
  $('src-dom').disabled = !state.results.dom.html;
  if (!state.results[state.source].html) state.source = state.results.raw.html ? 'raw' : 'dom';
  await render();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  const url = tab?.url || '';

  $('host').textContent = hostOf(url) || 'This page';
  $('page-url').textContent = url;
  if (tab?.favIconUrl) $('favicon').src = tab.favIconUrl;
  else $('favicon').hidden = true;

  const enc = encodeURIComponent(url);
  $('fb-debug').href = `https://developers.facebook.com/tools/debug/?q=${enc}`;
  $('li-debug').href = `https://www.linkedin.com/post-inspector/inspect/${enc}`;
  $('ogxyz').href = `https://www.opengraph.xyz/url/${enc}`;

  if (!/^https?:/i.test(url)) {
    showStatus('Open a regular http(s) page to inspect it.', true);
    document.querySelectorAll('.seg-btn, #reload').forEach((b) => (b.disabled = true));
    return;
  }

  document.querySelectorAll('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.source = b.dataset.source;
      render();
    }));
  $('reload').addEventListener('click', load);
  await load();
}

init();
