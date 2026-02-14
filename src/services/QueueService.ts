import { Queue, Worker, Job, QueueScheduler, QueueEvents } from 'bullmq';
import { logger } from '../utils/logger';

export interface JobPayload {
  [key: string]: unknown;
}

interface QueueConfig {
  name: string;
  defaultJobOptions?: {
    attempts?: number;
    backoff?: { type: string; delay: number };
    removeOnComplete?: boolean | number;
    removeOnFail?: boolean | number;
  };
}

const QUEUE_CONFIG: QueueConfig = {
  name: 'reserve-jobs',
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
};

const redisConnection = {
  host: new URL(process.env.REDIS_URL || 'redis://localhost:6379').hostname,
  port: parseInt(
    new URL(process.env.REDIS_URL || 'redis://localhost:6379').port || '6379',
    10
  ),
};

export class QueueService {
  private static instance: QueueService | null = null;
  private queue: Queue;
  private queueEvents: QueueEvents;
  private workers: Map<string, Worker> = new Map();

  constructor() {
    this.queue = new Queue(QUEUE_CONFIG.name, {
      connection: redisConnection,
      defaultJobOptions: QUEUE_CONFIG.defaultJobOptions,
    });

    this.queueEvents = new QueueEvents(QUEUE_CONFIG.name, {
      connection: redisConnection,
    });

    this.queueEvents.on('completed', ({ jobId }) => {
      logger.debug('Job completed', { jobId });
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      logger.error('Job failed', { jobId, reason: failedReason });
    });

    this.queueEvents.on('stalled', ({ jobId }) => {
      logger.warn('Job stalled', { jobId });
    });
  }

  static getInstance(): QueueService {
    if (!QueueService.instance) {
      QueueService.instance = new QueueService();
    }
    return QueueService.instance;
  }

  async addJob(
    name: string,
    data: JobPayload,
    options?: {
      priority?: number;
      delay?: number;
      repeat?: { pattern: string };
    }
  ): Promise<Job> {
    const job = await this.queue.add(name, data, {
      priority: options?.priority,
      delay: options?.delay,
      repeat: options?.repeat ? { pattern: options.repeat.pattern } : undefined,
    });

    logger.info('Job enqueued', {
      jobId: job.id,
      name,
      priority: options?.priority,
    });

    return job;
  }

  registerWorker(
    jobName: string,
    processor: (job: Job) => Promise<void>
  ): Worker {
    const worker = new Worker(
      QUEUE_CONFIG.name,
      async (job: Job) => {
        if (job.name !== jobName) return;

        const startTime = Date.now();
        logger.info('Processing job', {
          jobId: job.id,
          name: job.name,
          attempt: job.attemptsMade + 1,
        });

        try {
          await processor(job);
          logger.info('Job processed successfully', {
            jobId: job.id,
            name: job.name,
            durationMs: Date.now() - startTime,
          });
        } catch (error) {
          logger.error('Job processing failed', {
            jobId: job.id,
            name: job.name,
            error: error instanceof Error ? error.message : 'Unknown error',
            durationMs: Date.now() - startTime,
          });
          throw error;
        }
      },
      {
        connection: redisConnection,
        concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
        limiter: {
          max: 50,
          duration: 1000,
        },
      }
    );

    worker.on('error', (err) => {
      logger.error('Worker error', { jobName, error: err.message });
    });

    this.workers.set(jobName, worker);
    logger.info('Worker registered', { jobName });

    return worker;
  }

  async scheduleRecurring(
    name: string,
    data: JobPayload,
    cronPattern: string
  ): Promise<void> {
    await this.queue.add(name, data, {
      repeat: { pattern: cronPattern },
    });

    logger.info('Recurring job scheduled', { name, cron: cronPattern });
  }

  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down queue service...');

    const workerClosePromises = Array.from(this.workers.values()).map((w) =>
      w.close()
    );

    await Promise.all([
      ...workerClosePromises,
      this.queueEvents.close(),
      this.queue.close(),
    ]);

    this.workers.clear();
    logger.info('Queue service shut down');
  }
}
