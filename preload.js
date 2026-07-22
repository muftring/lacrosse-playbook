const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  savePlaybook: (data) => ipcRenderer.invoke('save-playbook', data),
  loadPlaybook: () => ipcRenderer.invoke('load-playbook'),
  exportPdf: (payload) => ipcRenderer.invoke('export-pdf', payload)
});
