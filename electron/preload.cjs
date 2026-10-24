const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flightSelectDesktop', {
  pickFolders: () => ipcRenderer.invoke('flight:pick-folders'),
  pickFiles: () => ipcRenderer.invoke('flight:pick-files'),
  readImages: images => ipcRenderer.invoke('flight:read-images', images),
  chooseOutputFolder: () => ipcRenderer.invoke('flight:choose-output'),
  copyImages: payload => ipcRenderer.invoke('flight:copy-images', payload)
});
