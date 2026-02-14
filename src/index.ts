import 'reflect-metadata';
import 'dotenv/config';

import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';

import { typeDefs } from './schema/typeDefs';
import { resolvers } from './schema/resolvers';
import { initializeDatabase, closeDatabase, AppDataSource } from './config/database';
import { getAuthContext, AuthenticatedContext } from './middleware/auth';
import { globalRateLimiter } from './middleware/rateLimiter';
import { BookingService } from './services/BookingService';
import { QueueService } from './services/QueueService';
import RedisClient from './utils/redis';
import { logger } from './utils/logger';

interface Context {
  auth: AuthenticatedContext;
  dataSources: {
    bookingService: BookingService;
  };
}

async function bootstrap(): Promise<void> {
  const PORT = parseInt(process.env.PORT || '4000', 10);

  // ─── Express ──────────────────────────────────────────
  const app = express();
  const httpServer = http.createServer(app);

  // ─── Database ─────────────────────────────────────────
  await initializeDatabase();
  logger.info('Database initialized');

  // ─── GraphQL Schema ───────────────────────────────────
  const schema = makeExecutableSchema({ typeDefs, resolvers });

  // ─── WebSocket Server (Subscriptions) ─────────────────
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: '/graphql',
  });

  const serverCleanup = useServer(
    {
      schema,
      context: async (ctx) => {
        // Extract auth from connection params
        const token = ctx.connectionParams?.authorization as string | undefined;
        const mockReq = {
          headers: { authorization: token },
        } as express.Request;

        const auth = await getAuthContext(mockReq);
        return {
          auth,
          dataSources: {
            bookingService: new BookingService(AppDataSource),
          },
        };
      },
      onConnect: async (ctx) => {
        logger.debug('WebSocket client connected');
      },
      onDisconnect: async () => {
        logger.debug('WebSocket client disconnected');
      },
    },
    wsServer
  );

  // ─── Apollo Server ────────────────────────────────────
  const server = new ApolloServer<Context>({
    schema,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await serverCleanup.dispose();
            },
          };
        },
      },
      {
        async requestDidStart() {
          const startTime = Date.now();
          return {
            async willSendResponse(requestContext) {
              const duration = Date.now() - startTime;
              const operationName =
                requestContext.request.operationName || 'anonymous';
              logger.info('GraphQL response', {
                operation: operationName,
                durationMs: duration,
                errors: requestContext.errors?.length ?? 0,
              });
            },
          };
        },
      },
    ],
    formatError: (formattedError, error) => {
      // Mask internal errors in production
      if (process.env.NODE_ENV === 'production') {
        if (
          formattedError.extensions?.code === 'INTERNAL_SERVER_ERROR'
        ) {
          return {
            message: 'An unexpected error occurred',
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          };
        }
      }
      return formattedError;
    },
    introspection: process.env.NODE_ENV !== 'production',
  });

  await server.start();
  logger.info('Apollo Server started');

  // ─── Middleware ────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(compression());

  // Health check (no auth, no rate limit)
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.use(
    '/graphql',
    cors<cors.CorsRequest>({
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true,
    }),
    express.json({ limit: '1mb' }),
    globalRateLimiter(),
    expressMiddleware(server, {
      context: async ({ req }): Promise<Context> => {
        const auth = await getAuthContext(req);
        return {
          auth,
          dataSources: {
            bookingService: new BookingService(AppDataSource),
          },
        };
      },
    })
  );

  // ─── Queue Workers ────────────────────────────────────
  const queueService = QueueService.getInstance();

  queueService.registerWorker('booking:confirmed', async (job) => {
    logger.info('Processing booking confirmation', { data: job.data });
    // In production: send email, update analytics, etc.
  });

  queueService.registerWorker('booking:cancelled', async (job) => {
    logger.info('Processing booking cancellation', { data: job.data });
    // In production: process refund, notify waitlist, etc.
  });

  // Schedule recurring slot reclamation (every 5 minutes)
  await queueService.scheduleRecurring(
    'slot:reclaim-expired-holds',
    {},
    '*/5 * * * *'
  );

  // ─── Start Server ────────────────────────────────────
  httpServer.listen(PORT, () => {
    logger.info(`ReserveAPI running at http://localhost:${PORT}/graphql`);
    logger.info(`Subscriptions at ws://localhost:${PORT}/graphql`);
    logger.info(`Health check at http://localhost:${PORT}/health`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // ─── Graceful Shutdown ───────────────────────────────
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

  signals.forEach((signal) => {
    process.on(signal, async () => {
      logger.info(`Received ${signal}, starting graceful shutdown...`);

      httpServer.close(async () => {
        await server.stop();
        await queueService.shutdown();
        await closeDatabase();
        await RedisClient.disconnect();
        logger.info('Graceful shutdown complete');
        process.exit(0);
      });

      // Force exit after 30s
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30000);
    });
  });
}

bootstrap().catch((error) => {
  logger.error('Failed to start ReserveAPI', { error });
  process.exit(1);
});
