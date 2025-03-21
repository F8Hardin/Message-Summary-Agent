const { contextBridge, ipcRenderer } = require('electron');

console.log("✅ Preload script loaded!"); // Debugging log

contextBridge.exposeInMainWorld("electronAPI", {
    submitPrompt: (userInput) => ipcRenderer.invoke('submitPrompt', userInput)
});
