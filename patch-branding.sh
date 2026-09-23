#!/bin/bash
# Patch LibreChat branding to PindyChat in Docker container JS bundles
# Run this after container restarts or updates to reapply branding

set -e

echo "Patching JS bundles in PindyChat-API container..."

# Replace LibreChat with PindyChat in all JS files
docker compose -f deploy-compose.yml exec api sh -c "find /app/client/dist/assets -name '*.js' -exec sed -i 's/LibreChat/PindyChat/g' {} \;"

# Replace librechat.ai with chat.pindyyogurt.store
docker compose -f deploy-compose.yml exec api sh -c "find /app/client/dist/assets -name '*.js' -exec sed -i 's/librechat\.ai/chat.pindyyogurt.store/g' {} \;"

echo "✓ Branding patched successfully"
echo "Note: Users may need to hard-refresh their browser (Ctrl+F5) to clear cached assets"
