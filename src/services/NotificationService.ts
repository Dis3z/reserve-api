import AWS from 'aws-sdk';
import { logger } from '../utils/logger';

export enum NotificationType {
  BOOKING_CONFIRMED = 'booking_confirmed',
  BOOKING_CANCELLED = 'booking_cancelled',
  BOOKING_REMINDER = 'booking_reminder',
  SLOT_AVAILABLE = 'slot_available',
  WAITLIST_PROMOTED = 'waitlist_promoted',
}

export interface NotificationPayload {
  type: NotificationType;
  userId: string;
  data: Record<string, unknown>;
  channels?: NotificationChannel[];
}

export enum NotificationChannel {
  PUSH = 'push',
  EMAIL = 'email',
  SMS = 'sms',
}

interface NotificationTemplate {
  title: string;
  body: string;
}

const NOTIFICATION_TEMPLATES: Record<NotificationType, (data: Record<string, unknown>) => NotificationTemplate> = {
  [NotificationType.BOOKING_CONFIRMED]: (data) => ({
    title: 'Booking Confirmed',
    body: `Your reservation (${data.confirmationCode}) has been confirmed for ${data.date}.`,
  }),
  [NotificationType.BOOKING_CANCELLED]: (data) => ({
    title: 'Booking Cancelled',
    body: `Your reservation (${data.confirmationCode}) has been cancelled.`,
  }),
  [NotificationType.BOOKING_REMINDER]: (data) => ({
    title: 'Upcoming Reservation',
    body: `Reminder: your reservation (${data.confirmationCode}) is scheduled for ${data.startTime}.`,
  }),
  [NotificationType.SLOT_AVAILABLE]: (data) => ({
    title: 'Slot Now Available',
    body: `A slot you were watching on ${data.date} is now available. Book it before it fills up!`,
  }),
  [NotificationType.WAITLIST_PROMOTED]: (data) => ({
    title: 'You Got a Spot!',
    body: `Great news! Your waitlisted reservation (${data.confirmationCode}) has been confirmed.`,
  }),
};

export class NotificationService {
  private sns: AWS.SNS;
  private topicArn: string;

  constructor() {
    this.sns = new AWS.SNS({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(process.env.NODE_ENV !== 'production' && {
        endpoint: process.env.SNS_ENDPOINT || undefined,
      }),
    });
    this.topicArn = process.env.SNS_TOPIC_ARN || '';
  }

  async send(payload: NotificationPayload): Promise<void> {
    const { type, userId, data, channels } = payload;

    const template = NOTIFICATION_TEMPLATES[type];
    if (!template) {
      logger.warn('Unknown notification type', { type });
      return;
    }

    const { title, body } = template(data);

    const message = {
      default: body,
      notification: JSON.stringify({
        type,
        userId,
        title,
        body,
        data,
        sentAt: new Date().toISOString(),
      }),
    };

    try {
      if (!this.topicArn) {
        logger.warn('SNS topic ARN not configured, skipping notification', {
          type,
          userId,
        });
        return;
      }

      const params: AWS.SNS.PublishInput = {
        TopicArn: this.topicArn,
        Message: JSON.stringify(message),
        MessageStructure: 'json',
        MessageAttributes: {
          notificationType: {
            DataType: 'String',
            StringValue: type,
          },
          userId: {
            DataType: 'String',
            StringValue: userId,
          },
          ...(channels && {
            channels: {
              DataType: 'String.Array',
              StringValue: JSON.stringify(channels),
            },
          }),
        },
      };

      const result = await this.sns.publish(params).promise();

      logger.info('Notification sent via SNS', {
        messageId: result.MessageId,
        type,
        userId,
        title,
      });
    } catch (error) {
      logger.error('Failed to send notification', {
        error: error instanceof Error ? error.message : 'Unknown error',
        type,
        userId,
      });

      // Don't throw -- notifications should not break the booking flow.
      // The queue worker will retry failed notifications.
    }
  }

  async sendBatch(payloads: NotificationPayload[]): Promise<void> {
    const results = await Promise.allSettled(
      payloads.map((payload) => this.send(payload))
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      logger.warn(`${failed.length}/${payloads.length} notifications failed in batch`);
    }
  }

  async subscribeEndpoint(
    protocol: 'email' | 'sms' | 'https',
    endpoint: string
  ): Promise<string | undefined> {
    try {
      const result = await this.sns
        .subscribe({
          TopicArn: this.topicArn,
          Protocol: protocol,
          Endpoint: endpoint,
          ReturnSubscriptionArn: true,
        })
        .promise();

      logger.info('SNS endpoint subscribed', {
        subscriptionArn: result.SubscriptionArn,
        protocol,
        endpoint: protocol === 'email' ? endpoint.replace(/(.{2}).*(@.*)/, '$1***$2') : '***',
      });

      return result.SubscriptionArn;
    } catch (error) {
      logger.error('Failed to subscribe SNS endpoint', {
        error: error instanceof Error ? error.message : 'Unknown error',
        protocol,
      });
      throw error;
    }
  }
}
