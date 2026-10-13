'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let modalOpener;
const visibleVideos = new Set();
const visibleGroups = new Set();
const videoObserver = new IntersectionObserver((entries) => {
  entries.forEach(({ target: video, isIntersecting }) => {
    if (isIntersecting) {
      visibleVideos.add(video);
      autoplayVideo(video);
    } else {
      visibleVideos.delete(video);
      video.pause();
    }
  });
}, { threshold: 0.3 });
const groupObserver = new IntersectionObserver((entries) => {
  entries.forEach(({ target: grid, isIntersecting }) => {
    if (isIntersecting) visibleGroups.add(grid);
    else visibleGroups.delete(grid);
    controlGroup(grid.dataset.playbackGroup, isIntersecting ? 'play' : 'pause', true);
  });
}, { threshold: 0.2 });

function canAutoplay() {
  return !reducedMotion.matches && !document.hidden && !$('#video-modal').open;
}

function autoplayVideo(video) {
  if (!canAutoplay() || video.dataset.userPaused === 'true') return;
  video.play().catch((error) => {
    if (!['NotAllowedError', 'AbortError'].includes(error.name) && !video.error) {
      console.error('Video autoplay failed:', error.message);
    }
  });
}

function pauseBackground() {
  visibleVideos.forEach((video) => video.pause());
  visibleGroups.forEach((grid) => controlGroup(grid.dataset.playbackGroup, 'pause', true));
}

function resumeBackground() {
  visibleVideos.forEach(autoplayVideo);
  visibleGroups.forEach((grid) => controlGroup(grid.dataset.playbackGroup, 'play', true));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function placeholder(title, description, label = 'Video placeholder') {
  const node = element('div', 'media-placeholder');
  node.dataset.testid = 'media-placeholder';
  const icon = element('span', 'placeholder-play', '▷');
  icon.setAttribute('aria-hidden', 'true');
  node.append(icon, element('span', 'placeholder-label', label), element('h3', '', title), element('p', '', description));
  return node;
}

function handleMediaError(video, title) {
  const showError = () => {
    video.hidden = true;
    if (!video.parentElement.querySelector('.media-placeholder')) {
      const fallback = placeholder(title, 'This recording is currently unavailable.', 'Media unavailable');
      if (video.id === 'hero-video') fallback.classList.add('hero-media-error');
      video.parentElement.append(fallback);
    }
  };
  video.addEventListener('error', showError, { once: true });
  if (video.error) showError();
}

function createVideo(asset, title) {
  const video = element('video');
  video.controls = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'none';
  video.setAttribute('aria-label', title);
  handleMediaError(video, title);
  video.poster = asset.poster;
  video.src = asset.src;
  return video;
}

function enableTabKeyboard(tablist) {
  tablist.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  });
}

function observeGroup(group) {
  const grid = $(`#${group}-videos`);
  grid.dataset.userPaused = 'false';
  grid.querySelectorAll('video').forEach((video) => {
    for (const event of ['play', 'pause', 'ended']) video.addEventListener(event, () => updateGroupControls(group));
    video.addEventListener('ended', () => {
      const videos = [...grid.querySelectorAll('video')];
      if (visibleGroups.has(grid) && videos.every((item) => item.ended)) controlGroup(group, 'restart', true);
    });
  });
  updateGroupControls(group);
  groupObserver.observe(grid);
}

function updateGroupControls(group) {
  const playing = [...$(`#${group}-videos`).querySelectorAll('video')].some((video) => !video.paused && !video.ended);
  $$(`button[data-group="${group}"]`).forEach((button) => {
    if (button.dataset.action === 'play') button.hidden = playing;
    if (button.dataset.action === 'pause') button.hidden = !playing;
  });
}

function initializeDemos() {
  $$('#robot-tabs [role="tab"]').forEach(tab => {
    tab.addEventListener('click', () => selectRobot(tab.dataset.robot));
  });
  $$('#robot-comparisons .comparison-robot').forEach(panel => {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `robot-tab-${panel.dataset.robot}`);
    panel.querySelector('.robot-heading').hidden = true;
  });
  selectRobot($('#robot-tabs [role="tab"]').dataset.robot);
  $('#robot-tabs').hidden = false;
  enableTabKeyboard($('#robot-tabs'));
  $$('.video-expand').forEach(button => {
    button.addEventListener('click', () => openModal(button));
    button.hidden = false;
  });
  $$('.playback-toolbar').forEach(toolbar => { toolbar.hidden = false; });
  $$('[data-playback-group]').forEach(grid => {
    grid.querySelectorAll('video').forEach(video => {
      handleMediaError(video, video.getAttribute('aria-label'));
    });
    observeGroup(grid.dataset.playbackGroup);
  });
}

function selectRobot(robotId) {
  $$('#robot-tabs [role="tab"]').forEach((tab) => {
    const selected = tab.dataset.robot === robotId;
    tab.setAttribute('aria-selected', String(selected));
    tab.classList.toggle('active', selected);
    tab.tabIndex = selected ? 0 : -1;
  });
  $$('#robot-comparisons [role="tabpanel"]').forEach((panel) => {
    panel.hidden = panel.dataset.robot !== robotId;
    if (panel.hidden) {
      const grid = panel.querySelector('[data-playback-group]');
      visibleGroups.delete(grid);
      controlGroup(grid.dataset.playbackGroup, 'pause', true);
    }
  });
}

