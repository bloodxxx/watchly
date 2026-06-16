/**
 * Watchly — Room Player v10
 *
 * VK Video : VK.VideoPlayer SDK (play/pause/seek через JS API)
 * RuTube   : postMessage protocol (player:play / player:pause / player:setCurrentTime)
 * YouTube  : официальный IFrame API
 *
 * Перезагрузка iframe выполняется ТОЛЬКО при смене источника видео.
 * Все play/pause/seek идут через JS API без reload — синхронизация работает
 * на VK / RuTube / YouTube одинаково.
 *
 * v10: синхронная перемотка для всех участников, паузы от участников
 */

(function () {
  'use strict';

  const IS_HOST = (CURRENT_USER === ROOM_HOST);

  /* ─── DOM ─── */
  const videoArea         = document.getElementById('video-area');
  const videoUrlInput     = document.getElementById('video-url-input');
  const loadVideoBtn      = document.getElementById('load-video-btn');
  const urlError          = document.getElementById('url-error');
  const videoFileInput    = document.getElementById('video-file-input');
  const uploadProgress    = document.getElementById('upload-progress');
  const uploadProgressBar = document.getElementById('upload-progress-bar');
  const uploadProgressTxt = document.getElementById('upload-progress-text');
  const btnEndSession     = document.getElementById('btn-end-session');
  const btnPlay           = document.getElementById('btn-play');
  const btnSync           = document.getElementById('btn-sync');
  const timeDisplay       = document.getElementById('time-display');
  const durationDisplay   = document.getElementById('duration-display');
  const seekBar           = document.getElementById('seek-bar');
  const wsDot             = document.getElementById('ws-dot');
  const wsStatus          = document.getElementById('ws-status');
  const chatMessages      = document.getElementById('chat-messages');
  const chatInput         = document.getElementById('chat-input');
  const chatSendBtn       = document.getElementById('chat-send-btn');
  const participantsList  = document.getElementById('participants-list');
  const participantsCount = document.getElementById('participants-count');
  const sessionOverlay    = document.getElementById('session-overlay');
  const overlayText       = document.getElementById('overlay-text');
  const overlaySubtext    = document.getElementById('overlay-subtext');
  const overlaySpinner    = document.getElementById('overlay-spinner');
  const readyBar          = document.getElementById('ready-bar');
  const readyCount        = document.getElementById('ready-count');
  const readyTotal        = document.getElementById('ready-total');

  /* ─── Состояние ─── */
  let ws              = null;
  let currentPlatform = null;
  let currentEmbed    = null;

  let localTime     = 0;
  let localPlaying  = false;
  let timerInterval = null;

  let playerReady      = false;
  let suppressUntil    = 0;
  let waitingForPlayAt = false;

  let participantsState      = {};
  let participantsList_order = [];
  let readySet               = new Set();
  let totalParticipants      = 1;

  let hostTime          = 0;
  let hostPlaying       = false;
  let hostTimeUpdatedAt = 0;

  let videoDuration   = 0;   // общая длительность видео (сек)
  let seekBarDragging = false;

  let scheduledPlayTimer = null;
  const PLAY_RESUME_MS   = 600;
  const PLAY_BUFFER_MS   = 5000;
  let videoEverStarted   = false;

  /* ─── Анонимный режим ─── */
  // IS_ANONYMOUS задаётся в шаблоне detail.html, поэтому читаем сразу
  let isAnonymous = (typeof IS_ANONYMOUS !== 'undefined') ? IS_ANONYMOUS : false;
  let anonMap     = {};   // username → 'Участник N'
  let anonCounter = 0;

  function anonName(username) {
    if (!isAnonymous) return username;
    if (!anonMap[username]) {
      anonCounter += 1;
      anonMap[username] = 'Участник ' + anonCounter;
    }
    return anonMap[username];
  }

  /* ─── Очередь команд для VK/RuTube, пока плеер не готов ─── */
  let pendingPlayerCmd = null; // { action: 'play'|'pause'|'seek', time }

  /* ─── YouTube IFrame API ─── */
  let ytPlayer             = null;
  let ytApiReady           = false;
  let ytPendingLoad        = null;
  let ytPendingPlay        = null;
  let ytPauseDebounceTimer = null;
  let ytTimePoller         = null;

  /* ─── VK SDK ─── */
  let vkSdkReady   = false;
  let vkSdkLoading = false;
  let vkPlayer     = null;       // VK.VideoPlayer instance
  let vkPendingInit = null;      // { iframe, startSec }
  let vkTimePoller = null;

  /* ─── RuTube ─── */
  let rtTimePoller = null;

  function loadVKSdk() {
    if (vkSdkReady || vkSdkLoading) return;
    vkSdkLoading = true;
    const tag = document.createElement('script');
    tag.id  = 'vk-videoplayer-sdk';
    tag.src = 'https://vk.com/js/api/videoplayer.js';
    tag.onload = () => {
      vkSdkReady = true;
      if (vkPendingInit) {
        const p = vkPendingInit; vkPendingInit = null;
        initVKPlayer(p.iframe, p.startSec);
      }
    };
    tag.onerror = () => { vkSdkLoading = false; };
    document.head.appendChild(tag);
  }

  function initVKPlayer(iframe, startSec) {
    if (!vkSdkReady || !window.VK || !VK.VideoPlayer) {
      vkPendingInit = { iframe, startSec };
      return;
    }
    try {
      vkPlayer = VK.VideoPlayer(iframe);
    } catch (e) {
      vkPlayer = null;
      return;
    }
    vkPlayer.on('inited',     () => { signalReady(); if (startSec) { try { vkPlayer.seek(startSec); } catch(_){} } flushPendingCmd(); });
    vkPlayer.on('started',    () => onRemotePlay());
    vkPlayer.on('resumed',    () => onRemotePlay());
    vkPlayer.on('paused',     () => onRemotePause());
    vkPlayer.on('ended',      () => { localPlaying = false; stopTimer(); updatePlayBtn(); });
    vkPlayer.on('timeupdate', (s) => {
      const t = (s && typeof s.time === 'number') ? s.time : null;
      if (t !== null) { if (!playerReady) signalReady(); localTime = t; timeDisplay.textContent = fmt(t); }
    });
    vkPlayer.on('error', () => showOverlay('Ошибка VK плеера', 'Попробуйте перезагрузить страницу', false));

    // На некоторых видео inited не приходит — fallback
    setTimeout(() => { if (!playerReady) signalReady(); flushPendingCmd(); }, 4000);
    startVKTimePoller();
  }

  function destroyVKPlayer() {
    if (vkTimePoller) { clearInterval(vkTimePoller); vkTimePoller = null; }
    if (vkPlayer) { try { vkPlayer.destroy(); } catch(_){} vkPlayer = null; }
  }

  function startVKTimePoller() {
    if (vkTimePoller) clearInterval(vkTimePoller);
    vkTimePoller = setInterval(() => {
      if (!vkPlayer || currentPlatform !== 'vk') return;
      try {
        const t = vkPlayer.getCurrentTime();
        if (typeof t === 'number' && !isNaN(t)) { localTime = t; timeDisplay.textContent = fmt(t); updateSeekBar(); }
        const d = vkPlayer.getDuration ? vkPlayer.getDuration() : 0;
        if (typeof d === 'number' && d > 0 && d !== videoDuration) { videoDuration = d; updateSeekBar(); }
      } catch(_) {}
    }, 700);
  }

  /* ─── RuTube postMessage helpers ─── */
  function rtPost(type, data) {
    const fr = document.getElementById('video-iframe');
    if (!fr || !fr.contentWindow) return;
    try {
      fr.contentWindow.postMessage(JSON.stringify({ type, data: data || {} }), '*');
    } catch(_) {}
  }

  function startRTTimePoller() {
    if (rtTimePoller) clearInterval(rtTimePoller);
    // Запрашиваем текущее время (RuTube отвечает событием player:currentTime)
    rtTimePoller = setInterval(() => {
      if (currentPlatform !== 'rutube') return;
      rtPost('player:getCurrentTime');
    }, 1000);
  }
  function stopRTTimePoller() { if (rtTimePoller) { clearInterval(rtTimePoller); rtTimePoller = null; } }

  /* ─── Local HTML5 Video ─── */
  let localVideoEl    = null;
  let localVideoTimer = null;

  function destroyLocalVideo() {
    if (localVideoTimer) { clearInterval(localVideoTimer); localVideoTimer = null; }
    const old = document.getElementById('local-video-el');
    if (old) old.remove();
    localVideoEl = null;
  }

  function createLocalVideoEl(src, startSec) {
    destroyLocalVideo();
    const el = document.createElement('video');
    el.id        = 'local-video-el';
    el.controls  = false;
    el.preload   = 'auto';
    el.style.cssText = 'width:100%;height:100%;background:#000;display:block;';
    el.src = src;
    videoArea.appendChild(el);
    localVideoEl = el;

    el.addEventListener('loadedmetadata', () => {
      videoDuration = el.duration || 0;
      if (durationDisplay) durationDisplay.textContent = fmt(videoDuration);
      updateSeekBar();
      if (startSec > 0) el.currentTime = startSec;
      signalReady();
      flushPendingCmd();
    });
    el.addEventListener('play',  () => { if (!isSuppressed()) onRemotePlay(); });
    el.addEventListener('pause', () => { if (!isSuppressed()) onRemotePause(); });
    el.addEventListener('ended', () => { localPlaying = false; stopTimer(); updatePlayBtn(); });
    el.addEventListener('timeupdate', () => {
      if (!localVideoEl) return;
      localTime = el.currentTime;
      timeDisplay.textContent = fmt(localTime);
      updateSeekBar();
    });

    // Fallback если loadedmetadata не сработает
    setTimeout(() => { if (!playerReady) { signalReady(); flushPendingCmd(); } }, 3000);

    // Поллер времени
    localVideoTimer = setInterval(() => {
      if (!localVideoEl) return;
      localTime = el.currentTime;
      timeDisplay.textContent = fmt(localTime);
      if (el.duration && el.duration !== videoDuration) {
        videoDuration = el.duration;
        if (durationDisplay) durationDisplay.textContent = fmt(videoDuration);
      }
      updateSeekBar();
    }, 500);

    return el;
  }

  /* ─── YouTube ─── */
  window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    if (ytPendingLoad) {
      const p = ytPendingLoad; ytPendingLoad = null;
      createYTPlayer(p.videoId, p.startSec);
    }
  };

  function loadYTApi() {
    if (document.getElementById('yt-api-script')) return;
    const tag = document.createElement('script');
    tag.id  = 'yt-api-script';
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  function getYTVideoId(embedUrl) {
    const m = embedUrl.match(/embed\/([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function createYTPlayer(videoId, startSec) {
    const old = document.getElementById('yt-player-container');
    if (old) old.remove();
    if (ytPlayer) { try { ytPlayer.destroy(); } catch(_) {} ytPlayer = null; }
    if (ytPauseDebounceTimer) { clearTimeout(ytPauseDebounceTimer); ytPauseDebounceTimer = null; }

    const container = document.createElement('div');
    container.id = 'yt-player-container';
    container.style.cssText = 'width:100%;height:100%;';
    videoArea.appendChild(container);

    ytPlayer = new YT.Player('yt-player-container', {
      width: '100%', height: '100%',
      videoId,
      playerVars: {
        autoplay: 0, start: Math.floor(startSec || 0),
        rel: 0, modestbranding: 1, playsinline: 1, enablejsapi: 1,
      },
      events: { onReady: onYTReady, onStateChange: onYTStateChange, onError: onYTError },
    });
  }

  function onYTReady() {
    signalReady();
    startYTTimePoller();
    // Получаем длительность
    try { const d = ytPlayer.getDuration(); if (d > 0) { videoDuration = d; updateSeekBar(); } } catch(_) {}
    if (ytPendingPlay !== null) {
      const p = ytPendingPlay; ytPendingPlay = null;
      _ytPlayNow(p.timeSec);
    }
  }

  function startYTTimePoller() {
    stopYTTimePoller();
    ytTimePoller = setInterval(() => {
      if (!ytPlayer || currentPlatform !== 'youtube') return;
      try {
        const t = ytPlayer.getCurrentTime();
        if (typeof t === 'number') { localTime = t; timeDisplay.textContent = fmt(t); updateSeekBar(); }
        const d = ytPlayer.getDuration();
        if (typeof d === 'number' && d > 0 && d !== videoDuration) { videoDuration = d; updateSeekBar(); }
      } catch(_) {}
    }, 500);
  }
  function stopYTTimePoller() { if (ytTimePoller) { clearInterval(ytTimePoller); ytTimePoller = null; } }

  function onYTStateChange(e) {
    if (currentPlatform !== 'youtube') return;
    const st = e.data;
    if (st === YT.PlayerState.PLAYING) {
      if (ytPauseDebounceTimer) { clearTimeout(ytPauseDebounceTimer); ytPauseDebounceTimer = null; }
      onRemotePlay();
    } else if (st === YT.PlayerState.PAUSED) {
      if (ytPauseDebounceTimer) clearTimeout(ytPauseDebounceTimer);
      ytPauseDebounceTimer = setTimeout(() => {
        ytPauseDebounceTimer = null;
        onRemotePause();
      }, 1200);
    } else if (st === YT.PlayerState.ENDED) {
      if (ytPauseDebounceTimer) { clearTimeout(ytPauseDebounceTimer); ytPauseDebounceTimer = null; }
      localPlaying = false; stopTimer(); updatePlayBtn();
    }
  }

  function onYTError(e) {
    const code = e.data;
    let text = 'Ошибка плеера', sub = `Код: ${code}`;
    if (code === 101 || code === 150 || code === 153) {
      text = 'Видео нельзя встроить';
      sub  = 'Владелец запретил просмотр вне YouTube.';
    } else if (code === 2) {
      text = 'Неверный ID видео'; sub = 'Проверь ссылку.';
    }
    showOverlay(text, sub, false);
  }

  /* ─── Общие реакции на события плеера ─── */
  function onRemotePlay() {
    if (!localPlaying && !isSuppressed()) {
      localPlaying = true; startTimer(); updatePlayBtn(); videoEverStarted = true;
      send({ type: 'host_play', current_time: localTime, play_at: Date.now() + PLAY_RESUME_MS });
    }
  }
  function onRemotePause() {
    if (localPlaying && !isSuppressed()) {
      localPlaying = false; stopTimer(); updatePlayBtn();
      send({ type: 'host_pause', current_time: localTime });
    }
  }

  /* ─── Утилиты ─── */
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = (sec % 60).toString().padStart(2, '0');
    return h > 0 ? `${h}:${m.toString().padStart(2,'0')}:${s}` : `${m}:${s}`;
  }
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str || ''));
    return d.innerHTML;
  }
  function isSuppressed() { return Date.now() < suppressUntil; }
  function suppress(ms)   { suppressUntil = Date.now() + (ms || 5000); }

  /* ─── Оверлей ─── */
  function showOverlay(text, subtext, spinner) {
    if (!sessionOverlay) return;
    overlayText.textContent    = text;
    overlaySubtext.textContent = subtext || '';
    if (overlaySpinner) overlaySpinner.style.display = spinner !== false ? 'block' : 'none';
    sessionOverlay.style.display = 'flex';
  }
  function hideOverlay() {
    if (sessionOverlay) sessionOverlay.style.display = 'none';
  }

  /* ─── Ready bar ─── */
  function updateReadyBar() {
    if (!IS_HOST || !readyBar) return;
    const n = readySet.size;
    if (readyCount) readyCount.textContent = n;
    if (readyTotal) readyTotal.textContent = totalParticipants;
    readyBar.style.display = (n > 0 && n < totalParticipants) ? 'flex' : 'none';
  }

  /* ─── Таймер ─── */
  function startTimer() {
    if (timerInterval) return;
    timerInterval = setInterval(() => {
      localTime += 1;
      timeDisplay.textContent = fmt(localTime);
      updateSeekBar();
      refreshParticipantTimes();
    }, 1000);
  }
  function stopTimer() { clearInterval(timerInterval); timerInterval = null; }

  /* ─── Создание iframe для VK / RuTube (один раз при загрузке источника) ─── */
  function buildInitialEmbedSrc(embedUrl, platform, startSec) {
    const t = Math.floor(Math.max(0, startSec || 0));
    if (platform === 'vk') {
      // js_api=1 уже есть в utils.py. Доп.: starttime
      const sep = embedUrl.includes('?') ? '&' : '?';
      return `${embedUrl}${sep}starttime=${t}`;
    }
    if (platform === 'rutube') {
      const sep = embedUrl.includes('?') ? '&' : '?';
      return `${embedUrl}${sep}t=${t}`;
    }
    return embedUrl;
  }

  function createEmbedIframe(embedUrl, platform, startSec) {
    // Удалить старый iframe и YT-контейнер
    const oldFrame = document.getElementById('video-iframe');
    if (oldFrame) oldFrame.remove();
    const oldYt = document.getElementById('yt-player-container');
    if (oldYt) oldYt.remove();
    destroyVKPlayer();
    destroyLocalVideo();
    stopRTTimePoller();
    stopYTTimePoller();

    const iframe = document.createElement('iframe');
    iframe.id = 'video-iframe';
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media');
    iframe.setAttribute('allowfullscreen', '');
    iframe.frameBorder = '0';
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
    videoArea.appendChild(iframe);
    iframe.src = buildInitialEmbedSrc(embedUrl, platform, startSec);

    if (platform === 'vk') {
      // Инициализируем VK.VideoPlayer на этом iframe
      iframe.addEventListener('load', () => {
        loadVKSdk();
        if (vkSdkReady) initVKPlayer(iframe, startSec);
        else vkPendingInit = { iframe, startSec };
      }, { once: true });
      // SDK тоже грузим заранее
      loadVKSdk();
    } else if (platform === 'rutube') {
      // RuTube не имеет отдельного SDK — общение через postMessage напрямую
      startRTTimePoller();
      // Fallback на signalReady если plaer:ready не пришёл
      setTimeout(() => { if (!playerReady) signalReady(); flushPendingCmd(); }, 4000);
    }

    return iframe;
  }

  /* ─── Сигнал готовности плеера ─── */
  function signalReady() {
    if (playerReady) return;
    playerReady = true;
    suppressUntil = 0;
    send({ type: 'player_ready' });
    hideOverlay();
  }

  /* ─── Применение очереди после готовности ─── */
  function flushPendingCmd() {
    if (!pendingPlayerCmd) return;
    const cmd = pendingPlayerCmd; pendingPlayerCmd = null;
    if (cmd.action === 'play')  doPlay(cmd.time);
    if (cmd.action === 'pause') doPause(cmd.time);
    if (cmd.action === 'seek')  applySeek(cmd.time);
  }

  /* ─── Загрузка нового видео ─── */
  function loadPlayer(embedUrl, platform, startSec) {
    stopTimer();
    cancelScheduledPlay();
    currentEmbed     = embedUrl;
    currentPlatform  = platform;
    localTime        = startSec || 0;
    localPlaying     = false;
    playerReady      = false;
    videoEverStarted = false;
    pendingPlayerCmd = null;
    videoDuration    = 0;
    readySet.clear();

    timeDisplay.textContent = fmt(localTime);
    if (durationDisplay) durationDisplay.textContent = fmt(0);
    updatePlayBtn();
    btnPlay.disabled = false;
    showOverlay('Загрузка видео…', 'Буферизуем, это займёт несколько секунд');

    if (platform === 'local') {
      // HTML5 video
      const old = document.getElementById('video-iframe');
      if (old) old.remove();
      const oldYt = document.getElementById('yt-player-container');
      if (oldYt) oldYt.remove();
      destroyVKPlayer();
      stopRTTimePoller();
      stopYTTimePoller();
      if (ytPlayer) { try { ytPlayer.destroy(); } catch(_) {} ytPlayer = null; }
      createLocalVideoEl(embedUrl, startSec || 0);
      return;
    }

    destroyLocalVideo();

    if (platform === 'youtube') {
      // Удалить любой старый iframe
      const old = document.getElementById('video-iframe');
      if (old) old.remove();
      destroyVKPlayer();
      stopRTTimePoller();

      const videoId = getYTVideoId(embedUrl);
      if (!videoId) { showOverlay('Неверная ссылка', '', false); return; }
      loadYTApi();
      if (ytApiReady) createYTPlayer(videoId, startSec);
      else ytPendingLoad = { videoId, startSec };
    } else {
      // VK / RuTube
      if (ytPlayer) { try { ytPlayer.destroy(); } catch(_) {} ytPlayer = null; }
      const ytc = document.getElementById('yt-player-container');
      if (ytc) ytc.remove();
      stopYTTimePoller();

      createEmbedIframe(embedUrl, platform, startSec);
    }
  }

  /* ─── Унифицированные команды плеера ─── */
  function applyPlay() {
    if (currentPlatform === 'local') {
      if (!localVideoEl) return;
      suppress(1000);
      try { localVideoEl.currentTime = Math.floor(localTime); localVideoEl.play(); } catch(_) {}
      return;
    }
    if (currentPlatform === 'youtube') { _ytPlayNow(localTime); return; }
    if (currentPlatform === 'vk') {
      if (!vkPlayer) { pendingPlayerCmd = { action: 'play', time: localTime }; return; }
      try { vkPlayer.seek(Math.floor(localTime)); } catch(_){}
      try { vkPlayer.play(); } catch(_){}
      return;
    }
    if (currentPlatform === 'rutube') {
      rtPost('player:setCurrentTime', { time: Math.floor(localTime) });
      rtPost('player:play');
      return;
    }
  }

  function applyPause() {
    if (currentPlatform === 'local') {
      if (!localVideoEl) return;
      suppress(1000);
      try { localVideoEl.pause(); localVideoEl.currentTime = Math.floor(localTime); } catch(_) {}
      return;
    }
    if (currentPlatform === 'youtube') {
      if (ytPlayer && playerReady) {
        try { ytPlayer.pauseVideo(); ytPlayer.seekTo(Math.floor(localTime), true); } catch(_){}
      }
      return;
    }
    if (currentPlatform === 'vk') {
      if (!vkPlayer) { pendingPlayerCmd = { action: 'pause', time: localTime }; return; }
      try { vkPlayer.pause(); } catch(_){}
      try { vkPlayer.seek(Math.floor(localTime)); } catch(_){}
      return;
    }
    if (currentPlatform === 'rutube') {
      rtPost('player:pause');
      rtPost('player:setCurrentTime', { time: Math.floor(localTime) });
      return;
    }
  }

  function applySeek(timeSec) {
    localTime = timeSec;
    timeDisplay.textContent = fmt(localTime);
    updateSeekBar();
    if (currentPlatform === 'local') {
      if (localVideoEl) try { localVideoEl.currentTime = Math.floor(timeSec); } catch(_) {}
      return;
    }
    if (currentPlatform === 'youtube' && ytPlayer && playerReady) {
      try { ytPlayer.seekTo(Math.floor(timeSec), true); } catch(_){}
    } else if (currentPlatform === 'vk') {
      if (!vkPlayer) { pendingPlayerCmd = { action: 'seek', time: timeSec }; return; }
      try { vkPlayer.seek(Math.floor(timeSec)); } catch(_){}
    } else if (currentPlatform === 'rutube') {
      rtPost('player:setCurrentTime', { time: Math.floor(timeSec) });
    }
  }

  /* ─── Синхронный старт ─── */
  function schedulePlay(timeSec, playAtMs) {
    cancelScheduledPlay();
    waitingForPlayAt = true;
    const delay = Math.max(0, playAtMs - Date.now());
    scheduledPlayTimer = setTimeout(() => {
      scheduledPlayTimer = null;
      waitingForPlayAt   = false;
      doPlay(timeSec);
    }, delay);
  }
  function cancelScheduledPlay() {
    if (scheduledPlayTimer) { clearTimeout(scheduledPlayTimer); scheduledPlayTimer = null; }
    waitingForPlayAt = false;
  }

  /* ─── doPlay / doPause через JS API ─── */
  function doPlay(timeSec) {
    localTime    = timeSec;
    localPlaying = true;
    videoEverStarted = true;
    stopTimer(); startTimer();
    updatePlayBtn();
    timeDisplay.textContent = fmt(localTime);
    hideOverlay();

    suppress(2000); // подавить эхо собственных команд

    if (currentPlatform === 'youtube' && !playerReady) {
      ytPendingPlay = { timeSec };
    } else if ((currentPlatform === 'vk' || currentPlatform === 'rutube') && !playerReady) {
      pendingPlayerCmd = { action: 'play', time: timeSec };
    } else {
      applyPlay();
    }
  }

  function _ytPlayNow(timeSec) {
    suppress(2000);
    try {
      ytPlayer.seekTo(Math.floor(timeSec), true);
      ytPlayer.mute();
      ytPlayer.playVideo();
      setTimeout(() => { try { if (ytPlayer) ytPlayer.unMute(); } catch(_) {} }, 1000);
    } catch(_) {
      try { ytPlayer.playVideo(); } catch(_) {}
    }
  }

  function doPause(timeSec) {
    cancelScheduledPlay();
    localTime    = timeSec;
    localPlaying = false;
    stopTimer();
    timeDisplay.textContent = fmt(localTime);
    updatePlayBtn();

    suppress(2000);

    if (!playerReady && (currentPlatform === 'vk' || currentPlatform === 'rutube')) {
      pendingPlayerCmd = { action: 'pause', time: timeSec };
      return;
    }
    applyPause();
  }

  /* ─── Синхронизация с хостом ─── */
  function syncWithHost() {
    if (!currentEmbed) { addSystemMsg('Нет активного видео'); return; }

    let syncTime = hostTime;
    if (hostPlaying && hostTimeUpdatedAt > 0) {
      syncTime = hostTime + (Date.now() - hostTimeUpdatedAt) / 1000;
    }
    syncTime = Math.max(0, syncTime);

    addSystemMsg('Синхронизируемся с хостом…');
    if (btnSync) {
      btnSync.classList.add('syncing');
      setTimeout(() => btnSync.classList.remove('syncing'), 1200);
    }

    if (hostPlaying) doPlay(syncTime);
    else             doPause(syncTime);
  }

  if (btnSync) btnSync.addEventListener('click', syncWithHost);

  /* ─── Кнопка Play ─── */
  btnPlay.addEventListener('click', () => {
    if (!currentEmbed) return;
    if (localPlaying) {
      doPause(localTime);
      hostTime = localTime; hostPlaying = false;
      send({ type: 'host_pause', current_time: localTime });
    } else {
      const bufMs  = videoEverStarted ? PLAY_RESUME_MS : PLAY_BUFFER_MS;
      const playAt = Date.now() + bufMs;
      videoEverStarted = true;
      hostTime = localTime; hostPlaying = true;
      send({ type: 'host_play', current_time: localTime, play_at: playAt });
      schedulePlay(localTime, playAt);
    }
  });

  function updatePlayBtn() {
    btnPlay.textContent = localPlaying ? '⏸' : '▶';
    btnPlay.classList.toggle('active', localPlaying);
  }

  function updateSeekBar() {
    if (!seekBar || seekBarDragging) return;
    const dur = videoDuration || 0;
    seekBar.max = dur > 0 ? Math.floor(dur) : 100;
    seekBar.value = Math.min(Math.floor(localTime), seekBar.max);
    // Обновляем дисплей длительности
    if (durationDisplay && dur > 0) durationDisplay.textContent = fmt(dur);
    // Обновляем CSS-переменную для визуала прогресса
    const pct = dur > 0 ? (localTime / dur * 100).toFixed(1) : 0;
    if (seekBar) seekBar.style.setProperty('--val', pct + '%');
  }

  /* ─── Seekbar events ─── */
  if (seekBar) {
    seekBar.addEventListener('mousedown',  () => { seekBarDragging = true; });
    seekBar.addEventListener('touchstart', () => { seekBarDragging = true; }, { passive: true });

    seekBar.addEventListener('input', () => {
      localTime = parseInt(seekBar.value, 10);
      timeDisplay.textContent = fmt(localTime);
    });

    seekBar.addEventListener('change', () => {
      seekBarDragging = false;
      const seekTo = parseInt(seekBar.value, 10);
      localTime = seekTo;
      applySeek(seekTo);
      // Рассылаем всем
      send({ type: 'seek', current_time: seekTo, is_playing: localPlaying });
      if (localPlaying) {
        const playAt = Date.now() + PLAY_RESUME_MS;
        send({ type: 'host_play', current_time: seekTo, play_at: playAt });
        schedulePlay(seekTo, playAt);
      } else {
        send({ type: 'host_pause', current_time: seekTo });
        doPause(seekTo);
      }
    });
  }

  /* ─── URL форма ─── */
  if (loadVideoBtn) {
    loadVideoBtn.addEventListener('click', () => {
      if (!IS_HOST) return;
      const url = videoUrlInput.value.trim();
      urlError.textContent = '';
      if (!url) return;
      loadVideoBtn.disabled    = true;
      loadVideoBtn.textContent = '...';

      const fd = new FormData();
      fd.append('url', url);
      fd.append('csrfmiddlewaretoken', CSRF_TOKEN);
      fetch(SET_VIDEO_URL, { method: 'POST', body: fd })
        .then(r => r.json())
        .then(data => {
          loadVideoBtn.disabled    = false;
          loadVideoBtn.textContent = 'Загрузить';
          if (data.status === 'ok') {
            loadPlayer(data.embed_url, data.platform, 0);
            send({ type: 'video_url_change', url });
          } else {
            urlError.textContent = data.message || 'Неверный URL';
          }
        })
        .catch(() => {
          loadVideoBtn.disabled    = false;
          loadVideoBtn.textContent = 'Загрузить';
          urlError.textContent     = 'Ошибка сети.';
        });
    });
    videoUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadVideoBtn.click(); });
  }

  /* ─── postMessage от RuTube (приём событий) ─── */
  window.addEventListener('message', (e) => {
    let msg;
    try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (_) { return; }
    if (!msg || !currentEmbed) return;

    if (currentPlatform === 'rutube') {
      const tp = msg.type;

      // Отладка — раскомментируй чтобы увидеть все события в консоли:
      // console.log('[RuTube postMessage]', tp, msg.data);

      if (tp === 'player:ready' || tp === 'player:loaded' || tp === 'player:init') {
        signalReady();
        flushPendingCmd();
        return;
      }

      // Обновление времени из события state или отдельного currentTime
      const stateTime = msg.data?.currentTime ?? msg.data?.time ?? null;
      if (tp === 'player:currentTime' || tp === 'player:timeupdate') {
        if (stateTime !== null) {
          if (!playerReady) signalReady();
          localTime = stateTime;
          timeDisplay.textContent = fmt(stateTime);
        }
        return;
      }

      // changeState — главное событие изменения состояния плеера
      if (tp === 'player:changeState') {
        const state = msg.data?.state ?? msg.data;
        if (!playerReady) { signalReady(); flushPendingCmd(); }
        if (isSuppressed()) return;
        if (state === 'playing') { onRemotePlay(); return; }
        if (state === 'paused')  { onRemotePause(); return; }
        return;
      }

      if (isSuppressed()) return;

      if (tp === 'player:play' || tp === 'player:playing' || tp === 'player:resume' || tp === 'player:start') {
        onRemotePlay();
      }
      if (tp === 'player:pause' || tp === 'player:paused') {
        onRemotePause();
      }
    }
    // VK события обрабатывает VK.VideoPlayer SDK
  });

  /* ─── Heartbeat каждые 3с ─── */
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      send({ type: 'heartbeat', current_time: localTime, playing: localPlaying });
    }
  }, 3000);

  /* ─── Интерполяция времени участников ─── */
  setInterval(() => {
    let changed = false;
    for (const name in participantsState) {
      if (participantsState[name].playing) { participantsState[name].time += 1; changed = true; }
    }
    if (changed) refreshParticipantTimes();
  }, 1000);

  /* ─── WebSocket ─── */
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/rooms/${ROOM_CODE}/`);
    ws.onopen    = () => setWsStatus(true);
    ws.onclose   = () => { setWsStatus(false); setTimeout(connect, 3000); };
    ws.onerror   = () => setWsStatus(false);
    ws.onmessage = e => { try { handleMessage(JSON.parse(e.data)); } catch (_) {} };
  }
  function setWsStatus(ok) {
    wsDot.className      = 'sync-dot' + (ok ? ' connected' : '');
    wsStatus.textContent = ok ? 'Подключено' : 'Переподключение...';
  }
  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  /* ─── WS сообщения ─── */
  function handleMessage(data) {
    switch (data.type) {

      case 'sync_state':
        if (data.embed_url) {
          hostTime          = data.current_time || 0;
          hostPlaying       = data.is_playing   || false;
          hostTimeUpdatedAt = Date.now();
          loadPlayer(data.embed_url, data.platform, hostTime);
          if (hostPlaying && !IS_HOST) {
            setTimeout(() => doPlay(hostTime), 300);
          }
        }
        break;

      case 'video_url_change':
        if (data.username !== CURRENT_USER) {
          loadPlayer(data.embed_url, data.platform, 0);
          addSystemMsg(`${escapeHtml(anonName(data.username))} сменил видео`);
        }
        break;

      case 'host_play':
        if (data.username === ROOM_HOST) {
          hostTime = data.current_time || 0; hostPlaying = true;
          hostTimeUpdatedAt = Date.now();
        }
        if (data.username !== CURRENT_USER) {
          schedulePlay(data.current_time || 0, data.play_at || Date.now());
          addSystemMsg(`${escapeHtml(anonName(data.username))} запустил видео`);
        }
        break;

      case 'host_pause':
        if (data.username === ROOM_HOST) {
          hostTime = data.current_time || localTime; hostPlaying = false;
          hostTimeUpdatedAt = Date.now();
        }
        if (data.username !== CURRENT_USER) {
          doPause(data.current_time || localTime);
          addSystemMsg(`${escapeHtml(anonName(data.username))} поставил на паузу`);
        }
        break;

      case 'seek':
        if (data.username !== CURRENT_USER) {
          const seekTo = data.current_time || 0;
          applySeek(seekTo);
          hostTime = seekTo;
          hostTimeUpdatedAt = Date.now();
          addSystemMsg(`${escapeHtml(anonName(data.username))} перемотал видео`);
        }
        break;

      case 'player_ready':
        if (IS_HOST && data.username) {
          readySet.add(data.username);
          updateReadyBar();
          if (readySet.size >= totalParticipants && readyBar) readyBar.style.display = 'none';
        }
        break;

      case 'heartbeat':
        if (data.username !== CURRENT_USER) {
          participantsState[data.username] = {
            time: data.current_time || 0,
            playing: data.playing || false,
          };
          if (data.username === ROOM_HOST) {
            hostTime          = data.current_time || 0;
            hostPlaying       = data.playing      || false;
            hostTimeUpdatedAt = Date.now();
          }
          refreshParticipantTimes();
        }
        break;

      case 'chat_message':
        if (data.username !== CURRENT_USER) {
          appendChatMessage(data.username, data.text, data.avatar);
        }
        break;

      case 'user_joined':
        if (data.username !== CURRENT_USER) addSystemMsg(`${escapeHtml(anonName(data.username))} присоединился`);
        break;

      case 'user_left':
        delete participantsState[data.username];
        readySet.delete(data.username);
        addSystemMsg(`${escapeHtml(anonName(data.username))} покинул комнату`);
        break;

      case 'participants_update':
        totalParticipants = data.participants.length;
        // Строим anonMap заранее в порядке списка
        data.participants.forEach(name => anonName(name));
        renderParticipants(data.participants);
        updateReadyBar();
        break;

      case 'room_full':
        showOverlay('Комната заполнена', 'Максимум 8 участников', false);
        btnPlay.disabled = true;
        break;

      case 'room_closed':
        showOverlay('Сессия завершена', 'Хост завершил сессию. Перенаправляем...', false);
        btnPlay.disabled = true;
        if (ws) { try { ws.close(); } catch(_) {} ws = null; }
        setTimeout(() => { window.location.href = '/'; }, 2500);
        break;
    }
  }

  /* ─── Участники ─── */
  function renderParticipants(list) {
    participantsList_order = list;
    participantsCount.textContent = list.length;
    participantsList.innerHTML = list.map((name, idx) => {
      const isMe       = (name === CURRENT_USER);
      const isRoomHost = (name === ROOM_HOST);
      const state      = isMe
        ? { time: localTime, playing: localPlaying }
        : (participantsState[name] || { time: 0, playing: false });
      return `
        <div class="participant-item" data-idx="${idx}">
          <div class="participant-avatar">${escapeHtml(anonName(name)[0].toUpperCase())}</div>
          <div class="participant-info">
            <div class="participant-name">
              ${escapeHtml(anonName(name))}
              ${isRoomHost ? '<span class="badge-host">хост</span>' : ''}
              ${isMe       ? '<span class="badge-me">(вы)</span>'  : ''}
            </div>
            <div class="participant-time">
              <span class="p-status">${state.playing ? '▶' : '⏸'}</span>
              <span class="p-time" data-idx="${idx}">${fmt(state.time)}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function refreshParticipantTimes() {
    participantsList.querySelectorAll('.p-time').forEach(el => {
      const idx  = parseInt(el.dataset.idx, 10);
      const name = participantsList_order[idx];
      if (!name) return;
      const state = (name === CURRENT_USER)
        ? { time: localTime, playing: localPlaying }
        : participantsState[name];
      if (!state) return;
      el.textContent = fmt(state.time);
      const statEl = el.closest('.participant-time')?.querySelector('.p-status');
      if (statEl) statEl.textContent = state.playing ? '▶' : '⏸';
    });
  }

  /* ─── Чат ─── */
  function appendChatMessage(username, text, avatarUrl) {
    if (!chatMessages) return;
    const empty = chatMessages.querySelector('.empty-state');
    if (empty) empty.remove();
    const isMe        = (username === CURRENT_USER);
    const displayName = anonName(username);
    const div         = document.createElement('div');
    div.className = 'chat-msg chat-msg-new';
    // В анонимном режиме не показываем фото аватара
    const avatarHtml = (!isAnonymous && avatarUrl)
      ? `<img src="${avatarUrl}" alt="">`
      : escapeHtml(displayName[0].toUpperCase());
    div.innerHTML = `
      <div class="chat-msg-avatar">${avatarHtml}</div>
      <div class="chat-msg-body">
        <div class="chat-msg-name"${isMe ? ' style="color:var(--gold-light)"' : ''}>${escapeHtml(displayName)}</div>
        <div class="chat-msg-text">${escapeHtml(text)}</div>
      </div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    // Убираем класс flash через 1.8с
    setTimeout(() => div.classList.remove('chat-msg-new'), 1800);
  }

  function addSystemMsg(text) {
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.innerHTML = `<div class="chat-msg-body"><div class="chat-msg-text" style="opacity:.5;font-style:italic;font-size:.8rem;">— ${text}</div></div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    if (chatInput.disabled) return;   // slow mode активен
    send({ type: 'chat_message', text });
    appendChatMessage(CURRENT_USER, text, null);
    chatInput.value = '';
    chatInput.style.height = 'auto';
    startSlowMode();
  }
  if (chatSendBtn) chatSendBtn.addEventListener('click', sendChatMessage);
  if (chatInput) {
    chatInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
    });
    chatInput.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });
  }

  window.copyInviteLink = function () {
    navigator.clipboard.writeText(location.href).then(() => {
      const btn = document.querySelector('.copy-link-btn');
      if (!btn) return;
      const orig = btn.innerHTML;
      btn.innerHTML = '✓ Скопировано';
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    });
  };

  /* ─── Инициализация ─── */
  btnPlay.disabled        = false;
  timeDisplay.textContent = '0:00';
  if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;

  // Скрываем url-bar для участников если только хост управляет видео
  if (!IS_HOST) {
    const urlBar = document.getElementById('url-bar');
    const hostOnlyVideo = (typeof HOST_ONLY_VIDEO !== 'undefined') ? HOST_ONLY_VIDEO : false;
    if (urlBar && hostOnlyVideo) urlBar.style.display = 'none';
    if (readyBar) readyBar.style.display = 'none';
  }

  // Slow mode — блокируем инпут на нужное время
  const slowModeSec   = (typeof SLOW_MODE !== 'undefined') ? SLOW_MODE : 0;
  const slowModeBar   = document.getElementById('slow-mode-bar');
  const slowModeTimer = document.getElementById('slow-mode-timer');
  let slowModeUntil   = 0;
  let slowInterval    = null;

  function startSlowMode() {
    if (slowModeSec <= 0 || IS_HOST) return;
    slowModeUntil = Date.now() + slowModeSec * 1000;
    if (chatInput)   chatInput.disabled   = true;
    if (chatSendBtn) chatSendBtn.disabled = true;
    if (slowModeBar) slowModeBar.style.display = 'flex';
    if (slowInterval) clearInterval(slowInterval);
    slowInterval = setInterval(() => {
      const left = Math.ceil((slowModeUntil - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(slowInterval); slowInterval = null;
        if (chatInput)   { chatInput.disabled = false; chatInput.focus(); }
        if (chatSendBtn)   chatSendBtn.disabled = false;
        if (slowModeBar)   slowModeBar.style.display = 'none';
      } else {
        if (slowModeTimer) slowModeTimer.textContent = left;
      }
    }, 250);
  }

  /* ─── Загрузка видео-файла ─── */
  if (videoFileInput) {
    videoFileInput.addEventListener('change', () => {
      const file = videoFileInput.files[0];
      if (!file) return;

      const allowed = ['.mp4', '.webm', '.mkv', '.avi', '.mov'];
      const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
      if (!allowed.includes(ext)) {
        if (urlError) urlError.textContent = `Формат ${ext} не поддерживается.`;
        return;
      }

      const fd = new FormData();
      fd.append('video', file);
      fd.append('csrfmiddlewaretoken', CSRF_TOKEN);

      if (uploadProgress) uploadProgress.style.display = 'flex';
      if (urlError) urlError.textContent = '';

      const xhr = new XMLHttpRequest();
      xhr.open('POST', UPLOAD_VIDEO_URL);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round(e.loaded / e.total * 100);
          if (uploadProgressBar) uploadProgressBar.style.width = pct + '%';
          if (uploadProgressTxt) uploadProgressTxt.textContent = `Загрузка ${pct}%…`;
        }
      };
      xhr.onload = () => {
        if (uploadProgress) uploadProgress.style.display = 'none';
        videoFileInput.value = '';
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.status === 'ok') {
            loadPlayer(data.embed_url, data.platform, 0);
            send({ type: 'video_url_change', url: data.embed_url });
            if (videoUrlInput) videoUrlInput.value = '';
          } else {
            if (urlError) urlError.textContent = data.message || 'Ошибка загрузки.';
          }
        } catch(e) {
          if (urlError) urlError.textContent = 'Ошибка сервера.';
        }
      };
      xhr.onerror = () => {
        if (uploadProgress) uploadProgress.style.display = 'none';
        if (urlError) urlError.textContent = 'Ошибка сети.';
      };
      xhr.send(fd);
    });
  }

  /* ─── Завершение сессии (хост) ─── */
  if (btnEndSession) {
    btnEndSession.addEventListener('click', () => {
      if (!confirm('Завершить сессию для всех участников?')) return;
      // Сообщаем через WS — все получат room_closed
      send({ type: 'room_close' });
      // Также делаем REST запрос чтобы пометить комнату неактивной
      fetch(DELETE_ROOM_URL, {
        method: 'POST',
        headers: { 'X-CSRFToken': CSRF_TOKEN },
      }).catch(() => {});
      // Хост сам идёт на главную
      setTimeout(() => { window.location.href = '/'; }, 500);
    });
  }

  connect();

})();
