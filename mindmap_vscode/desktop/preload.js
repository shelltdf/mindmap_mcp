const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => {
  return {
    postMessage: (msg) => ipcRenderer.send('vscode:postMessage', msg),
    setState: () => {},
    getState: () => null
  };
});

contextBridge.exposeInMainWorld('mindmapDesktop', {
  openFile: () => ipcRenderer.invoke('mindmap:open'),
  saveAs: (payload) => ipcRenderer.invoke('mindmap:saveAs', payload),
  save: (payload) => ipcRenderer.invoke('mindmap:save', payload)
});
