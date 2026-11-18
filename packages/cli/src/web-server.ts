import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

export interface WebServer {
  readonly port: number;
  stop(): Promise<void>;
}

/** Serves the bundled web dashboard and tells the browser which port the daemon uses. */
export async function startWebServer(rpcPort: number): Promise<WebServer> {
  const bundled = fileURLToPath(new URL('./web/dist/', import.meta.url));
  const source = fileURLToPath(new URL('../dist/web/dist/', import.meta.url));
  const webRoot = existsSync(bundled) ? bundled : source;
  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (pathname === '/api/daemon') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ port: rpcPort }));
          return;
        }

        const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
        const filePath = join(webRoot, relative);
        if (!filePath.startsWith(webRoot)) {
          response.writeHead(403);
          response.end('Forbidden');
          return;
        }
        const body = await readFile(filePath);
        response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end('Not found');
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    async stop() {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    },
  };
}
