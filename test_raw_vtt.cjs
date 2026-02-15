const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const COOKIE_FILE = path.join(__dirname, 'www.youtube.com_cookies.txt');

function getRawVtt(videoId) {
    const tempPrefix = path.join(os.tmpdir(), `debug_vtt_${videoId}_${Date.now()}`);
    const cookiesArg = fs.existsSync(COOKIE_FILE) ? `--cookies "${COOKIE_FILE}"` : '';
    const cmd = `yt-dlp --write-subs --write-auto-sub --sub-lang en --skip-download --no-warnings ${cookiesArg} --output "${tempPrefix}" https://www.youtube.com/watch?v=${videoId}`;

    try {
        execSync(cmd, { stdio: 'pipe' });
        const dir = os.tmpdir();
        const files = fs.readdirSync(dir);
        const prefixBase = path.basename(tempPrefix);
        const vttFile = files.find(f => f.startsWith(prefixBase) && f.endsWith('.vtt'));
        if (vttFile) {
            const content = fs.readFileSync(path.join(dir, vttFile), 'utf8');
            // Clean up
            fs.unlinkSync(path.join(dir, vttFile));
            return content;
        }
    } catch (e) {
        console.error(e);
    }
    return null;
}

const vtt = getRawVtt('sp79zufiyO0');
if (vtt) {
    const lines = vtt.split('\n');
    // Search for "final week"
    lines.forEach((line, i) => {
        if (line.includes('final week') || line.includes('We are on')) {
            console.log(`Line ${i}: ${line}`);
            // Print context
            for (let j = Math.max(0, i - 5); j < Math.min(lines.length, i + 5); j++) {
                console.log(`  ${j}: ${lines[j].trim()}`);
            }
        }
    });
}
