import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AgentWatcher, AgentWatcherContext } from "../../contracts/agent-watcher";

function resolveHermesSource(): string | null {
  const explicit = process.env.HERMES_LOG_PATH?.trim();
  if (explicit) return explicit;

  const home = homedir();
  const candidates = [
    join(home, ".hermes", "sessions"),
    join(home, ".local", "share", "hermes", "sessions"),
    join(home, ".config", "hermes", "sessions"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

export class HermesAgentWatcher implements AgentWatcher {
  readonly name = "hermes";

  private ctx: AgentWatcherContext | null = null;
  private sourcePath: string | null = null;

  start(ctx: AgentWatcherContext): void {
    this.ctx = ctx;
    this.sourcePath = resolveHermesSource();

    if (!this.sourcePath) {
      return;
    }

    // Source-specific integration will be added once Hermes event format is confirmed.
  }

  stop(): void {
    this.ctx = null;
    this.sourcePath = null;
  }
}
