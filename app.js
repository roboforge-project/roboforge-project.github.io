'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const methodLabels = { gpt: 'GPT', eureka: 'Eureka-style', oneshot: 'One-shot Motion', ours: 'RoboForge (ours)' };
const caseData = {
  go2: {
    task: 'walk_lie',
    observed: 'A standing-to-crouch transition followed by low, alternating steps.',
    changed: 'Continuous body shifts toward the supporting legs, with increased swing-foot clearance.',
  },
  gorilla: {
    task: 'gorilla_handstand',
    observed: 'The torso rotates into a handstand.',
    changed: 'The legs fold before inversion, with flat palms through the handstand and recovery.',
  },
};
const comparisonSkills = {
  go2: 'bend',
  microduck: 'microduck_curious_look',
  ostrich: 'ostrich_walk_happy',
  gorilla: 'gorilla_handstand',
};
let media;
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
  video.addEventListener('error', () => {
    video.hidden = true;
    if (!video.parentElement.querySelector('.media-placeholder')) {
      const fallback = placeholder(title, 'This recording is currently unavailable.', 'Media unavailable');
      if (video.id === 'hero-video') fallback.classList.add('hero-media-error');
      video.parentElement.append(fallback);
    }
  }, { once: true });
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

function videoCard(asset, title, featured = false, badge = '') {
  const card = element('article', `video-card${featured ? ' featured' : ''}`);
  const header = element('div', 'video-card-header');
  header.append(element('span', '', title));
  if (badge) header.append(element('span', 'video-tag', badge));
  const frame = element('div', 'video-frame');
  frame.append(asset ? createVideo(asset.preview || asset, title) : placeholder(title, 'Reference recording to be added.', 'Reference placeholder'));
  card.append(header, frame);
  return card;
}

