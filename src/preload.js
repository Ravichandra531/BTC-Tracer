const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  trace:      (args)    => ipcRenderer.invoke('trace', args),
  openCSV:    ()        => ipcRenderer.invoke('open-csv'),
  exportJSON: (payload) => ipcRenderer.invoke('export-json', payload),
  onProgress: (cb)      => ipcRenderer.on('trace-progress', (_, msg) => cb(msg)),
  offProgress:()        => ipcRenderer.removeAllListeners('trace-progress'),
  minimize:   ()        => ipcRenderer.send('win-minimize'),
  maximize:   ()        => ipcRenderer.send('win-maximize'),
  close:      ()        => ipcRenderer.send('win-close'),
});
