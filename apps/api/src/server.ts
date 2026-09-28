import { buildApp } from './app.js';
import { environment } from './config/env.js';

const app = buildApp();

async function start(): Promise<void> {
  try {
    await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
  } catch (error) {
    app.log.error(error, 'Unable to start API');
    process.exitCode = 1;
  }
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down API');
  await app.close();
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

void start();
