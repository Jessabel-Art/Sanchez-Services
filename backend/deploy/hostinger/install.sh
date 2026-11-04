#!/usr/bin/env bash
# Installs a Sanchez Services release on Hostinger (run over SSH from the extracted release folder).
#
#   bash install.sh --domain staging.sanchezproservices.com
#   bash install.sh --domain staging.sanchezproservices.com --app-dir ~/ss-app-staging --replace-docroot
#
# What it does (and nothing else):
#   1. Backs up the current app folder and the domain's public_html to ~/ss-backups/<timestamp>/ (tar.gz)
#   2. Installs the PHP app OUTSIDE the web root (default ~/ss-app-<first label of domain>), keeping config/ and storage/
#   3. Replaces the domain's public_html with the built site + /api front controller
#   4. Creates config/config.php from the example if missing (you then edit it), otherwise runs database migrations
# It never touches other domains, never deletes backups, and refuses the production domain unless --production is given.
set -euo pipefail

DOMAIN="" APP_DIR="" DOCROOT="" REPLACE=0 PRODUCTION=0
PHP_BIN="${PHP:-php}"
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --docroot) DOCROOT="$2"; shift 2 ;;
    --replace-docroot) REPLACE=1; shift ;;
    --production) PRODUCTION=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DOMAIN" ] || { echo "Usage: bash install.sh --domain <domain> [--app-dir DIR] [--replace-docroot]" >&2; exit 2; }
case "$DOMAIN" in
  sanchezproservices.com|www.sanchezproservices.com)
    [ "$PRODUCTION" = 1 ] || { echo "Refusing to install on the production domain without --production (cutover needs the owner's approval)." >&2; exit 1; } ;;
esac

SRC="$(cd "$(dirname "$0")" && pwd)"
[ -d "$SRC/ss-app" ] && [ -d "$SRC/public_html" ] || { echo "Run this from the extracted release folder (ss-app/ and public_html/ missing)." >&2; exit 1; }
DOCROOT="${DOCROOT:-$HOME/domains/$DOMAIN/public_html}"
[ -d "$DOCROOT" ] || { echo "Document root not found: $DOCROOT (create the subdomain in hPanel first)." >&2; exit 1; }
LABEL="${DOMAIN%%.*}"
APP_DIR="${APP_DIR:-$HOME/ss-app-$LABEL}"
APP_DIR="$(cd "$(dirname "$APP_DIR")" && pwd)/$(basename "$APP_DIR")"
case "$APP_DIR/" in "$DOCROOT"/*) echo "The app folder must be outside public_html." >&2; exit 1 ;; esac

"$PHP_BIN" -r 'exit(version_compare(PHP_VERSION, "8.2.0", ">=") ? 0 : 1);' || { echo "PHP 8.2+ required for CLI ($("$PHP_BIN" -v | head -1)). Set PHP=/path/to/php8.2" >&2; exit 1; }

TS="$(date +%Y%m%d-%H%M%S)"
BK="$HOME/ss-backups/$TS"
mkdir -p "$BK"; chmod 700 "$HOME/ss-backups" "$BK"
if [ -d "$APP_DIR" ]; then tar -czf "$BK/app.tar.gz" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"; fi
tar -czf "$BK/public_html.tar.gz" -C "$DOCROOT" .
echo "Backups: $BK"

# A docroot that is not ours (no marker) is only replaced with --replace-docroot.
if [ ! -f "$DOCROOT/.ss-release" ] && [ -n "$(ls -A "$DOCROOT" 2>/dev/null | grep -v '^\.well-known$' || true)" ] && [ "$REPLACE" != 1 ]; then
  echo "$DOCROOT already has files that are not from a Sanchez Services release:" >&2
  ls -A "$DOCROOT" | head -20 >&2
  echo "They are backed up in $BK/public_html.tar.gz. Re-run with --replace-docroot to replace them." >&2
  exit 1
fi

# 1) App outside the web root, keeping config and storage
NEW="$APP_DIR.new-$TS"
cp -R "$SRC/ss-app" "$NEW"
if [ -d "$APP_DIR/config" ]; then cp -p "$APP_DIR"/config/config.php "$NEW/config/" 2>/dev/null || true; fi
if [ -d "$APP_DIR/storage" ]; then rm -rf "$NEW/storage"; cp -Rp "$APP_DIR/storage" "$NEW/storage"; fi
mkdir -p "$NEW/storage/logs"
if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$BK/app-previous"; fi
mv "$NEW" "$APP_DIR"
chmod 750 "$APP_DIR"

# 2) Web root (keep .well-known for SSL validation)
find "$DOCROOT" -mindepth 1 -maxdepth 1 ! -name .well-known -exec rm -rf {} +
cp -R "$SRC/public_html/." "$DOCROOT/"
printf "<?php\nreturn %s;\n" "'$APP_DIR'" > "$DOCROOT/api/app-root.php"
echo "$TS" > "$DOCROOT/.ss-release"

# 3) Config + migrations
if [ ! -f "$APP_DIR/config/config.php" ]; then
  cp "$APP_DIR/config/config.example.php" "$APP_DIR/config/config.php"
  chmod 640 "$APP_DIR/config/config.php"
  echo
  echo "NEXT: edit the config, then run this installer again:"
  echo "  nano $APP_DIR/config/config.php"
  exit 0
fi
chmod 640 "$APP_DIR/config/config.php"
"$PHP_BIN" "$APP_DIR/bin/migrate.php"
echo
echo "Installed release $TS for $DOMAIN"
echo "  App:      $APP_DIR"
echo "  Web root: $DOCROOT"
echo "  Cron (hPanel → Advanced → Cron Jobs, every 5 minutes):"
echo "    $(command -v "$PHP_BIN") $APP_DIR/bin/job.php due"
echo "  Check:    $PHP_BIN $APP_DIR/bin/staging-check.php"
echo "  Roll back: restore $BK/public_html.tar.gz into $DOCROOT and move $BK/app-previous back to $APP_DIR"
