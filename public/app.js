// Episwipe front end: show grid, owner "Manage" view and the full-screen swipe
// player. Progress and watched episodes are kept per browser in localStorage.
'use strict';

// One-time migration of progress saved before the rename (swiplex:* keys).
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('swiplex:')) continue;
    const nk = 'episwipe:' + k.slice('swiplex:'.length);
    if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k));
    localStorage.removeItem(k);
  }
} catch { /* storage unavailable: nothing to migrate */ }
const $ = (s) => document.querySelector(s);
const app = $('#app'), feed = $('#feed');
async function api(p, o) {
  const r = await fetch(p, o);
  if (r.status === 401) { showLogin(); throw new Error('login required'); }
  return r.json();
}

let me = null;
function showLogin() {
  me = null;
  if (!feed.classList.contains('hidden')) closeFeed(true);
  $('#navBtn').classList.add('hidden'); $('#meBtn').classList.add('hidden');
  const err = { denied: "That Plex account doesn't have access to this server.", failed: "Sign-in didn't finish. Please try again." }[new URLSearchParams(location.search).get('login')];
  app.innerHTML = `<div class="login">
    <h2>Watch your shows, swipe style</h2>
    <div>Sign in with the Plex account that has access to this server.</div>
    ${err ? `<div class="err">${err}</div>` : ''}
    <a class="plexbtn" href="/auth/login">Sign in with Plex</a>
  </div>`;
}

async function boot() {
  try { me = await api('/api/me'); } catch { return; }
  if (location.search) history.replaceState(null, '', '/');
  $('#meBtn').innerHTML = `${me.thumb ? `<img src="${esc(me.thumb)}" alt="">` : ''}<span>Sign out</span>`;
  $('#meBtn').classList.remove('hidden');
  $('#navBtn').classList.toggle('hidden', !me.owner);
  render();
}
$('#meBtn').onclick = async () => {
  if (!confirm(`Sign out ${me?.name || ''}?`)) return;
  await fetch('/auth/logout', { method: 'POST' });
  showLogin();
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let view = 'home';

$('#navBtn').onclick = () => { view = view === 'home' ? 'manage' : 'home'; render(); };

async function render() {
  if (!me?.owner) view = 'home';
  $('#navBtn').textContent = view === 'home' ? 'Manage' : 'Done';
  app.innerHTML = '<div class="empty">Loading…</div>';
  let shows;
  try { shows = await api('/api/shows'); } catch { return; }
  view === 'home' ? renderHome(shows) : renderManage(shows);
}

function renderHome(shows) {
  const sel = shows.filter((s) => s.selected);
  if (!sel.length) {
    app.innerHTML = `<div class="empty">No shows selected yet.<br>${me?.owner ? 'Tap <b>Manage</b> to pick shows and give them categories.' : 'Ask the server owner to add some.'}</div>`;
    return;
  }
  const cats = {};
  sel.forEach((s) => (cats[s.category] ||= []).push(s));
  app.innerHTML = Object.keys(cats).sort().map((c) => `
    <h2>${esc(c)}</h2>
    <div class="grid">${cats[c].map((s) => `
      <button class="show" data-id="${s.id}" data-title="${esc(s.title)}">
        ${s.thumb ? `<img loading="lazy" src="${esc(s.thumb)}" alt="">` : '<div class="ph"></div>'}
        <b>${esc(s.title)}</b><small>${s.episodes} episodes${progressLabel(s.id)}</small>
      </button>`).join('')}
    </div>`).join('');
  app.querySelectorAll('.show').forEach((b) => (b.onclick = () => openFeed(b.dataset.id, b.dataset.title)));
}

function progressLabel(id) {
  const p = getProgress(id);
  return p ? ` · on ep ${p.index + 1}` : '';
}

function renderManage(shows) {
  const cats = [...new Set(shows.map((s) => s.category).filter(Boolean))];
  app.innerHTML = `<datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>` +
    shows.map((s) => `
    <label class="row">
      <input type="checkbox" data-id="${s.id}" ${s.selected ? 'checked' : ''}>
      ${s.thumb ? `<img loading="lazy" src="${esc(s.thumb)}" alt="">` : ''}
      <span class="t"><b>${esc(s.title)}</b><small class="muted">${s.episodes} episodes</small></span>
      <input type="text" list="cats" placeholder="Category" value="${esc(s.category)}" data-cat="${s.id}">
    </label>`).join('');
  const save = (id) => api('/api/select', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, selected: app.querySelector(`[data-id="${id}"]`).checked, category: app.querySelector(`[data-cat="${id}"]`).value }),
  });
  app.querySelectorAll('input[type=checkbox]').forEach((c) => (c.onchange = () => save(c.dataset.id)));
  app.querySelectorAll('input[type=text]').forEach((t) => (t.onchange = () => {
    const c = app.querySelector(`[data-id="${t.dataset.cat}"]`);
    if (t.value.trim()) c.checked = true;
    save(t.dataset.cat);
  }));
}

