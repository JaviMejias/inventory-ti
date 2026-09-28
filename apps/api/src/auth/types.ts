import type { Role } from '@prisma/client';

export type PublicUser = {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  phone: string | null;
  role: Role;
  isActive: boolean;
  isActivated: boolean;
};

export type AuthContext = {
  user: PublicUser;
  sessionId: string;
  sessionToken: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
