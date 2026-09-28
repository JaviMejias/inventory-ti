import { createContext, useContext } from 'react';

export type UserRole = 'JEFE' | 'COORDINADOR' | 'SOPORTE';

export type AuthUser = {
  id: string;
  username: string;
  email: string | null;
  phone: string | null;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  isActivated: boolean;
};

export type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (input: { displayName: string; email: string | null; phone: string | null }) => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return context;
}
