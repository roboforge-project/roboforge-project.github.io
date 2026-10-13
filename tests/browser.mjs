import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(siteRoot, 'validation');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome';
const failures = [];
let browser;
let server;
let serverOutput = '';

async function assertStandalone(directory = siteRoot) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'validation', '.git'].includes(entry.name)) continue;
    assert(!entry.isSymbolicLink(), `Runtime directory contains a symbolic link: ${path.join(directory, entry.name)}`);
    if (entry.isDirectory()) await assertStandalone(path.join(directory, entry.name));
  }
}

async function startServer() {
  // Python chooses a free loopback port and serves this directory regardless of cwd.
  const source = `
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import sys
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=sys.argv[1]))
print(server.server_address[1], flush=True)
server.serve_forever()
`;
  server = spawn(process.env.PYTHON || 'python3', ['-u', '-c', source, siteRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-12000); });
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Local server did not start. ${serverOutput}`)), 10000);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Local server exited with ${code}. ${serverOutput}`)); });
    server.stdout.once('data', chunk => {
      clearTimeout(timeout);
      const port = Number(String(chunk).trim());
      if (!Number.isInteger(port) || port <= 0) reject(new Error(`Invalid local server port: ${chunk}`));
      else resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function watchPage(page, origin, { expectedMissing = false } = {}) {
  page.on('pageerror', error => failures.push(`Uncaught JavaScript: ${error.message}`));
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) failures.push(`External request: ${url}`);
  });
  page.on('response', response => {
    if (response.status() >= 400 && !expectedMissing) failures.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on('console', message => {
    if (message.type() === 'error' && !expectedMissing) failures.push(`Browser console: ${message.text()}`);
  });
}

async function eventually(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  assert(dimensions.content <= dimensions.viewport + 1, `${label} horizontal overflow: ${JSON.stringify(dimensions)}`);
}

async function checkHero(page) {
  const dimensions = await page.locator('#hero-video').evaluate(video => {
    const box = video.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight, fit: getComputedStyle(video).objectFit, paused: video.paused };
  });
  assert.equal(dimensions.x, 0, 'Hero video should start at the left edge');
  assert.equal(dimensions.y, 0, 'Hero video should start at the top edge');
  assert.equal(dimensions.width, dimensions.viewportWidth, 'Hero video should span the viewport width');
  assert.equal(dimensions.height, dimensions.viewportHeight, 'Hero video should fill the first screen');
  assert.equal(dimensions.fit, 'cover', 'Hero footage should cover its viewport');
  assert(dimensions.paused, 'Reduced-motion visitors should see a paused hero');
}

async function checkStaticDemos(origin) {
  const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  watchPage(page, origin);
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  const manifest = await (await page.request.get(`${origin}/assets/media.json`)).json();
  assert.equal(await page.title(), 'RoboForge — Generation, Verification & Revision');
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://roboforge-project.github.io/');
  const site = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
  assert.equal(site['@type'], 'WebSite');
  assert.equal(site.name, 'RoboForge');
  assert.equal(site.url, 'https://roboforge-project.github.io/');
  assert.equal(await page.locator('#hero-video').getAttribute('src'), manifest.hero.src);
  assert.equal(await page.locator('#robot-tabs').isVisible(), false, 'Tabs require JavaScript');
  assert.equal(await page.locator('#skills .comparison-robot:visible').count(), 4, 'All robots must be readable without JavaScript');
  assert.equal(await page.locator('#refinement .refinement-row:visible').count(), 2);
  assert.equal(await page.locator('#skills video').count(), 16);
  assert.equal(await page.locator('#refinement video').count(), 4);
  for (const robot of manifest.robots) {
    const panel = page.locator(`#robot-panel-${robot.id}`);
    const taskId = await panel.locator('.comparison-skill').getAttribute('data-task');
    const task = manifest.tasks.find(task => task.id === taskId && task.robot === robot.id);
    assert(task, 'Static panel must describe a real task for its robot');
    assert.equal(await panel.locator('.task-prompt').textContent(), `Task: ${task.prompt}`);
    assert.equal(await panel.locator('.robot-heading').textContent(), robot.label);
    const videos = await panel.locator('video').evaluateAll(nodes => nodes.map(node => ({ src: node.getAttribute('src'), poster: node.getAttribute('poster'), controls: node.controls })));
    Object.keys({ gpt: 0, eureka: 0, oneshot: 0, ours: 0 }).forEach((method, i) => {
      const asset = task.methods[method].preview || task.methods[method];
      assert.deepEqual(videos[i], { src: asset.src, poster: asset.poster, controls: true });
    });
  }
  assert(await page.locator('video').evaluateAll(nodes => nodes.every(node => node.getAttribute('src') && node.getAttribute('poster'))), 'Every video needs an initial source and poster');
  assert.equal(await page.locator('.video-expand:visible, .playback-toolbar:visible').count(), 0, 'Hide script-only controls without JavaScript');
  await assertNoOverflow(page, 'Static mobile page');
  await page.close();
}

