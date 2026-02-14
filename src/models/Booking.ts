import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { User } from './User';
import { Slot } from './Slot';

export enum BookingStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  COMPLETED = 'completed',
  NO_SHOW = 'no_show',
}

@Entity('bookings')
@Index('idx_bookings_user', ['userId'])
@Index('idx_bookings_slot', ['slotId'])
@Index('idx_bookings_status', ['status'])
@Index('idx_bookings_confirmation_code', ['confirmationCode'], { unique: true })
@Index('idx_bookings_venue_date', ['venueId', 'bookingDate'])
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'slot_id', type: 'uuid' })
  slotId!: string;

  @Column({ name: 'venue_id', type: 'uuid' })
  venueId!: string;

  @Column({
    name: 'confirmation_code',
    type: 'varchar',
    length: 12,
    unique: true,
  })
  confirmationCode!: string;

  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.PENDING,
  })
  status!: BookingStatus;

  @Column({ name: 'guest_count', type: 'int', default: 1 })
  guestCount!: number;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ name: 'booking_date', type: 'date' })
  bookingDate!: string;

  @Column({ name: 'cancelled_at', type: 'timestamp with time zone', nullable: true })
  cancelledAt?: Date;

  @Column({ name: 'cancellation_reason', type: 'text', nullable: true })
  cancellationReason?: string;

  @Column({ name: 'confirmed_at', type: 'timestamp with time zone', nullable: true })
  confirmedAt?: Date;

  @Column({ name: 'completed_at', type: 'timestamp with time zone', nullable: true })
  completedAt?: Date;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  totalPrice?: number;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @ManyToOne(() => User, (user) => user.bookings, { eager: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => Slot, (slot) => slot.bookings, { eager: false })
  @JoinColumn({ name: 'slot_id' })
  slot!: Slot;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt!: Date;

  @BeforeInsert()
  generateConfirmationCode(): void {
    if (!this.confirmationCode) {
      const raw = uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
      this.confirmationCode = `RSV-${raw}`;
    }
  }

  get isCancellable(): boolean {
    if (this.status === BookingStatus.CANCELLED || this.status === BookingStatus.COMPLETED) {
      return false;
    }

    const cancellationWindowHours = parseInt(
      process.env.BOOKING_CANCELLATION_WINDOW_HOURS || '24',
      10
    );
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() + cancellationWindowHours);

    return true;
  }
}
