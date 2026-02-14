<p align="center">
  <h1 align="center">ReserveAPI</h1>
  <p align="center">A high-performance, real-time booking and reservation system built for scale.</p>
</p>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen?style=flat-square&logo=node.js" alt="Node.js" /></a>
  <a href="#"><img src="https://img.shields.io/badge/TypeScript-5.3-blue?style=flat-square&logo=typescript" alt="TypeScript" /></a>
  <a href="#"><img src="https://img.shields.io/badge/GraphQL-16.8-e10098?style=flat-square&logo=graphql" alt="GraphQL" /></a>
  <a href="#"><img src="https://img.shields.io/badge/Apollo%20Server-4.x-311C87?style=flat-square&logo=apollographql" alt="Apollo Server" /></a>
  <a href="#"><img src="https://img.shields.io/badge/Redis-7.x-DC382D?style=flat-square&logo=redis" alt="Redis" /></a>
  <a href="#"><img src="https://img.shields.io/badge/PostgreSQL-16-336791?style=flat-square&logo=postgresql" alt="PostgreSQL" /></a>
  <a href="#"><img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker" alt="Docker" /></a>
  <a href="#"><img src="https://img.shields.io/badge/AWS-Integrated-FF9900?style=flat-square&logo=amazonaws" alt="AWS" /></a>
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" /></a>
</p>

---

## Overview

ReserveAPI is a production-grade reservation engine designed to handle high-concurrency booking scenarios with zero double-booking guarantees. It leverages Redis distributed locks, PostgreSQL row-level locking, and event-driven architecture to ensure data integrity under heavy load.

Built as a set of composable services behind a unified GraphQL gateway, ReserveAPI supports multi-tenant venue management, flexible time-slot configurations, and real-time availability updates via WebSocket subscriptions.

## Features

- **Real-time Booking Engine** -- Optimistic locking with Redis + PostgreSQL to prevent double bookings under concurrent access
- **GraphQL API** -- Strongly-typed queries, mutations, and subscriptions with DataLoader for N+1 query prevention
- **Queue-Based Processing** -- BullMQ workers for async booking confirmation, email dispatch, and slot reclamation
- **Push Notifications** -- AWS SNS integration for booking confirmations, reminders, and cancellation alerts
- **Rate Limiting** -- Token-bucket rate limiting backed by Redis for abuse prevention
- **JWT Authentication** -- Stateless auth with refresh token rotation and role-based access control
- **Multi-Venue Support** -- Manage multiple venues with independent availability calendars and slot configurations
- **Automatic Slot Reclamation** -- Expired holds are released back into the pool via scheduled workers
- **Observability** -- Structured JSON logging with Winston, request tracing, and health check endpoints

## Architecture

```
                                    +------------------+
                                    |   Client Apps    |
                                    |  (Web / Mobile)  |
                                    +--------+---------+
                                             |
                                        WebSocket / HTTPS
                                             |
                                    +--------v---------+
                                    |   API Gateway     |
                                    |  (Apollo Server)  |
                                    +--+-----+------+--+
                                       |     |      |
                          +------------+     |      +-------------+
                          |                  |                    |
                  +-------v------+   +------v-------+   +-------v--------+
                  |   Auth       |   |  Booking     |   |  Notification  |
                  |  Middleware   |   |  Service     |   |  Service       |
                  +--------------+   +--+--------+--+   +-------+--------+
                                        |        |              |
                                   +----v--+ +---v----+   +----v-----+
                                   |  PG   | | Redis  |   |  AWS SNS |
                                   +-------+ +--------+   +----------+
                                                |
                                          +-----v------+
                                          |   BullMQ   |
                                          |   Workers  |
                                          +------------+
```

## Tech Stack

| Layer          | Technology                          |
|----------------|-------------------------------------|
| Runtime        | Node.js 20, TypeScript 5.3          |
| API            | Apollo Server 4, GraphQL 16         |
| Database       | PostgreSQL 16, TypeORM              |
| Cache / Locks  | Redis 7 (ioredis)                   |
| Queue          | BullMQ                              |
| Auth           | JWT (jsonwebtoken), bcryptjs        |
| Notifications  | AWS SNS                             |
| Containerization | Docker, Docker Compose            |
| Logging        | Winston                             |

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- Docker & Docker Compose
- AWS credentials (for notification features)

### Installation

```bash
# Clone the repository
git clone https://github.com/nicolaslumbert/reserve-api.git
cd reserve-api

# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Start infrastructure (PostgreSQL + Redis)
docker-compose up -d postgres redis

# Run database migrations
npm run migrate

# Start the development server
npm run dev
```

The GraphQL playground will be available at `http://localhost:4000/graphql`.

### Docker (Full Stack)

```bash
docker-compose up -d
```

## API Documentation

### Authentication

```graphql
mutation Login {
  login(input: { email: "user@example.com", password: "securepass" }) {
    accessToken
    refreshToken
    user {
      id
      email
      name
    }
  }
}
```

### Query Available Slots

```graphql
query GetAvailableSlots {
  availableSlots(
    venueId: "venue_01HQ3..."
    date: "2025-04-15"
  ) {
    id
    startTime
    endTime
    status
    capacity
    remainingCapacity
  }
}
```

### Create a Booking

```graphql
mutation CreateBooking {
  createBooking(input: {
    slotId: "slot_01HQ3..."
    venueId: "venue_01HQ3..."
    guestCount: 4
    notes: "Window seat preferred"
  }) {
    id
    status
    confirmationCode
    slot {
      startTime
      endTime
    }
    venue {
      name
      address
    }
  }
}
```

### Cancel a Booking

```graphql
mutation CancelBooking {
  cancelBooking(id: "booking_01HQ3...") {
    id
    status
    cancelledAt
  }
}
```

### Real-Time Subscription

```graphql
subscription OnSlotUpdated {
  slotAvailabilityChanged(venueId: "venue_01HQ3...") {
    slotId
    status
    remainingCapacity
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `4000` |
| `DATABASE_URL` | PostgreSQL connection string | -- |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `JWT_SECRET` | Secret for signing tokens | -- |
| `JWT_EXPIRES_IN` | Token expiry duration | `7d` |
| `AWS_REGION` | AWS region for SNS | `us-east-1` |
| `SNS_TOPIC_ARN` | SNS topic for notifications | -- |
| `RATE_LIMIT_MAX_REQUESTS` | Requests per window | `100` |
| `MAX_BOOKING_ADVANCE_DAYS` | Booking horizon in days | `90` |
| `SLOT_DURATION_MINUTES` | Default slot length | `30` |

## Project Structure

```
src/
  config/        # Database and service configuration
  middleware/     # Auth, rate limiting, error handling
  models/        # TypeORM entities (Booking, Slot, User)
  schema/        # GraphQL type definitions and resolvers
  services/      # Business logic layer
  utils/         # Redis client, logger, helpers
  index.ts       # Application entry point
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Run compiled production build |
| `npm test` | Run test suite with coverage |
| `npm run migrate` | Run pending database migrations |
| `npm run lint` | Lint source files |
| `npm run docker:up` | Start all services via Docker Compose |

## License

MIT

---

<p align="center">Built by <a href="https://github.com/nicolaslumbert">Nicolas Lumbert</a></p>
