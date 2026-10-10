import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:8080/' },
  output: { type: 'string', default: path.join(root, 'exports/RoboForge-website-review.pdf') },
} });
const output = path.resolve(values.output);
const artifacts = path.join(root, 'validation/pdf-review', path.basename(output, '.pdf'));
let browser;

try {
  assert(output.endsWith('.pdf'), '--output must end in .pdf');
  assert(output.startsWith(`${root}exports/`), '--output must be inside website/exports/');
  let exists = true;
  try { await access(output); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exists = false;
  }
  assert(!exists, `Refusing to overwrite ${output}; choose a new output name.`);
  execFileSync('pdfunite', ['-v'], { stdio: 'pipe' });
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  const response = await page.goto(values.url, { waitUntil: 'domcontentloaded' });
  assert(response?.ok(), `Preview request failed: ${response?.status()}`);
  await page.waitForFunction(() => document.querySelectorAll('.comparison-robot').length === 4);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await customElements.whenDefined('model-viewer');
    document.querySelector('#robot-model').loading = 'eager';
  });
  await page.locator('#robot-model').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#robot-model').loaded, null, { timeout: 45000 });
  // The load event can precede the first WebGL frame. Require rendered model pixels.
  await page.waitForFunction(async () => {
    const image = new Image();
    image.src = document.querySelector('#robot-model').toDataURL('image/png');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 64, 32);
    const pixels = context.getImageData(0, 0, 64, 32).data;
    let visible = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 32) visible++;
    return visible > 50;
  }, null, { timeout: 30000, polling: 250 });
  const modelData = await page.locator('#robot-model').evaluate(model => model.toDataURL('image/png'));
  const modelImage = Buffer.from(modelData.split(',')[1], 'base64');
  await writeFile(path.join(artifacts, 'robot-model.png'), modelImage);
  const media = await page.evaluate(async modelData => {
    const viewer = document.querySelector('#robot-model');
    const model = new Image();
    model.src = modelData;
    model.alt = viewer.alt;
    model.style.cssText = `width:100%;height:${viewer.clientHeight}px;min-height:300px;object-fit:contain;flex:1`;
    viewer.replaceWith(model);
    const records = [];
    for (const video of document.querySelectorAll('video')) {
      video.pause();
      if (!video.poster) throw new Error(`Missing video poster: ${video.src}`);
      const style = getComputedStyle(video);
      const still = new Image();
      still.src = video.poster;
      still.id = video.id;
      still.className = video.className;
      still.alt = video.getAttribute('aria-label') || 'Video still';
      still.style.cssText = `width:100%;height:100%;object-fit:${style.objectFit};object-position:${style.objectPosition}`;
      records.push({ poster: video.getAttribute('poster'), fit: style.objectFit, position: style.objectPosition });
      video.replaceWith(still);
    }
    for (const image of document.images) image.loading = 'eager';
    await Promise.all([...document.images].map(image => image.decode()));
    return records;
  }, `data:image/png;base64,${modelImage.toString('base64')}`);
  assert.equal(media.length, 23, 'Expected hero, 16 comparisons, four references and two hardware videos');

  const pages = await page.evaluate(() => {
    const specs = [];
    const add = (title, selector, article = false) => specs.push({
      title, hero: selector === '#top',
      html: article ? `<section class="section">${document.querySelector(selector).outerHTML}</section>` : document.querySelector(selector).outerHTML,
    });
    add('RoboForge', '#top');
    add('Abstract', '#abstract');
    add('Evaluating generated robot designs', '#embodiment', true);
    add('RoboForge: motion in the learning loop', '#roboforge-method', true);
    for (const tab of document.querySelectorAll('#robot-tabs [role="tab"]')) {
      tab.click();
      add(`Diverse Robot Behaviors · ${tab.textContent}`, '#skills');
    }
    add('Refining the Generated Motion', '#refinement');
    add('Real-World Demonstrations', '#hardware');
    return specs;
  });
  await page.addStyleTag({ content: `
    html { scroll-behavior: auto; }
    body { width: 1440px; }
    * { animation: none !important; transition: none !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .hero { height: 900px; }
    .method-part + .method-part { margin-top: 0; }
    .review-content { min-height: 820px; }
    .review-footer { width: 1100px; margin: 0 auto; padding: 22px 0; border-top: 1px solid #e4e7e5; display:flex; justify-content:space-between; font-size:13px; color:#6b716e; }
    .section { border-bottom: 0; }
  ` });
  await page.emulateMedia({ media: 'screen' });
  const files = [];
  const manifest = [];
  for (const [index, spec] of pages.entries()) {
    await page.evaluate(({ spec, index, total }) => {
      const content = document.createElement(spec.hero ? 'div' : 'main');
      content.className = spec.hero ? 'review-content' : 'container review-content';
      content.innerHTML = spec.html;
      const footer = document.createElement('div');
      footer.className = 'review-footer';
      const label = document.createElement('span');
      label.textContent = `RoboForge · Website review · ${spec.title}`;
      const number = document.createElement('span');
      number.textContent = `${index + 1} / ${total}`;
      footer.append(label, number);
      document.body.replaceChildren(content, footer);
      window.scrollTo(0, 0);
    }, { spec, index, total: pages.length });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode()));
    });
    const layout = await page.evaluate(() => ({
      height: Math.ceil(document.body.scrollHeight) + 2,
      width: document.body.scrollWidth,
      images: [...document.images].filter(image => image.getBoundingClientRect().width > 0).length,
      text: document.body.innerText,
    }));
    assert(layout.width <= 1440, `Horizontal overflow: ${spec.title}`);
    const file = path.join(artifacts, `page-${String(index + 1).padStart(2, '0')}.pdf`);
    await page.pdf({ path: file, width: '1440px', height: `${layout.height}px`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    files.push(file);
    manifest.push({ page: index + 1, title: spec.title, ...layout });
    console.log(`Exported ${index + 1}/${pages.length}: ${spec.title}`);
  }
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
  execFileSync('pdfunite', [...files, output], { stdio: 'pipe' });
  await writeFile(path.join(artifacts, 'manifest.json'), JSON.stringify({ output, media, pages: manifest }, null, 2) + '\n');
  console.log(`PDF: ${output}`);
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
