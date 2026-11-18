'use strict';
const $ = id => document.getElementById(id);
const countWords = text => (text.trim().match(/\S+/gu) || []).length;
const readSaved = (storage, key, fallback) => {
  try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const save = (storage, key, value) => { try { storage.setItem(key, JSON.stringify(value)); } catch {} };
const removeSaved = (storage, key) => { try { storage.removeItem(key); } catch {} };
let clientId = readSaved(sessionStorage, 'frameflow-client', null) || crypto.randomUUID();
save(sessionStorage, 'frameflow-client', clientId);
let imageFile = null, imageUrl = null, imageToken = 0, online = false, ready = false;
let busy = false, socket = null, socketRetry = null, pollTimer = null, nodeTitles = {}, generationStarted = 0;
let activeJob = readSaved(sessionStorage, 'frameflow-active', null);
if (activeJob && !/^[a-zA-Z0-9-]{1,80}$/.test(activeJob.promptId || '')) activeJob = null;
let creations = readSaved(localStorage, 'frameflow-creations', []);
if (!Array.isArray(creations)) creations = [];
creations = creations.filter(item => item && typeof item.url === 'string' && item.url.startsWith('/api/comfy/view?') &&
  typeof item.filename === 'string' && item.settings).slice(0, 8);

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(90000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('The local server returned an unexpected response. Check that ComfyUI is running.'); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || 'The request failed.');
  return data;
}
function settings() {
  return { seconds: Number($('duration').value), megapixels: Number(document.querySelector('input[name="resolution"]:checked').value) };
}
function updateControls() {
  const words = countWords($('prompt').value);
  $('word-count').textContent = words + ' / 300 words';
  $('word-count').classList.toggle('invalid', words > 300 || (words > 0 && words < 5));
  $('generate').disabled = busy || !online || !ready || !imageFile || words < 5 || words > 300;
  const current = settings();
  $('duration-value').replaceChildren(document.createTextNode(current.seconds + ' '));
  const unit = document.createElement('span'); unit.textContent = 'sec'; $('duration-value').append(unit);
  const pixels = Math.round(Math.sqrt(current.megapixels * 1024 * 1024) / 32) * 32;
  $('resolution-note').textContent = pixels + ' × ' + pixels + ' px · Square canvas';
  if (!busy) {
    $('output-duration').textContent = current.seconds + ' sec';
    $('output-resolution').textContent = current.megapixels.toFixed(1) + 'M';
  }
}
function showError(message) {
  $('form-error').textContent = message;
  $('form-error').hidden = !message;
}
function setBusy(value) {
  busy = value;
  $('controls').disabled = value;
  $('generate-label').textContent = value ? 'Creating your video…' : 'Generate video';
  document.querySelectorAll('.recent-card').forEach(button => { button.disabled = value; });
  updateControls();
}
async function checkHealth() {
  $('connection').disabled = true;
  try {
    const data = await api('/api/health', { signal: AbortSignal.timeout(20000) });
    online = data.online; ready = data.ready;
    $('connection').className = 'connection' + (ready ? '' : ' offline');
    $('connection-label').textContent = ready ? 'ComfyUI connected' : 'Setup required';
    $('connection').title = ready ? data.device + ' · ComfyUI ' + data.version + ' · ' + data.queue + ' queued/running. Click to refresh.' :
      'Missing: ' + [...data.missingNodes, ...data.missingModels].join(', ');
    if (!ready && !busy) showError('Missing workflow requirements: ' + [...data.missingNodes, ...data.missingModels].join(', '));
  } catch (error) {
    online = false; ready = false;
    $('connection').className = 'connection offline';
    $('connection-label').textContent = 'ComfyUI offline';
    $('connection').title = error.message + ' Click to retry.';
  } finally {
    $('connection').disabled = false;
    updateControls();
  }
}
async function selectImage(file) {
  if (!file || busy) return;
  const token = ++imageToken;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { showError('Choose a PNG, JPG, or WebP image.'); return; }
  if (file.size > 20 * 1024 * 1024) { showError('Your image is too large. Choose a file up to 20 MB.'); return; }
  const url = URL.createObjectURL(file);
  const decoded = new Image(); decoded.src = url;
  try { await decoded.decode(); }
  catch { URL.revokeObjectURL(url); showError('This file could not be read as an image. Choose another PNG, JPG, or WebP.'); return; }
  if (token !== imageToken || busy) { URL.revokeObjectURL(url); return; }
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageFile = file; imageUrl = url;
  $('source-preview').src = url; $('stage-image').src = url;
  $('image-name').textContent = file.name;
  $('image-dimensions').textContent = decoded.naturalWidth + ' × ' + decoded.naturalHeight + ' px · ' + (file.size / 1024 / 1024).toFixed(1) + ' MB';
  $('choose-image').hidden = true; $('image-selected').hidden = false;
  $('empty-preview').hidden = true; $('stage-image').hidden = false; $('result-video').hidden = true;
  $('result-video').pause(); $('download').hidden = true;
  $('progress-overlay').hidden = true; $('preview-status').textContent = 'Your starting frame';
  showError(''); updateControls();
}
function clearImage() {
  if (busy) return;
  imageToken++;
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageFile = null; imageUrl = null; $('image-input').value = '';
  $('source-preview').removeAttribute('src'); $('stage-image').removeAttribute('src');
  $('choose-image').hidden = false; $('image-selected').hidden = true;
  $('stage-image').hidden = true;
  if ($('result-video').hidden) { $('empty-preview').hidden = false; $('preview-status').textContent = 'Ready when you are'; }
  updateControls();
}
function progress(title, detail, value, step) {
  $('progress-overlay').hidden = false;
  $('progress-overlay').classList.remove('failed');
  $('progress-title').textContent = title;
  $('progress-detail').textContent = detail;
  if (typeof value === 'number') $('progress-bar').value = value;
  else $('progress-bar').removeAttribute('value');
  $('progress-step').textContent = step || 'Generating';
  $('preview-status').textContent = 'Creation in progress';
}
function connectSocket() {
  clearTimeout(socketRetry);
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;
  socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/comfy/ws?clientId=' + encodeURIComponent(clientId));
  socket.onmessage = event => {
    if (typeof event.data !== 'string' || !activeJob) return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    const data = message.data || {};
    if (data.prompt_id !== activeJob.promptId) return;
    if (message.type === 'execution_start') progress('Bringing your image to life', 'Loading your workflow and models. The first run can take a while.', null, 'Loading models');
    if (message.type === 'executing' && data.node) {
      const title = nodeTitles[data.node] || 'Processing workflow';
      progress('Bringing your image to life', title, null, title);
    }
    if (message.type === 'progress') {
      const title = nodeTitles[data.node] || 'Sampling';
      progress('A story is taking shape', title + ' · step ' + data.value + ' of ' + data.max, data.max ? data.value / data.max * 100 : null, 'Sampling progress');
    }
    if (message.type === 'execution_error') failJob(data.exception_message || 'ComfyUI encountered an error while generating the video.');
    if (message.type === 'execution_interrupted') failJob('Generation was interrupted in ComfyUI.');
    if (message.type === 'execution_success' || (message.type === 'executing' && data.node === null)) pollJob();
  };
  socket.onclose = () => { socketRetry = setTimeout(connectSocket, 5000); };
  socket.onerror = () => { /* History polling remains available without WebSocket updates. */ };
}
function imageView(image) {
  return '/api/comfy/view?' + new URLSearchParams({ filename: image.name, subfolder: image.subfolder || '', type: 'input' });
}
function displayResult(item) {
  $('empty-preview').hidden = true; $('stage-image').hidden = true; $('progress-overlay').hidden = true;
  $('result-video').hidden = false; $('result-video').src = item.url; $('result-video').load();
  $('download').href = item.url + '&download=1';
  $('download').download = item.filename;
  $('download').hidden = false;
  $('preview-status').textContent = '';
  $('output-duration').textContent = item.settings.actualSeconds.toFixed(2) + ' sec';
  $('output-resolution').textContent = item.settings.megapixels.toFixed(1) + 'M';
  $('preview-title').textContent = 'Your image, a little more alive.';
}
function renderCreations() {
  $('recent-count').textContent = creations.length;
  $('recent-list').classList.toggle('has-items', !!creations.length);
  $('recent-list').replaceChildren();
  if (!creations.length) {
    const empty = document.createElement('div'); empty.className = 'recent-empty';
    empty.textContent = 'Your first creation is just a few clicks away.';
    $('recent-list').append(empty); return;
  }
  for (const item of creations) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'recent-card'; button.disabled = busy;
    const thumb = document.createElement('img'); thumb.alt = 'Starting frame'; thumb.loading = 'lazy';
    if (typeof item.thumbnail === 'string' && item.thumbnail.startsWith('/api/comfy/view?')) thumb.src = item.thumbnail;
    const body = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = item.label || 'Untitled creation';
    const info = document.createElement('small');
    info.textContent = item.settings.actualSeconds.toFixed(2) + ' sec · ' + item.settings.megapixels.toFixed(1) + 'M · ' + new Date(item.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    body.append(title, info); button.append(thumb, body);
    button.addEventListener('click', () => { if (busy) return; displayResult(item); $('preview-title').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    $('recent-list').append(button);
  }
}
function failJob(message) {
  clearTimeout(pollTimer);
  activeJob = null; removeSaved(sessionStorage, 'frameflow-active');
  setBusy(false); showError(message);
  $('progress-overlay').classList.add('failed');
  $('progress-overlay').hidden = false;
  $('progress-title').textContent = 'This creation hit a pause.';
  $('progress-detail').textContent = message;
  $('progress-bar').removeAttribute('value'); $('progress-step').textContent = 'Check ComfyUI, then try again';
  $('preview-status').textContent = 'Generation stopped';
}
let polling = false, unknownCount = 0;
async function pollJob() {
  clearTimeout(pollTimer);
  if (!activeJob || polling) return;
  polling = true;
  const job = activeJob;
  try {
    const result = await api('/api/jobs/' + encodeURIComponent(job.promptId), { signal: AbortSignal.timeout(20000) });
    if (activeJob?.promptId !== job.promptId) return;
    if (result.state === 'complete') {
      const item = { ...result.files[0], settings: job.settings, thumbnail: job.thumbnail,
        label: job.label, created: Date.now(), promptId: job.promptId };
      creations = [item, ...creations.filter(entry => entry.promptId !== job.promptId)].slice(0, 8);
      save(localStorage, 'frameflow-creations', creations);
      activeJob = null; removeSaved(sessionStorage, 'frameflow-active');
      setBusy(false); displayResult(item); renderCreations(); showError(''); return;
    }
    if (result.state === 'error') { failJob(result.error); return; }
    if (result.state === 'queued') progress('Your video is in the queue', 'ComfyUI will start when the current work finishes.', null, 'Queue position ' + result.position);
    if (result.state === 'running' && $('progress-step').textContent.startsWith('Queue')) progress('Bringing your image to life', 'ComfyUI is processing your workflow.', null, 'Generating');
    if (result.state === 'unknown') {
      unknownCount++;
      if (unknownCount >= 5 && Date.now() - job.started > 30000) { failJob('This job is no longer in ComfyUI’s queue or history. It may have been removed or the backend restarted.'); return; }
    } else unknownCount = 0;
  } catch (error) {
    if (activeJob?.promptId === job.promptId) progress('Waiting for ComfyUI', 'Connection lost. Reconnecting automatically; your queued job is retained.', null, 'Reconnecting');
  } finally {
    polling = false;
    if (activeJob) pollTimer = setTimeout(pollJob, 2000);
  }
}
$('generation-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const words = countWords($('prompt').value);
  if (!imageFile) { showError('Add a starting image first.'); return; }
  if (words < 5 || words > 300) { showError('Write a prompt between 5 and 300 words.'); $('prompt').focus(); return; }
  if (!online || !ready) { showError('Connect to ComfyUI before generating. Use the connection button to retry.'); return; }
  const input = { ...settings(), prompt: $('prompt').value.trim(), clientId };
  const file = imageFile;
  showError(''); setBusy(true);
  $('result-video').pause(); $('result-video').hidden = true; $('download').hidden = true;
  $('stage-image').hidden = false; $('stage-image').src = imageUrl;
  $('empty-preview').hidden = true;
  $('preview-title').textContent = 'A new story is on its way.';
  progress('Preparing your video', 'Uploading your starting frame to ComfyUI…', null, 'Uploading image');
  const started = Date.now(); generationStarted = started;
  try {
    const form = new FormData();
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type];
    form.append('image', file, 'frameflow-' + crypto.randomUUID() + '.' + extension);
    form.append('type', 'input'); form.append('subfolder', 'frameflow'); form.append('overwrite', 'false');
    const image = await api('/api/comfy/upload/image', { method: 'POST', body: form });
    progress('Preparing your video', 'Submitting your workflow to ComfyUI…', null, 'Submitting workflow');
    const result = await api('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, image }) });
    activeJob = { promptId: result.promptId, settings: result.settings, thumbnail: imageView(image), label: file.name.replace(/\.[^.]+$/, ''), started };
    unknownCount = 0;
    save(sessionStorage, 'frameflow-active', activeJob);
    $('output-duration').textContent = input.seconds + ' sec';
    $('output-resolution').textContent = input.megapixels.toFixed(1) + 'M';
    progress('Your video is in the queue', 'ComfyUI is preparing your workflow.', null, 'Queue');
    connectSocket(); pollJob();
  } catch (error) { failJob(error.message); }
});
$('choose-image').addEventListener('click', () => $('image-input').click());
$('image-input').addEventListener('change', () => selectImage($('image-input').files[0]));
$('remove-image').addEventListener('click', clearImage);
$('dropzone').addEventListener('dragover', event => { event.preventDefault(); if (!busy) $('dropzone').classList.add('dragover'); });
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragover'));
$('dropzone').addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('dragover'); selectImage(event.dataTransfer.files[0]); });
$('prompt').addEventListener('input', () => { showError(''); updateControls(); });
$('duration').addEventListener('input', updateControls);
document.querySelectorAll('input[name="resolution"]').forEach(input => input.addEventListener('change', updateControls));
$('example-prompt').addEventListener('click', () => { $('prompt').value = 'The camera slowly pushes in toward the subject. A gentle breeze adds subtle natural movement, while warm afternoon light shifts softly across the scene. Keep the original composition and a calm, cinematic atmosphere.'; showError(''); updateControls(); $('prompt').focus(); });
$('connection').addEventListener('click', checkHealth);
$('workflow-info').addEventListener('click', () => $('workflow-dialog').showModal());
$('close-dialog').addEventListener('click', () => $('workflow-dialog').close());
$('dialog-done').addEventListener('click', () => $('workflow-dialog').close());
$('workflow-dialog').addEventListener('click', event => { if (event.target === $('workflow-dialog')) { const bounds = $('workflow-dialog').getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $('workflow-dialog').close(); } });
$('result-video').addEventListener('error', () => { if (!$('result-video').hidden) { $('preview-status').textContent = 'Preview unavailable — try the download'; } });
setInterval(() => {
  if (!busy) return;
  const duration = Math.floor((Date.now() - (activeJob?.started || generationStarted || Date.now())) / 1000);
  $('elapsed').textContent = Math.floor(duration / 60) + ':' + String(duration % 60).padStart(2, '0');
}, 1000);
setInterval(checkHealth, 15000);
renderCreations(); updateControls();
api('/api/config').then(config => { nodeTitles = config.nodes; }).catch(() => {});
checkHealth(); connectSocket();
if (activeJob) {
  setBusy(true);
  if (activeJob.thumbnail?.startsWith('/api/comfy/view?')) { $('stage-image').src = activeJob.thumbnail; $('stage-image').hidden = false; $('empty-preview').hidden = true; }
  $('output-duration').textContent = activeJob.settings.seconds + ' sec';
  $('output-resolution').textContent = activeJob.settings.megapixels.toFixed(1) + 'M';
  progress('Resuming your creation', 'Checking the saved job in ComfyUI…', null, 'Reconnecting'); pollJob();
}