async function exerciseComparison(page) {
  const manifest = await page.evaluate(async () => (await fetch('assets/media.json')).json());
  const expectedTasks = { go2: 'bend', microduck: 'microduck_curious_look', ostrich: 'ostrich_walk_happy', gorilla: 'gorilla_handstand' };
  const robots = page.locator('#skills').getByTestId('comparison-robot');
  assert.equal(await robots.count(), 4, 'Comparisons should include all four robots');
  assert.equal(await page.getByTestId('robot-tab').count(), 4, 'Show four robot buttons');
  for (const robot of await robots.all()) {
    const id = await robot.getAttribute('data-robot');
    const tab = page.locator(`#robot-tab-${id}`);
    await tab.click();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#robot-comparisons [role="tabpanel"]:visible').count(), 1, 'Only the selected robot is visible');
    assert(await robot.isVisible(), 'Selected robot panel should be visible');
    assert(await page.locator('#robot-comparisons [hidden] video').evaluateAll(videos => videos.every(video => video.paused)), 'Hidden robots must be paused');
    const rows = robot.getByTestId('comparison-skill');
    assert.equal(await rows.count(), 1, 'Each robot should show exactly one featured skill');
    for (const row of await rows.all()) {
      const taskId = await row.getAttribute('data-task');
      assert.equal(taskId, expectedTasks[await robot.getAttribute('data-robot')], 'Featured skill must match the opening video');
      const task = manifest.tasks.find(task => task.id === taskId);
      assert.equal(task.robot, await robot.getAttribute('data-robot'), 'Skill belongs to the wrong robot');
      assert.equal(await row.locator('.task-prompt').textContent(), `Task: ${task.prompt}`, 'Show the matching task description');
      const sources = await row.locator('video').evaluateAll(videos => videos.map(video => video.src));
      assert.equal(sources.length, 4, 'Each skill should show all four methods');
      ['gpt', 'eureka', 'oneshot', 'ours'].forEach((method, index) => assert(sources[index].endsWith((task.methods[method].preview || task.methods[method]).src), 'Method label and policy preview must match'));
      assert.equal(await row.locator('.video-card-header').last().textContent(), 'RoboForge (ours)');
    }
  }
  await page.locator('#robot-tab-gorilla').press('Home');
  assert.equal(await page.locator('#robot-tab-go2').getAttribute('aria-selected'), 'true', 'Home should select the first robot');
  await page.locator('#robot-tab-go2').press('ArrowRight');
  assert.equal(await page.locator('#robot-tab-microduck').getAttribute('aria-selected'), 'true', 'Arrow keys should switch robots');
  await page.locator('#robot-tab-microduck').press('Home');
  const row = page.getByTestId('comparison-skill').first();
  const videos = row.locator('video');
  await row.locator('[data-action="play"]').click();
  await eventually(() => videos.evaluateAll(nodes => nodes.every(video => !video.paused && video.currentTime > 0.05)), 'Comparison videos did not start playing');
  await row.locator('[data-action="pause"]').click();
  assert(await videos.evaluateAll(nodes => nodes.every(video => video.paused)), 'Pause should stop every video in the row');
  const pausedTimes = await videos.evaluateAll(nodes => nodes.map(video => video.currentTime));
  await new Promise(resolve => setTimeout(resolve, 250));
  const afterPause = await videos.evaluateAll(nodes => nodes.map(video => video.currentTime));
  assert(pausedTimes.every((time, index) => Math.abs(time - afterPause[index]) < 0.1), 'Paused comparison continued advancing');
  await row.locator('[data-action="restart"]').click();
  await eventually(() => videos.evaluateAll(nodes => nodes.every(video => !video.paused && video.currentTime < 1)), 'Restart should reset and play all comparison videos');
  await row.locator('[data-action="pause"]').click();
}

