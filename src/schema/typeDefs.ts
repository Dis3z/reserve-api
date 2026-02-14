import { gql } from 'graphql-tag';

export const typeDefs = gql`
  # ────────────────────────────────────────
  # Scalars
  # ────────────────────────────────────────
  scalar DateTime
  scalar Date

  # ────────────────────────────────────────
  # Enums
  # ────────────────────────────────────────
  enum BookingStatus {
    PENDING
    CONFIRMED
    CANCELLED
    COMPLETED
    NO_SHOW
  }

  enum SlotStatus {
    AVAILABLE
    HELD
    BOOKED
    BLOCKED
  }

  enum UserRole {
    GUEST
    MEMBER
    ADMIN
  }

  enum SortDirection {
    ASC
    DESC
  }

  # ────────────────────────────────────────
  # Types
  # ────────────────────────────────────────
  type User {
    id: ID!
    name: String!
    email: String!
    phone: String
    role: UserRole!
    isActive: Boolean!
    lastLoginAt: DateTime
    bookings(limit: Int = 10, offset: Int = 0): BookingConnection!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type Venue {
    id: ID!
    name: String!
    address: String!
    description: String
    timezone: String!
    capacity: Int!
    imageUrl: String
    isActive: Boolean!
    slots(date: Date!, status: SlotStatus): [Slot!]!
    createdAt: DateTime!
  }

  type Slot {
    id: ID!
    venueId: ID!
    date: Date!
    startTime: DateTime!
    endTime: DateTime!
    capacity: Int!
    remainingCapacity: Int!
    status: SlotStatus!
    durationMinutes: Int!
    price: Float
    currency: String!
    bookings: [Booking!]!
  }

  type Booking {
    id: ID!
    user: User!
    slot: Slot!
    venue: Venue!
    confirmationCode: String!
    status: BookingStatus!
    guestCount: Int!
    notes: String
    bookingDate: Date!
    totalPrice: Float
    cancelledAt: DateTime
    cancellationReason: String
    confirmedAt: DateTime
    completedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  # ────────────────────────────────────────
  # Pagination
  # ────────────────────────────────────────
  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    totalCount: Int!
  }

  type BookingConnection {
    edges: [Booking!]!
    pageInfo: PageInfo!
  }

  type SlotConnection {
    edges: [Slot!]!
    pageInfo: PageInfo!
  }

  # ────────────────────────────────────────
  # Auth
  # ────────────────────────────────────────
  type AuthPayload {
    accessToken: String!
    refreshToken: String!
    user: User!
  }

  type TokenRefreshPayload {
    accessToken: String!
    refreshToken: String!
  }

  # ────────────────────────────────────────
  # Queue Stats (Admin)
  # ────────────────────────────────────────
  type QueueStats {
    waiting: Int!
    active: Int!
    completed: Int!
    failed: Int!
    delayed: Int!
  }

  # ────────────────────────────────────────
  # Inputs
  # ────────────────────────────────────────
  input RegisterInput {
    name: String!
    email: String!
    password: String!
    phone: String
  }

  input LoginInput {
    email: String!
    password: String!
  }

  input CreateBookingInput {
    slotId: ID!
    venueId: ID!
    guestCount: Int! = 1
    notes: String
  }

  input CancelBookingInput {
    bookingId: ID!
    reason: String
  }

  input UpdateProfileInput {
    name: String
    phone: String
  }

  input SlotFilterInput {
    venueId: ID!
    date: Date!
    minCapacity: Int
    status: SlotStatus
  }

  input BookingFilterInput {
    status: BookingStatus
    dateFrom: Date
    dateTo: Date
    venueId: ID
  }

  # ────────────────────────────────────────
  # Queries
  # ────────────────────────────────────────
  type Query {
    # Auth
    me: User!

    # Venues
    venue(id: ID!): Venue
    venues(limit: Int = 20, offset: Int = 0): [Venue!]!

    # Slots
    availableSlots(venueId: ID!, date: Date!): [Slot!]!
    slot(id: ID!): Slot

    # Bookings
    booking(id: ID!): Booking
    bookingByConfirmationCode(code: String!): Booking
    myBookings(
      filter: BookingFilterInput
      limit: Int = 20
      offset: Int = 0
    ): BookingConnection!

    # Admin
    queueStats: QueueStats!
  }

  # ────────────────────────────────────────
  # Mutations
  # ────────────────────────────────────────
  type Mutation {
    # Auth
    register(input: RegisterInput!): AuthPayload!
    login(input: LoginInput!): AuthPayload!
    refreshToken(refreshToken: String!): TokenRefreshPayload!
    logout: Boolean!
    updateProfile(input: UpdateProfileInput!): User!

    # Bookings
    createBooking(input: CreateBookingInput!): Booking!
    cancelBooking(input: CancelBookingInput!): Booking!

    # Admin
    blockSlot(slotId: ID!, reason: String): Slot!
    unblockSlot(slotId: ID!): Slot!
  }

  # ────────────────────────────────────────
  # Subscriptions
  # ────────────────────────────────────────
  type SlotUpdate {
    slotId: ID!
    venueId: ID!
    status: SlotStatus!
    remainingCapacity: Int!
  }

  type BookingUpdate {
    bookingId: ID!
    status: BookingStatus!
    confirmationCode: String!
  }

  type Subscription {
    slotAvailabilityChanged(venueId: ID!): SlotUpdate!
    bookingStatusChanged(userId: ID!): BookingUpdate!
  }
`;

export default typeDefs;
