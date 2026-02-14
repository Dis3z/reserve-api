import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  Index,
  JoinColumn,
  Check,
} from 'typeorm';

import { Booking } from './Booking';

export enum SlotStatus {
  AVAILABLE = 'available',
  HELD = 'held',
  BOOKED = 'booked',
  BLOCKED = 'blocked',
}

@Entity('slots')
@Index('idx_slots_venue_date', ['venueId', 'date'])
@Index('idx_slots_status_date', ['status', 'date'])
@Check('"capacity" > 0')
@Check('"remaining_capacity" >= 0')
@Check('"end_time" > "start_time"')
export class Slot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'venue_id', type: 'uuid' })
  venueId!: string;

  @Column({ type: 'date' })
  date!: string;

  @Column({ name: 'start_time', type: 'timestamp with time zone' })
  startTime!: Date;

  @Column({ name: 'end_time', type: 'timestamp with time zone' })
  endTime!: Date;

  @Column({ type: 'int', default: 1 })
  capacity!: number;

  @Column({ name: 'remaining_capacity', type: 'int', default: 1 })
  remainingCapacity!: number;

  @Column({
    type: 'enum',
    enum: SlotStatus,
    default: SlotStatus.AVAILABLE,
  })
  status!: SlotStatus;

  @Column({ name: 'duration_minutes', type: 'int', default: 30 })
  durationMinutes!: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price?: number;

  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @OneToMany(() => Booking, (booking) => booking.slot)
  bookings!: Booking[];

  @Column({ name: 'held_until', type: 'timestamp with time zone', nullable: true })
  heldUntil?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt!: Date;

  get isAvailable(): boolean {
    return this.status === SlotStatus.AVAILABLE && this.remainingCapacity > 0;
  }

  get isPast(): boolean {
    return new Date(this.endTime) < new Date();
  }

  canAccommodate(guestCount: number): boolean {
    return this.isAvailable && this.remainingCapacity >= guestCount;
  }
}
