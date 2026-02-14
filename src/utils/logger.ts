import winston from 'winston';

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const devFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const stackStr = stack ? `\n${stack}` : '';
  return `${ts} [${level}]: ${message}${metaStr}${stackStr}`;
});

const isProduction = process.env.NODE_ENV === 'production';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  defaultMeta: {
    service: 'reserve-api',
    version: process.env.npm_package_version || '0.0.0',
  },
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    errors({ stack: true })
  ),
  transports: [
    new winston.transports.Console({
      format: isProduction
        ? combine(json())
        : combine(colorize({ all: true }), devFormat),
    }),
  ],
  exceptionHandlers: [
    new winston.transports.Console({
      format: combine(json()),
    }),
  ],
  rejectionHandlers: [
    new winston.transports.Console({
      format: combine(json()),
    }),
  ],
  exitOnError: false,
});

if (!isProduction) {
  logger.debug('Logger initialized in development mode');
}

export const requestLogger = (
  reqId: string,
  operation: string,
  duration?: number
): void => {
  const meta: Record<string, unknown> = { requestId: reqId, operation };
  if (duration !== undefined) {
    meta.durationMs = duration;
  }
  logger.info(`GraphQL ${operation}`, meta);
};

export default logger;