// ---- progress (per browser) ----
const getProgress = (id) => { try { return JSON.parse(localStorage.getItem('episwipe:' + id)); } catch { return null; } };
const setProgress = (id, v) => { try { localStorage.setItem('episwipe:' + id, JSON.stringify(v)); } catch {} };

// ---- feed ----
const ui = $('#chrome'), sheet = $('#sheet'), seekEl = $('#seek');
let observer, currentShow, showTitle = '', eps = [];
let pendingSeek = 0, activeIndex = -1;

const slideAt = (i) => feed.querySelectorAll('.slide')[i];
const activeVideo = () => slideAt(activeIndex)?.querySelector('video');

// Watched episodes (per browser): indexes that were opened.
const getSeen = (id) => { try { return new Set(JSON.parse(localStorage.getItem('episwipe:seen:' + id)) || []); } catch { return new Set(); } };
const addSeen = (id, i) => { const s = getSeen(id); s.add(i); try { localStorage.setItem('episwipe:seen:' + id, JSON.stringify([...s])); } catch {} };

async function openFeed(showId, title) {
  currentShow = showId; showTitle = title;
  eps = await api(`/api/shows/${showId}/episodes`);
  feed.innerHTML = eps.map((e, i) => `<section class="slide" data-i="${i}"><video playsinline preload="none"></video></section>`).join('');
  feed.classList.remove('hidden'); ui.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  $('#pTitle').textContent = title;
  $('#epbarTxt').textContent = `EP 1-${eps.length}`;

  const slides = [...feed.querySelectorAll('.slide')];
  slides.forEach((s) => {
    const v = s.querySelector('video');
    s.onclick = () => {
      // While the UI is hidden, a tap only brings it back.
      if (ui.classList.contains('idle') && !v.paused) return wake();
      wake();
      userPaused = !v.paused;
      userPaused ? v.pause() : v.play();
    };
    v.onplay = () => { s.classList.remove('paused'); wake(); };
    v.onpause = () => { s.classList.add('paused'); wake(); };
    v.ontimeupdate = () => {
      if (+s.dataset.i !== activeIndex) return;
      drawSeek();
      if (Math.floor(v.currentTime) % 5 === 0) setProgress(currentShow, { index: activeIndex, time: v.currentTime });
    };
    v.onended = () => next(+s.dataset.i);
  });

  observer?.disconnect();
  observer = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (en.isIntersecting && en.intersectionRatio > 0.6) activate(+en.target.dataset.i);
  }), { root: feed, threshold: [0.6] });
  slides.forEach((s) => observer.observe(s));

  const p = getProgress(showId);
  const start = p && p.index < eps.length ? p.index : 0;
  slides[start].scrollIntoView();
  pendingSeek = p && p.index === start ? p.time : 0;
  activate(start);
}

function activate(i) {
  if (i === activeIndex) return;
  activeIndex = i;
  userPaused = false; stuck = 0; recoveries = 0;
  wake();
  feed.querySelectorAll('.slide').forEach((s, j) => {
    const v = s.querySelector('video');
    if (Math.abs(j - i) <= 1) load(v, eps[j]); else unload(v);
    if (j !== i) v.pause();
  });
  const v = activeVideo();
  if (pendingSeek) { const t = pendingSeek; pendingSeek = 0; v.addEventListener('loadedmetadata', () => (v.currentTime = t), { once: true }); }
  setProgress(currentShow, { index: i, time: v.currentTime || 0 });
  addSeen(currentShow, i);
  $('#pEp').textContent = `EP ${i + 1}`;
  $('#pSub').textContent = `EP ${i + 1} / ${eps.length}`;
  drawSeek();
  if (sheet.classList.contains('open')) renderSheet();
  tryPlay(v, i);
}

