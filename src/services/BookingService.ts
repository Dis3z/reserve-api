import { Repository, DataSource, QueryRunner } from 'typeorm';
import { Booking, BookingStatus } from '../models/Booking';
import { Slot, SlotStatus } from '../models/Slot';
import { User } from '../models/User';
import RedisClient from '../utils/redis';
import { logger } from '../utils/logger';
import { NotificationService, NotificationType } from './NotificationService';
import { QueueService } from './QueueService';

export interface CreateBookingInput {
  userId: string;
  slotId: string;
  venueId: string;
  guestCount: number;
  notes?: string;
}

export interface CancelBookingInput {
  bookingId: string;
  userId: string;
  reason?: string;
}

export class BookingError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

export class BookingService {
  private bookingRepo: Repository<Booking>;
  private slotRepo: Repository<Slot>;
  private userRepo: Repository<User>;
  private dataSource: DataSource;
  private notificationService: NotificationService;
  private queueService: QueueService;

  constructor(dataSource: DataSource) {
    this.dataSource = dataSource;
    this.bookingRepo = dataSource.getRepository(Booking);
    this.slotRepo = dataSource.getRepository(Slot);
    this.userRepo = dataSource.getRepository(User);
    this.notificationService = new NotificationService();
    this.queueService = new QueueService();
  }

  async createBooking(input: CreateBookingInput): Promise<Booking> {
    const { userId, slotId, venueId, guestCount, notes } = input;

    // Acquire distributed lock to prevent double-booking
    const lockKey = `booking:slot:${slotId}`;
    const lockId = await RedisClient.acquireLock(lockKey, 15000);

    if (!lockId) {
      throw new BookingError(
        'This slot is currently being processed. Please try again.',
        'SLOT_LOCKED',
        409
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Verify user exists and is active
      const user = await this.userRepo.findOne({ where: { id: userId, isActive: true } });
      if (!user) {
        throw new BookingError('User not found or inactive', 'USER_NOT_FOUND', 404);
      }

      // Check user's concurrent booking limit
      const activeBookings = await this.bookingRepo.count({
        where: {
          userId,
          status: BookingStatus.CONFIRMED,
        },
      });

      const maxConcurrent = parseInt(
        process.env.MAX_CONCURRENT_BOOKINGS_PER_USER || '5',
        10
      );

      if (activeBookings >= maxConcurrent) {
        throw new BookingError(
          `Maximum concurrent bookings (${maxConcurrent}) reached`,
          'MAX_BOOKINGS_REACHED',
          429
        );
      }

      // Fetch slot with row-level lock
      const slot = await queryRunner.manager
        .getRepository(Slot)
        .createQueryBuilder('slot')
        .setLock('pessimistic_write')
        .where('slot.id = :slotId', { slotId })
        .getOne();

      if (!slot) {
        throw new BookingError('Slot not found', 'SLOT_NOT_FOUND', 404);
      }

      if (slot.status === SlotStatus.BLOCKED) {
        throw new BookingError('This slot is not available for booking', 'SLOT_BLOCKED');
      }

      if (!slot.canAccommodate(guestCount)) {
        throw new BookingError(
          `Insufficient capacity. Available: ${slot.remainingCapacity}, Requested: ${guestCount}`,
          'INSUFFICIENT_CAPACITY'
        );
      }

      if (slot.isPast) {
        throw new BookingError('Cannot book a slot in the past', 'SLOT_IN_PAST');
      }

      // Check advance booking window
      const maxAdvanceDays = parseInt(
        process.env.MAX_BOOKING_ADVANCE_DAYS || '90',
        10
      );
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + maxAdvanceDays);

      if (new Date(slot.startTime) > maxDate) {
        throw new BookingError(
          `Cannot book more than ${maxAdvanceDays} days in advance`,
          'ADVANCE_LIMIT_EXCEEDED'
        );
      }

      // Check for duplicate booking
      const existingBooking = await this.bookingRepo.findOne({
        where: {
          userId,
          slotId,
          status: BookingStatus.CONFIRMED,
        },
      });

      if (existingBooking) {
        throw new BookingError(
          'You already have a booking for this slot',
          'DUPLICATE_BOOKING',
          409
        );
      }

      // Create booking
      const booking = this.bookingRepo.create({
        userId,
        slotId,
        venueId,
        guestCount,
        notes,
        bookingDate: slot.date,
        status: BookingStatus.CONFIRMED,
        confirmedAt: new Date(),
        totalPrice: slot.price ? Number(slot.price) * guestCount : undefined,
      });

      await queryRunner.manager.save(booking);

      // Update slot capacity
      slot.remainingCapacity -= guestCount;
      if (slot.remainingCapacity === 0) {
        slot.status = SlotStatus.BOOKED;
      }
      await queryRunner.manager.save(slot);

      await queryRunner.commitTransaction();

      // Invalidate cache
      await this.invalidateSlotCache(venueId, slot.date);

      // Queue async tasks
      await this.queueService.addJob('booking:confirmed', {
        bookingId: booking.id,
        userId,
        confirmationCode: booking.confirmationCode,
      });

      // Send notification
      await this.notificationService.send({
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        data: {
          bookingId: booking.id,
          confirmationCode: booking.confirmationCode,
          date: slot.date,
          startTime: slot.startTime.toISOString(),
        },
      });

      logger.info('Booking created successfully', {
        bookingId: booking.id,
        userId,
        slotId,
        confirmationCode: booking.confirmationCode,
      });

      return booking;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
      await RedisClient.releaseLock(lockKey, lockId);
    }
  }

