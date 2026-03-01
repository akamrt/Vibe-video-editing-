type ServerStatus = 'connected' | 'disconnected' | 'connecting';
type StatusListener = (status: ServerStatus) => void;

let currentStatus: ServerStatus = 'connecting';
const listeners = new Set<StatusListener>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function setStatus(s: ServerStatus) {
  if (s !== currentStatus) {
    currentStatus = s;
    listeners.forEach(fn => fn(s));
  }
}

export function startHealthPolling(intervalMs = 5000) {
  if (pollTimer) return;
  checkHealth().then(ok => setStatus(ok ? 'connected' : 'disconnected'));
  pollTimer = setInterval(async () => {
    const ok = await checkHealth();
    setStatus(ok ? 'connected' : 'disconnected');
  }, intervalMs);
}

export function stopHealthPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export function onStatusChange(fn: StatusListener): () => void {
  listeners.add(fn);
  fn(currentStatus);
  return () => listeners.delete(fn);
}

export function getServerStatus(): ServerStatus { return currentStatus; }
