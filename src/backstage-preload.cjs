'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('backstageApi', {
  getState: () => ipcRenderer.invoke('backstage:get-state'),
  updateTrack: (update) => ipcRenderer.invoke('backstage:update-track', update),
  command: (type, payload) => ipcRenderer.invoke('backstage:command', { type, payload }),
  selectMedia: () => ipcRenderer.invoke('media:select'),
  inspectMedia: (paths) => ipcRenderer.invoke('media:inspect', paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  selectCover: () => ipcRenderer.invoke('media:select-cover'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  connectLive: (identityCode) => ipcRenderer.invoke('live:connect', identityCode),
  disconnectLive: () => ipcRenderer.invoke('live:disconnect'),
  exportArchiveCsv: (sessionId) => ipcRenderer.invoke('archive:export-csv', sessionId),
  getStreamState: () => ipcRenderer.invoke('stream:state'),
  probeStream: (ffmpegPath) => ipcRenderer.invoke('stream:probe', ffmpegPath),
  selectStreamTestFile: () => ipcRenderer.invoke('stream:select-test-file'),
  startStream: (options) => ipcRenderer.invoke('stream:start', options),
  stopStream: () => ipcRenderer.invoke('stream:stop'),
  onStreamState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('stream:state', listener);
    return () => ipcRenderer.removeListener('stream:state', listener);
  },
  onState: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('backstage:state', listener);
    return () => ipcRenderer.removeListener('backstage:state', listener);
  },
  onFeedback: (callback) => {
    const listener = (_event, feedback) => callback(feedback);
    ipcRenderer.on('backstage:feedback', listener);
    return () => ipcRenderer.removeListener('backstage:feedback', listener);
  },
});