  async cancelBooking(input: CancelBookingInput): Promise<Booking> {
    const { bookingId, userId, reason } = input;

    const booking = await this.bookingRepo.findOne({
      where: { id: bookingId },
      relations: ['slot'],
    });

    if (!booking) {
      throw new BookingError('Booking not found', 'BOOKING_NOT_FOUND', 404);
    }

    if (booking.userId !== userId) {
      throw new BookingError('Not authorized to cancel this booking', 'UNAUTHORIZED', 403);
    }

    if (!booking.isCancellable) {
      throw new BookingError(
        'This booking can no longer be cancelled',
        'CANCELLATION_NOT_ALLOWED'
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      booking.status = BookingStatus.CANCELLED;
      booking.cancelledAt = new Date();
      booking.cancellationReason = reason;
      await queryRunner.manager.save(booking);

      // Restore slot capacity
      const slot = await queryRunner.manager
        .getRepository(Slot)
        .createQueryBuilder('slot')
        .setLock('pessimistic_write')
        .where('slot.id = :slotId', { slotId: booking.slotId })
        .getOne();

      if (slot) {
        slot.remainingCapacity += booking.guestCount;
        if (slot.status === SlotStatus.BOOKED && slot.remainingCapacity > 0) {
          slot.status = SlotStatus.AVAILABLE;
        }
        await queryRunner.manager.save(slot);
      }

      await queryRunner.commitTransaction();

      // Invalidate cache
      await this.invalidateSlotCache(booking.venueId, booking.bookingDate);

      // Queue refund / notification processing
      await this.queueService.addJob('booking:cancelled', {
        bookingId: booking.id,
        userId,
        slotId: booking.slotId,
      });

      await this.notificationService.send({
        type: NotificationType.BOOKING_CANCELLED,
        userId,
        data: {
          bookingId: booking.id,
          confirmationCode: booking.confirmationCode,
        },
      });

      logger.info('Booking cancelled', {
        bookingId: booking.id,
        userId,
        reason,
      });

      return booking;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async getAvailableSlots(venueId: string, date: string): Promise<Slot[]> {
    const cacheKey = `slots:${venueId}:${date}`;
    const redis = RedisClient.getInstance();
    const cached = await redis.get(cacheKey);

    if (cached) {
      logger.debug('Cache hit for available slots', { venueId, date });
      return JSON.parse(cached);
    }

    const slots = await this.slotRepo
      .createQueryBuilder('slot')
      .where('slot.venueId = :venueId', { venueId })
      .andWhere('slot.date = :date', { date })
      .andWhere('slot.status IN (:...statuses)', {
        statuses: [SlotStatus.AVAILABLE],
      })
      .andWhere('slot.remainingCapacity > 0')
      .andWhere('slot.startTime > :now', { now: new Date() })
      .orderBy('slot.startTime', 'ASC')
      .getMany();

    // Cache for 60 seconds
    await redis.set(cacheKey, JSON.stringify(slots), 'EX', 60);

    return slots;
  }

  async getBookingById(bookingId: string): Promise<Booking | null> {
    return this.bookingRepo.findOne({
      where: { id: bookingId },
      relations: ['user', 'slot'],
    });
  }

  async getBookingsByUser(
    userId: string,
    status?: BookingStatus,
    limit: number = 20,
    offset: number = 0
  ): Promise<{ bookings: Booking[]; total: number }> {
    const query = this.bookingRepo
      .createQueryBuilder('booking')
      .leftJoinAndSelect('booking.slot', 'slot')
      .where('booking.userId = :userId', { userId })
      .orderBy('booking.createdAt', 'DESC')
      .skip(offset)
      .take(limit);

    if (status) {
      query.andWhere('booking.status = :status', { status });
    }

    const [bookings, total] = await query.getManyAndCount();
    return { bookings, total };
  }

  async getBookingByConfirmationCode(code: string): Promise<Booking | null> {
    return this.bookingRepo.findOne({
      where: { confirmationCode: code },
      relations: ['user', 'slot'],
    });
  }

  private async invalidateSlotCache(venueId: string, date: string): Promise<void> {
    const redis = RedisClient.getInstance();
    const cacheKey = `slots:${venueId}:${date}`;
    await redis.del(cacheKey);
    logger.debug('Cache invalidated', { cacheKey });
  }
}
