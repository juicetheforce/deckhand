const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('probe', {
  key: (event) => ipcRenderer.send('probe-key', event),
  click: () => ipcRenderer.send('probe-click'),
  onState: (callback) => ipcRenderer.on('probe-state', (_event, state) => callback(state)),
});