async function exerciseRefinement(page) {
  const rows = page.getByTestId('refinement-row');
  assert.equal(await page.locator('#refinement [role="tablist"]').count(), 0, 'Motion references should not use a case switcher');
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(row => row.dataset.robot)), ['go2', 'gorilla'], 'Show Go2 then Gorilla as two permanent rows');
  const manifest = await page.evaluate(async () => (await fetch('assets/media.json')).json());
  const taskIds = { go2: 'walk_lie', gorilla: 'gorilla_handstand' };
  for (const row of await rows.all()) {
    assert(await row.isVisible(), 'Both reference rows should remain displayed');
    const robot = await row.getAttribute('data-robot');
    const task = manifest.tasks.find(task => task.id === taskIds[robot]);
    assert.deepEqual(Object.keys(task.references), ['initial', 'final'], 'Only first and final training references should be selected');
    assert.equal(task.references.initial.trial, 1);
    assert.equal(task.references.final.trial, 3);
    assert.equal(await row.locator('.task-prompt').textContent(), `Task: ${task.prompt}`, 'Task wording must match the shared catalog');
    const sources = await row.locator('video').evaluateAll(videos => videos.map(video => video.src));
    const expected = Object.values(task.references).map(asset => (asset.preview || asset).src);
    assert.equal(sources.length, expected.length, 'Only actual reference recordings should be present');
    expected.forEach((source, index) => assert(sources[index].endsWith(source), 'Motion comparison must use reference assets, not policy videos'));
    assert.equal(await row.locator('.video-card').count(), 2, 'Each row should contain its initial/final pair');
    assert.equal(await row.getByTestId('media-placeholder').count(), 0, 'Both references are available');
    assert((await row.locator('.video-card-header').last().textContent()).startsWith('Final motion'), 'The second slot must show the final reference');
    await row.locator('[data-action="play"]').click();
    await eventually(() => row.locator('video').evaluateAll(videos => videos.length === 2 && videos.every(video => !video.paused && video.currentTime > .05)), `${robot}: both first and final videos should play`);
    await row.locator('[data-action="pause"]').click();
    assert(await row.locator('video').evaluateAll(videos => videos.every(video => video.paused)), `${robot}: both videos should pause`);
  }
  const bounds = await rows.evaluateAll(nodes => nodes.map(row => ({ top: row.getBoundingClientRect().top, bottom: row.getBoundingClientRect().bottom })));
  assert(bounds[1].top > bounds[0].bottom, 'Gorilla should appear below the complete Go2 row');
  const introduction = (await page.locator('#refinement > .section-intro').allTextContents()).join(' ');
  assert(introduction.includes('reference motion'), 'Motion-refinement introduction should identify reference motion');
  assert.equal(await page.locator('#refinement-note').count(), 0, 'Remove the intermediate-trial note');
}

async function exerciseHardware(page) {
  const section = page.locator('#hardware');
  assert.equal(await section.locator('img').count(), 1, 'Real-world section should show only the assembled robot photograph');
  assert((await section.locator('img').getAttribute('src')).endsWith('hardware-gorilla.webp'));
  assert.equal(await section.getByTestId('media-placeholder').count(), 0, 'Hardware recordings should replace placeholders');
  assert(!(await section.locator('.section-intro').textContent()).includes('The paper'), 'Describe our method directly');
  const videos = section.locator('video');
  assert.deepEqual(await videos.evaluateAll(nodes => nodes.map(video => video.getAttribute('src'))), ['assets/videos/hardware/walk.mp4', 'assets/videos/hardware/wave.mp4']);
  for (const video of await videos.all()) {
    await video.scrollIntoViewIfNeeded();
    assert(await video.evaluate(node => node.muted && node.loop && node.playsInline && node.paused), 'Hardware video should be muted and paused for reduced motion');
    await video.evaluate(node => node.play());
    await eventually(() => video.evaluate(node => !node.paused && node.currentTime > .05 && node.videoWidth > 0), 'Hardware recording should play');
    await video.evaluate(node => node.pause());
  }
}

