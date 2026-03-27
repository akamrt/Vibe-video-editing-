# 🎬 Vibe — AI Video Editor

**Your AI video editor that watches your footage so you don't have to.**

Vibe is an Electron-based desktop app that brings Gemini-powered AI into the video editing workflow. Paste a YouTube URL, drop a file, or import from your camera roll — Gemini handles the analysis, finds the moments, removes the filler, tracks the speaker, and hands you a polished edit ready to export.

Built for content creators, churches, educators, and anyone who has ever watched an hour of footage to find the three good minutes.

---

## The Good Stuff

### 🤖 AI Finds the Best Moments — Then You Approve
Paste a YouTube URL or drop a video, Gemini analyses the whole thing and flags the most engaging moments — the quotable bits, the visual peaks, the unexpected turns. You pick what stays. It's like having an editor who already watched everything.

### 🎯 Auto-Centre on the Speaker
AI tracks where the speaker is in every frame and keeps them centred. No more jump-cuts on talking heads. No expensive tracking software. Just: upload, scan, done.

### 🗣️ It Removes All the "Umms" and "Ahhs"
One click and Gemini finds every filler word, repeated phrase, and awkward pause across your entire video. A second click removes them. What used to take an hour of scrubbing timeline now takes minutes.

### 📊 Trend-Aware Shorts
Connect YouTube, Google Trends, or Reddit and Vibe tells you what's trending *right now* — then scores your existing footage against those trends. It suggests which moments align with what's going viral today.

### 💬 Chat With Your Video
Ask your footage questions. *"What was the main point at 4:30?" "Find the moment about purpose." "Summarise this in 30 seconds."* It's Gemini watching so you don't have to.

### 🎞️ B-Roll on Demand
Select a clip → Gemini searches Pexels for relevant stock footage and suggests B-roll cuts automatically. No tab-switching, no hunting. Just select and drop.

---

## The Really Impressive Bits

- **Word-level karaoke subtitles** — each word highlights as it's spoken, with shimmer, particle, and glow effects
- **40+ transition types** — fades, wipes, slides, glitches, film burns, light leaks, dissolves, mosaic, iris, zoom-rotate
- **Per-clip keyframe animation** — pan, zoom, rotate, scale on individual clips with bezier tangent controls
- **Render queue** — batch-export 10 versions at once, different aspect ratios, different formats
- **Google Fonts live** — search and apply any font from Google's library directly in the app
- **Pivot keyframes** — AI detects where the speaker's head is in each frame and keys it automatically
- **Dual tracker types** — stabiliser (locks to a point) vs parent (moves with the subject)
- **Re-detect fillers** — second-pass AI catches the ones it missed first time
- **Import AI shorts from JSON** — paste output from ChatGPT or other AI tools and Vibe builds the edit
- **Transcript phrase search** — find any moment in any video by typing what was said
- **Audio unlinking** — pull audio off a clip, reposition it, add crossfades without touching the video
- **Cost tracker** — see exactly how much each operation costs in Gemini API credits

---

## The Boring but Important Bits

- Import: YouTube URL, drag-and-drop, or file picker
- Aspect ratios: 9:16, 16:9, 1:1, 4:5, custom
- Export: WebM, up to 4K, adjustable bitrate and FPS
- Project files: save/load, export as `.vibe`, import from file
- YouTube cookie auth for age-restricted content
- Undo/redo with full action history
- Auto-save to IndexedDB
- Cross-platform: Windows, Mac, Linux

---

## 🚀 Install — Up and Running in 5 Minutes

### 🪟 Windows

**1. Get the files**
Download the Vibe folder and put it somewhere convenient — Desktop, Documents, or Downloads all work.

**2. Install everything**
Open the folder and double-click:
```
INSTALL.bat
```
A black window will open. Let it run — it'll install Node.js and all the tools automatically. If Windows shows a "Windows protected your PC" popup, click **"More info" → "Run anyway"**. This is normal for downloaded scripts.

When you see **"INSTALLATION COMPLETE!"** you're done with this step.

**3. Add your free API key**
The AI features need a free API key from Google:
1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Sign in → click **"Create API Key"** → copy it
3. In the Vibe folder, find **`.env.local`** — right-click → **Open with → Notepad**
4. Replace `your_gemini_api_key_here` with your actual key
5. Save (Ctrl+S) and close

*Can't see the .env.local file? In File Explorer, click **View** → check **"Hidden items"**.*

**4. Run**
Double-click:
```
START.bat
```
The app opens in your browser automatically. You're ready to go.

---

### 🍎 Mac

**1. Open Terminal**
Press **Cmd + Space**, type "Terminal", press Enter.

**2. Get the files**
Paste and run:
```
git clone https://github.com/akamrt/Vibe-video-editing-.git && cd Vibe-video-editing-
```
If Terminal asks to install Xcode Command Line Tools, click **Install** and wait.

**3. Install everything**
Run these two commands, pressing Enter after each:
```
chmod +x INSTALL.sh START.sh
./INSTALL.sh
```
Enter your Mac password if asked. The script installs everything automatically. When you see **"INSTALLATION COMPLETE!"** you're done.

**4. Add your free API key**
Get a free key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey), then paste this in Terminal:
```
nano .env.local
```
Replace the placeholder with your key. Press **Ctrl + O** (Save) → Enter → **Ctrl + X** (Exit).

**5. Run**
```
./START.sh
```
The app opens in your browser. To stop it later, press **Ctrl + C** in Terminal.

---

## 🔄 Updating

When there's a new version, updating takes about 30 seconds.

**Windows:**
```
git pull && INSTALL.bat
```

**Mac:**
```
git pull && ./INSTALL.sh
```

Your API key and settings are never affected by updates.

---

## 🛠️ Troubleshooting

**"localhost refused to connect"** — Wait 10 seconds and refresh. If it still doesn't work, close everything and run START.bat again.

**"Port is already in use"** — Another app is using port 3000. Close all Terminal/command prompt windows and try again.

**"API key not set"** — The .env.local file wasn't set up correctly. See Step 3 above.

**YouTube video won't download** — YouTube may require browser cookies. Install the "Get cookies.txt" Chrome extension, go to youtube.com, export cookies, and save the file as `www.youtube.com_cookies.txt` in the Vibe folder.

---

## Stack

**Frontend:** React 19, TypeScript, Vite, Remotion, Canvas API  
**Backend:** Express, yt-dlp, FFmpeg  
**AI:** Google Gemini (transcription, analysis, person detection, chat)  
**Desktop:** Electron 33  
**Tracking:** Python + OpenCV  
**Stock media:** Pexels API  

---

## Screenshots

*Add your screenshots here*

---

## License

MIT
