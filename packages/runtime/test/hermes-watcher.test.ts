import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HermesAgentWatcher, determineStatus } from "../src/agents/watchers/hermes";
import type { AgentEvent } from "../src/contracts/agent";
import type { AgentWatcherContext } from "../src/contracts/agent-watcher";

describe("Hermes determineStatus", () => {
  test("returns running for user messages", () => {
    expect(determineStatus({ role: "user", content: "start task" })).toBe("running");
  });

  test("returns done for assistant stop", () => {
    expect(determineStatus({ role: "assistant", content: "done", finish_reason: "stop" })).toBe("done");
  });

  test("returns tool-running for tool_use", () => {
    expect(determineStatus({ role: "assistant", content: "tool", finish_reason: "tool_use" })).toBe("tool-running");
  });

  test("returns tool-running for tool_calls", () => {
    expect(determineStatus({ role: "assistant", content: "tool", finish_reason: "tool_calls" })).toBe("tool-running");
  });

  test("returns interrupted for interruption text", () => {
    expect(determineStatus({ role: "assistant", content: "[Request interrupted by user]" })).toBe("interrupted");
  });
});

describe("HermesAgentWatcher", () => {
  let root: string;
  let sessionsDir: string;
  let sessionFile: string;
  let watcher: HermesAgentWatcher;
  let events: AgentEvent[];
  let ctx: AgentWatcherContext;

  beforeEach(() => {
    root = join(tmpdir(), `hermes-watcher-test-${Date.now()}`);
    sessionsDir = join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    sessionFile = join(sessionsDir, "session_20260413_143121_0c8f8a.json");
    writeFileSync(sessionFile, JSON.stringify({
      session_id: "20260413_143121_0c8f8a",
      title: "Hermes Feature",
      messages: [
        { role: "user", content: "Implement feature" },
        { role: "assistant", content: "Working..." },
      ],
    }));

    process.env.HERMES_LOG_PATH = sessionsDir;

    events = [];
    ctx = {
      resolveSession: (dir) => dir === "/Users/bytedance/workspace/code/fe/cloud-phone-dashboard" ? "cloud-phone-dashboard" : null,
      emit: (event) => events.push(event),
    };

    watcher = new HermesAgentWatcher();
  });

  afterEach(() => {
    watcher.stop();
    delete process.env.HERMES_LOG_PATH;
    rmSync(root, { recursive: true, force: true });
  });

  test("seed scan emits status for mapped session", async () => {
    writeFileSync(sessionFile, JSON.stringify({
      session_id: "20260413_143121_0c8f8a",
      title: "Hermes Feature",
      messages: [
        { role: "user", content: "status" },
        { role: "assistant", content: "{\"output\": \"/Users/bytedance/workspace/code/fe/cloud-phone-dashboard\\n\"}" },
        { role: "assistant", content: "done", finish_reason: "stop" },
      ],
    }));

    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1]!;
    expect(last.agent).toBe("hermes");
    expect(last.session).toBe("cloud-phone-dashboard");
    expect(last.status).toBe("done");
  });

  test("emits updated status when file changes", async () => {
    writeFileSync(sessionFile, JSON.stringify({
      session_id: "20260413_143121_0c8f8a",
      title: "Hermes Feature",
      messages: [
        { role: "user", content: "status" },
        { role: "assistant", content: "{\"output\": \"/Users/bytedance/workspace/code/fe/cloud-phone-dashboard\\n\"}" },
        { role: "assistant", content: "thinking" },
      ],
    }));

    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const seedCount = events.length;

    writeFileSync(sessionFile, JSON.stringify({
      session_id: "20260413_143121_0c8f8a",
      title: "Hermes Feature",
      messages: [
        { role: "user", content: "status" },
        { role: "assistant", content: "{\"output\": \"/Users/bytedance/workspace/code/fe/cloud-phone-dashboard\\n\"}" },
        { role: "assistant", content: "done", finish_reason: "stop" },
      ],
    }));

    await new Promise((resolve) => setTimeout(resolve, 2300));
    const post = events.slice(seedCount);
    expect(post.length).toBeGreaterThanOrEqual(1);
    expect(post[post.length - 1]!.status).toBe("done");
  });
});
