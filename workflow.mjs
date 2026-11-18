import { randomBytes } from 'node:crypto';

export const WORKFLOW_FILE = 'MiniMax_H3_I2V_Balanced.json';
export const DEFAULTS = Object.freeze({ seconds: 10, megapixels: 0.8 });
export const RESOLUTIONS = Object.freeze([0.4, 0.6, 0.8, 1.0]);
const BINDINGS = {
  '114': 'LoadImage', '115': 'ResolutionSelector',
  '105:104': 'MiniMaxH3ImageToVideo', '105:111': 'PrimitiveFloat',
  '105:107': 'ComfyMathExpression', '105:15': 'RandomNoise',
  '105:91': 'CreateVideo', '92': 'SaveVideo',
};

export class InputError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
export function wordCount(value) {
  return typeof value === 'string' ? (value.trim().match(/\S+/gu) || []).length : 0;
}
export function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new InputError('Generation settings are required.');
  if (typeof input.prompt !== 'string' || input.prompt.length > 20000 ||
      wordCount(input.prompt) < 5 || wordCount(input.prompt) > 300) {
    throw new InputError('Write a prompt between 5 and 300 words.');
  }
  const seconds = input.seconds ?? DEFAULTS.seconds;
  const megapixels = input.megapixels ?? DEFAULTS.megapixels;
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 5 || seconds > 15) {
    throw new InputError('Duration must be a whole number from 5 to 15 seconds.');
  }
  if (typeof megapixels !== 'number' || !RESOLUTIONS.includes(megapixels)) {
    throw new InputError('Choose 0.4M, 0.6M, 0.8M, or 1.0M resolution.');
  }
  const image = input.image;
  if (!image || typeof image.name !== 'string' || !image.name ||
      image.name.length > 255 || /[\\/\x00-\x1f]/.test(image.name) ||
      !/\.(png|jpe?g|webp)$/i.test(image.name)) {
    throw new InputError('Upload a PNG, JPG, or WebP image first.');
  }
  const subfolder = image.subfolder || '';
  if (typeof subfolder !== 'string' || subfolder.length > 500 ||
      subfolder.split(/[\\/]/).includes('..') || /[\x00-\x1f]/.test(subfolder) ||
      /^[\\/]/.test(subfolder)) throw new InputError('The uploaded image path is invalid.');
  if (typeof input.clientId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.clientId)) {
    throw new InputError('A valid client ID is required.');
  }
  return { prompt: input.prompt.trim(), seconds, megapixels, image: { name: image.name, subfolder }, clientId: input.clientId };
}
export function describeSettings(seconds, megapixels) {
  const base = Math.max(5, Math.round(seconds * 24));
  const frames = base + ((5 - base % 17 + 17) % 17);
  const dimension = Math.round(Math.sqrt(megapixels * 1024 * 1024) / 32) * 32;
  return { frames, fps: 24, actualSeconds: frames / 24, width: dimension, height: dimension, megapixels, seconds };
}
export function buildWorkflow(template, input) {
  const settings = validateSettings(input);
  for (const [id, type] of Object.entries(BINDINGS)) {
    if (template[id]?.class_type !== type) throw new Error('Workflow binding ' + id + ' must be ' + type + '.');
  }
  const prompt = structuredClone(template);
  prompt['114'].inputs.image = [settings.image.subfolder, settings.image.name].filter(Boolean).join('/');
  prompt['105:104'].inputs.prompt = settings.prompt;
  prompt['105:111'].inputs.value = settings.seconds;
  prompt['115'].inputs.megapixels = settings.megapixels;
  const seed = Number(randomBytes(6).readUIntBE(0, 6));
  prompt['105:15'].inputs.noise_seed = seed;
  // Only submit the graph reachable from SaveVideo. The supplied file also has
  // disconnected ImageScaleToTotalPixels/GetImageSize nodes with a missing input.
  const reachable = new Set();
  function visit(id) {
    if (reachable.has(id)) return;
    if (!prompt[id]) throw new Error('Workflow references a missing node: ' + id);
    reachable.add(id);
    for (const value of Object.values(prompt[id].inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' &&
          Number.isInteger(value[1])) visit(value[0]);
    }
  }
  visit('92');
  const graph = Object.fromEntries([...reachable].map(id => [id, prompt[id]]));
  return { prompt: graph, client_id: settings.clientId, settings: { ...describeSettings(settings.seconds, settings.megapixels), seed } };
}
export function videoFiles(outputs = {}) {
  const found = new Map();
  for (const output of Object.values(outputs)) {
    for (const key of ['images', 'videos', 'gifs']) {
      for (const file of Array.isArray(output[key]) ? output[key] : []) {
        if (!file?.filename || !/\.(mp4|webm|mkv|mov)$/i.test(file.filename)) continue;
        const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
        found.set(params.toString(), { filename: file.filename, url: '/api/comfy/view?' + params });
      }
    }
  }
  return [...found.values()];
}
export function errorMessage(data) {
  const messages = [data?.error?.message, data?.error?.details, typeof data?.error === 'string' ? data.error : null];
  for (const [id, node] of Object.entries(data?.node_errors || {})) {
    for (const issue of node.errors || []) messages.push('Node ' + id + ': ' + (issue.message || '') + (issue.details ? ' — ' + issue.details : ''));
  }
  return messages.filter(Boolean).join('\n') || 'ComfyUI rejected the request.';
}