// play() can reject transiently (e.g. interrupted while loading); retry a few times.
// If the browser blocks autoplay with sound, stay paused (▶ shown); a tap plays it.
function tryPlay(v, i, n = 0) {
  v.play().catch((err) => {
    if (i !== activeIndex) return;
    if (err.name === 'NotAllowedError' || n >= 4) slideAt(i).classList.add('paused');
    else setTimeout(() => i === activeIndex && v.paused && tryPlay(v, i, n + 1), 300);
  });
}

function load(v, e) {
  if (v.dataset.loaded) return;
  v.dataset.loaded = 1;
  if (e.hls && !v.canPlayType('application/vnd.apple.mpegurl') && window.Hls?.isSupported()) {
    v._hls = new Hls(); v._hls.loadSource(e.src); v._hls.attachMedia(v);
  } else { v.src = e.src; }
  v.preload = 'auto';
}
function unload(v) {
  if (!v.dataset.loaded) return;
  delete v.dataset.loaded;
  v._hls?.destroy(); v._hls = null;
  v.pause(); v.removeAttribute('src'); v.load();
}

function jump(i) { slideAt(i)?.scrollIntoView(); }
function next(from) {
  if (from === activeIndex) slideAt(from + 1)?.scrollIntoView({ behavior: 'smooth' });
}

// Reload the active episode's stream and continue from where it was.
function reload(i = activeIndex) {
  const v = slideAt(i)?.querySelector('video');
  if (!v) return;
  const t = v.currentTime;
  unload(v); load(v, eps[i]);
  if (t > 0) v.addEventListener('loadedmetadata', () => (v.currentTime = t), { once: true });
  stuck = 0;
  tryPlay(v, i);
}

