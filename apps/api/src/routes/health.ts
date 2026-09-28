import type { FastifyInstance } from 'fastify';

type HealthResponse = {
  service: 'api';
  status: 'ok';
};

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Reply: HealthResponse }>('/health', async () => ({
    service: 'api',
    status: 'ok'
  }));
}
