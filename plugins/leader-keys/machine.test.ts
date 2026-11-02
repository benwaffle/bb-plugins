import { describe, expect, it } from "vitest";
import { parseKeymap } from "./keymap";
import { IDLE, SPACE_HOLD_MS, echo, reduce, startLeader, type Effect, type KeyInput, type LeaderState } from "./machine";

const keymap = parseKeymap(null);

function key(keyValue: string, overrides: Partial<KeyInput> = {}): KeyInput {
  const code =
    keyValue === " " ? "Space" : /^[a-z]$/iu.test(keyValue) ? `Key${keyValue.toUpperCase()}` : /^[0-9]$/u.test(keyValue) ? `Digit${keyValue}` : keyValue;
  return {
    type: "keydown",
    key: keyValue,
    code,
    alt: false,
    ctrl: false,
    meta: false,
    shift: keyValue.length === 1 && keyValue !== keyValue.toLowerCase(),
    repeat: false,
    composing: false,
    defaultPrevented: false,
    focus: "body",
    modalOpen: false,
    questionOpen: false,
    time: 0,
    ...overrides,
  };
}

const up = (keyValue: string, overrides: Partial<KeyInput> = {}) => key(keyValue, { type: "keyup", ...overrides });

/** Feeds inputs in order and returns the final state plus every effect and disposition. */
function run(inputs: KeyInput[], from: LeaderState = IDLE) {
  let state = from;
  const effects: Effect[] = [];
  const dispositions: string[] = [];
  for (const input of inputs) {
    const result = reduce(state, input, keymap);
    state = result.state;
    effects.push(...result.effects);
    dispositions.push(result.disposition);
  }
  return { state, effects, dispositions };
}

/** A Space tap at body focus: down at t=0, up before the push-to-talk hold delay. */
const tap = [key(" ", { time: 0 }), up(" ", { time: 50 })];

