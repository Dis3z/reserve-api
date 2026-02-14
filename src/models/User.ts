import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
  BeforeInsert,
} from 'typeorm';
import { IsEmail, Length, IsEnum } from 'class-validator';
import bcrypt from 'bcryptjs';
import { Booking } from './Booking';

export enum UserRole {
  GUEST = 'guest',
  MEMBER = 'member',
  ADMIN = 'admin',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  @Length(2, 255)
  name!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  @IsEmail()
  @Index('idx_users_email', { unique: true })
  email!: string;

  @Column({ type: 'varchar', length: 255, select: false })
  password!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone?: string;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.MEMBER,
  })
  @IsEnum(UserRole)
  role!: UserRole;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  refreshToken?: string;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt?: Date;

  @OneToMany(() => Booking, (booking) => booking.user)
  bookings!: Booking[];

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt!: Date;

  @BeforeInsert()
  async hashPassword(): Promise<void> {
    if (this.password) {
      this.password = await bcrypt.hash(this.password, 12);
    }
  }

  async comparePassword(candidatePassword: string): Promise<boolean> {
    return bcrypt.compare(candidatePassword, this.password);
  }

  toJSON(): Omit<User, 'password' | 'refreshToken' | 'hashPassword' | 'comparePassword' | 'toJSON'> {
    const { password: _p, refreshToken: _r, ...rest } = this as Record<string, unknown>;
    return rest as Omit<User, 'password' | 'refreshToken' | 'hashPassword' | 'comparePassword' | 'toJSON'>;
  }
}
