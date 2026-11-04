-- Sanchez Services PHP backend — initial schema (MySQL 8 / MariaDB 10.6+)
-- Instants are stored in UTC as DATETIME(3). Business dates use DATE in BUSINESS_TIMEZONE.
-- Collection tables keep the canonical document in doc_json (same field names as Firestore,
-- timestamps encoded as {"__ts": "ISO-8601Z"}) plus indexed projections maintained by PHP.

CREATE TABLE users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uid VARCHAR(128) NOT NULL,                       -- Firebase UID for imported users; random for new users
  email VARCHAR(254) NOT NULL,
  email_lower VARCHAR(254) NOT NULL,
  email_verified_at DATETIME(3) NULL,
  display_name VARCHAR(200) NULL,
  phone_number VARCHAR(40) NULL,
  password_hash VARCHAR(255) NULL,                 -- password_hash(); NULL = must reset
  legacy_password_hash TEXT NULL,                  -- Firebase scrypt hash (only if import flag is used)
  legacy_password_salt VARCHAR(255) NULL,
  legacy_providers VARCHAR(255) NULL,              -- e.g. "password,google.com"
  role ENUM('client','admin','owner') NOT NULL DEFAULT 'client',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  imported_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_users_uid (uid),
  UNIQUE KEY uq_users_email_lower (email_lower)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE profiles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doc_id VARCHAR(128) NOT NULL,                    -- = users.uid
  email_lower VARCHAR(254) NULL,
  phone_normalized VARCHAR(20) NULL,
  doc_json LONGTEXT NOT NULL,
  created_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_profiles_doc (doc_id),
  KEY ix_profiles_email (email_lower),
  KEY ix_profiles_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE addresses (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doc_id VARCHAR(128) NOT NULL,
  owner_uid VARCHAR(128) NOT NULL,                 -- profiles/{owner_uid}/addresses/{doc_id}
  sort_order INT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  doc_json LONGTEXT NOT NULL,
  created_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_addresses_doc (owner_uid, doc_id),
  KEY ix_addresses_owner (owner_uid, sort_order, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bookings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doc_id VARCHAR(160) NOT NULL,                    -- Firestore doc id; Stripe metadata.bookingId refers to it
  user_uid VARCHAR(128) NULL,
  contact_email_lower VARCHAR(254) NULL,           -- coalesce(contactEmailLower, contact.emailLower, contact.email)
  status VARCHAR(30) NULL,
  start_at DATETIME(3) NULL,
  end_at DATETIME(3) NULL,
  business_date DATE NULL,
  checkout_request_id VARCHAR(96) NULL,
  stripe_session_id VARCHAR(128) NULL,
  deposit_payment_intent_id VARCHAR(64) NULL,
  balance_payment_intent_id VARCHAR(64) NULL,
  total_price DECIMAL(10,2) NULL,
  paid_amount DECIMAL(10,2) NULL,
  doc_json LONGTEXT NOT NULL,
  legacy_raw_json LONGTEXT NULL,                   -- original Firestore document at import time (audit)
  created_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_bookings_doc (doc_id),
  UNIQUE KEY uq_bookings_checkout (user_uid, checkout_request_id),
  KEY ix_bookings_day_status (business_date, status),
  KEY ix_bookings_start (start_at),
  KEY ix_bookings_status_start (status, start_at),
  KEY ix_bookings_status_created (status, created_at),
  KEY ix_bookings_user_start (user_uid, start_at),
  KEY ix_bookings_email_start (contact_email_lower, start_at),
  KEY ix_bookings_session (stripe_session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-day lock row; replaces Firestore bookingReservations/{dateKey}
CREATE TABLE booking_day_locks (
  business_date DATE NOT NULL PRIMARY KEY,
  version INT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE blackouts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doc_id VARCHAR(128) NOT NULL,
  start_at DATETIME(3) NULL,
  end_at DATETIME(3) NULL,
  all_day TINYINT(1) NOT NULL DEFAULT 0,
  doc_json LONGTEXT NOT NULL,
  created_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_blackouts_doc (doc_id),
  KEY ix_blackouts_start (start_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reviews (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doc_id VARCHAR(128) NOT NULL,
  client_uid VARCHAR(128) NULL,
  booking_doc_id VARCHAR(160) NULL,
  status VARCHAR(20) NULL,
  doc_json LONGTEXT NOT NULL,
  created_at DATETIME(3) NULL,
  published_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_reviews_doc (doc_id),
  KEY ix_reviews_status_created (status, created_at),
  KEY ix_reviews_status_published (status, published_at),
  KEY ix_reviews_client (client_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Payment ledger (Stripe + imported). Booking doc fields remain the UI's source of truth.
CREATE TABLE payments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_doc_id VARCHAR(160) NOT NULL,
  kind ENUM('deposit','remaining_due','imported') NOT NULL,
  source ENUM('stripe','stripe_recovery','migrated') NOT NULL,
  amount_net DECIMAL(10,2) NULL,
  amount_fee DECIMAL(10,2) NULL,
  amount_gross DECIMAL(10,2) NULL,
  stripe_payment_intent_id VARCHAR(64) NULL,
  stripe_event_id VARCHAR(64) NULL,
  occurred_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_payments_pi (stripe_payment_intent_id),
  KEY ix_payments_booking (booking_doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stripe_events (
  event_id VARCHAR(64) NOT NULL PRIMARY KEY,
  type VARCHAR(80) NOT NULL,
  status ENUM('processing','processed','ignored','failed') NOT NULL,
  error TEXT NULL,
  payload_json LONGTEXT NULL,
  received_at DATETIME(3) NOT NULL,
  processed_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Replaces the Firestore `mail` collection + Trigger Email extension
CREATE TABLE email_outbox (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doc_id VARCHAR(64) NOT NULL,
  booking_doc_id VARCHAR(160) NULL,
  kind VARCHAR(60) NULL,
  to_json TEXT NOT NULL,
  reply_to VARCHAR(254) NULL,
  subject VARCHAR(500) NOT NULL,
  html MEDIUMTEXT NULL,
  text_body MEDIUMTEXT NULL,
  meta_json TEXT NULL,
  status ENUM('queued','sending','sent','failed') NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  send_after DATETIME(3) NOT NULL,
  sent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_outbox_doc (doc_id),
  KEY ix_outbox_status (status, send_after),
  KEY ix_outbox_booking (booking_doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE password_resets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_reset_token (token_hash),
  KEY ix_reset_user (user_id),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE sessions (
  id VARCHAR(128) NOT NULL PRIMARY KEY,
  data MEDIUMTEXT NOT NULL,
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
  actor_uid VARCHAR(128) NULL,
  action VARCHAR(60) NOT NULL,
  entity VARCHAR(40) NOT NULL,
  entity_id VARCHAR(160) NULL,
  before_json LONGTEXT NULL,
  after_json LONGTEXT NULL,
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
