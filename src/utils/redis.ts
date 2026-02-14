import Redis from 'ioredis';
import { logger } from './logger';

class RedisClient {
  private static instance: Redis | null = null;
  private static subscriber: Redis | null = null;

  private constructor() {}

  static getInstance(): Redis {
    if (!RedisClient.instance) {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

      RedisClient.instance = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy(times: number): number | null {
          if (times > 10) {
            logger.error('Redis: max retry attempts reached, giving up');
            return null;
          }
          const delay = Math.min(times * 200, 5000);
          logger.warn(`Redis: retrying connection in ${delay}ms (attempt ${times})`);
          return delay;
        },
        reconnectOnError(err: Error): boolean {
          const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
          return targetErrors.some((e) => err.message.includes(e));
        },
        enableReadyCheck: true,
        lazyConnect: false,
      });

      RedisClient.instance.on('connect', () => {
        logger.info('Redis: connection established');
      });

      RedisClient.instance.on('ready', () => {
        logger.info('Redis: ready to accept commands');
      });

      RedisClient.instance.on('error', (err: Error) => {
        logger.error('Redis: connection error', { error: err.message });
      });

      RedisClient.instance.on('close', () => {
        logger.warn('Redis: connection closed');
      });
    }

    return RedisClient.instance;
  }

  static getSubscriber(): Redis {
    if (!RedisClient.subscriber) {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      RedisClient.subscriber = new Redis(redisUrl);

      RedisClient.subscriber.on('error', (err: Error) => {
        logger.error('Redis subscriber: connection error', { error: err.message });
      });
    }

    return RedisClient.subscriber;
  }

  static async disconnect(): Promise<void> {
    if (RedisClient.instance) {
      await RedisClient.instance.quit();
      RedisClient.instance = null;
    }
    if (RedisClient.subscriber) {
      await RedisClient.subscriber.quit();
      RedisClient.subscriber = null;
    }
    logger.info('Redis: all connections closed');
  }

  static async acquireLock(
    key: string,
    ttlMs: number = 10000
  ): Promise<string | null> {
    const redis = RedisClient.getInstance();
    const lockId = `lock:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const result = await redis.set(
      `lock:${key}`,
      lockId,
      'PX',
      ttlMs,
      'NX'
    );
    return result === 'OK' ? lockId : null;
  }

  static async releaseLock(key: string, lockId: string): Promise<boolean> {
    const redis = RedisClient.getInstance();
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await redis.eval(script, 1, `lock:${key}`, lockId);
    return result === 1;
  }
}

export const redis = RedisClient.getInstance();
export default RedisClient;
