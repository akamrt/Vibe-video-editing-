import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  saveApiKeys: (keys: Record<string, string>) =>
    ipcRenderer.invoke('setup:saveApiKeys', keys),

  checkBinaries: () =>
    ipcRenderer.invoke('setup:checkBinaries'),

  completeSetup: () =>
    ipcRenderer.invoke('setup:complete'),

  openExternal: (url: string) =>
    ipcRenderer.invoke('setup:openExternal', url),
});
