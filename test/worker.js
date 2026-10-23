import worker from '../src/index.js';
import { flushOutbox } from '../src/delivery.js';

// Test-only entry point; never included in wrangler.jsonc or production bundles.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__flush') {
      await flushOutbox(env, { now: Number(url.searchParams.get('now')), limit: 25 });
      return new Response('ok');
    }
    if (url.pathname === '/__scheduled') {
      await worker.scheduled({ scheduledTime: Number(url.searchParams.get('time')) }, env, ctx);
      return new Response('ok');
    }
    return worker.fetch(request, env, ctx);
  },
};
