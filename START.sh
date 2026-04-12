#!/bin/bash

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BLUE}${BOLD}"
echo "  ==================================================="
echo "       VibeCut AI - Starting Application..."
echo "  ==================================================="
echo -e "${NC}"
echo ""

# Check if setup has been run
if [ ! -d "node_modules" ]; then
    echo "First time running? Let me set things up for you..."
    echo ""
    bash INSTALL.sh
    echo ""
fi

# Auto-update: pull latest from GitHub and reinstall if needed
if command -v git &> /dev/null && git rev-parse --git-dir &> /dev/null; then
    echo -e "${YELLOW}Checking for updates...${NC}"
    # Save current package.json hash to detect dependency changes
    OLD_PKG_HASH=$(md5sum package.json 2>/dev/null || md5 -q package.json 2>/dev/null || echo "")

    git pull --ff-only 2>&1
    PULL_EXIT=$?

    if [ $PULL_EXIT -eq 0 ]; then
        NEW_PKG_HASH=$(md5sum package.json 2>/dev/null || md5 -q package.json 2>/dev/null || echo "")
        if [ "$OLD_PKG_HASH" != "$NEW_PKG_HASH" ]; then
            echo -e "${YELLOW}Dependencies changed — running npm install...${NC}"
            npm install
        fi
        echo -e "${GREEN}Up to date!${NC}"
    else
        echo -e "${YELLOW}Could not auto-update (you may have local changes). Continuing with current version.${NC}"
    fi
    echo ""
fi

# Cleanup function
cleanup() {
    echo ""
    echo "Shutting down VibeCut AI..."
    if [ -n "$BACKEND_PID" ]; then
        kill $BACKEND_PID 2>/dev/null
        wait $BACKEND_PID 2>/dev/null
    fi
    # Kill any orphaned tracker processes
    pkill -f vibecut-tracker 2>/dev/null || true
    echo "Goodbye!"
    exit 0
}
trap cleanup INT TERM

# Start backend
echo "Starting backend server..."
node server/server.cjs &
BACKEND_PID=$!
sleep 2

echo ""
echo -e "${GREEN}${BOLD}"
echo "  ==================================================="
echo ""
echo "   Your app is starting! A browser window will open."
echo ""
echo "   If it doesn't open, go to:"
echo "   http://localhost:3000"
echo ""
echo "   TO STOP: Press Ctrl+C"
echo ""
echo "  ==================================================="
echo -e "${NC}"
echo ""

# Open browser
if command -v open &> /dev/null; then
    open http://localhost:3000
elif command -v xdg-open &> /dev/null; then
    xdg-open http://localhost:3000
fi

# Run frontend (blocks)
npx vite

cleanup
