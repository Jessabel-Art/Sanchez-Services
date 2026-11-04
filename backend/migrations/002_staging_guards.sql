-- Staging safety: messages blocked by the recipient allowlist are kept (status 'suppressed') instead of being sent.
ALTER TABLE email_outbox MODIFY status ENUM('queued','sending','sent','failed','suppressed') NOT NULL DEFAULT 'queued';

-- Optional Google sign-in (off unless auth.google is configured): stable Google account id.
ALTER TABLE users ADD COLUMN google_sub VARCHAR(64) NULL AFTER legacy_providers, ADD UNIQUE KEY uq_users_google_sub (google_sub);
