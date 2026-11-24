const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ov', {
  init: () => ipcRenderer.invoke('ov-init'),
  done: (res) => ipcRenderer.send('ov-done', res),
  cancel: () => ipcRenderer.send('ov-done', null),
});
