import cors from 'cors';

export function createCorsMiddleware(origins: readonly string[]) {
  const allowed = new Set(origins);

  return cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      callback(null, allowed.has(origin));
    },
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Request-ID', 'Authorization'],
    exposedHeaders: ['X-Request-ID'],
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
}
