import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';

// Commit the generated HTML so visitors and crawlers do not need JavaScript
// to discover the demonstrations. Paths resolve from this script, not cwd.
const root = new URL('../', import.meta.url);
const checkOnly = process.argv.slice(2).includes('--check');
assert(process.argv.slice(2).every(arg => arg === '--check'), 'Usage: node scripts/render-demos.mjs [--check]');
const media = JSON.parse(await readFile(new URL('assets/media.json', root), 'utf8'));
const methods = { gpt: 'GPT', eureka: 'Eureka-style', oneshot: 'One-shot Motion', ours: 'RoboForge (ours)' };
const skills = { go2: 'bend', microduck: 'microduck_curious_look', ostrich: 'ostrich_walk_happy', gorilla: 'gorilla_handstand' };
const refinements = {
  go2: { task: 'walk_lie', observed: 'A standing-to-crouch transition followed by low, alternating steps.', changed: 'Continuous body shifts toward the supporting legs, with increased swing-foot clearance.' },
  gorilla: { task: 'gorilla_handstand', observed: 'The torso rotates into a handstand.', changed: 'The legs fold before inversion, with flat palms through the handstand and recovery.' },
};
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
assert(Array.isArray(media.robots) && Array.isArray(media.tasks) && media.hero, 'Incomplete media catalog');
async function validateAsset(asset) {
  assert(asset, 'Missing media asset');
  for (const key of ['src', 'poster']) {
    const value = asset[key];
    assert(typeof value === 'string' && /^assets\/[a-zA-Z0-9_./-]+$/.test(value) && !value.split('/').includes('..'), `Invalid ${key}: ${value}`);
    await access(new URL(value, root));
  }
  if (asset.preview) await validateAsset(asset.preview);
}
await validateAsset(media.hero);
for (const task of media.tasks) {
  for (const method of Object.keys(methods)) await validateAsset(task.methods?.[method]);
  for (const reference of Object.values(task.references || {})) await validateAsset(reference);
}
function taskFor(robot, id) {
  const task = media.tasks.find(item => item.id === id && item.robot === robot);
  assert(task, `Missing task ${id} for ${robot}`);
  return task;
}
function video(asset, title) {
  const preview = asset.preview || asset;
  return `<video src="${escape(preview.src)}" poster="${escape(preview.poster)}" aria-label="${escape(title)}" controls muted playsinline preload="none"></video>`;
}
function toolbar(group) {
  return `<div class="playback-toolbar" hidden><div class="playback-buttons">${[['play', '▶ Play all'], ['pause', 'Ⅱ Pause all'], ['restart', '↺ Replay']].map(([action, label]) => `<button type="button" class="small-button" data-group="${group}" data-action="${action}" aria-controls="${group}-videos">${label}</button>`).join('')}</div><span class="caption">Original speed</span></div><p id="${group}-status" class="playback-status" role="status"></p>`;
}
const expandIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>';
function comparison(robot) {
  const task = taskFor(robot.id, skills[robot.id]);
  const group = `baseline-${robot.id}`;
  const cards = Object.entries(methods).map(([method, label]) => {
    const asset = task.methods[method];
    return `          <article class="video-card${method === 'ours' ? ' featured' : ''}"><div class="video-card-header"><span>${label}</span><button type="button" class="text-button video-expand" title="Expand video" data-testid="video-open" data-method="${method}" data-src="${escape(asset.src)}" data-poster="${escape(asset.poster)}" aria-label="${escape(`Watch ${task.label} on ${robot.label} — ${label}`)}" hidden>${expandIcon}</button></div><div class="video-frame">${video(asset, label)}</div></article>`;
  }).join('\n');
  return `      <article id="robot-panel-${robot.id}" class="comparison-robot" data-robot="${robot.id}" data-testid="comparison-robot" aria-labelledby="robot-heading-${robot.id}">
        <h3 id="robot-heading-${robot.id}" class="robot-heading">${escape(robot.label)}</h3>
        <div class="comparison-skill" data-testid="comparison-skill" data-task="${task.id}">
          <h4>${escape(task.label)}</h4><p class="task-prompt">Task: ${escape(task.prompt)}</p>
          <div id="${group}-videos" class="baseline-grid" data-playback-group="${group}">
${cards}
          </div>
          ${toolbar(group)}
        </div>
      </article>`;
}
function refinement(robot, chosen) {
  const task = taskFor(robot, chosen.task);
  const label = media.robots.find(item => item.id === robot)?.label;
  assert(label, `Missing robot ${robot}`);
  const group = `refinement-${robot}`;
  const cards = [['initial', 'Initial motion'], ['final', 'Final motion']].map(([key, title]) => {
    const asset = task.references?.[key];
    assert(asset && Number.isInteger(asset.trial), `Missing ${key} reference trial for ${task.id}`);
    return `          <article class="video-card${key === 'final' ? ' featured' : ''}"><div class="video-card-header"><span>${title}</span><span class="video-tag">Trial ${asset.trial}</span></div><div class="video-frame">${video(asset, title)}</div></article>`;
  }).join('\n');
  return `      <article id="${group}" class="refinement-row" data-robot="${robot}" data-testid="refinement-row" aria-labelledby="${group}-title">
        <div class="case-heading"><h3 id="${group}-title">${escape(label)} · ${escape(task.label)}</h3></div>
        <p class="task-prompt">Task: ${escape(task.prompt)}</p>
        <div id="${group}-videos" class="two-video-grid" data-playback-group="${group}">
${cards}
        </div>
        ${toolbar(group)}
        <div class="case-explanation"><div><span class="mono">Initial motion</span><p>${escape(chosen.observed)}</p></div><div><span class="mono accent">Final motion</span><p>${escape(chosen.changed)}</p></div></div>
      </article>`;
}
const sections = {
  hero: `    <div class="hero-viewport"><video id="hero-video" class="hero-video" src="${escape(media.hero.src)}" poster="${escape(media.hero.poster)}" muted loop playsinline preload="metadata" aria-label="A montage of learned behaviors on four simulated robots"></video></div>`,
  comparisons: `      <div id="robot-tabs" class="robot-tabs" role="tablist" aria-label="Choose a robot" hidden>${media.robots.map(robot => `<button type="button" id="robot-tab-${robot.id}" class="chip" data-robot="${robot.id}" data-testid="robot-tab" role="tab" aria-controls="robot-panel-${robot.id}">${escape(robot.label)}</button>`).join('')}</div>\n      <div id="robot-comparisons">\n${media.robots.map(comparison).join('\n')}\n      </div>`,
  refinements: `      <div id="refinement-rows">\n${Object.entries(refinements).map(([robot, chosen]) => refinement(robot, chosen)).join('\n')}\n      </div>`,
};
const filename = new URL('index.html', root);
const original = await readFile(filename, 'utf8');
let html = original;
for (const [name, content] of Object.entries(sections)) {
  const marker = new RegExp(`(<!-- demos:${name}:start -->)\\n[\\s\\S]*?( *<!-- demos:${name}:end -->)`, 'g');
  assert.equal([...html.matchAll(marker)].length, 1, `Expected one ${name} block in index.html`);
  html = html.replace(marker, (_, start, end) => `${start}\n${content}\n${end}`);
}
if (checkOnly) assert.equal(html, original, 'Static demonstrations are stale. Run npm run render:demos.');
else if (html !== original) await writeFile(filename, html);
console.log(checkOnly ? 'PASS static demonstrations match the media catalog.' : 'Static demonstrations written to index.html.');