async function exerciseModal(page) {
  const row = page.getByTestId('comparison-skill').first();
  const modal = page.getByTestId('video-modal');
  const manifest = await page.evaluate(async () => (await fetch('assets/media.json')).json());
  const task = manifest.tasks.find(task => task.id === 'bend');
  const cards = row.locator('.video-card');
  for (const card of await cards.all()) {
    const method = await card.getByTestId('video-open').getAttribute('data-method');
    const source = task.methods[method].src;
    const label = await card.locator('.video-card-header').textContent();
    await card.getByTestId('video-open').click();
    await modal.waitFor({ state: 'visible' });
    assert.equal(await modal.locator('video').getAttribute('src'), source, 'Expanded video must show the chosen method in its original full frame');
    assert((await modal.locator('#modal-robot').textContent()).endsWith(label), 'Modal must identify the chosen method');
    await page.keyboard.press('Escape');
    await modal.waitFor({ state: 'hidden' });
    assert(await modal.locator('video').evaluateAll(nodes => nodes.every(video => video.paused)), 'Closing modal should stop playback');
  }
}

async function checkAnchors(page) {
  const broken = await page.locator('a[href^="#"]').evaluateAll(links => links
    .map(link => link.getAttribute('href'))
    .filter(href => href.length > 1 && !document.getElementById(decodeURIComponent(href.slice(1)))));
  assert.deepEqual(broken, [], 'Navigation contains nonexistent targets');
  const methodLink = page.locator('a[href="#method"]').first();
  await methodLink.click();
  await eventually(async () => new URL(page.url()).hash === '#method', 'Method navigation failed');
}

async function exerciseRobotModel(page, touch = false) {
  const viewer = page.locator('#robot-model');
  await viewer.scrollIntoViewIfNeeded();
  await eventually(() => viewer.evaluate(model => model.loaded === true), 'Robot model did not load', 30000);
  assert(await page.locator('#model-status').isHidden(), 'Successful model load should hide the loading message');
  const initial = await viewer.evaluate(model => ({ ...model.getCameraOrbit() }));
  const box = await viewer.boundingBox();
  const x = box.x + box.width * .4;
  const y = box.y + box.height * .5;
  if (touch) {
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + step * 12, y }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 100, y, { steps: 10 });
    await page.mouse.up();
  }
  await eventually(() => viewer.evaluate((model, theta) => Math.abs(model.getCameraOrbit().theta - theta) > .05, initial.theta), 'Dragging should rotate the 3D model');
  await page.locator('#model-reset').click();
  await eventually(() => viewer.evaluate((model, orbit) => {
    const current = model.getCameraOrbit();
    return Math.abs(current.theta - orbit.theta) < .001 && Math.abs(current.phi - orbit.phi) < .001 && Math.abs(current.radius - orbit.radius) < .001;
  }, initial), 'Reset view should restore the original camera');
  await assertNoOverflow(page, touch ? 'Mobile model' : 'Desktop model');
}

async function checkMissingModel(origin) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await page.route('**/assets/models/gorilla.glb', route => route.fulfill({ status: 404, body: 'Intentional missing model test' }));
  await page.goto(`${origin}/#method`, { waitUntil: 'domcontentloaded' });
  await page.locator('#robot-model').scrollIntoViewIfNeeded();
  await eventually(async () => (await page.locator('#model-status').textContent()).includes('3D model unavailable'), 'Missing model should show an explicit error');
  assert(await page.locator('#model-reset').isDisabled(), 'Reset must stay disabled when the model fails to load');
  const poster = page.locator('#robot-model').locator('#default-poster');
  assert(await poster.isVisible(), 'Missing model should retain its assembly preview');
  await page.close();
}

