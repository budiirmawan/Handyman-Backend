/**
 * BE-01B — Credential domain types.
 *
 * These records are internal only. Credential data (including password
 * hashes) must never appear in public API responses or logs.
 */
export type CredentialRecord = {
  id: string;
  userId: string;
  passwordHash: string;
  mustChangePassword: boolean;
  passwordChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateCredentialInput = {
  userId: string;
  password: string;
  mustChangePassword?: boolean;
};

export type UpdatePasswordInput = {
  passwordHash: string;
  passwordChangedAt: Date;
};