function robotLabel(id) {
  return media.robots.find((robot) => robot.id === id).label;
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

function renderRefinements() {
  Object.entries(caseData).forEach(([robot, chosen]) => {
    const task = media.tasks.find((item) => item.id === chosen.task);
    const group = `refinement-${robot}`;
    const row = element('article', 'refinement-row');
    row.id = group;
    row.dataset.robot = robot;
    row.dataset.testid = 'refinement-row';
    row.setAttribute('aria-labelledby', `${group}-title`);
    const heading = element('div', 'case-heading');
    const title = element('h3', '', `${robotLabel(robot)} · ${task.label}`);
    title.id = `${group}-title`;
    heading.append(title);
    const grid = element('div', 'two-video-grid');
    grid.id = `${group}-videos`;
    grid.dataset.playbackGroup = group;
    const refs = task.references || {};
    grid.append(
      videoCard(refs.initial, 'Initial motion', false, refs.initial ? `Trial ${refs.initial.trial}` : ''),
      videoCard(refs.final, 'Final motion', true, refs.final ? `Trial ${refs.final.trial}` : '')
    );
    const status = element('p', 'playback-status');
    status.id = `${group}-status`;
    status.setAttribute('role', 'status');
    const explanation = element('div', 'case-explanation');
    for (const [label, text, className] of [['Initial motion', chosen.observed, 'mono'], ['Final motion', chosen.changed, 'mono accent']]) {
      const detail = element('div');
      detail.append(element('span', className, label), element('p', '', text));
      explanation.append(detail);
    }
    row.append(heading, element('p', 'task-prompt', `Task: ${task.prompt}`), grid,
      playbackToolbar(group), status, explanation);
    $('#refinement-rows').append(row);
    observeGroup(group);
  });
}

function playbackToolbar(group) {
  const toolbar = element('div', 'playback-toolbar');
  const buttons = element('div', 'playback-buttons');
  for (const [action, label] of [['play', '▶ Play all'], ['pause', 'Ⅱ Pause all'], ['restart', '↺ Replay']]) {
    const button = element('button', 'small-button', label);
    button.type = 'button';
    button.dataset.group = group;
    button.dataset.action = action;
    button.setAttribute('aria-controls', `${group}-videos`);
    buttons.append(button);
  }
  toolbar.append(buttons, element('span', 'caption', 'Original speed'));
  return toolbar;
}

function renderComparisons() {
  $('#robot-comparisons').replaceChildren();
  $('#robot-tabs').replaceChildren();
  media.robots.forEach((robot) => {
    const tab = element('button', 'chip', robot.label);
    tab.type = 'button';
    tab.id = `robot-tab-${robot.id}`;
    tab.dataset.robot = robot.id;
    tab.dataset.testid = 'robot-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `robot-panel-${robot.id}`);
    tab.addEventListener('click', () => selectRobot(robot.id));
    $('#robot-tabs').append(tab);
    const section = element('article', 'comparison-robot');
    section.id = `robot-panel-${robot.id}`;
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-labelledby', tab.id);
    section.hidden = true;
    section.dataset.robot = robot.id;
    section.dataset.testid = 'comparison-robot';
    const task = media.tasks.find((item) => item.id === comparisonSkills[robot.id]);
    const group = `baseline-${robot.id}`;
    const row = element('div', 'comparison-skill');
    row.dataset.testid = 'comparison-skill';
    row.dataset.task = task.id;
    row.append(element('h4', '', task.label), element('p', 'task-prompt', `Task: ${task.prompt}`));
    const grid = element('div', 'baseline-grid');
    grid.id = `${group}-videos`;
    grid.dataset.playbackGroup = group;
    grid.append(...['gpt', 'eureka', 'oneshot', 'ours'].map((method) => {
      const card = videoCard(task.methods[method], methodLabels[method], method === 'ours');
      const open = element('button', 'text-button video-expand');
      open.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>';
      open.type = 'button';
      open.title = 'Expand video';
      open.dataset.testid = 'video-open';
      open.dataset.method = method;
      open.setAttribute('aria-label', `Watch ${task.label} on ${robot.label} — ${methodLabels[method]}`);
      open.addEventListener('click', () => openModal(task, method, open));
      card.querySelector('.video-card-header').append(open);
      return card;
    }));
    const status = element('p', 'playback-status');
    status.id = `${group}-status`;
    status.setAttribute('role', 'status');
    row.append(grid, playbackToolbar(group), status);
    section.append(row);
    $('#robot-comparisons').append(section);
    section.querySelectorAll('[data-playback-group]').forEach((grid) => observeGroup(grid.dataset.playbackGroup));
  });
  selectRobot(media.robots[0].id);
  enableTabKeyboard($('#robot-tabs'));
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

function openModal(task, method, opener) {
  const dialog = $('#video-modal');
  modalOpener = opener;
  pauseBackground();
  $('#modal-title').textContent = task.label;
  $('#modal-robot').textContent = `${robotLabel(task.robot)} · ${methodLabels[method]}`;
  $('#modal-prompt').textContent = task.prompt;
  const video = createVideo(task.methods[method], `${task.label} — ${methodLabels[method]}`);
  video.loop = true;
  $('#modal-media').replaceChildren(video);
  dialog.showModal();
  document.body.style.overflow = 'hidden';
  video.play().catch((error) => {
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError' && !video.error) {
      $('#modal-media').append(placeholder(task.label, 'Use the video controls to start playback.', 'Playback paused'));
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
  video.poster = media.hero.poster;
  video.src = media.hero.src;
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

function validateManifest(value) {
  if (!Array.isArray(value.tasks) || !value.tasks.length || !Array.isArray(value.robots) || !value.hero) throw new Error('The demonstration catalog is incomplete.');
  const check = (asset) => {
    if (!asset || !['src', 'poster'].every((key) => typeof asset[key] === 'string' && /^assets\/[a-zA-Z0-9_./-]+$/.test(asset[key]) && !asset[key].split('/').includes('..'))) throw new Error('The demonstration catalog contains an invalid media path.');
    if (asset.preview) check(asset.preview);
  };
  check(value.hero);
  value.tasks.forEach((task) => {
    ['gpt', 'eureka', 'oneshot', 'ours'].forEach((method) => check(task.methods?.[method]));
    Object.values(task.references || {}).forEach(check);
  });
}

async function init() {
  initializeNavigation();
  try {
    const response = await fetch('assets/media.json');
    if (!response.ok) throw new Error('The demonstration catalog could not be loaded.');
    media = await response.json();
    validateManifest(media);
    renderRefinements();
    renderComparisons();
    initializeControls();
    initializeHero();
    initializeHardware();
  } catch (error) {
    $('#robot-comparisons').replaceChildren(placeholder('Demonstrations unavailable', 'Please reload the page to try again.', 'Catalog unavailable'));
    $('#data-error').textContent = error.message;
    $('#data-error').hidden = false;
    $$('[data-group]').forEach((button) => { button.disabled = true; });
  }
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