async function checkMissingMedia(origin) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  watchPage(page, origin, { expectedMissing: true });
  let missingURL;
  await page.route('**/*.mp4', async route => {
    if (!missingURL) missingURL = route.request().url();
    if (route.request().url() === missingURL) await route.fulfill({ status: 404, body: 'Intentional missing video test' });
    else await route.continue();
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('comparison-skill').first().waitFor();
  await eventually(async () => Boolean(missingURL), 'Missing-media test did not intercept a video');
  await eventually(() => page.locator('video').evaluateAll((videos, missing) => videos.some(video => {
    const source = video.currentSrc || video.src || video.querySelector('source')?.src;
    if (source !== missing || !video.error) return false;
    let parent = video.parentElement;
    for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
      const placeholder = parent.querySelector('[data-testid="media-placeholder"]');
      if (placeholder && placeholder.getBoundingClientRect().height > 0 && getComputedStyle(placeholder).visibility !== 'hidden') return true;
    }
    return false;
  }), missingURL), 'An unavailable video should reveal a visible placeholder beside its failed player');
  await page.close();
}

async function checkAutoplay(origin) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  watchPage(page, origin);
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  const hero = page.locator('#hero-video');
  await eventually(() => hero.evaluate(video => !video.paused && video.currentTime > 0.05), 'Hero should play automatically without reduced motion');
  await page.locator('#hero-toggle').click();
  assert(await hero.evaluate(video => video.paused), 'Hero pause control should work');
  await page.locator('#hero-toggle').click();
  await eventually(() => hero.evaluate(video => !video.paused), 'Hero play control should work');
  const demo = page.locator('#skills video').first();
  await page.locator('#skills .baseline-grid').first().scrollIntoViewIfNeeded();
  await eventually(() => demo.evaluate(video => !video.paused && video.currentTime > 0.05), 'Visible demo should autoplay');
  assert(await hero.evaluate(video => video.paused), 'Offscreen hero should pause');
  const references = page.locator('#refinement video');
  for (const robot of ['go2', 'gorilla']) {
    const grid = page.locator(`#refinement-${robot}-videos`);
    await grid.scrollIntoViewIfNeeded();
    await eventually(() => grid.locator('video').evaluateAll(videos => videos.length === 2 && videos.every(video => !video.paused && video.currentTime > 0.05)), `${robot}: visible reference pair should autoplay`);
  }
  await eventually(() => demo.evaluate(video => video.paused), 'Offscreen demo video should pause');

  const row = page.getByTestId('comparison-skill').first();
  const comparison = row.locator('video');
  await row.locator('.baseline-grid').scrollIntoViewIfNeeded();
  await eventually(() => comparison.evaluateAll(videos => videos.length === 4 && videos.every(video => !video.paused && video.currentTime > 0.05)), 'Four-method comparison should autoplay');
  await page.locator('#robot-tab-microduck').click();
  const alternate = page.locator('#robot-panel-microduck video');
  await eventually(() => alternate.evaluateAll(videos => videos.every(video => !video.paused && video.currentTime > 0.05)), 'Selecting another robot should autoplay its videos');
  assert(await comparison.evaluateAll(videos => videos.every(video => video.paused)), 'Switching robots should stop the previous group');
  await page.locator('#robot-tab-go2').click();
  await eventually(() => comparison.evaluateAll(videos => videos.every(video => !video.paused)), 'Returning to Go2 should resume its videos');
  assert(await alternate.evaluateAll(videos => videos.every(video => video.paused)), 'Hidden Microduck videos should stop');
  await eventually(() => references.evaluateAll(videos => videos.every(video => video.paused)), 'Offscreen reference pair should pause');
  const positions = await comparison.evaluateAll(videos => videos.map(video => video.getBoundingClientRect().top));
  assert(positions.every(y => Math.abs(y - positions[0]) < 1), 'Desktop methods should share one horizontal row');
  await comparison.evaluateAll(videos => videos.forEach(video => {
    video.addEventListener('ended', () => { video.dataset.finishedCycle = 'true'; }, { once: true });
  }));
  try {
    await eventually(() => comparison.evaluateAll(videos => videos.every(video => video.dataset.finishedCycle === 'true' && !video.paused && video.currentTime < 1)), 'Completed comparisons should restart together', 30000);
  } catch (error) {
    console.error(await comparison.evaluateAll(videos => videos.map(video => ({ src: video.src, time: video.currentTime, duration: video.duration, paused: video.paused, ended: video.ended, ready: video.readyState }))));
    console.error(await row.locator('.playback-status').textContent());
    throw error;
  }
  await row.locator('[data-action="pause"]').click();
  await page.locator('#hardware').scrollIntoViewIfNeeded();
  await row.locator('.baseline-grid').scrollIntoViewIfNeeded();
  assert(await comparison.evaluateAll(videos => videos.every(video => video.paused)), 'Explicit pause should survive scrolling away and back');
  await row.locator('[data-action="play"]').click();
  await eventually(() => comparison.evaluateAll(videos => videos.every(video => !video.paused)), 'Manual play should resume a paused group');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await eventually(() => comparison.evaluateAll(videos => videos.every(video => video.paused)), 'Enabling reduced motion should pause autoplay');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await eventually(() => comparison.evaluateAll(videos => videos.every(video => !video.paused)), 'Disabling reduced motion should resume visible comparisons');
  await page.locator('#hardware').scrollIntoViewIfNeeded();
  await eventually(() => comparison.evaluateAll(videos => videos.every(video => video.paused)), 'Offscreen comparison row should pause');
  const hardware = page.locator('#hardware video');
  for (const video of await hardware.all()) {
    await video.scrollIntoViewIfNeeded();
    await eventually(() => video.evaluate(node => node.muted && !node.paused && node.currentTime > .05), 'Visible hardware recording should autoplay silently');
  }
  await page.locator('#top').scrollIntoViewIfNeeded();
  await eventually(() => hardware.evaluateAll(videos => videos.every(video => video.paused)), 'Offscreen hardware recordings should pause');
  await page.close();
}

