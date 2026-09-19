/**
 * agents-master-switch.test.ts — `/agents on|off`, the session master switch.
 *
 * The point of the feature is a quiet default: a fresh session must not carry
 * the subagent tool specs in its system prompt, and `/agents on` must bring them
 * back in place, without a reload. `setActiveTools` is what makes that real, so
 * what these tests pin is the active set on either side of the toggle — plus the
 * footer label and that the no-argument form still opens the menu.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

let hermetic: Hermetic;

beforeEach(() => {
  hermetic = hermeticDir();
});

afterEach(() => {
  hermetic.restore();
});

/** Boot the real extension and hand back its `/agents` command. */
function boot() {
  const booted = makePi();
  subagentsExtension(booted.pi);
  // The mock starts with an empty registry; real pi reports every registered
  // tool here, which is what the switch reads before re-adding a name. The
  // description matters: the workflow-collision check identifies our own tool by
  // it, and a description-less entry reads as a foreign `SubagentWorkflow`.
  booted.pi.getAllTools = vi.fn(() =>
    [...booted.tools.values()].map((t: any) => ({ name: t.name, description: t.description })),
  );
  const command = booted.commands.get("agents");
  if (!command) throw new Error("the extension did not register /agents");
  return { ...booted, command };
}

/** A session_start ctx with the UI surface the gate and the status line touch. */
const uiCtx = () =>
  ctx({
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      addAutocompleteProvider: vi.fn(),
    },
  });

/** Tools the master switch governs. */
const GOVERNED = ["Agent", "get_subagent_result", "steer_subagent", "SubagentWorkflow"];

describe("the subagent master switch", () => {
  it("starts every session with the subagent tools withdrawn", async () => {
    const { lifecycle, pi } = boot();

    // Registered and active before the session starts, exactly as pi loads them.
    expect(pi.getActiveTools()).toEqual(expect.arrayContaining(GOVERNED));

    await lifecycle.get("session_start")({ type: "session_start" }, uiCtx());

    const active = pi.getActiveTools();
    for (const name of GOVERNED) expect(active).not.toContain(name);

    // Still registered, so `/agents on` can bring them back without a reload.
    expect(pi.getAllTools().map((t: any) => t.name)).toEqual(expect.arrayContaining(GOVERNED));
  });

  it("reports `Subagents: off` in the footer by default", async () => {
    const { lifecycle } = boot();
    const c = uiCtx();

    await lifecycle.get("session_start")({ type: "session_start" }, c);

    expect(c.ui.setStatus).toHaveBeenCalledWith("subagents", "Subagents: off");
  });

  it("starts enabled when `subagentsEnabled` is set in settings", async () => {
    // The persisted start state. A session toggle never writes it back, so this
    // is the only way to begin with the tools active.
    hermetic.restore();
    hermetic = hermeticDir({ settings: { subagentsEnabled: true } });
    const { lifecycle, pi } = boot();
    const c = uiCtx();

    await lifecycle.get("session_start")({ type: "session_start" }, c);

    const active = pi.getActiveTools();
    for (const name of GOVERNED) expect(active).toContain(name);
    expect(c.ui.setStatus).toHaveBeenCalledWith("subagents", "Subagents: on");
  });

  it("`/agents on` restores the tools and the label in the same session", async () => {
    const { lifecycle, command, pi } = boot();
    const c = uiCtx();
    await lifecycle.get("session_start")({ type: "session_start" }, c);

    await command.handler("on", c);

    const active = pi.getActiveTools();
    for (const name of GOVERNED) expect(active).toContain(name);
    expect(c.ui.setStatus).toHaveBeenCalledWith("subagents", "Subagents: on");
    expect(c.ui.notify).toHaveBeenCalledWith("Subagents: on", "info");
  });

  it("`/agents off` withdraws the tools again", async () => {
    const { lifecycle, command, pi } = boot();
    const c = uiCtx();
    await lifecycle.get("session_start")({ type: "session_start" }, c);
    await command.handler("on", c);

    await command.handler("off", c);

    const active = pi.getActiveTools();
    for (const name of GOVERNED) expect(active).not.toContain(name);
    expect(c.ui.setStatus).toHaveBeenCalledWith("subagents", "Subagents: off");
  });

  it("does not touch tools that are not ours", async () => {
    const { lifecycle, command, pi } = boot();
    const c = uiCtx();
    await lifecycle.get("session_start")({ type: "session_start" }, c);

    // A built-in the switch must never remove.
    pi.setActiveTools([...pi.getActiveTools(), "read"]);
    await command.handler("off", c);

    expect(pi.getActiveTools()).toContain("read");
  });

  it("`/agents` with no args still opens the menu", async () => {
    const { lifecycle, command } = boot();
    const c = uiCtx();
    c.ui.select = vi.fn(async () => undefined);
    await lifecycle.get("session_start")({ type: "session_start" }, c);

    await command.handler("", c);

    expect(c.ui.select).toHaveBeenCalled();
  });

  it("rejects an unknown argument without opening the menu", async () => {
    const { lifecycle, command } = boot();
    const c = uiCtx();
    c.ui.select = vi.fn(async () => undefined);
    await lifecycle.get("session_start")({ type: "session_start" }, c);

    await command.handler("banana", c);

    expect(c.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "warning");
    expect(c.ui.select).not.toHaveBeenCalled();
  });

  it("colors the footer label `muted`, like the neighbouring statuses", async () => {
    const { lifecycle } = boot();
    const c = uiCtx();
    c.ui.theme = { fg: vi.fn((_color: string, text: string) => `<${text}>`) };

    await lifecycle.get("session_start")({ type: "session_start" }, c);

    expect(c.ui.theme.fg).toHaveBeenCalledWith("muted", "Subagents: off");
    expect(c.ui.setStatus).toHaveBeenCalledWith("subagents", "<Subagents: off>");
  });

  it("tells the model the state, so it need not infer it from absent tools", async () => {
    const { lifecycle, command } = boot();
    const c = uiCtx();
    await lifecycle.get("session_start")({ type: "session_start" }, c);
    const hook = lifecycle.get("before_agent_start");

    const off = await hook({ systemPrompt: "SYS" }, c);
    expect(off.systemPrompt).toContain("Subagents are OFF");
    // Appended to the caller's prompt, never replacing it.
    expect(off.systemPrompt.startsWith("SYS")).toBe(true);

    await command.handler("on", c);
    const on = await hook({ systemPrompt: "SYS" }, c);
    expect(on.systemPrompt).toContain("Subagents are ON");
  });
});
