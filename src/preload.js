const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('islandAPI', Object.freeze({
  onInit: (callback) => subscribe('app:init', callback),
  onMedia: (callback) => subscribe('media:state', callback),
  onLyrics: (callback) => subscribe('lyrics:state', callback),
  onSettings: (callback) => subscribe('settings:state', callback),
  onToast: (callback) => subscribe('ui:toast', callback),
  onDragState: (callback) => subscribe('window:drag-state', callback),
  onHoverState: (callback) => subscribe('window:hover-state', callback),
  onMascots: (callback) => subscribe('mascots:state', callback),
  getMascots: () => ipcRenderer.invoke('mascots:list'),
  selectMascot: (id) => ipcRenderer.invoke('mascots:select', id),
  importMascot: () => ipcRenderer.invoke('mascots:import'),
  removeMascot: (id) => ipcRenderer.invoke('mascots:remove', id),
  setMascotPanel: (open) => ipcRenderer.send('mascots:panel', Boolean(open)),
  setMascotMotion: (motion) => ipcRenderer.send('mascots:motion', motion),
  setMode: (mode) => ipcRenderer.send('window:set-mode', mode),
  setClickThrough: (enabled) => ipcRenderer.send('window:set-click-through', Boolean(enabled)),
  updateSettings: (patch) => ipcRenderer.send('settings:update', patch),
  hide: () => ipcRenderer.send('window:hide'),
  resetPosition: () => ipcRenderer.send('window:reset-position'),
  toggleDemo: () => ipcRenderer.send('demo:toggle'),
  ready: () => ipcRenderer.send('ui:ready'),
}));
