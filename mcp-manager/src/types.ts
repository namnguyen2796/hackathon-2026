export interface ManagedServerConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  restartDelayMs?: number;
}

export interface ServersConfigFile {
  servers: Record<string, ManagedServerConfig>;
}

export type ServerStatus = "starting" | "running" | "stopped" | "crashed" | "restarting";

export interface ManagedServerInfo {
  name: string;
  status: ServerStatus;
  pid?: number;
  startedAt?: string;
  restartCount: number;
  lastError?: string;
}
