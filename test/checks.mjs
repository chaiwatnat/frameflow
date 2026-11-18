import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { buildWorkflow, describeSettings, wordCount, videoFiles, errorMessage } from '../workflow.mjs';
import { createAppServer } from '../server.mjs';

const template = JSON.parse(await readFile(new URL('../MiniMax_H3_I2V_Balanced.json', import.meta.url), 'utf8'));
const input = { prompt: 'A gentle breeze moves through the trees.', image: { name: 'frame.png', subfolder: 'frameflow' }, clientId: 'test-client', seconds: 10, megapixels: 0.8 };
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
}
export const checks = [
  ['workflow bindings preserve connected model/audio/LoRA graph and original template', async () => {
    const before = JSON.stringify(template);
    const built = buildWorkflow(template, input);
    assert.equal(built.prompt['114'].inputs.image, 'frameflow/frame.png');
    assert.equal(built.prompt['105:104'].inputs.prompt, input.prompt);
    assert.equal(built.prompt['105:111'].inputs.value, 10);
    assert.equal(built.prompt['115'].inputs.megapixels, 0.8);
    assert.equal(built.prompt['115'].inputs.aspect_ratio, '1:1 (Square)');
    assert.equal(JSON.stringify(built.prompt['105:107']), JSON.stringify(template['105:107']));
    assert.equal(JSON.stringify(built.prompt['105:91']), JSON.stringify(template['105:91']));
    assert.equal(JSON.stringify(built.prompt['105:126']), JSON.stringify(template['105:126']));
    assert.equal(JSON.stringify(built.prompt['105:104'].inputs.first_frame), JSON.stringify(['114', 0]));
    assert.equal(built.client_id, input.clientId);
    assert.equal(JSON.stringify(template), before);
    assert.ok(Number.isSafeInteger(built.settings.seed));
    assert.notEqual(built.settings.seed, buildWorkflow(template, input).settings.seed);
    assert.equal(built.prompt['119'], undefined);
    assert.equal(built.prompt['120'], undefined);
    for (const node of Object.values(built.prompt)) for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === 'string') assert.ok(built.prompt[value[0]]);
    }
  }],
  ['defaults, duration bounds, and exact MiniMax frame snapping', async () => {
    const defaults = buildWorkflow(template, { ...input, seconds: undefined, megapixels: undefined });
    assert.equal(defaults.settings.seconds, 10); assert.equal(defaults.settings.megapixels, 0.8);
    assert.equal(defaults.settings.frames, 243); assert.equal(defaults.settings.actualSeconds, 10.125);
    assert.equal(defaults.settings.width, 928); assert.equal(defaults.settings.height, 928);
    for (let seconds = 5; seconds <= 15; seconds++) {
      const meta = describeSettings(seconds, 0.8);
      assert.equal(meta.frames % 17, 5); assert.ok(meta.frames >= seconds * 24);
      assert.ok(meta.frames - seconds * 24 < 17);
      assert.equal(buildWorkflow(template, { ...input, seconds }).prompt['105:111'].inputs.value, seconds);
    }
    assert.equal(describeSettings(15, 0.8).frames, 362);
    for (const seconds of [4, 16, 10.5, '10', NaN, Infinity]) assert.throws(() => buildWorkflow(template, { ...input, seconds }), /Duration/);
  }],
  ['prompt count includes exact 5 and 300 word boundaries and whitespace', async () => {
    for (const words of [5, 300]) assert.doesNotThrow(() => buildWorkflow(template, { ...input, prompt: Array(words).fill('word').join(' \n ') }));
    for (const words of [0, 4, 301]) assert.throws(() => buildWorkflow(template, { ...input, prompt: Array(words).fill('word').join(' ') }), /5 and 300/);
    assert.equal(wordCount(' \n one  two\tthree '), 3);
    assert.throws(() => buildWorkflow(template, { ...input, prompt: {} }), /5 and 300/);
  }],
  ['invalid resolution, upload path, client ID, and changed workflow are rejected', async () => {
    for (const megapixels of [0, 0.7, 2, '0.8', NaN]) assert.throws(() => buildWorkflow(template, { ...input, megapixels }), /resolution/);
    for (const image of [{ name: '../x.png' }, { name: 'x.exe' }, { name: 'x.png', subfolder: '../secret' }, { name: 'x.png', subfolder: '/abs' }, null]) {
      assert.throws(() => buildWorkflow(template, { ...input, image }));
    }
    assert.throws(() => buildWorkflow(template, { ...input, clientId: 'x&other=yes' }), /client ID/);
    const changed = structuredClone(template); changed['115'].class_type = 'Other';
    assert.throws(() => buildWorkflow(changed, input), /binding 115/);
  }],
  ['native and custom video outputs, encoded media URLs, and node errors are parsed', async () => {
    const file = { filename: 'movie clip.mp4', subfolder: 'video/ไทย', type: 'output' };
    const files = videoFiles({ '92': { images: [file, { filename: 'still.png' }] }, other: { videos: [file], gifs: [{ filename: 'v.webm' }] } });
    assert.equal(files.length, 2);
    assert.equal(new URL(files[0].url, 'http://localhost').searchParams.get('filename'), file.filename);
    assert.equal(new URL(files[0].url, 'http://localhost').searchParams.get('subfolder'), file.subfolder);
    assert.match(errorMessage({ node_errors: { '114': { errors: [{ message: 'Bad image', details: 'Missing file' }] } } }), /Node 114: Bad image — Missing file/);
  }],
  ['complete upload → queue → history → media range and download flow', async () => {
    const info = Object.fromEntries(Object.values(template).map(node => [node.class_type, { input: { required: {} } }]));
    let captured = null, completed = false, uploadBody = '', rangeHeader = '';
    const backend = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/system_stats') return json(res, 200, { system: { comfyui_version: 'test' }, devices: [{ name: 'Test GPU' }] });
      if (url.pathname === '/object_info') return json(res, 200, info);
      if (url.pathname === '/upload/image') {
        for await (const chunk of req) uploadBody += chunk.toString();
        return json(res, 200, { name: 'uploaded.png', subfolder: 'frameflow', type: 'input' });
      }
      if (url.pathname === '/prompt') {
        let body = ''; for await (const chunk of req) body += chunk.toString();
        captured = JSON.parse(body); return json(res, 200, { prompt_id: 'mock-job', number: 0, node_errors: {} });
      }
      if (url.pathname === '/history/mock-job') return json(res, 200, completed ? {
        'mock-job': { status: { completed: true, status_str: 'success' }, outputs: { '92': { images: [{ filename: 'result.mp4', subfolder: 'video', type: 'output' }] } } },
      } : {});
      if (url.pathname === '/queue') return json(res, 200, { queue_running: captured && !completed ? [[0, 'mock-job']] : [], queue_pending: [] });
      if (url.pathname === '/view') {
        rangeHeader = req.headers.range;
        res.writeHead(rangeHeader ? 206 : 200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', ...(rangeHeader ? { 'content-range': 'bytes 0-3/4' } : {}) });
        return res.end(Buffer.from([0, 1, 2, 3]));
      }
      json(res, 404, {});
    });
    let app;
    try {
      const backendUrl = await listen(backend);
      app = await createAppServer({ backendUrl }); const base = await listen(app);
      assert.equal((await fetch(base + '/')).status, 200);
      const config = await (await fetch(base + '/api/config')).json(); assert.equal(config.defaults.megapixels, 0.8);
      const page = await (await fetch(base + '/')).text();
      assert.ok(page.includes('value="10"')); assert.ok(page.includes('value="0.8" checked'));
      const health = await (await fetch(base + '/api/health')).json(); assert.ok(health.ready);
      const boundary = 'frameflow-test-boundary';
      const form = '--' + boundary + '\r\nContent-Disposition: form-data; name="image"; filename="uploaded.png"\r\nContent-Type: image/png\r\n\r\nimage\r\n--' + boundary + '--\r\n';
      const uploaded = await (await fetch(base + '/api/comfy/upload/image', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=' + boundary }, body: form })).json();
      assert.ok(uploadBody.includes('uploaded.png'));
      const generation = await fetch(base + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, image: uploaded }) });
      assert.equal(generation.status, 200);
      assert.equal((await generation.json()).promptId, 'mock-job');
      assert.equal(captured.prompt['114'].inputs.image, 'frameflow/uploaded.png');
      assert.equal(captured.prompt['105:104'].inputs.prompt, input.prompt);
      assert.equal((await (await fetch(base + '/api/jobs/mock-job')).json()).state, 'running');
      completed = true;
      const result = await (await fetch(base + '/api/jobs/mock-job')).json(); assert.equal(result.state, 'complete');
      const media = await fetch(base + result.files[0].url, { headers: { Range: 'bytes=0-3' } });
      assert.equal(media.status, 206); assert.equal(rangeHeader, 'bytes=0-3');
      assert.equal((await media.arrayBuffer()).byteLength, 4);
      const download = await fetch(base + result.files[0].url + '&download=1');
      assert.match(download.headers.get('content-disposition'), /attachment/);
      assert.equal((await fetch(base + '/api/comfy/interrupt', { method: 'POST' })).status, 404);
      assert.equal((await fetch(base + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://foreign.example' }, body: JSON.stringify(input) })).status, 403);
      const invalid = await fetch(base + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, seconds: 16 }) });
      assert.equal(invalid.status, 400);
    } finally { if (app) await close(app); await close(backend); }
  }],
  ['backend connection failure gives an actionable status', async () => {
    const app = await createAppServer({ fetchImpl: async () => { throw new Error('offline'); } });
    try {
      const base = await listen(app);
      const result = await fetch(base + '/api/health'); assert.equal(result.status, 503);
      assert.match((await result.json()).error, /Start ComfyUI/);
    } finally { await close(app); }
  }],
  ['history execution errors and missing saved videos are reported', async () => {
    let history = { failed: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'Out of memory' }]] } } };
    const app = await createAppServer({ fetchImpl: async url => ({ ok: true, json: async () => new URL(url).pathname.startsWith('/history/') ? history : { queue_running: [], queue_pending: [] } }) });
    try {
      const base = await listen(app);
      const failure = await (await fetch(base + '/api/jobs/failed')).json();
      assert.equal(failure.state, 'error'); assert.equal(failure.error, 'Out of memory');
      history = { empty: { status: { completed: true }, outputs: {} } };
      const empty = await (await fetch(base + '/api/jobs/empty')).json();
      assert.equal(empty.state, 'error'); assert.match(empty.error, /without a saved video/);
    } finally { await close(app); }
  }],
];
export async function runChecks() {
  const results = [];
  for (const [name, check] of checks) {
    try { await check(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.stack }); }
  }
  return results;
}
