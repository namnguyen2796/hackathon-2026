import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export interface ChildProcessTransportOptions {
  cwd: string;
  env?: Record<string, string>;
}

/** Minimal MCP stdio client transport we own outright, so the child's pid and kill control
 *  are ours rather than the SDK's internals. MCP stdio framing is one JSON-RPC message per line. */
export class ChildProcessTransport {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";

  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  onStderr?: (text: string) => void;
  onExit?: (code: number | null) => void;

  constructor(
    private command: string,
    private args: string[],
    private options: ChildProcessTransportOptions
  ) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    const child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr?.(chunk.toString()));
    child.on("error", (err) => this.onerror?.(err));
    child.on("exit", (code) => {
      this.onExit?.(code);
      this.onclose?.();
    });

    // Resolve only once the OS has actually started the process, so a bad command surfaces
    // here instead of as a silent hang waiting for an `initialize` response that never comes.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  private handleChunk(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      } catch {
        this.onerror?.(new Error(`Failed to parse message from child: ${line}`));
      }
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child?.stdin.writable) {
      throw new Error("Child process is not running");
    }
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async close(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }
}