async function cleanup() {
  try {
    await browser?.close();
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000);
        server.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}

process.once('SIGINT', () => { cleanup().finally(() => process.exit(130)); });
process.once('SIGTERM', () => { cleanup().finally(() => process.exit(143)); });

try {
  await access(executablePath);
  await assertStandalone();
  await mkdir(artifacts, { recursive: true });
  const origin = await startServer();
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  await checkStaticDemos(origin);
  console.log('PASS without JavaScript: paper title, site identity, canonical URL, all robot tasks, video sources and posters');
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  desktop.setDefaultTimeout(15000);
  watchPage(desktop, origin);
  await desktop.goto(origin, { waitUntil: 'domcontentloaded' });
  await desktop.getByTestId('comparison-skill').first().waitFor();
  await checkHero(desktop);
  await assertNoOverflow(desktop, 'Desktop');
  await checkAnchors(desktop);
  await exerciseRobotModel(desktop);
  await exerciseComparison(desktop);
  await exerciseRefinement(desktop);
  await exerciseModal(desktop);
  await exerciseHardware(desktop);
  await desktop.evaluate(() => { document.querySelectorAll('video').forEach(video => video.pause()); window.scrollTo(0, 0); });
  await desktop.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
  console.log('PASS desktop: navigation, interactive model, featured comparisons, refinement, hardware videos, modal, overflow');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  mobile.setDefaultTimeout(15000);
  watchPage(mobile, origin);
  await mobile.goto(origin, { waitUntil: 'domcontentloaded' });
  await mobile.getByTestId('comparison-skill').first().waitFor();
  await checkHero(mobile);
  await assertNoOverflow(mobile, 'Mobile');
  await exerciseRobotModel(mobile, true);
  await exerciseComparison(mobile);
  await exerciseRefinement(mobile);
  await exerciseModal(mobile);
  await exerciseHardware(mobile);
  await mobile.evaluate(() => { document.querySelectorAll('video').forEach(video => video.pause()); window.scrollTo(0, 0); });
  await mobile.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
  console.log('PASS mobile: touch model controls, featured comparisons, motion references, hardware videos, modal, overflow');

  await checkAutoplay(origin);
  console.log('PASS hero, motion references, hardware and four-method autoplay; grouped looping, pause and reduced motion');
  await checkMissingMedia(origin);
  console.log('PASS missing-video placeholder');
  await checkMissingModel(origin);
  console.log('PASS missing-model preview and error message');
  assert.deepEqual([...new Set(failures)], [], 'Unexpected browser errors or external requests');
  console.log('PASS self-contained resources; no runtime errors or external requests');
  console.log(`Screenshots: ${path.relative(process.cwd(), artifacts)}`);
} catch (error) {
  console.error(error.stack || error);
  if (failures.length) console.error([...new Set(failures)].join('\n'));
  process.exitCode = 1;
} finally {
  await cleanup();
}
