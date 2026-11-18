import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_FILE, DEFAULTS, RESOLUTIONS, buildWorkflow, videoFiles, errorMessage, InputError } from './workflow.mjs';

const PUBLIC = new URL('./public/', import.meta.url);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
function sendJson(res, status, data) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('Use JSON for generation settings.');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new InputError('The request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new InputError('The request contains invalid JSON.'); }
}
export async function createAppServer({ backendUrl = 'http://127.0.0.1:8188', workflowPath = fileURLToPath(new URL('./' + WORKFLOW_FILE, import.meta.url)), fetchImpl = fetch } = {}) {
  const backend = new URL(backendUrl);
  if (backend.protocol !== 'http:') throw new Error('COMFYUI_URL must use http://.');
  const template = JSON.parse(await readFile(workflowPath, 'utf8'));
  // Fail at startup if the supplied template no longer matches the bindings.
  buildWorkflow(template, { prompt: 'A quiet landscape moves in sunlight.', image: { name: 'check.png' }, clientId: 'startup' });
  async function comfy(route, options = {}) {
    let response;
    try { response = await fetchImpl(new URL(route, backend), { ...options, signal: AbortSignal.timeout(15000) }); }
    catch { const e = new Error('Cannot reach ComfyUI at ' + backend.origin + '. Start ComfyUI and retry.'); e.status = 503; throw e; }
    const data = await response.json();
    if (!response.ok) { const e = new Error(errorMessage(data)); e.status = response.status; throw e; }
    return data;
  }
  let healthCache = null, healthTime = 0, healthPromise;
  async function health() {
    if (healthCache && Date.now() - healthTime < 10000) return healthCache;
    if (healthPromise) return healthPromise;
    healthPromise = (async () => {
      const [stats, info, queue] = await Promise.all([comfy('/system_stats'), comfy('/object_info'), comfy('/queue')]);
      const missingNodes = [...new Set(Object.values(template).map(n => n.class_type))].filter(type => !info[type]);
      const missingModels = [];
      for (const node of Object.values(template)) {
        if (!['VAELoader', 'UNETLoader', 'CLIPLoader', 'LoraLoaderModelOnly'].includes(node.class_type)) continue;
        for (const [key, value] of Object.entries(node.inputs)) {
          if (!key.endsWith('_name')) continue;
          const schema = info[node.class_type]?.input?.required?.[key];
          const choices = Array.isArray(schema?.[0]) ? schema[0] : schema?.[1]?.options;
          if (Array.isArray(choices) && !choices.includes(value)) missingModels.push(value);
        }
      }
      healthCache = { online: true, ready: !missingNodes.length && !missingModels.length, missingNodes, missingModels,
        version: stats.system?.comfyui_version, device: stats.devices?.[0]?.name || 'ComfyUI',
        queue: (queue.queue_running?.length || 0) + (queue.queue_pending?.length || 0), backend: backend.origin };
      healthTime = Date.now();
      return healthCache;
    })();
    try { return await healthPromise; } finally { healthPromise = null; }
  }
  async function proxy(req, res, route) {
    const uploading = req.method === 'POST';
    if (uploading && !req.headers['content-type']?.startsWith('multipart/form-data;')) throw new InputError('Upload an image as multipart form data.');
    const limit = 21 * 1024 * 1024;
    if (uploading && Number(req.headers['content-length'] || 0) > limit) throw new InputError('Images must be 20 MB or smaller.');
    const headers = {};
    for (const key of ['content-type', 'range', 'if-range']) if (req.headers[key]) headers[key] = req.headers[key];
    const upstream = http.request(new URL(route, backend), { method: req.method, headers }, response => {
      const outputHeaders = { 'cache-control': 'no-store' };
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (response.headers[key]) outputHeaders[key] = response.headers[key];
      if (new URL(route, backend).searchParams.has('download')) {
        outputHeaders['content-disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(new URL(route, backend).searchParams.get('filename') || 'video.mp4');
      }
      res.writeHead(response.statusCode, outputHeaders);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.setTimeout(60000, () => upstream.destroy(new Error('ComfyUI request timed out.')));
    upstream.on('error', () => { if (!res.headersSent) sendJson(res, 503, { error: 'Cannot reach ComfyUI. Check that it is running at ' + backend.origin + '.' }); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    if (uploading) {
      let received = 0;
      req.on('data', chunk => { received += chunk.length; if (received > limit) { upstream.destroy(); if (!res.headersSent) sendJson(res, 413, { error: 'Images must be 20 MB or smaller.' }); } });
      req.pipe(upstream);
    } else upstream.end();
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) {
        sendJson(res, 403, { error: 'Submit requests from this local studio.' }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        sendJson(res, 200, { workflow: WORKFLOW_FILE, defaults: DEFAULTS, resolutions: RESOLUTIONS,
          aspectRatio: template['115'].inputs.aspect_ratio, fps: template['105:91'].inputs.fps,
          nodes: Object.fromEntries(Object.entries(template).map(([id, node]) => [id, node._meta?.title || node.class_type])) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, await health()); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/generate') {
        const input = await readJson(req);
        const built = buildWorkflow(template, input);
        const readiness = await health();
        if (!readiness.ready) { const e = new Error('Missing workflow requirements: ' + [...readiness.missingNodes, ...readiness.missingModels].join(', ')); e.status = 503; throw e; }
        const result = await comfy('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: built.prompt, client_id: built.client_id }) });
        if (!result.prompt_id || Object.keys(result.node_errors || {}).length) throw new InputError(errorMessage(result));
        sendJson(res, 200, { promptId: result.prompt_id, number: result.number, settings: built.settings }); return;
      }
      const match = /^\/api\/jobs\/([a-zA-Z0-9-]{1,80})$/.exec(url.pathname);
      if (req.method === 'GET' && match) {
        const id = match[1];
        const [history, queue] = await Promise.all([comfy('/history/' + id), comfy('/queue')]);
        const item = history[id];
        if (item) {
          const failure = (item.status?.messages || []).find(([type]) => ['execution_error', 'execution_interrupted'].includes(type));
          if (failure || item.status?.status_str === 'error') {
            sendJson(res, 200, { state: 'error', error: failure?.[1]?.exception_message || (failure?.[0] === 'execution_interrupted' ? 'Generation was interrupted in ComfyUI.' : 'ComfyUI could not complete this video.') }); return;
          }
          const files = videoFiles(item.outputs);
          if (files.length) { sendJson(res, 200, { state: 'complete', files }); return; }
          if (item.status?.completed) { sendJson(res, 200, { state: 'error', error: 'The workflow completed without a saved video. Check SaveVideo in ComfyUI.' }); return; }
        }
        if (queue.queue_running?.some(entry => entry[1] === id)) { sendJson(res, 200, { state: 'running' }); return; }
        const position = queue.queue_pending?.findIndex(entry => entry[1] === id) ?? -1;
        sendJson(res, 200, { state: position >= 0 ? 'queued' : 'unknown', position: position >= 0 ? position + 1 : null }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/comfy/upload/image') { await proxy(req, res, '/upload/image'); return; }
      if (req.method === 'GET' && url.pathname === '/api/comfy/view') { await proxy(req, res, '/view' + url.search); return; }
      if (req.method === 'GET' && ['/', '/index.html', '/styles.css', '/app.js', '/icon.svg'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const content = await readFile(new URL(file, PUBLIC));
        const extension = '.' + file.split('.').pop();
        res.writeHead(200, { 'content-type': TYPES[extension], 'cache-control': 'no-cache',
          'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        res.end(content); return;
      }
      sendJson(res, 404, { error: 'Not found.' });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.status ? error.message : 'The local server encountered an error. Check the terminal for details.' });
      if (!error.status) console.error(error);
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/comfy/ws' || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) { socket.destroy(); return; }
    const clientId = url.searchParams.get('clientId');
    if (!clientId || !/^[a-zA-Z0-9-]{1,80}$/.test(clientId)) { socket.destroy(); return; }
    const upstream = http.request(new URL('/ws?clientId=' + encodeURIComponent(clientId), backend), {
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': req.headers['sec-websocket-key'], 'sec-websocket-version': '13' },
    });
    upstream.on('upgrade', (response, peer, peerHead) => {
      peer.setTimeout(0);
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n');
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      peer.pipe(socket); socket.pipe(peer);
      peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
      socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
    });
    upstream.on('response', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.setTimeout(10000, () => upstream.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.end();
  });
  return server;
}
