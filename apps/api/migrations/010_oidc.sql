-- OIDC identities. A user can have either dsm_uid or oidc_sub (or both, future).
-- Drop the UNIQUE on dsm_uid so SSO-only users (no DSM) don't collide.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS oidc_sub TEXT,
  ADD COLUMN IF NOT EXISTS oidc_issuer TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_sub_idx ON users(oidc_issuer, oidc_sub) WHERE oidc_sub IS NOT NULL;
