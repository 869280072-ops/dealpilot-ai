import { compare, hash } from 'bcryptjs';

// Shared by Next.js authentication and standalone development tools.
// Keep bcrypt cost 10 and existing hash verification behavior unchanged.
export const hashPassword = (password: string) => hash(password, 10);
export const comparePasswords = (plain: string, hashed: string) => compare(plain, hashed);
