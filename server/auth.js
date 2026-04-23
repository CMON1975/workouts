import bcrypt from 'bcrypt';
import fastifySecureSession from '@fastify/secure-session';

export async function registerAuth(app, { sessionKey, passwordHash, isProd }) {
  await app.register(fastifySecureSession, {
    key: sessionKey,
    cookieName: 'workouts_session',
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 60 * 60 * 24 * 30,
    },
  });

  app.post('/api/login', {
    config: {
      rateLimit: { max: 10, timeWindow: '10 minutes' },
    },
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        properties: { password: { type: 'string', maxLength: 256 } },
      },
    },
  }, async (req, reply) => {
    const { password } = req.body;
    const ok = await bcrypt.compare(password, passwordHash);
    if (!ok) return reply.code(401).send({ error: 'invalid' });
    req.session.set('authed', true);
    req.session.set('at', Date.now());
    return reply.code(204).send();
  });

  app.post('/api/logout', async (req, reply) => {
    req.session.delete();
    return reply.code(204).send();
  });
}

export function requireAuth(req, reply, done) {
  if (req.session.get('authed') === true) return done();
  reply.code(401).send({ error: 'unauthenticated' });
}