describe("leader state machine", () => {
  it.each([
    ["SPC f n", [...tap, key("f"), key("n")], "thread.new", 1],
    ["SPC f R (shifted)", [...tap, key("f"), key("R")], "thread.rename", 1],
    ["SPC SPC", [...tap, key(" ", { time: 100 })], "thread.search", 1],
    ["SPC :", [...tap, key(":", { shift: true })], "palette.open", 1],
    ["SPC TAB", [...tap, key("Tab")], "composer.focus", 1],
    ["SPC w l", [...tap, key("w"), key("l")], "pane.focus.right", 1],
  ])("runs %s", (_label, inputs, action, times) => {
    const { state, effects } = run(inputs);
    expect(state).toEqual(IDLE);
    expect(effects).toEqual([expect.objectContaining({ type: "run", action, times })]);
  });

  it("leaves a held Space to push-to-talk", () => {
    const { state, effects, dispositions } = run([
      key(" ", { time: 0 }),
      key(" ", { time: 30, repeat: true }),
      up(" ", { time: SPACE_HOLD_MS + 50 }),
      key("f"),
    ]);
    expect(state).toEqual(IDLE);
    expect(effects).toEqual([]);
    expect(dispositions.at(-1)).toBe("pass");
  });

  it("takes a fast roll as a sequence without hiding the key from push-to-talk", () => {
    const { state, effects, dispositions } = run([key(" ", { time: 0 }), key("f", { time: 40 }), key("n", { time: 60 })]);
    expect(state).toEqual(IDLE);
    expect(effects).toEqual([expect.objectContaining({ action: "thread.new" })]);
    expect(dispositions).toEqual(["prevent", "swallow", "own"]);
  });

  it.each([
    ["in the composer", { focus: "editable" as const }],
    ["on a button", { focus: "interactive" as const }],
    ["in the terminal", { focus: "terminal" as const }],
    ["with a modal open", { modalOpen: true }],
    ["with Shift", { shift: true }],
    ["after another listener handled it", { defaultPrevented: true }],
  ])("ignores bare Space %s", (_label, overrides) => {
    const { state, dispositions } = run([key(" ", overrides), up(" ", { ...overrides, time: 50 })]);
    expect(state).toEqual(IDLE);
    expect(dispositions).toEqual(["pass", "pass"]);
  });

  it("starts from Option+Space in the composer and owns the event", () => {
    const { state, dispositions } = run([key(" ", { code: "Space", alt: true, focus: "editable" })]);
    expect(state).toMatchObject({ mode: "pending", keys: [] });
    expect(dispositions).toEqual(["own"]);
  });

  it("does not start from Option+Space while a modal is open", () => {
    const { state } = run([key(" ", { code: "Space", alt: true, modalOpen: true })]);
    expect(state).toEqual(IDLE);
  });

  it("passes Option+Space through in a terminal when terminalFallback is off", () => {
    const local = parseKeymap(JSON.stringify({ terminalFallback: false }));
    const result = reduce(IDLE, key(" ", { code: "Space", alt: true, focus: "terminal" }), local);
    expect(result.state).toEqual(IDLE);
    expect(result.disposition).toBe("pass");
  });

  it("cancels on Escape and swallows it so bb's Back does not also fire", () => {
    const { state, effects, dispositions } = run([...tap, key("f"), key("Escape")]);
    expect(state).toEqual(IDLE);
    expect(effects).toEqual([]);
    expect(dispositions.at(-1)).toBe("own");
  });

  it("goes up one level on Backspace", () => {
    const { state } = run([...tap, key("f"), key("Backspace")]);
    expect(state).toMatchObject({ mode: "pending", keys: [] });
    expect(run([...tap, key("Backspace")]).state).toEqual(IDLE);
  });

  it("reports an unbound key and returns to idle", () => {
    const { state, effects } = run([...tap, key("f"), key("z")]);
    expect(state).toEqual(IDLE);
    expect(effects).toEqual([{ type: "undefined", keys: ["f", "z"] }]);
  });

  it("cancels on a Cmd chord and lets it through to bb", () => {
    const { state, dispositions } = run([...tap, key("k", { meta: true })]);
    expect(state).toEqual(IDLE);
    expect(dispositions.at(-1)).toBe("pass");
  });

  it("opens the cheat sheet on ? at the root", () => {
    expect(run([...tap, key("?", { shift: true })]).effects).toEqual([{ type: "cheat-sheet" }]);
  });

  it("repeats movement by a count typed before the leader", () => {
    const { effects } = run([key("1"), key("2"), ...tap, key("f"), key("j")]);
    expect(effects).toEqual([expect.objectContaining({ action: "thread.next", times: 12 })]);
  });

  it("runs a non-repeatable command once whatever the count", () => {
    const { effects } = run([key("3"), ...tap, key("f"), key("n")]);
    expect(effects).toEqual([expect.objectContaining({ action: "thread.new", times: 1 })]);
  });

  it("takes a count after SPC u", () => {
    const { effects } = run([...tap, key("u"), key("4"), key("b"), key("n")]);
    expect(effects).toEqual([expect.objectContaining({ action: "panel.nextTab", times: 4 })]);
  });

  it("does not take digits as a count while a question is open", () => {
    const { state } = run([key("3", { questionOpen: true })]);
    expect(state).toEqual(IDLE);
  });

  it("describes the next sequence instead of running it after SPC h k", () => {
    const { state, effects } = run([...tap, key("h"), key("k"), key("f"), key("n")]);
    expect(state).toEqual(IDLE);
    expect(effects).toEqual([{ type: "describe", keys: ["f", "n"], action: "thread.new" }]);
  });

  it("starts from bb's Leader key command and keeps a pending count", () => {
    expect(startLeader({ mode: "count", count: 5 })).toMatchObject({ mode: "pending", count: 5 });
    const pendingState = run(tap).state;
    expect(startLeader(pendingState)).toBe(pendingState);
  });

  it("echoes the pending keys", () => {
    expect(echo(run([key("3"), ...tap, key("f")]).state)).toBe("3 SPC f -");
    expect(echo(IDLE)).toBeNull();
  });
});
