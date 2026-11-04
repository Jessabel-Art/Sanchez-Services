-- Sanchez Services — relational schema (MySQL 8 / MariaDB 10.6+, InnoDB, utf8mb4)
-- Instants are UTC DATETIME(3). business_date / blackout dates are calendar dates in BUSINESS_TIMEZONE.
-- Money is DECIMAL(10,2) USD.

CREATE TABLE users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  legacy_firebase_uid VARCHAR(128) NULL,
  email VARCHAR(254) NOT NULL,
  email_lower VARCHAR(254) NOT NULL,
  email_verified_at DATETIME(3) NULL,
  name VARCHAR(200) NULL,
  phone VARCHAR(40) NULL,
  password_hash VARCHAR(255) NULL,             -- NULL = must set a password via reset
  legacy_password_hash TEXT NULL,              -- Firebase scrypt (only with importer opt-in flag)
  legacy_password_salt VARCHAR(255) NULL,
  legacy_providers VARCHAR(255) NULL,
  role ENUM('client','admin','owner') NOT NULL DEFAULT 'client',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  imported_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_users_email (email_lower),
  UNIQUE KEY uq_users_legacy_uid (legacy_firebase_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE client_profiles (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  phone_normalized VARCHAR(20) NULL,
  preferred_contact_method ENUM('email','phone','text') NULL,
  fragrance_preference VARCHAR(40) NULL,
  focus_preference VARCHAR(40) NULL,
  pet_preference VARCHAR(40) NULL,
  preferences_notes TEXT NULL,
  internal_notes TEXT NULL,                    -- admin-only
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY ix_profiles_phone (phone_normalized),
  CONSTRAINT fk_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE addresses (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  label VARCHAR(60) NULL,
  line1 VARCHAR(200) NOT NULL,
  line2 VARCHAR(200) NULL,
  city VARCHAR(100) NOT NULL,
  state CHAR(2) NOT NULL,
  zip VARCHAR(10) NOT NULL,
  access_instructions TEXT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  legacy_ref VARCHAR(160) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY ix_addresses_user (user_id, sort_order),
  UNIQUE KEY uq_addresses_legacy (user_id, legacy_ref),
  CONSTRAINT fk_addresses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bookings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ref VARCHAR(160) NOT NULL,                   -- public id (Firestore id for imported rows; Stripe metadata)
  invoice_number VARCHAR(30) NULL,
  user_id BIGINT UNSIGNED NULL,
  status ENUM('pending_payment','pending','confirmed','completed','cancelled','declined','expired') NOT NULL,
  hold_expires_at DATETIME(3) NULL,            -- pending_payment slot hold
  contact_name VARCHAR(200) NOT NULL,
  contact_email VARCHAR(254) NOT NULL,
  contact_email_lower VARCHAR(254) NOT NULL,
  contact_phone VARCHAR(40) NULL,
  address_line1 VARCHAR(200) NOT NULL,
  address_line2 VARCHAR(200) NULL,
  address_city VARCHAR(100) NOT NULL,
  address_state CHAR(2) NOT NULL,
  address_zip VARCHAR(10) NOT NULL,
  service_slug VARCHAR(50) NOT NULL,
  service_name VARCHAR(100) NOT NULL,
  property_type VARCHAR(30) NULL,
  bedrooms DECIMAL(4,1) NULL,
  bathrooms DECIMAL(4,1) NULL,
  sqft INT NULL,
  property_condition ENUM('light','standard','heavy') NULL,
  pets TINYINT(1) NOT NULL DEFAULT 0,
  addons_json TEXT NULL,
  frequency VARCHAR(20) NOT NULL DEFAULT 'one-time',
  promo_code VARCHAR(30) NULL,
  access_notes TEXT NULL,
  cleaner_notes TEXT NULL,
  admin_notes TEXT NULL,
  start_at DATETIME(3) NOT NULL,
  end_at DATETIME(3) NOT NULL,
  business_date DATE NOT NULL,
  duration_minutes INT NOT NULL,
  pricing_json TEXT NULL,                      -- line-item breakdown used for invoices
  total_price DECIMAL(10,2) NOT NULL,
  deposit_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  amount_paid DECIMAL(10,2) NOT NULL DEFAULT 0,      -- maintained from payments ledger (net, minus refunds)
  amount_refunded DECIMAL(10,2) NOT NULL DEFAULT 0,
  payment_status ENUM('not_required','unpaid','deposit_paid','paid','refunded') NOT NULL DEFAULT 'unpaid',
  stripe_customer_id VARCHAR(64) NULL,
  checkout_request_id VARCHAR(96) NULL,
  created_via ENUM('online','admin','import') NOT NULL,
  created_by_user_id BIGINT UNSIGNED NULL,
  cancellation_reason VARCHAR(500) NULL,
  cancelled_by ENUM('client','admin','system') NULL,
  confirmed_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  expired_at DATETIME(3) NULL,
  reminder48_sent_at DATETIME(3) NULL,
  reminder24_sent_at DATETIME(3) NULL,
  needs_attention VARCHAR(500) NULL,           -- e.g. payment received after hold expired and slot taken
  legacy_json LONGTEXT NULL,                   -- original Firestore document (imported rows only)
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_bookings_ref (ref),
  UNIQUE KEY uq_bookings_invoice (invoice_number),
  UNIQUE KEY uq_bookings_request (user_id, checkout_request_id),
  KEY ix_bookings_day (business_date, status),
  KEY ix_bookings_start (start_at),
  KEY ix_bookings_user (user_id, start_at),
  KEY ix_bookings_email (contact_email_lower, start_at),
  KEY ix_bookings_status (status, start_at),
  CONSTRAINT fk_bookings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lock row per business date: every create/reschedule serializes on it (FOR UPDATE).
CREATE TABLE booking_day_locks (
  business_date DATE NOT NULL PRIMARY KEY,
  version INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE booking_history (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id BIGINT UNSIGNED NOT NULL,
  event VARCHAR(40) NOT NULL,                  -- created, confirmed, rescheduled, cancelled, payment, refund, note...
  actor_user_id BIGINT UNSIGNED NULL,
  actor_role ENUM('client','admin','system') NOT NULL,
  details_json TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY ix_history_booking (booking_id, id),
  CONSTRAINT fk_history_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE checkout_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id BIGINT UNSIGNED NOT NULL,
  stripe_session_id VARCHAR(128) NOT NULL,
  purpose ENUM('deposit','balance') NOT NULL,
  amount_net DECIMAL(10,2) NOT NULL,
  amount_fee DECIMAL(10,2) NOT NULL,
  amount_gross DECIMAL(10,2) NOT NULL,
  url TEXT NULL,
  status ENUM('open','complete','expired') NOT NULL DEFAULT 'open',
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_checkout_session (stripe_session_id),
  KEY ix_checkout_booking (booking_id, status),
  CONSTRAINT fk_checkout_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Payment ledger: the single source of truth for money.
CREATE TABLE payments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id BIGINT UNSIGNED NOT NULL,
  type ENUM('payment','refund') NOT NULL DEFAULT 'payment',
  purpose ENUM('deposit','balance','other') NOT NULL DEFAULT 'other',
  method ENUM('card','cash','zelle','venmo','cash_app','check','other') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,               -- credited to the booking (positive; refunds positive with type=refund)
  fee DECIMAL(10,2) NOT NULL DEFAULT 0,        -- card processing fee paid by the customer (not credited)
  gross DECIMAL(10,2) NOT NULL DEFAULT 0,      -- amount the customer was charged
  status ENUM('succeeded','voided') NOT NULL DEFAULT 'succeeded',
  source ENUM('stripe','admin','import') NOT NULL,
  stripe_payment_intent_id VARCHAR(64) NULL,
  stripe_refund_id VARCHAR(64) NULL,
  checkout_session_id BIGINT UNSIGNED NULL,
  refund_of_payment_id BIGINT UNSIGNED NULL,
  note VARCHAR(500) NULL,
  recorded_by_user_id BIGINT UNSIGNED NULL,
  paid_at DATETIME(3) NOT NULL,
  voided_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_payments_pi (stripe_payment_intent_id),
  UNIQUE KEY uq_payments_refund (stripe_refund_id),
  KEY ix_payments_booking (booking_id),
  KEY ix_payments_paid (paid_at),
  CONSTRAINT fk_payments_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stripe_events (
  event_id VARCHAR(64) NOT NULL PRIMARY KEY,
  type VARCHAR(80) NOT NULL,
  status ENUM('processing','processed','ignored','failed') NOT NULL,
  error TEXT NULL,
  received_at DATETIME(3) NOT NULL,
  processed_at DATETIME(3) NULL
) ENGINE=InnoDB;

CREATE TABLE blackouts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  all_day TINYINT(1) NOT NULL,
  start_date DATE NULL,                        -- all-day: inclusive
  end_date_exclusive DATE NULL,                -- all-day: exclusive
  start_at DATETIME(3) NULL,                   -- timed (UTC)
  end_at DATETIME(3) NULL,
  reason VARCHAR(300) NULL,
  created_by_user_id BIGINT UNSIGNED NULL,
  legacy_ref VARCHAR(160) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY ix_blackouts_dates (start_date, end_date_exclusive),
  KEY ix_blackouts_times (start_at, end_at),
  UNIQUE KEY uq_blackouts_legacy (legacy_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reviews (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id BIGINT UNSIGNED NULL,
  user_id BIGINT UNSIGNED NULL,
  rating TINYINT NOT NULL,
  comment TEXT NOT NULL,
  display_mode ENUM('anonymous','initials','firstInitialLastName') NOT NULL DEFAULT 'initials',
  display_name VARCHAR(100) NOT NULL,
  service_name VARCHAR(100) NULL,
  status ENUM('pending','approved','declined') NOT NULL DEFAULT 'pending',
  moderated_by_user_id BIGINT UNSIGNED NULL,
  legacy_ref VARCHAR(160) NULL,
  created_at DATETIME(3) NOT NULL,
  published_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_reviews_booking (booking_id),
  UNIQUE KEY uq_reviews_legacy (legacy_ref),
  KEY ix_reviews_status (status, created_at),
  CONSTRAINT fk_reviews_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL,
  CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE email_outbox (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  dedupe_key VARCHAR(190) NOT NULL,
  booking_id BIGINT UNSIGNED NULL,
  kind VARCHAR(60) NOT NULL,
  to_email VARCHAR(254) NOT NULL,
  reply_to VARCHAR(254) NULL,
  subject VARCHAR(500) NOT NULL,
  html MEDIUMTEXT NOT NULL,
  text_body MEDIUMTEXT NOT NULL,
  status ENUM('queued','sending','sent','failed') NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  send_after DATETIME(3) NOT NULL,
  sent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_outbox_dedupe (dedupe_key),
  KEY ix_outbox_status (status, send_after),
  KEY ix_outbox_booking (booking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE auth_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  purpose ENUM('password_reset','email_verify') NOT NULL,
  token_hash CHAR(64) NOT NULL,
  email VARCHAR(254) NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_tokens_hash (token_hash),
  KEY ix_tokens_user (user_id, purpose),
  CONSTRAINT fk_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE sessions (
  id CHAR(64) NOT NULL PRIMARY KEY,
  data TEXT NOT NULL,
  last_activity INT UNSIGNED NOT NULL,
  KEY ix_sessions_activity (last_activity)
) ENGINE=InnoDB;

CREATE TABLE rate_limits (
  bucket VARCHAR(190) NOT NULL PRIMARY KEY,
  hits INT NOT NULL,
  window_start DATETIME(3) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_user_id BIGINT UNSIGNED NULL,
  action VARCHAR(60) NOT NULL,
  entity VARCHAR(40) NOT NULL,
  entity_id VARCHAR(160) NULL,
  details_json TEXT NULL,
  ip VARCHAR(45) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY ix_audit_entity (entity, entity_id),
  KEY ix_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE job_runs (
  job VARCHAR(60) NOT NULL PRIMARY KEY,
  lock_token VARCHAR(64) NULL,
  last_started_at DATETIME(3) NULL,
  last_finished_at DATETIME(3) NULL,
  last_status VARCHAR(20) NULL,
  last_result TEXT NULL
) ENGINE=InnoDB;

CREATE TABLE schema_migrations (
  version VARCHAR(100) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;
