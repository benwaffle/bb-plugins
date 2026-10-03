// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUTTON_ATTRIBUTE, decorateProjectRows, removeDecorations } from "./decorate.js";

function projectRow(projectId: string, name: string): string {
  return `
    <div data-sidebar-project-id="${projectId}">
      <div data-sidebar-rename-row="">
        <div>
          <span class="label">
            <span title="${name}">${name}</span>
            <button data-sidebar-rename-anchor="">toggle</button>
          </span>
        </div>
      </div>
      <div class="threads">
        <span><button data-sidebar-rename-anchor="">thread</button></span>
      </div>
    </div>`;
}

function render(): void {
  document.body.innerHTML = projectRow("proj_a", "alpha") + projectRow("proj_b", "beta");
}

function options(emoji: Record<string, string>, onOpen = vi.fn()) {
  return {
    pluginId: "project-emoji",
    emojiByProject: new Map(Object.entries(emoji)),
    projectNames: new Map([
      ["proj_a", "alpha"],
      ["proj_b", "beta"],
    ]),
    onOpen,
  };
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`[${BUTTON_ATTRIBUTE}]`)];
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("decorateProjectRows", () => {
  it("puts one emoji button before each project title, not on thread rows", () => {
    render();
    decorateProjectRows(document, options({ proj_a: "🐙", proj_b: "🚀" }));
    decorateProjectRows(document, options({ proj_a: "🐙", proj_b: "🚀" }));

    expect(buttons().map((button) => button.textContent)).toEqual(["🐙", "🚀"]);
    const first = buttons()[0]!;
    expect(first.parentElement?.className).toBe("label");
    expect(first.nextElementSibling?.textContent).toBe("alpha");
    expect(first.getAttribute("aria-label")).toBe("Change icon for alpha");
    expect(first.getAttribute("data-bb-plugin")).toBe("project-emoji");
    expect(document.querySelector(".threads [data-project-emoji-button]")).toBeNull();
  });

  it("updates the emoji in place and drops it when the project has none", () => {
    render();
    decorateProjectRows(document, options({ proj_a: "🐙", proj_b: "🚀" }));
    const original = buttons()[0];
    decorateProjectRows(document, options({ proj_a: "🦀" }));
    expect(buttons().map((button) => button.textContent)).toEqual(["🦀"]);
    expect(buttons()[0]).toBe(original);
  });

  it("opens the picker on click without letting the row see the click", () => {
    render();
    const onOpen = vi.fn();
    const rowClick = vi.fn();
    document.querySelector("[data-sidebar-project-id]")!.addEventListener("click", rowClick);
    decorateProjectRows(document, options({ proj_a: "🐙" }, onOpen));
    buttons()[0]!.click();
    expect(onOpen).toHaveBeenCalledWith("proj_a", buttons()[0]);
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("re-adds the button after the host re-renders the row", () => {
    render();
    decorateProjectRows(document, options({ proj_a: "🐙" }));
    render();
    expect(buttons()).toEqual([]);
    decorateProjectRows(document, options({ proj_a: "🐙" }));
    expect(buttons().map((button) => button.textContent)).toEqual(["🐙"]);
  });

  it("removes every button it added", () => {
    render();
    decorateProjectRows(document, options({ proj_a: "🐙", proj_b: "🚀" }));
    removeDecorations(document);
    expect(buttons()).toEqual([]);
  });
});
