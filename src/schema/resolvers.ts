import { GraphQLError } from 'graphql';
import { PubSub, withFilter } from 'graphql-subscriptions';
import bcrypt from 'bcryptjs';

import { AppDataSource } from '../config/database';
import { User, UserRole } from '../models/User';
import { Booking, BookingStatus } from '../models/Booking';
import { Slot, SlotStatus } from '../models/Slot';
import { BookingService, BookingError } from '../services/BookingService';
import {
  AuthenticatedContext,
  generateTokens,
  requireAuth,
  requireRole,
  refreshAccessToken,
} from '../middleware/auth';
import { consumeAuthRateLimit, consumeMutationRateLimit } from '../middleware/rateLimiter';
import { QueueService } from '../services/QueueService';
import { logger } from '../utils/logger';

const pubsub = new PubSub();

const SLOT_UPDATED = 'SLOT_UPDATED';
const BOOKING_UPDATED = 'BOOKING_UPDATED';

interface ResolverContext {
  auth: AuthenticatedContext;
  dataSources: {
    bookingService: BookingService;
  };
}

function handleError(error: unknown): never {
  if (error instanceof BookingError) {
    throw new GraphQLError(error.message, {
      extensions: {
        code: error.code,
        http: { status: error.statusCode },
      },
    });
  }

  if (error instanceof GraphQLError) {
    throw error;
  }

  logger.error('Unhandled resolver error', {
    error: error instanceof Error ? error.message : 'Unknown error',
  });

  throw new GraphQLError('An unexpected error occurred', {
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  });
}

