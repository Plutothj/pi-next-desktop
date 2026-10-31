const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pi", {
  start: (cwd) => ipcRenderer.invoke("pi:start", { cwd }),
  send: (payload) => ipcRenderer.invoke("pi:send", payload),
  pickFolder: () => ipcRenderer.invoke("pi:pickFolder"),
  sessions: () => ipcRenderer.invoke("pi:sessions"),
  reveal: (target) => ipcRenderer.invoke("pi:reveal", target),
  cfg: {
    read: (cwd) => ipcRenderer.invoke("cfg:read", { cwd }),
    saveProvider: (payload) => ipcRenderer.invoke("cfg:saveProvider", payload),
    deleteProvider: (name) => ipcRenderer.invoke("cfg:deleteProvider", name),
    setSetting: (patch) => ipcRenderer.invoke("cfg:setSetting", patch),
    gallery: (query) => ipcRenderer.invoke("cfg:gallery", query),
    readSkill: (file) => ipcRenderer.invoke("cfg:readSkill", file),
    deleteSkill: (dir) => ipcRenderer.invoke("cfg:deleteSkill", dir),
    setMcp: (name, enabled) => ipcRenderer.invoke("cfg:setMcp", { name, enabled }),
    savePersona: (payload) => ipcRenderer.invoke("cfg:savePersona", payload),
    setResources: (source, disabled) => ipcRenderer.invoke("cfg:setResources", { source, disabled }),
    install: (source) => ipcRenderer.invoke("cfg:install", source),
    uninstall: (source) => ipcRenderer.invoke("cfg:uninstall", source),
  },
  files: (cwd, query) => ipcRenderer.invoke("files:search", { cwd, query }),
  tree: (cwd, dir = "") => ipcRenderer.invoke("files:tree", { cwd, dir }),
  readFile: (cwd, file) => ipcRenderer.invoke("files:read", { cwd, file }),
  agents: (cwd) => ipcRenderer.invoke("agents:list", { cwd }),
  term: {
    run: (cmd, cwd, label, host) => ipcRenderer.invoke("term:run", { cmd, cwd, label, host }),
    list: () => ipcRenderer.invoke("term:list"),
    output: (id) => ipcRenderer.invoke("term:out", id),
    kill: (id) => ipcRenderer.invoke("term:kill", id),
    remove: (id) => ipcRenderer.invoke("term:remove", id),
    hosts: () => ipcRenderer.invoke("ssh:hosts"),
  },
  onEvent: (fn) => {
    const listener = (_e, record) => fn(record);
    ipcRenderer.on("pi:event", listener);
    return () => ipcRenderer.removeListener("pi:event", listener);
  },
});
