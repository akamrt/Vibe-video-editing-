#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Minimum Node.js version required (Vite 6 needs 20.18+ or 22.12+)
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=18

echo ""
echo -e "${BLUE}${BOLD}"
echo "  ==================================================="
echo "       VibeCut AI - One-Click Installer"
echo "  ==================================================="
echo -e "${NC}"
echo ""

# ====================================================
# STEP 1: Check for Node.js
# ====================================================
echo -e "${BOLD}[Step 1/4] Checking for Node.js...${NC}"
echo ""

install_node() {
    # macOS
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &> /dev/null; then
            echo "Installing/upgrading Node.js via Homebrew..."
            brew install node 2>/dev/null || brew upgrade node 2>/dev/null || true
        else
            echo -e "${YELLOW}==================================================="
            echo "  Please install Node.js (version $MIN_NODE_MAJOR.$MIN_NODE_MINOR or higher):"
            echo ""
            echo "  Option A (recommended): Install Homebrew first"
            echo "    1. Paste this in Terminal:"
            echo '       /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
            echo "    2. Then run: brew install node"
            echo "    3. Then run this script again"
            echo ""
            echo "  Option B: Download from https://nodejs.org"
            echo "    1. Click the LTS Download button"
            echo "    2. Open the downloaded .pkg file"
            echo "    3. Follow the installer steps"
            echo -e "    4. Run this script again${NC}"
            echo "==================================================="
            exit 1
        fi
    else
        # Linux
        echo "Installing Node.js..."
        if command -v apt-get &> /dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
            sudo apt-get install -y nodejs
        elif command -v dnf &> /dev/null; then
            curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
            sudo dnf install -y nodejs
        else
            echo -e "${RED}Please install Node.js (version $MIN_NODE_MAJOR.$MIN_NODE_MINOR+) from https://nodejs.org${NC}"
            exit 1
        fi
    fi
}

if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Node.js is NOT installed on this computer.${NC}"
    echo "Node.js is required to run VibeCut AI."
    echo ""
    install_node
    echo ""
fi

# Verify Node.js version meets minimum requirements
NODE_VER=$(node --version)
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f2)

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
    echo -e "${RED}[ERROR] Node.js $NODE_VER is too old. VibeCut requires v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+${NC}"
    echo ""
    echo "Attempting to upgrade..."
    install_node
    # Re-check after upgrade attempt
    NODE_VER=$(node --version)
    NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
    NODE_MINOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f2)
    if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
        echo -e "${RED}[ERROR] Upgrade failed. Please manually install Node.js v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ from https://nodejs.org${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}[OK] Node.js is installed: $NODE_VER${NC}"
echo ""

# ====================================================
# STEP 2: Install npm packages
# ====================================================
echo -e "${BOLD}[Step 2/4] Installing app dependencies...${NC}"
echo "(This may take a minute the first time)"
echo ""

# Detect if Node.js version changed since last install — if so, clean reinstall
NODE_VER_FILE=".node-version-used"
NEED_CLEAN=false

if [ -d "node_modules" ]; then
    if [ -f "$NODE_VER_FILE" ]; then
        PREV_VER=$(cat "$NODE_VER_FILE")
        PREV_MAJOR=$(echo "$PREV_VER" | sed 's/v//' | cut -d. -f1)
        CURR_MAJOR=$NODE_MAJOR
        if [ "$PREV_MAJOR" != "$CURR_MAJOR" ]; then
            echo -e "${YELLOW}Node.js major version changed ($PREV_VER -> $NODE_VER). Doing clean reinstall...${NC}"
            NEED_CLEAN=true
        fi
    else
        # No record of previous version — safe to clean install
        echo -e "${YELLOW}First install with version tracking. Doing clean reinstall to be safe...${NC}"
        NEED_CLEAN=true
    fi
fi

if [ "$NEED_CLEAN" = true ]; then
    rm -rf node_modules package-lock.json
    echo "Cleared old node_modules."
fi

npm install --loglevel=error
echo "$NODE_VER" > "$NODE_VER_FILE"
echo ""
echo -e "${GREEN}[OK] Dependencies installed!${NC}"
echo ""

# ====================================================
# STEP 3: Download yt-dlp and ffmpeg
# ====================================================
echo -e "${BOLD}[Step 3/4] Downloading video tools...${NC}"
echo ""

mkdir -p bin
OS=$(uname -s)

# Download yt-dlp
if [ -f "bin/yt-dlp" ]; then
    echo -e "${GREEN}[OK] yt-dlp already downloaded.${NC}"
else
    echo "Downloading yt-dlp (video downloader)..."
    if [[ "$OS" == "Darwin" ]]; then
        curl -L -o bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" 2>/dev/null
    else
        curl -L -o bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" 2>/dev/null
    fi
    if [ -f "bin/yt-dlp" ]; then
        chmod +x bin/yt-dlp
        echo -e "${GREEN}[OK] yt-dlp downloaded!${NC}"
    else
        echo -e "${YELLOW}[WARNING] Could not download yt-dlp. Video downloads may not work.${NC}"
    fi
fi

# Download/link ffmpeg
if [ -f "bin/ffmpeg" ]; then
    echo -e "${GREEN}[OK] ffmpeg already available.${NC}"
