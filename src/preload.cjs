'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tasteArena', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  selectMedia: () => ipcRenderer.invoke('media:select'),
  inspectMedia: (paths) => ipcRenderer.invoke('media:inspect', paths),
  selectCover: () => ipcRenderer.invoke('media:select-cover'),
  openBackstage: () => ipcRenderer.invoke('backstage:open'),
  publishBackstageState: (snapshot) => ipcRenderer.invoke('backstage:publish-state', snapshot),
  onBackstageUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('backstage:update-track', listener);
    return () => ipcRenderer.removeListener('backstage:update-track', listener);
  },
  onBackstageCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('backstage:command', listener);
    return () => ipcRenderer.removeListener('backstage:command', listener);
  },
  sendBackstageFeedback: (message, type) => ipcRenderer.invoke('backstage:feedback', { message, type }),
  onStreamStartCapture: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('stream:start-capture', listener);
    return () => ipcRenderer.removeListener('stream:start-capture', listener);
  },
  onStreamStopCapture: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('stream:stop-capture', listener);
    return () => ipcRenderer.removeListener('stream:stop-capture', listener);
  },
  sendStreamChunk: (id, bytes) => ipcRenderer.send('stream:chunk', id, bytes),
  sendStreamCaptureReady: (id) => ipcRenderer.send('stream:capture-ready', id),
  sendStreamCaptureError: (id, message) => ipcRenderer.send('stream:capture-error', id, message),
  sendStreamCaptureStopped: (id) => ipcRenderer.send('stream:capture-stopped', id),
  pathForFile: (file) => webUtils.getPathForFile(file),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  connectLive: (identityCode) => ipcRenderer.invoke('live:connect', identityCode),
  disconnectLive: () => ipcRenderer.invoke('live:disconnect'),
  startArchive: (metadata) => ipcRenderer.invoke('archive:start', metadata),
  appendArchive: (sessionId, entry) => ipcRenderer.invoke('archive:append', sessionId, entry),
  finishArchive: (sessionId, summary) => ipcRenderer.invoke('archive:finish', sessionId, summary),
  exportArchiveCsv: (sessionId) => ipcRenderer.invoke('archive:export-csv', sessionId),
  onLiveState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('live:state', listener);
    return () => ipcRenderer.removeListener('live:state', listener);
  },
  onLiveMessage: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('live:message', listener);
    return () => ipcRenderer.removeListener('live:message', listener);
  },
  onDiagnostic: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('live:diagnostic', listener);
    return () => ipcRenderer.removeListener('live:diagnostic', listener);
  },
});
