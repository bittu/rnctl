import { describe, expect, it } from 'vitest';
import { startWebServer } from './web-server.js';

describe('web server', () => {
  it('serves the dashboard and the daemon port', async () => {
    const server = await startWebServer(4321);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const portResponse = await fetch(`${base}/api/daemon`);
      expect(await portResponse.json()).toEqual({ port: 4321 });

      const indexResponse = await fetch(base);
      expect(indexResponse.status).toBe(200);
      expect(await indexResponse.text()).toContain('<!doctype html>');
    } finally {
      await server.stop();
    }
  });
});
