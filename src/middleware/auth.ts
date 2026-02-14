import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';
import { AppDataSource } from '../config/database';
import { User, UserRole } from '../models/User';

export interface AuthPayload {
  userId: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}

export interface AuthenticatedContext {
  user: AuthPayload | null;
  isAuthenticated: boolean;
}

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

export function generateTokens(user: User): {
  accessToken: string;
  refreshToken: string;
} {
  const payload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
    issuer: 'reserve-api',
    audience: 'reserve-client',
  });

  const refreshToken = jwt.sign(
    { userId: user.id, tokenType: 'refresh' },
    JWT_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN, issuer: 'reserve-api' }
  );

  return { accessToken, refreshToken };
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET, {
    issuer: 'reserve-api',
    audience: 'reserve-client',
  }) as AuthPayload;
}

export function extractTokenFromHeader(authHeader?: string): string | null {
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  return parts[1];
}

export async function getAuthContext(req: Request): Promise<AuthenticatedContext> {
  const token = extractTokenFromHeader(req.headers.authorization);

  if (!token) {
    return { user: null, isAuthenticated: false };
  }

  try {
    const payload = verifyToken(token);

    return {
      user: payload,
      isAuthenticated: true,
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logger.debug('Token expired', { error: error.message });
    } else if (error instanceof jwt.JsonWebTokenError) {
      logger.warn('Invalid token presented', { error: error.message });
    }

    return { user: null, isAuthenticated: false };
  }
}

export function requireAuth(
  context: AuthenticatedContext
): asserts context is AuthenticatedContext & { user: AuthPayload; isAuthenticated: true } {
  if (!context.isAuthenticated || !context.user) {
    throw new Error('Authentication required');
  }
}

export function requireRole(
  context: AuthenticatedContext,
  ...roles: UserRole[]
): void {
  requireAuth(context);

  if (!roles.includes(context.user.role)) {
    throw new Error(
      `Insufficient permissions. Required: ${roles.join(' or ')}`
    );
  }
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET, {
      issuer: 'reserve-api',
    }) as { userId: string; tokenType: string };

    if (decoded.tokenType !== 'refresh') {
      return null;
    }

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: decoded.userId, isActive: true },
    });

    if (!user || user.refreshToken !== refreshToken) {
      logger.warn('Refresh token reuse detected or user not found', {
        userId: decoded.userId,
      });
      return null;
    }

    // Rotate refresh token
    const tokens = generateTokens(user);
    user.refreshToken = tokens.refreshToken;
    await userRepo.save(user);

    return tokens;
  } catch {
    return null;
  }
}