export const resolvers = {
  // ─── Custom Scalar Stubs ──────────────────────────────
  DateTime: {
    __serialize: (value: Date | string) =>
      value instanceof Date ? value.toISOString() : value,
    __parseValue: (value: string) => new Date(value),
  },

  Date: {
    __serialize: (value: string) => value,
    __parseValue: (value: string) => value,
  },

  // ─── Query ────────────────────────────────────────────
  Query: {
    me: async (_: unknown, __: unknown, ctx: ResolverContext) => {
      requireAuth(ctx.auth);
      const userRepo = AppDataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: ctx.auth.user!.userId } });
      if (!user) {
        throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
      }
      return user;
    },

    venue: async (_: unknown, { id }: { id: string }) => {
      // Venue is a simplified lookup — in production this would be its own entity
      // For now we return a stub for the schema to resolve
      return { id, name: 'Venue', address: '', timezone: 'UTC', capacity: 0, isActive: true };
    },

    venues: async (_: unknown, { limit, offset }: { limit: number; offset: number }) => {
      // Placeholder: would query a Venue repository
      return [];
    },

    availableSlots: async (
      _: unknown,
      { venueId, date }: { venueId: string; date: string },
      ctx: ResolverContext
    ) => {
      try {
        return await ctx.dataSources.bookingService.getAvailableSlots(venueId, date);
      } catch (error) {
        handleError(error);
      }
    },

    slot: async (_: unknown, { id }: { id: string }) => {
      const slotRepo = AppDataSource.getRepository(Slot);
      return slotRepo.findOne({ where: { id } });
    },

    booking: async (_: unknown, { id }: { id: string }, ctx: ResolverContext) => {
      requireAuth(ctx.auth);

      const booking = await ctx.dataSources.bookingService.getBookingById(id);
      if (!booking) {
        throw new GraphQLError('Booking not found', { extensions: { code: 'NOT_FOUND' } });
      }

      // Users can only view their own bookings unless admin
      if (
        booking.userId !== ctx.auth.user!.userId &&
        ctx.auth.user!.role !== UserRole.ADMIN
      ) {
        throw new GraphQLError('Not authorized', { extensions: { code: 'FORBIDDEN' } });
      }

      return booking;
    },

    bookingByConfirmationCode: async (
      _: unknown,
      { code }: { code: string },
      ctx: ResolverContext
    ) => {
      requireAuth(ctx.auth);
      return ctx.dataSources.bookingService.getBookingByConfirmationCode(code);
    },

    myBookings: async (
      _: unknown,
      args: { filter?: { status?: BookingStatus }; limit: number; offset: number },
      ctx: ResolverContext
    ) => {
      requireAuth(ctx.auth);

      const { bookings, total } = await ctx.dataSources.bookingService.getBookingsByUser(
        ctx.auth.user!.userId,
        args.filter?.status,
        args.limit,
        args.offset
      );

      return {
        edges: bookings,
        pageInfo: {
          hasNextPage: args.offset + args.limit < total,
          hasPreviousPage: args.offset > 0,
          totalCount: total,
        },
      };
    },

    queueStats: async (_: unknown, __: unknown, ctx: ResolverContext) => {
      requireRole(ctx.auth, UserRole.ADMIN);
      const queueService = QueueService.getInstance();
      return queueService.getQueueStats();
    },
  },

  // ─── Mutation ─────────────────────────────────────────
  Mutation: {
    register: async (_: unknown, { input }: { input: { name: string; email: string; password: string; phone?: string } }) => {
      const userRepo = AppDataSource.getRepository(User);

      const existingUser = await userRepo.findOne({ where: { email: input.email } });
      if (existingUser) {
        throw new GraphQLError('An account with this email already exists', {
          extensions: { code: 'CONFLICT' },
        });
      }

      const user = userRepo.create({
        name: input.name,
        email: input.email.toLowerCase().trim(),
        password: input.password,
        phone: input.phone,
        role: UserRole.MEMBER,
      });

      await userRepo.save(user);
      const tokens = generateTokens(user);

      user.refreshToken = tokens.refreshToken;
      await userRepo.save(user);

      logger.info('User registered', { userId: user.id, email: user.email });

      return { ...tokens, user };
    },

    login: async (_: unknown, { input }: { input: { email: string; password: string } }) => {
      await consumeAuthRateLimit(`login:${input.email.toLowerCase()}`);

      const userRepo = AppDataSource.getRepository(User);
      const user = await userRepo
        .createQueryBuilder('user')
        .addSelect('user.password')
        .where('user.email = :email', { email: input.email.toLowerCase().trim() })
        .andWhere('user.isActive = :isActive', { isActive: true })
        .getOne();

      if (!user) {
        throw new GraphQLError('Invalid email or password', {
          extensions: { code: 'UNAUTHORIZED' },
        });
      }

      const validPassword = await bcrypt.compare(input.password, user.password);
      if (!validPassword) {
        throw new GraphQLError('Invalid email or password', {
          extensions: { code: 'UNAUTHORIZED' },
        });
      }

      const tokens = generateTokens(user);

      user.refreshToken = tokens.refreshToken;
      user.lastLoginAt = new Date();
      await userRepo.save(user);

      logger.info('User logged in', { userId: user.id });

      return { ...tokens, user };
    },

    refreshToken: async (_: unknown, { refreshToken }: { refreshToken: string }) => {
      const tokens = await refreshAccessToken(refreshToken);
      if (!tokens) {
        throw new GraphQLError('Invalid or expired refresh token', {
          extensions: { code: 'UNAUTHORIZED' },
        });
      }
      return tokens;
    },

    logout: async (_: unknown, __: unknown, ctx: ResolverContext) => {
      requireAuth(ctx.auth);

      const userRepo = AppDataSource.getRepository(User);
      await userRepo.update(ctx.auth.user!.userId, { refreshToken: undefined });

      return true;
    },

    updateProfile: async (
      _: unknown,
      { input }: { input: { name?: string; phone?: string } },
      ctx: ResolverContext
    ) => {
      requireAuth(ctx.auth);

      const userRepo = AppDataSource.getRepository(User);
      await userRepo.update(ctx.auth.user!.userId, input);

      return userRepo.findOneOrFail({ where: { id: ctx.auth.user!.userId } });
    },

    createBooking: async (
      _: unknown,
      { input }: { input: { slotId: string; venueId: string; guestCount: number; notes?: string } },
      ctx: ResolverContext
    ) => {
      requireAuth(ctx.auth);

      await consumeMutationRateLimit(`booking:create:${ctx.auth.user!.userId}`);

      try {
        const booking = await ctx.dataSources.bookingService.createBooking({
          userId: ctx.auth.user!.userId,
          slotId: input.slotId,
          venueId: input.venueId,
          guestCount: input.guestCount,
          notes: input.notes,
        });

        // Publish real-time update
        const slot = await AppDataSource.getRepository(Slot).findOne({
          where: { id: input.slotId },
        });

        if (slot) {
          pubsub.publish(SLOT_UPDATED, {
            slotAvailabilityChanged: {
              slotId: slot.id,
              venueId: slot.venueId,
              status: slot.status,
              remainingCapacity: slot.remainingCapacity,
            },
          });
        }

        pubsub.publish(BOOKING_UPDATED, {
          bookingStatusChanged: {
            bookingId: booking.id,
            status: booking.status,
            confirmationCode: booking.confirmationCode,
          },
          userId: ctx.auth.user!.userId,
        });

        return booking;
      } catch (error) {
        handleError(error);
      }
    },

    cancelBooking: async (
      _: unknown,
      { input }: { input: { bookingId: string; reason?: string } },
      ctx: ResolverContext
    ) => {
      requireAuth(ctx.auth);

      try {
        const booking = await ctx.dataSources.bookingService.cancelBooking({
          bookingId: input.bookingId,
          userId: ctx.auth.user!.userId,
          reason: input.reason,
        });

        const slot = await AppDataSource.getRepository(Slot).findOne({
          where: { id: booking.slotId },
        });

        if (slot) {
          pubsub.publish(SLOT_UPDATED, {
            slotAvailabilityChanged: {
              slotId: slot.id,
              venueId: slot.venueId,
              status: slot.status,
              remainingCapacity: slot.remainingCapacity,
            },
          });
        }

        return booking;
      } catch (error) {
        handleError(error);
      }
    },

    blockSlot: async (
      _: unknown,
      { slotId, reason }: { slotId: string; reason?: string },
      ctx: ResolverContext
    ) => {
      requireRole(ctx.auth, UserRole.ADMIN);

      const slotRepo = AppDataSource.getRepository(Slot);
      const slot = await slotRepo.findOne({ where: { id: slotId } });

      if (!slot) {
        throw new GraphQLError('Slot not found', { extensions: { code: 'NOT_FOUND' } });
      }

      slot.status = SlotStatus.BLOCKED;
      slot.metadata = { ...slot.metadata, blockReason: reason, blockedBy: ctx.auth.user!.userId };
      await slotRepo.save(slot);

      logger.info('Slot blocked by admin', { slotId, adminId: ctx.auth.user!.userId, reason });

      return slot;
    },

    unblockSlot: async (_: unknown, { slotId }: { slotId: string }, ctx: ResolverContext) => {
      requireRole(ctx.auth, UserRole.ADMIN);

      const slotRepo = AppDataSource.getRepository(Slot);
      const slot = await slotRepo.findOne({ where: { id: slotId } });

      if (!slot) {
        throw new GraphQLError('Slot not found', { extensions: { code: 'NOT_FOUND' } });
      }

      slot.status = SlotStatus.AVAILABLE;
      await slotRepo.save(slot);

      return slot;
    },
  },

  // ─── Subscription ────────────────────────────────────
  Subscription: {
    slotAvailabilityChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterator([SLOT_UPDATED]),
        (payload, variables) =>
          payload.slotAvailabilityChanged.venueId === variables.venueId
      ),
    },

    bookingStatusChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterator([BOOKING_UPDATED]),
        (payload, variables) => payload.userId === variables.userId
      ),
    },
  },

  // ─── Type Resolvers ──────────────────────────────────
  User: {
    bookings: async (
      parent: User,
      { limit, offset }: { limit: number; offset: number }
    ) => {
      const bookingRepo = AppDataSource.getRepository(Booking);
      const [bookings, total] = await bookingRepo.findAndCount({
        where: { userId: parent.id },
        order: { createdAt: 'DESC' },
        take: limit,
        skip: offset,
      });

      return {
        edges: bookings,
        pageInfo: {
          hasNextPage: offset + limit < total,
          hasPreviousPage: offset > 0,
          totalCount: total,
        },
      };
    },
  },

  Booking: {
    user: async (parent: Booking) => {
      if (parent.user) return parent.user;
      const userRepo = AppDataSource.getRepository(User);
      return userRepo.findOne({ where: { id: parent.userId } });
    },
    slot: async (parent: Booking) => {
      if (parent.slot) return parent.slot;
      const slotRepo = AppDataSource.getRepository(Slot);
      return slotRepo.findOne({ where: { id: parent.slotId } });
    },
    venue: async (parent: Booking) => {
      // Simplified: in production this would load from a Venue entity
      return {
        id: parent.venueId,
        name: 'Venue',
        address: '',
        timezone: 'UTC',
        capacity: 0,
        isActive: true,
        createdAt: new Date(),
      };
    },
  },
};

export default resolvers;
