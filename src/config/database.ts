import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { logger } from '../utils/logger';

const isProduction = process.env.NODE_ENV === 'production';

const baseConfig: DataSourceOptions = {
  type: 'postgres',
  url: process.env.DATABASE_URL,
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USER || 'reserve',
  password: process.env.DB_PASSWORD || 'reserve_secret',
  database: process.env.DB_NAME || 'reserve_db',
  synchronize: false,
  logging: isProduction ? ['error', 'warn'] : ['query', 'error', 'warn'],
  entities: [__dirname + '/../models/*.{ts,js}'],
  migrations: [__dirname + '/../migrations/*.{ts,js}'],
  subscribers: [],
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  extra: {
    max: parseInt(process.env.DB_POOL_SIZE || '20', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },
  cache: {
    type: 'ioredis',
    options: process.env.REDIS_URL || 'redis://localhost:6379',
    duration: 30000,
  },
};

export const AppDataSource = new DataSource(baseConfig);

export async function initializeDatabase(): Promise<DataSource> {
  try {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
      logger.info('Database connection established', {
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'reserve_db',
        ssl: isProduction,
      });

      const pendingMigrations = await AppDataSource.showMigrations();
      if (pendingMigrations) {
        logger.warn('There are pending database migrations. Run `npm run migrate` to apply them.');
      }
    }

    return AppDataSource;
  } catch (error) {
    logger.error('Failed to initialize database connection', { error });
    throw error;
  }
}

export async function closeDatabase(): Promise<void> {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
    logger.info('Database connection closed');
  }
}

export default AppDataSource;
