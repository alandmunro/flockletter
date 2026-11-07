import { z } from 'zod';
export const teamRole = z.enum(['viewer', 'editor']);
export type TeamRole = z.infer<typeof teamRole>;
export const clerkUserId = z.string().regex(/^user_[A-Za-z0-9_-]{1,120}$/);
export type DirectoryMember = {
  userId: string;
  name: string;
  membership: 'owner' | 'member';
  permission: TeamRole | null;
  brandIds: string[];
};
export type TeamPage = {
  members: DirectoryMember[];
  total: number;
  offset: number;
  limit: number;
  seats: number | null;
  overLimit: boolean;
  source: 'clerk';
};
