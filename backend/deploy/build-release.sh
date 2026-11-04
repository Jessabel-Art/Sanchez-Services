#!/usr/bin/env bash
# Builds a deployable PHP-backend release WITHOUT deploying it.
#
#   backend/deploy/build-release.sh <app-root-on-server> [out-dir]
#   e.g. backend/deploy/build-release.sh /home/u123456789/ss-app release
#
# Produces:
#   <out>/public_html/   -> upload to the domain's document root (built SPA + /api front controller)
#   <out>/ss-app/        -> upload OUTSIDE the document root (PHP code, vendor/, migrations, bin/)
# The real config file is NOT included; create it on the server (see config/config.example.php).
set -euo pipefail
APP_ROOT="${1:?usage: build-release.sh <absolute app root on server> [out-dir]}"
OUT="${2:-release}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf "$OUT" && mkdir -p "$OUT/public_html/api" "$OUT/ss-app"

# Frontend. Uses a separate outDir so the tracked dist/ is never touched.
( cd "$REPO" && npx vite build --outDir "$OUT/public_html" --emptyOutDir )
cp "$REPO/backend/deploy/hostinger/root.htaccess" "$OUT/public_html/.htaccess"
mkdir -p "$OUT/public_html/api"
cp "$REPO/backend/public/api/index.php" "$REPO/backend/public/api/.htaccess" "$OUT/public_html/api/"
printf "<?php\nreturn %s;\n" "'$APP_ROOT'" > "$OUT/public_html/api/app-root.php"

# Backend code with production dependencies only.
cp -R "$REPO/backend/src" "$REPO/backend/bin" "$REPO/backend/migrations" "$REPO/backend/bootstrap.php" "$REPO/backend/composer.json" "$REPO/backend/composer.lock" "$OUT/ss-app/"
mkdir -p "$OUT/ss-app/config" "$OUT/ss-app/storage/logs"
cp "$REPO/backend/config/config.example.php" "$OUT/ss-app/config/"
( cd "$OUT/ss-app" && composer install --no-dev --no-interaction --optimize-autoloader --quiet )
rm -f "$OUT/ss-app/composer.json" "$OUT/ss-app/composer.lock"
printf "Deny from all\nRequire all denied\n" > "$OUT/ss-app/.htaccess"
echo "Release ready in $OUT (not deployed)."
