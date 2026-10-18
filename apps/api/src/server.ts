import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';
import { connectionsRouter } from './routes/connections.js';
import { errorHandler } from './middleware/error-handler.js';

const app = express();
const port = Number(process.env.PORT ?? 4000);
app.disable('x-powered-by');
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json({ limit: '256kb' }));
app.use('/api/health', healthRouter);
app.use('/api/connections', connectionsRouter);
app.use(errorHandler);

// This API is a local development service and must not listen on LAN interfaces.
app.listen(port, '127.0.0.1', () => {
  console.log(`DBFLOW API listening on http://localhost:${port}`);
});
