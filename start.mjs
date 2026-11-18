import process from 'node:process';
import { createAppServer } from './server.mjs';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const server = await createAppServer({ backendUrl: process.env.COMFYUI_URL || 'http://127.0.0.1:8188' });
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Port ' + port + ' is in use. Set PORT to another port and retry.' : error); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log('Frameflow is ready: http://127.0.0.1:' + port));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); process.exit(0); });
