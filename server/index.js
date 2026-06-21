import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import templatesRoutes from './routes/templates.js';
import draftsRoutes from './routes/drafts.js';
import sessionsRoutes from './routes/sessions.js';
import routinesRoutes from './routes/routines.js';
import workoutsRoutes from './routes/workouts.js';
import prescriptionsRoutes from './routes/prescriptions.js';
import bodyMetricsRoutes from './routes/body-metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

export async function buildApp(opts = {}) {
  const {
    dbPath = process.env.DB_PATH || join(__dirname, '..', 'data', 'workouts.db'),
    logger = true,
  } = opts;

  const app = Fastify({ logger, bodyLimit: 262144, trustProxy: true });
  app.db = openDb(dbPath);

  await app.register(fastifyRateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) => req.url?.startsWith('/assets/'),
  });

  await app.register(templatesRoutes);
  await app.register(routinesRoutes);
  await app.register(workoutsRoutes);
  await app.register(prescriptionsRoutes);
  await app.register(bodyMetricsRoutes);
  await app.register(draftsRoutes);
  await app.register(sessionsRoutes);

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    index: 'index.html',
  });

  app.addHook('onClose', async () => {
    try { app.db.close(); } catch {}
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const app = await buildApp();
  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      app.log.info({ sig }, 'shutting down');
      await app.close();
      process.exit(0);
    });
  }
}
