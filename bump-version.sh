#!/bin/bash
# Usage: ./bump-version.sh [major|minor|patch]
# Default: patch

set -e

TYPE=${1:-patch}
DIR="$(cd "$(dirname "$0")" && pwd)"

# Read current version from plugin.json
CURRENT=$(grep '"version"' "$DIR/.claude-plugin/plugin.json" | head -1 | sed 's/.*"version": *"//;s/".*//')

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: $0 [major|minor|patch]"; exit 1 ;;
esac

NEW="${MAJOR}.${MINOR}.${PATCH}"

# Update all version files
sed -i '' "s/\"version\": *\"$CURRENT\"/\"version\": \"$NEW\"/g" \
  "$DIR/.claude-plugin/plugin.json" \
  "$DIR/.claude-plugin/marketplace.json" \
  "$DIR/skills/chrome-cdp/package.json"

echo "$CURRENT -> $NEW"
