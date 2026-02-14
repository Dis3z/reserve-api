import { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';

interface RateLimiterConfig {
  keyPrefix: string;
  points: number;
  duration: number;
  blockDuration?: number;
}

const configs: Record<string, RateLimiterConfig> = {
  global: {
    keyPrefix: 'rl:global',
    points: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
    duration: 60, // per minute
    blockDuration: 0,
  },
  auth: {
    keyPrefix: 'rl:auth',
    points: 10,
    duration: 900, // 15 minutes
    blockDuration: 900,
  },
  mutation: {
    keyPrefix: 'rl:mutation',
    points: 30,
    duration: 60,
    blockDuration: 60,
  },
};

const limiters = new Map<string, RateLimiterRedis>();

function getLimiter(name: string): RateLimiterRedis {
  if (!limiters.has(name)) {
    const config = configs[name];
    if (!config) {
      throw new Error(`Unknown rate limiter: ${name}`);
    }

    limiters.set(
      name,
      new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: config.keyPrefix,
        points: config.points,
        duration: config.duration,
        blockDuration: config.blockDuration,
        insuranceLimiter: undefined,
      })
    );
  }

  return limiters.get(name)!;
}

function getClientKey(req: Request): string {
  // Use authenticated user ID if available, otherwise fall back to IP
  const userId = (req as Request & { userId?: string }).userId;
  if (userId) return `user:${userId}`;

  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.ip || req.socket.remoteAddress || 'unknown';

  return `ip:${ip}`;
}

function setRateLimitHeaders(res: Response, limiterRes: RateLimiterRes, maxPoints: number): void {
  res.set({
    'X-RateLimit-Limit': String(maxPoints),
    'X-RateLimit-Remaining': String(Math.max(0, limiterRes.remainingPoints)),
    'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000 + limiterRes.msBeforeNext / 1000)),
    'Retry-After': String(Math.ceil(limiterRes.msBeforeNext / 1000)),
  });
}

export function globalRateLimiter() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const limiter = getLimiter('global');
    const key = getClientKey(req);

    try {
      const result = await limiter.consume(key);
      setRateLimitHeaders(res, result, configs.global.points);
      next();
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        setRateLimitHeaders(res, error, configs.global.points);
        logger.warn('Rate limit exceeded', { key, limiter: 'global' });
        res.status(429).json({
          errors: [
            {
              message: 'Too many requests. Please try again later.',
              extensions: {
                code: 'RATE_LIMIT_EXCEEDED',
                retryAfter: Math.ceil(error.msBeforeNext / 1000),
              },
            },
          ],
        });
        return;
      }
      // If Redis is down, let the request through
      logger.error('Rate limiter error', { error });
      next();
    }
  };
}

export async function consumeAuthRateLimit(key: string): Promise<void> {
  const limiter = getLimiter('auth');

  try {
    await limiter.consume(key);
  } catch (error) {
    if (error instanceof RateLimiterRes) {
      const retryAfter = Math.ceil(error.msBeforeNext / 1000);
      throw new Error(
        `Too many login attempts. Please try again in ${retryAfter} seconds.`
      );
    }
    throw error;
  }
}

export async function consumeMutationRateLimit(key: string): Promise<void> {
  const limiter = getLimiter('mutation');

  try {
    await limiter.consume(key);
  } catch (error) {
    if (error instanceof RateLimiterRes) {
      throw new Error('Too many write operations. Please slow down.');
    }
    throw error;
  }
}
