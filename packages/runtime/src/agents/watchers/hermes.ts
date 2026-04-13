import { existsSync } from "fs";
import { readdir, stat } from "fs/promises";
import { homedir } from "os";
import { join, basename } from "path";
import type { AgentStatus } from "../../contracts/agent";
import type { AgentWatcher, AgentWatcherContext } from "../../contracts/agent-watcher";

interface HermesMessage {
  role?: string;
  content?: unknown;
  finish_reason?: string | null;
  finishReason?: string | null;
}

interface HermesSession {
  session_id?: string;
  messages?: HermesMessage[];
  last_updated?: number;
  title?: string;
  cwd?: string;
  project_dir?: string;
  projectDir?: string;
}

interface SessionState {
  status: AgentStatus;
  fileSize: number;
  threadName?: string;
  projectDir?: string;
  toolUseSeenAt?: number;
  lastGrowthAt?: number;
  lastMtimeMs?: number;
}

const POLL_MS = 2000;
const STALE_MS = 5 * 60 * 1000;
const TOOL_WAIT_MS = 3000;
const STUCK_MS = 15_000;

const INTERRUPT_PATTERNS = [
  "[Request interrupted",
  "interrupted by user",
  "KeyboardInterrupt",
  "cancelled by user",
];

const ERROR_PATTERNS = [
  "error:",
  "fatal:",
  "traceback",
  "exception",
  "failed",
];

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

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

export function determineStatus(message: HermesMessage): AgentStatus | null {
  const role = message.role;
  if (!role) return null;

  const text = normalizeMessageContent(message.content).toLowerCase();
  const finish = (message.finish_reason ?? message.finishReason ?? "")?.toLowerCase();

  if (INTERRUPT_PATTERNS.some((p) => text.includes(p.toLowerCase()))) return "interrupted";
  if (finish === "interrupted") return "interrupted";

  if (role === "assistant") {
    if (finish === "error" || finish === "failed") return "error";
    if (ERROR_PATTERNS.some((p) => text.includes(p))) return "error";
    if (finish === "tool_use" || finish === "tooluse" || finish === "tool_calls") return "tool-running";
    if (!finish) return "running";
    if (finish === "stop" || finish === "end_turn") return "done";
    return "done";
  }

  if (role === "user") {
    if (text.includes("/exit")) return "done";
    return "running";
  }

  return null;
}

function extractThreadName(messages: HermesMessage[]): string | undefined {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = normalizeMessageContent(m.content).trim();
    if (!text || text.startsWith("[") || text.startsWith("{")) continue;
    return text.slice(0, 80);
  }
  return undefined;
}

function extractProjectDir(session: HermesSession): string | undefined {
  const direct = session.cwd ?? session.project_dir ?? session.projectDir;
  if (direct && typeof direct === "string") return direct;

  const messages = session.messages ?? [];
  const pathPattern = /(\/(?:Users|home|workspace)\/[\w./-]+)/g;
  for (const m of messages) {
    const text = normalizeMessageContent(m.content);
    const match = text.match(pathPattern);
    if (!match || match.length === 0) continue;
    for (const raw of match) {
      const cleaned = raw.replace(/\\n.*$/, "").replace(/[\",;)]$/, "");
      if (cleaned.split("/").length >= 4) return cleaned;
    }
  }

  return undefined;
}

function deriveStatus(session: HermesSession): AgentStatus {
  const messages = session.messages ?? [];
  let status: AgentStatus = "idle";
  for (const m of messages) {
    const s = determineStatus(m);
    if (s !== null) status = s;
  }
  return status;
}

export class HermesAgentWatcher implements AgentWatcher {
  readonly name = "hermes";

  private ctx: AgentWatcherContext | null = null;
  private sourcePath: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sessions = new Map<string, SessionState>();
  private scanning = false;
  private seeded = false;

  start(ctx: AgentWatcherContext): void {
    this.ctx = ctx;
    this.sourcePath = resolveHermesSource();
    if (!this.sourcePath) return;

    setTimeout(() => void this.scan(), 50);
    this.pollTimer = setInterval(() => void this.scan(), POLL_MS);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.ctx = null;
    this.sourcePath = null;
    this.sessions.clear();
    this.scanning = false;
    this.seeded = false;
  }

  private emit(threadId: string, state: SessionState): void {
    if (!this.ctx || !this.seeded || !state.projectDir) return;
    const mapped = this.ctx.resolveSession(state.projectDir);
    if (!mapped) return;
    this.ctx.emit({
      agent: "hermes",
      session: mapped,
      status: state.status,
      ts: Date.now(),
      threadId,
      threadName: state.threadName,
    });
  }

  private async processFile(filePath: string): Promise<void> {
    if (!this.ctx) return;

    let size: number;
    let mtimeMs: number;
    try {
      const s = await stat(filePath);
      size = s.size;
      mtimeMs = s.mtimeMs;
    } catch {
      return;
    }

    const threadId = basename(filePath, ".json");
    const prev = this.sessions.get(threadId);

    if (prev && size === prev.fileSize) {
      const now = Date.now();
      if (prev.status === "tool-running" && prev.toolUseSeenAt && now - prev.toolUseSeenAt >= TOOL_WAIT_MS) {
        prev.status = "waiting";
        prev.toolUseSeenAt = undefined;
        this.emit(threadId, prev);
      }
      if ((prev.status === "running" || prev.status === "tool-running" || prev.status === "waiting") && prev.lastGrowthAt && now - prev.lastGrowthAt >= STUCK_MS) {
        prev.status = "stale";
        prev.toolUseSeenAt = undefined;
        prev.lastGrowthAt = undefined;
        this.emit(threadId, prev);
      }
      return;
    }

    let doc: HermesSession;
    try {
      doc = JSON.parse(await Bun.file(filePath).text()) as HermesSession;
    } catch {
      return;
    }

    const status = deriveStatus(doc);
    const threadName = doc.title ?? extractThreadName(doc.messages ?? []);
    const projectDir = extractProjectDir(doc);

    const now = Date.now();
    const next: SessionState = {
      status,
      fileSize: size,
      threadName,
      projectDir,
      toolUseSeenAt: status === "tool-running" ? now : undefined,
      lastMtimeMs: mtimeMs,
      lastGrowthAt: status === "running" || status === "tool-running" || status === "waiting" ? now : undefined,
    };

    const prevStatus = prev?.status;
    const prevName = prev?.threadName;
    this.sessions.set(threadId, next);

    if (status !== prevStatus || threadName !== prevName) {
      this.emit(threadId, next);
    }
  }

  private async scan(): Promise<void> {
    if (!this.sourcePath || !this.ctx || this.scanning) return;
    this.scanning = true;
    try {
      let files: string[];
      try {
        files = await readdir(this.sourcePath);
      } catch {
        return;
      }

      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(this.sourcePath, file);
        try {
          const fileStat = await stat(filePath);
          if (now - fileStat.mtimeMs > STALE_MS) continue;
        } catch {
          continue;
        }
        await this.processFile(filePath);
      }
    } finally {
      if (!this.seeded) {
        this.seeded = true;
        for (const [threadId, state] of this.sessions) {
          if (state.status === "idle" || !state.projectDir) continue;
          const session = this.ctx?.resolveSession(state.projectDir);
          if (!session) continue;
          this.ctx?.emit({
            agent: "hermes",
            session,
            status: state.status,
            ts: state.lastMtimeMs ?? Date.now(),
            threadId,
            threadName: state.threadName,
          });
        }
      }
      this.scanning = false;
    }
  }
}
