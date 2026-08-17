import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { JsonStore } from './store.js';

const port = Number(process.env.PORT || 4173);
const store = await new JsonStore().init();
const app = createApp({ store });

serve({ fetch: app.fetch, port, hostname: process.env.HOST || '0.0.0.0' }, (info) => {
  console.log(`致富投資 local server listening on http://localhost:${info.port}`);
});
