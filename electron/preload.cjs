const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pi", {
  start: (cwd) => ipcRenderer.invoke("pi:start", { cwd }),
  send: (payload) => ipcRenderer.invoke("pi:send", payload),
  pickFolder: () => ipcRenderer.invoke("pi:pickFolder"),
  sessions: () => ipcRenderer.invoke("pi:sessions"),
  searchSessions: (query) => ipcRenderer.invoke("pi:searchSessions", { query }),
  deleteSession: (filePath) => ipcRenderer.invoke("pi:deleteSession", { path: filePath }),
  forkSessionAt: (entryId) => ipcRenderer.invoke("pi:forkSessionAt", { entryId }),
  respondUi: (id, values) => ipcRenderer.invoke("pi:uiRespond", { id, ...values }),
  parseAttachment: (payload) => ipcRenderer.invoke("attachments:parse", payload),
  exportHtml: () => ipcRenderer.invoke("pi:exportHtml"),
  diagExport: () => ipcRenderer.invoke("diag:export"),
  plans: {
    save: (cwd, content) => ipcRenderer.invoke("plans:save", { cwd, content }),
  },
  stats: {
    usage: (days) => ipcRenderer.invoke("stats:usage", { days }),
  },
  updater: {
    state: () => ipcRenderer.invoke("update:state"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    openReleases: () => ipcRenderer.invoke("update:releases"),
  },
  // Only registered when the main process runs with PI_DEBUG.
  debugDialog: (dialog) => ipcRenderer.invoke("pi:debugDialog", dialog),
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    add: (dir) => ipcRenderer.invoke("projects:add", dir),
    remove: (dir) => ipcRenderer.invoke("projects:remove", dir),
  },
  reveal: (target) => ipcRenderer.invoke("pi:reveal", target),
  showWindow: () => ipcRenderer.invoke("pi:showWindow"),
  zoom: (delta) => ipcRenderer.invoke("ui:zoom", { delta }),
  zoomReset: () => ipcRenderer.invoke("ui:zoomReset"),
  cfg: {
    read: (cwd) => ipcRenderer.invoke("cfg:read", { cwd }),
    saveProvider: (payload) => ipcRenderer.invoke("cfg:saveProvider", payload),
    deleteProvider: (name) => ipcRenderer.invoke("cfg:deleteProvider", name),
    fetchModels: (payload) => ipcRenderer.invoke("cfg:fetchModels", payload),
    setSetting: (patch) => ipcRenderer.invoke("cfg:setSetting", patch),
    gallery: (query, from) => ipcRenderer.invoke("cfg:gallery", { query, from }),
    readSkill: (file, cwd) => ipcRenderer.invoke("cfg:readSkill", { file, cwd }),
    deleteSkill: (dir) => ipcRenderer.invoke("cfg:deleteSkill", dir),
    setMcp: (name, enabled) => ipcRenderer.invoke("cfg:setMcp", { name, enabled }),
    savePersona: (payload) => ipcRenderer.invoke("cfg:savePersona", payload),
    savePrompt: (payload) => ipcRenderer.invoke("cfg:savePrompt", payload),
    deletePrompt: (payload) => ipcRenderer.invoke("cfg:deletePrompt", payload),
    readPrompt: (payload) => ipcRenderer.invoke("cfg:readPrompt", payload),
    setResources: (source, disabled) => ipcRenderer.invoke("cfg:setResources", { source, disabled }),
    install: (source) => ipcRenderer.invoke("cfg:install", source),
    uninstall: (source) => ipcRenderer.invoke("cfg:uninstall", source),
  },
  files: (cwd, query) => ipcRenderer.invoke("files:search", { cwd, query }),
  tree: (cwd, dir = "") => ipcRenderer.invoke("files:tree", { cwd, dir }),
  readFile: (cwd, file) => ipcRenderer.invoke("files:read", { cwd, file }),
  agents: (cwd) => ipcRenderer.invoke("agents:list", { cwd }),
  git: {
    status: (cwd) => ipcRenderer.invoke("git:status", { cwd }),
    branches: (cwd) => ipcRenderer.invoke("git:branches", { cwd }),
    checkout: (cwd, branch) => ipcRenderer.invoke("git:checkout", { cwd, branch }),
  },
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