else
    if command -v ffmpeg &> /dev/null; then
        ln -sf "$(command -v ffmpeg)" bin/ffmpeg
        echo -e "${GREEN}[OK] ffmpeg linked from system install.${NC}"
    elif [[ "$OS" == "Darwin" ]]; then
        if command -v brew &> /dev/null; then
            echo "Installing ffmpeg via Homebrew..."
            brew install ffmpeg
            ln -sf "$(command -v ffmpeg)" bin/ffmpeg
            echo -e "${GREEN}[OK] ffmpeg installed!${NC}"
        else
            echo "Downloading ffmpeg..."
            curl -L -o bin/ffmpeg.zip "https://evermeet.cx/ffmpeg/getrelease/zip" 2>/dev/null
            if [ -f "bin/ffmpeg.zip" ]; then
                unzip -o bin/ffmpeg.zip -d bin/ 2>/dev/null
                rm -f bin/ffmpeg.zip
                chmod +x bin/ffmpeg
                echo -e "${GREEN}[OK] ffmpeg downloaded!${NC}"
            else
                echo -e "${YELLOW}[WARNING] Could not download ffmpeg.${NC}"
            fi
        fi
    else
        echo -e "${YELLOW}[WARNING] ffmpeg not found. Install with: sudo apt install ffmpeg${NC}"
    fi
fi

echo ""

# ====================================================
# STEP 4: Set up API keys
# ====================================================
echo -e "${BOLD}[Step 4/5] Building Python tracker (optional)...${NC}"
echo ""

if [ -f "bin/vibecut-tracker" ] || [ -f "bin/vibecut-tracker.exe" ]; then
    echo -e "${GREEN}[OK] Python tracker already built.${NC}"
else
    if command -v python3 &> /dev/null; then
        PYTHON_CMD=python3
    elif command -v python &> /dev/null; then
        PYTHON_CMD=python
    else
        PYTHON_CMD=""
    fi

    if [ -n "$PYTHON_CMD" ]; then
        echo "Checking Python dependencies for AI-powered person tracking..."
        if $PYTHON_CMD -c "import mediapipe; import cv2" 2>/dev/null; then
            echo "Dependencies found! Checking for PyInstaller..."
            if $PYTHON_CMD -c "import PyInstaller" 2>/dev/null; then
                echo "Building Python tracker binary (this may take a few minutes)..."
                $PYTHON_CMD python/build.py
                if [ -f "bin/vibecut-tracker" ] || [ -f "bin/vibecut-tracker.exe" ]; then
                    echo -e "${GREEN}[OK] Python tracker built successfully!${NC}"
                else
                    echo -e "${YELLOW}[WARNING] Python tracker build failed. Browser tracking will be used instead.${NC}"
                fi
            else
                echo "Installing PyInstaller..."
                $PYTHON_CMD -m pip install pyinstaller --quiet
                echo "Building Python tracker binary (this may take a few minutes)..."
                $PYTHON_CMD python/build.py
                if [ -f "bin/vibecut-tracker" ] || [ -f "bin/vibecut-tracker.exe" ]; then
                    echo -e "${GREEN}[OK] Python tracker built successfully!${NC}"
                else
                    echo -e "${YELLOW}[WARNING] Python tracker build failed. Browser tracking will be used instead.${NC}"
                fi
            fi
        else
            echo -e "${YELLOW}[INFO] Python tracking dependencies not installed. Trying auto-install...${NC}"
            if $PYTHON_CMD -m pip install mediapipe opencv-python-headless numpy pyinstaller --quiet 2>&1; then
                echo -e "${GREEN}[OK] Python tracking dependencies installed!${NC}"
                echo "Building Python tracker binary (this may take a few minutes)..."
                $PYTHON_CMD python/build.py
                if [ -f "bin/vibecut-tracker" ] || [ -f "bin/vibecut-tracker.exe" ]; then
                    echo -e "${GREEN}[OK] Python tracker built successfully!${NC}"
                else
                    echo -e "${YELLOW}[WARNING] Python tracker build failed. Browser tracking will be used instead.${NC}"
                fi
            else
                echo -e "${YELLOW}[INFO] Auto-install failed. To enable AI-powered person tracking, run:"
                echo "    pip install mediapipe opencv-python-headless numpy pyinstaller"
                echo "    python python/build.py"
                echo ""
                echo -e "  The app will use browser-based tracking in the meantime.${NC}"
            fi
        fi
    else
        echo -e "${YELLOW}[INFO] Python not found. Skipping tracker build."
        echo -e "  The app will use browser-based tracking.${NC}"
    fi
fi

echo ""

# ====================================================
# STEP 5: Set up API keys
# ====================================================
echo -e "${BOLD}[Step 5/5] Checking API keys...${NC}"
echo ""

if [ ! -f ".env.local" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env.local
    else
        cat > .env.local << 'EOF'
GEMINI_API_KEY=your_gemini_api_key_here
KIMI_API_KEY=your_kimi_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
MINIMAX_API_KEY=your_minimax_api_key_here
EOF
    fi
    echo -e "${YELLOW}==================================================="
    echo "  You need API keys to use the AI features."
    echo "  Open the file '.env.local' in a text editor and"
    echo "  replace the placeholder text with your real keys."
    echo ""
    echo "  Need a free API key? Get one at:"
    echo "  https://aistudio.google.com/apikey"
    echo -e "===================================================${NC}"
else
    echo -e "${GREEN}[OK] API keys file already exists.${NC}"
fi

echo ""
echo -e "${GREEN}${BOLD}"
echo "  ==================================================="
echo "   INSTALLATION COMPLETE!"
echo "  ==================================================="
echo -e "${NC}"
echo ""
echo "  To run VibeCut AI:"
echo "    ./START.sh"
echo ""
echo "  The app will open in your web browser automatically."
echo ""


