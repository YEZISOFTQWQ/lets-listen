'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('backstageApi', {
  getState: () => ipcRenderer.invoke('backstage:get-state'),
  updateTrack: (update) => ipcRenderer.invoke('backstage:update-track', update),
  onState: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('backstage:state', listener);
    return () => ipcRenderer.removeListener('backstage:state', listener);
  },
});