let toastTimer;
function toast(msg) {
  $('#toast').textContent = msg; $('#toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 1800);
}
$('#railReload').onclick = (e) => { e.stopPropagation(); userPaused = false; recoveries = 0; toast('Reloading…'); reload(); wake(); };

// Watchdog: if the episode should be playing but its clock hasn't moved for 3s,
// recover it: first a small seek, then a full reload (max 3 tries per episode).
// Near the end, a stall means the file never fires 'ended', so just move on.
let lastT = -1, stuck = 0, recoveries = 0, userPaused = false;
setInterval(() => {
  const v = activeVideo();
  if (!v || v.ended || userPaused || dragging || document.hidden || !v.dataset.loaded) { stuck = 0; lastT = -1; return; }
  const moved = v.currentTime !== lastT;
  lastT = v.currentTime;
  if (moved && !v.paused) { stuck = 0; return; }
  if (v.duration && v.duration - v.currentTime < 3 && !v.paused) return next(activeIndex);
  if (++stuck < 3 || recoveries >= 3) return;
  recoveries++; stuck = 0;
  if (recoveries === 1 && v.readyState >= 1) { v.currentTime = v.currentTime + 0.05; tryPlay(v, activeIndex); }
  else { toast('Reloading…'); reload(); }
}, 1000);

// ---- seek bar ----
const fmt = (t) => (t > 0 ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');
let dragging = false;
function drawSeek(ratio) {
  const v = activeVideo();
  const r = ratio ?? (v?.duration ? v.currentTime / v.duration : 0);
  seekEl.querySelector('.fill').style.width = r * 100 + '%';
  seekEl.querySelector('.knob').style.left = r * 100 + '%';
  const bubble = seekEl.querySelector('.bubble');
  bubble.style.left = Math.min(Math.max(r * 100, 8), 92) + '%';
  bubble.textContent = `${fmt(r * (v?.duration || 0))} / ${fmt(v?.duration)}`;
}
function seekRatio(e) {
  const b = seekEl.querySelector('.track').getBoundingClientRect();
  return Math.min(Math.max((e.clientX - b.left) / b.width, 0), 1);
}
seekEl.onpointerdown = (e) => {
  e.stopPropagation();
  dragging = true; seekEl.classList.add('drag'); seekEl.setPointerCapture(e.pointerId);
  wake(); drawSeek(seekRatio(e));
};
seekEl.onpointermove = (e) => { if (dragging) { wake(); drawSeek(seekRatio(e)); } };
seekEl.onpointerup = seekEl.onpointercancel = (e) => {
  if (!dragging) return;
  dragging = false; seekEl.classList.remove('drag');
  const v = activeVideo();
  if (v?.duration) v.currentTime = Math.min(seekRatio(e) * v.duration, v.duration - 0.1);
  drawSeek();
};
seekEl.onclick = (e) => e.stopPropagation();

// ---- episode sheet ----
const PAGE = 30;
let sheetPage = 0;
function openSheet() {
  sheetPage = Math.floor(activeIndex / PAGE);
  renderSheet();
  sheet.classList.add('open'); $('#backdrop').classList.add('open');
  wake();
}
function closeSheet() { sheet.classList.remove('open'); $('#backdrop').classList.remove('open'); wake(); }
function renderSheet() {
  $('#sTitle').textContent = showTitle;
  $('#sSub').textContent = `${eps.length} episodes · watching EP ${activeIndex + 1}`;
  const pages = Math.ceil(eps.length / PAGE);
  $('#sTabs').innerHTML = pages > 1 ? Array.from({ length: pages }, (_, p) =>
    `<button data-p="${p}" class="${p === sheetPage ? 'on' : ''}">${p * PAGE + 1}-${Math.min((p + 1) * PAGE, eps.length)}</button>`).join('') : '';
  $('#sTabs').classList.toggle('hidden', pages <= 1);
  const seen = getSeen(currentShow);
  const from = sheetPage * PAGE, to = Math.min(from + PAGE, eps.length);
  let html = '';
  for (let i = from; i < to; i++) html += `<button data-i="${i}" class="${i === activeIndex ? 'cur' : seen.has(i) ? 'seen' : ''}">${i + 1}</button>`;
  $('#sEps').innerHTML = html;
}
$('#sTabs').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { sheetPage = +b.dataset.p; renderSheet(); } };
$('#sEps').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { closeSheet(); jump(+b.dataset.i); } };
$('#railEps').onclick = $('#epbar').onclick = (e) => { e.stopPropagation(); openSheet(); };
$('#sClose').onclick = $('#backdrop').onclick = closeSheet;

// ---- auto-hide: show UI, then hide it after a few seconds while playing ----
let idleTimer;
function wake() {
  ui.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const v = activeVideo();
    if (v && !v.paused && !dragging && !sheet.classList.contains('open')) ui.classList.add('idle');
  }, 3000);
}
feed.addEventListener('mousemove', wake);

function closeFeed(skipRender) {
  closeSheet();
  feed.querySelectorAll('video').forEach(unload);
  observer?.disconnect(); activeIndex = -1;
  feed.classList.add('hidden'); ui.classList.add('hidden');
  document.body.style.overflow = '';
  if (skipRender !== true) render();
}
$('#closeFeed').onclick = () => closeFeed();
document.addEventListener('keydown', (e) => {
  if (feed.classList.contains('hidden')) return;
  wake();
  const v = activeVideo();
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); next(activeIndex); }
  if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); slideAt(activeIndex - 1)?.scrollIntoView({ behavior: 'smooth' }); }
  if (e.key === ' ') { e.preventDefault(); slideAt(activeIndex)?.click(); }
  if (e.key === 'ArrowLeft' && v?.duration) v.currentTime = Math.max(v.currentTime - 10, 0);
  if (e.key === 'ArrowRight' && v?.duration) v.currentTime = Math.min(v.currentTime + 10, v.duration - 0.1);
  if (e.key === 'e') sheet.classList.contains('open') ? closeSheet() : openSheet();
  if (e.key === 'Escape') sheet.classList.contains('open') ? closeSheet() : closeFeed();
});

boot();
