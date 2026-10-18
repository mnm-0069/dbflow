import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  // Avoid logging connection input or raw driver errors; they may contain sensitive details.
  const raw = error instanceof Error ? error.message : 'Unknown error';
  const safeMessage = raw.includes('password') || raw.includes('ECONNREFUSED')
    ? 'Could not connect. Check the host, port, credentials, SSL settings, and whether the database is accepting connections.'
    : 'Connection failed. Check the connection details and database permissions.';
  res.status(502).json({ error: safeMessage });
};
