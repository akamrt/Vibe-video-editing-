#!/bin/bash

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Move to the folder this script lives in (works from Finder double-click too)
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Self-heal: make sure launcher scripts are executable on this machine
# (GitHub ZIP downloads strip the +x bit, which makes Finder open them in TextEdit)
chmod +x "START.sh" "INSTALL.sh" "Start Vibe.command" 2>/dev/null || true

echo ""
echo -e "${BLUE}${BOLD}"
echo "  ==================================================="
echo "       VibeCut AI - Starting Application..."
echo "  ==================================================="
echo -e "${NC}"
echo ""

# ------------------------------------------------------------------
# Kill any previous instance still running on our ports
# ------------------------------------------------------------------
free_port() {
    local PORT=$1
    local PIDS
    PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo -e "${YELLOW}Closing previous instance on port $PORT (PID: $PIDS)...${NC}"
        kill $PIDS 2>/dev/null
        sleep 1
        # Force-kill anything still holding the port
        PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null)
        if [ -n "$PIDS" ]; then
            kill -9 $PIDS 2>/dev/null
            sleep 1
        fi
    fi
}

free_port 3000   # Vite frontend
free_port 3001   # Express backend
# Clean up orphaned trackers from a previous run
pkill -f vibecut-tracker 2>/dev/null || true

# ------------------------------------------------------------------
# First-run install
# ------------------------------------------------------------------
if [ ! -d "node_modules" ]; then
    echo "First time running? Setting things up for you..."
    echo ""
    bash INSTALL.sh
    echo ""
fi

# ------------------------------------------------------------------
# Auto-update from GitHub (skip silently if no network/no git)
# ------------------------------------------------------------------
if command -v git &> /dev/null && git rev-parse --git-dir &> /dev/null; then
    echo -e "${YELLOW}Checking for updates...${NC}"
    OLD_PKG_HASH=$(md5sum package.json 2>/dev/null || md5 -q package.json 2>/dev/null || echo "")

    if git pull --ff-only 2>&1; then
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

# ------------------------------------------------------------------
# Cleanup on exit
# ------------------------------------------------------------------
cleanup() {
    echo ""
    echo "Shutting down VibeCut AI..."
    [ -n "$BACKEND_PID" ] && kill $BACKEND_PID 2>/dev/null
    [ -n "$VITE_PID" ]    && kill $VITE_PID 2>/dev/null
    pkill -f vibecut-tracker 2>/dev/null || true
    # Make sure the ports are freed even if the children spawned grandchildren
    free_port 3000
    free_port 3001
    echo "Goodbye!"
    exit 0
}
trap cleanup INT TERM EXIT

# ------------------------------------------------------------------
# Start backend
# ------------------------------------------------------------------
echo "Starting backend server..."
node server/server.cjs &
BACKEND_PID=$!

# ------------------------------------------------------------------
# Start frontend (Vite) in background so we can wait for it to be ready
# ------------------------------------------------------------------
echo "Starting frontend..."
npx vite &
VITE_PID=$!

# ------------------------------------------------------------------
# Wait until Vite actually serves the page before opening the browser
# ------------------------------------------------------------------
echo -n "Waiting for app to be ready"
READY=false
for i in $(seq 1 60); do
    if curl -sf -o /dev/null --max-time 1 http://localhost:3000 2>/dev/null; then
        READY=true
        break
    fi
    echo -n "."
    sleep 1
done
echo ""

if [ "$READY" = true ]; then
    echo -e "${GREEN}${BOLD}"
    echo "  ==================================================="
    echo ""
    echo "   Your app is ready! Opening browser..."
    echo ""
    echo "   If it doesn't open, go to:"
    echo "   http://localhost:3000"
    echo ""
    echo "   TO STOP: Press Ctrl+C, or just close this window"
    echo ""
    echo "  ==================================================="
    echo -e "${NC}"

    if command -v open &> /dev/null; then
        open http://localhost:3000
    elif command -v xdg-open &> /dev/null; then
        xdg-open http://localhost:3000
    fi
else
    echo -e "${RED}App did not start within 60 seconds. Check the messages above for errors.${NC}"
fi

# Keep script alive while Vite runs; cleanup trap handles shutdown
wait $VITE_PID
