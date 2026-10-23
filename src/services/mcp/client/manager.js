const { McpClient } = require("./McpClient");
const { NAME, validateServer } = require("./configStore");
const MAX_LOG = 100;
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const signature = (server) =>
  JSON.stringify([server.command, server.args || [], server.cwd || null]);
class McpManager {
  constructor(store, options = {}) {
    this.store = store;
    this.credentials = options.credentials;
    this.reservedNames = new Set(options.reservedNames || []);
    this.clients = new Map();
    this.errors = new Map();
    this.spawnLog = [];
    this.revision = 0;
    this.configText = null;
  }
  config() {
    return this.store.read();
  }
  settings(config, name) {
    return config._openwhispr?.[name] || {};
  }
  isEnabled(config, name) {
    return this.settings(config, name).enabled !== false;
  }
  resolve(server) {
    const visit = (value) => {
      if (typeof value === "string" && value.startsWith("credential://")) {
        const secret = this.credentials?.read(value.slice("credential://".length));
        if (typeof secret?.value !== "string") throw new Error("Missing MCP secret");
        return secret.value;
      }
      if (Array.isArray(value)) return value.map(visit);
      if (isObject(value))
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
      return value;
    };
    return visit(server);
  }
  publicServer(name, server, config) {
    const settings = this.settings(config, name);
    return {
      name,
      config: server,
      enabled: this.isEnabled(config, name),
      confirmed: server.type === "http" || settings.confirmed === signature(server),
      allowWithoutAsking: settings.allowWithoutAsking === true,
      maxResultChars: [8000, 32000, 64000, 128000, 256000].includes(settings.maxResultChars)
        ? settings.maxResultChars
        : undefined,
      status: this.clients.has(name)
        ? "connected"
        : settings.enabled === false
          ? "disabled"
          : this.errors.has(name)
            ? "error"
            : "stopped",
      lastError: this.errors.get(name) || null,
    };
  }
  list() {
    const config = this.config();
    return {
      revision: this.revision,
      servers: Object.entries(config.mcpServers).map(([name, server]) =>
        this.publicServer(name, server, config)
      ),
    };
  }
  logSpawn(name, details) {
    const entry = { name, ...details, at: new Date().toISOString() };
    this.spawnLog.push(entry);
    if (this.spawnLog.length > MAX_LOG) this.spawnLog.shift();
    console.info("MCP spawn", entry);
  }
  logError(name, error) {
    this.errors.set(name, error.message || String(error));
  }
  async start(name) {
    if (this.clients.has(name)) return this.clients.get(name);
    const config = this.config();
    const server = config.mcpServers[name];
    if (!server || !this.isEnabled(config, name)) throw new Error("MCP server disabled or missing");
    if (server.type !== "http" && this.settings(config, name).confirmed !== signature(server))
      throw new Error("MCP command needs confirmation");
    let client;
    try {
      client = new McpClient(this.resolve(server), {
        onSpawn: (details) => this.logSpawn(name, details),
        onFailure: (error) => {
          this.logError(name, error);
          if (this.clients.get(name) === client) {
            this.clients.delete(name);
            this.revision++;
          }
        },
      });
      const tools = await client.initialize();
      const used = new Set(this.reservedNames);
      for (const [otherName, item] of this.clients)
        if (otherName !== name)
          for (const tool of item.tools) used.add(`${otherName}__${tool.name}`);
      for (const tool of tools) {
        const full = `${name}__${tool.name}`;
        if (!NAME.test(full) || used.has(full))
          throw new Error(`Invalid or colliding MCP tool: ${full}`);
        used.add(full);
      }
      this.clients.set(name, client);
      this.errors.delete(name);
      this.revision++;
      return client;
    } catch (error) {
      client?.stop();
      this.logError(name, error);
      throw error;
    }
  }
  async sync() {
    const config = this.config();
    const text = JSON.stringify(config);
    if (text === this.configText) return this.list();
    this.configText = text;
    for (const name of this.clients.keys()) this.stop(name);
    for (const name of Object.keys(config.mcpServers)) {
      if (this.isEnabled(config, name)) await this.start(name).catch(() => {});
    }
    this.revision++;
    return this.list();
  }
  stop(name) {
    this.clients.get(name)?.stop();
    this.clients.delete(name);
    this.revision++;
  }
  stopAll() {
    for (const name of [...this.clients.keys()]) this.stop(name);
  }
  async upsert(name, server, options = {}) {
    validateServer(name, server);
    if (
      !isObject(options) ||
      (options.enabled !== undefined && typeof options.enabled !== "boolean") ||
      (options.addOnly !== undefined && typeof options.addOnly !== "boolean") ||
      Object.keys(options).some((key) => !["enabled", "addOnly", "secrets"].includes(key))
    )
      throw new Error("Invalid MCP options");
    if (options.secrets !== undefined && !isObject(options.secrets))
      throw new Error("Invalid secrets");
    const config = this.config();
    const old = config.mcpServers[name];
    const oldSettings = config._openwhispr?.[name];
    if (old && options.addOnly) throw new Error("Duplicate server name");
    let stored = structuredClone(server);
    for (const [field, value] of Object.entries(options.secrets || {})) {
      if (!/^(env|headers)\.[a-zA-Z0-9_-]+$/.test(field) || typeof value !== "string")
        throw new Error("Invalid secret");
      const [section, key] = field.split(".");
      if (!isObject(stored[section]) || typeof stored[section][key] !== "string")
        throw new Error("Invalid secret field");
      const credentialId = `mcp-${name}-${section}-${key}`.toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(credentialId)) throw new Error("Invalid secret name");
      this.credentials.replace(credentialId, { value });
      stored[section][key] = `credential://${credentialId}`;
    }
    config.mcpServers[name] = stored;
    config._openwhispr ||= {};
    const current = this.settings(config, name);
    config._openwhispr[name] = {
      ...current,
      enabled: options.enabled !== false,
      confirmed: old && signature(old) === signature(stored) ? current.confirmed : undefined,
    };
    this.store.write(config);
    this.configText = JSON.stringify(config);
    this.stop(name);
    if (stored.type === "http" || config._openwhispr[name].confirmed) {
      try {
        await this.start(name);
      } catch (error) {
        if (/colliding|Invalid or colliding/.test(error.message)) {
          if (old) config.mcpServers[name] = old;
          else delete config.mcpServers[name];
          if (oldSettings) config._openwhispr[name] = oldSettings;
          else delete config._openwhispr[name];
          this.store.write(config);
          this.configText = JSON.stringify(config);
          throw error;
        }
      }
    }
    return this.list();
  }
  async setEnabled(name, enabled) {
    if (typeof enabled !== "boolean") throw new Error("Invalid enabled value");
    const config = this.config();
    if (!config.mcpServers[name]) throw new Error("Unknown MCP server");
    config._openwhispr ||= {};
    config._openwhispr[name] = { ...this.settings(config, name), enabled };
    this.store.write(config);
    this.configText = JSON.stringify(config);
    if (enabled) {
      try {
        await this.start(name);
      } catch (error) {
        if (/colliding|Invalid or colliding/.test(error.message)) {
          config._openwhispr[name].enabled = false;
          this.store.write(config);
          this.configText = JSON.stringify(config);
        }
        throw error;
      }
    } else this.stop(name);
    return this.list();
  }
  async confirm(name, details) {
    const config = this.config();
    const server = config.mcpServers[name];
    if (
      !server ||
      server.type === "http" ||
      !isObject(details) ||
      details.command !== server.command ||
      JSON.stringify(details.args) !== JSON.stringify(server.args || []) ||
      details.cwd !== (server.cwd || null)
    )
      throw new Error("MCP command confirmation mismatch");
    config._openwhispr ||= {};
    config._openwhispr[name] = { ...this.settings(config, name), confirmed: signature(server) };
    this.store.write(config);
    this.configText = JSON.stringify(config);
    if (this.isEnabled(config, name)) {
      try {
        await this.start(name);
      } catch (error) {
        if (/colliding|Invalid or colliding/.test(error.message)) {
          config._openwhispr[name].enabled = false;
          this.store.write(config);
          this.configText = JSON.stringify(config);
        }
        throw error;
      }
    }
    return this.list();
  }
  setAllow(name, allowed) {
    if (typeof allowed !== "boolean") throw new Error("Invalid approval setting");
    const config = this.config();
    if (!config.mcpServers[name]) throw new Error("Unknown MCP server");
    config._openwhispr ||= {};
    config._openwhispr[name] = { ...this.settings(config, name), allowWithoutAsking: allowed };
    this.store.write(config);
    this.configText = JSON.stringify(config);
    return this.list();
  }
  setResultSize(name, maxResultChars) {
    if (maxResultChars !== null && ![8000, 32000, 64000, 128000, 256000].includes(maxResultChars))
      throw new Error("Invalid MCP result size");
    const config = this.config();
    if (!config.mcpServers[name]) throw new Error("Unknown MCP server");
    config._openwhispr ||= {};
    const settings = { ...this.settings(config, name) };
    if (maxResultChars === null) delete settings.maxResultChars;
    else settings.maxResultChars = maxResultChars;
    config._openwhispr[name] = settings;
    this.store.write(config);
    this.configText = JSON.stringify(config);
    this.revision++;
    return this.list();
  }
  remove(name) {
    const config = this.config();
    if (!config.mcpServers[name]) throw new Error("Unknown MCP server");
    this.stop(name);
    delete config.mcpServers[name];
    if (config._openwhispr) delete config._openwhispr[name];
    this.store.write(config);
    this.configText = JSON.stringify(config);
    return this.list();
  }
  tools(name) {
    if (typeof name !== "string" || !NAME.test(name)) throw new Error("Invalid server name");
    return this.clients.get(name)?.tools || [];
  }
  async call(name, tool, args, signal) {
    if (
      typeof name !== "string" ||
      typeof tool !== "string" ||
      !NAME.test(name) ||
      !NAME.test(tool) ||
      !isObject(args)
    )
      throw new Error("Invalid MCP call");
    const client = this.clients.get(name);
    if (!client || !client.tools.some((item) => item.name === tool))
      throw new Error("MCP tool unavailable");
    return client.call(tool, args, signal);
  }
  recent() {
    return { errors: Object.fromEntries(this.errors), spawns: [...this.spawnLog] };
  }
}
module.exports = { McpManager, signature };
