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
export type PendingInvitation = { id: string; email: string; expiresAt: string };
export const invitationEmail = z.string().trim().max(254).pipe(z.email()).transform((email) => email.toLowerCase());
export type InvitationState = 'awaiting_reconciliation' | 'pending' | 'accepted' | 'revoked' | 'expired';
export type InvitationOutcome = { operationKey: string; state: InvitationState };
export type InvitationPilot = { choices: { email: string; prior: InvitationOutcome | null }[]; reserved: number; maximum: number; blocked: boolean };
export type TeamInvitationPage = {
  invitations: PendingInvitation[];
  offset: number;
  limit: number;
  total: number;
  members: number;
  seats: number | null;
  available: number | null;
  pilot?: InvitationPilot;
};
