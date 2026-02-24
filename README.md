# VibeCut AI

AI-powered video editing tool that creates short-form content from YouTube videos.

## 🚀 First Time? Start Here!

**Open `SETUP_GUIDE.html`** in your browser for a visual step-by-step guide with pictures.

### Quick Version:

| | Windows | Mac |
|---|---------|-----|
| **Install** | Double-click `INSTALL.bat` | `chmod +x INSTALL.sh && ./INSTALL.sh` |
| **Run** | Double-click `START.bat` | `./START.sh` |

> **Just want to run it?** Double-click `START.bat` — it will auto-install on first run.

## 🔑 API Keys

You need at least one AI API key. Get a free Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

Edit `.env.local` and paste your key. See `.env.example` for the format.

## 📋 What This App Does

1. **Import** — Paste a YouTube URL to download video + transcript
2. **AI Shorts** — AI picks the best moments for short-form content
3. **Edit** — Fine-tune timing, add subtitles, style effects
4. **Export** — Export finished videos from the browser

## 🔧 Troubleshooting

See the **Troubleshooting** section in `SETUP_GUIDE.html`, or:

| Problem | Solution |
|---------|----------|
| Video won't download | Export cookies from Chrome to `www.youtube.com_cookies.txt` |
| Can't see `.env.local` | Show hidden files (Windows: View → Hidden items) |
| "Port in use" | Close all terminal windows and retry |