function waitForVideo(video) {
  if (video.error) return Promise.reject(new Error('A recording is unavailable.'));
  if (video.readyState >= 3) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timeout);
      video.removeEventListener('canplay', ready);
      video.removeEventListener('error', failed);
      error ? reject(error) : resolve();
    };
    const ready = () => done();
    const failed = () => done(new Error('A recording is unavailable.'));
    const timeout = setTimeout(() => done(new Error('The videos are taking longer to load. Please try again.')), 15000);
    video.addEventListener('canplay', ready, { once: true });
    video.addEventListener('error', failed, { once: true });
    video.preload = 'auto';
  });
}

const groupActions = new Map();
async function controlGroup(group, action, automatic = false) {
  const grid = $(`#${group}-videos`);
  if (action !== 'pause' && grid.closest('[hidden]')) return;
  if (automatic && action !== 'pause' && (!canAutoplay() || grid.dataset.userPaused === 'true')) return;
  if (!automatic) grid.dataset.userPaused = String(action === 'pause');
  const videos = [...grid.querySelectorAll('video')];
  const status = $(`#${group}-status`);
  const token = {};
  groupActions.set(group, token);
  status.textContent = '';
  if (action === 'pause') {
    videos.forEach((video) => video.pause());
    return;
  }
  if (!videos.length) return;
  videos.forEach((video) => video.pause());
  if (action === 'restart' || videos.every((video) => video.ended)) videos.forEach((video) => { video.currentTime = 0; });
  status.textContent = 'Preparing videos…';
  try {
    await Promise.all(videos.map(waitForVideo));
    if (groupActions.get(group) !== token || videos.some((video) => !video.isConnected)) return;
    await Promise.all(videos.filter((video) => !video.ended).map((video) => video.play()));
    if (groupActions.get(group) === token) status.textContent = '';
  } catch (error) {
    if (groupActions.get(group) !== token || videos.some((video) => !video.isConnected)) return;
    videos.forEach((video) => video.pause());
    if (error.name === 'AbortError') return;
    status.textContent = error.name === 'NotAllowedError' ? 'Use a video’s play button to allow playback, then try again.' : error.message;
  }
}

function openModal(opener) {
  const dialog = $('#video-modal');
  const row = opener.closest('.comparison-skill');
  const robot = opener.closest('.comparison-robot').dataset.robot;
  const taskLabel = row.querySelector('h4').textContent;
  const method = opener.closest('.video-card-header').querySelector('span').textContent;
  modalOpener = opener;
  pauseBackground();
  $('#modal-title').textContent = taskLabel;
  $('#modal-robot').textContent = `${$(`#robot-tab-${robot}`).textContent} · ${method}`;
  $('#modal-prompt').textContent = row.querySelector('.task-prompt').textContent.replace(/^Task: /, '');
  const video = createVideo({ src: opener.dataset.src, poster: opener.dataset.poster }, `${taskLabel} — ${method}`);
  video.loop = true;
  $('#modal-media').replaceChildren(video);
  dialog.showModal();
  document.body.style.overflow = 'hidden';
  video.play().catch((error) => {
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError' && !video.error) {
      $('#modal-media').append(placeholder(taskLabel, 'Use the video controls to start playback.', 'Playback paused'));
    }
  });
}

function initializeControls() {
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-group]');
    if (button) controlGroup(button.dataset.group, button.dataset.action);
  });
  const pauseModal = () => $('#video-modal').querySelectorAll('video').forEach((video) => video.pause());
  const closeModal = () => { pauseModal(); $('#video-modal').close(); };
  $('#video-close').addEventListener('click', closeModal);
  $('#video-modal').addEventListener('cancel', pauseModal);
  $('#video-modal').addEventListener('close', () => {
    pauseModal();
    document.body.style.overflow = '';
    modalOpener?.focus({ preventScroll: true });
    resumeBackground();
  });
  $('#video-modal').addEventListener('click', (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeModal();
  });
}

function initializeHero() {
  const video = $('#hero-video');
  const button = $('#hero-toggle');
  handleMediaError(video, 'Highlights');
  const updateButton = () => {
    button.textContent = video.paused ? 'Play ▷' : 'Pause Ⅱ';
    button.setAttribute('aria-label', `${video.paused ? 'Play' : 'Pause'} highlight video`);
    button.setAttribute('aria-pressed', String(!video.paused));
  };
  button.addEventListener('click', () => {
    video.dataset.userPaused = String(!video.paused);
    if (video.paused) video.play().catch(() => updateButton());
    else video.pause();
  });
  video.addEventListener('play', updateButton);
  video.addEventListener('pause', updateButton);
  updateButton();
  videoObserver.observe(video);
}

function initializeHardware() {
  $$('#hardware video').forEach((video) => {
    handleMediaError(video, video.getAttribute('aria-label'));
    videoObserver.observe(video);
  });
}

function initializeNavigation() {
  const links = $$('.toc a:not(.toc-top)');
  const sections = $$('.section');
  function update() {
    const active = [...sections].reverse().find((section) => section.getBoundingClientRect().top < window.innerHeight * 0.35);
    links.forEach((link) => {
      const selected = link.hash === `#${active?.id}`;
      link.classList.toggle('active', selected);
      if (selected) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  let scheduled = false;
  window.addEventListener('scroll', () => {
    if (!scheduled) requestAnimationFrame(() => { update(); scheduled = false; });
    scheduled = true;
  }, { passive: true });
  update();
}

function init() {
  initializeNavigation();
  initializeDemos();
  initializeControls();
  initializeHero();
  initializeHardware();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pauseBackground();
    $('#video-modal').querySelectorAll('video').forEach((video) => video.pause());
  } else resumeBackground();
});
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) pauseBackground();
  else resumeBackground();
});
$$('figure img').forEach((image) => image.addEventListener('error', () => {
  image.hidden = true;
  image.parentElement.prepend(placeholder('Figure placeholder', 'This illustration is currently unavailable.', 'Image unavailable'));
}, { once: true }));
init();
