export const BUTTON_ATTRIBUTE = "data-project-emoji-button";

const PROJECT_ROW_SELECTOR = "[data-sidebar-project-id]";
const LABEL_ANCHOR_SELECTOR = "[data-sidebar-rename-anchor]";

export const BUTTON_CLASS =
  "relative z-20 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sm leading-none outline-none ring-sidebar-ring hover:bg-sidebar-accent focus-visible:ring-2";

export interface DecorateOptions {
  readonly pluginId: string;
  readonly emojiByProject: ReadonlyMap<string, string>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly onOpen: (projectId: string, anchor: HTMLElement) => void;
}

function stopEvent(event: Event): void {
  event.stopPropagation();
}

function labelContainer(row: Element): Element | null {
  return row.querySelector(LABEL_ANCHOR_SELECTOR)?.parentElement ?? null;
}

function createButton(options: DecorateOptions, projectId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = BUTTON_CLASS;
  button.setAttribute("data-bb-plugin", options.pluginId);
  button.setAttribute(BUTTON_ATTRIBUTE, projectId);
  button.addEventListener("pointerdown", stopEvent);
  button.addEventListener("mousedown", stopEvent);
  button.addEventListener("keydown", stopEvent);
  button.addEventListener("dblclick", stopEvent);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onOpen(projectId, button);
  });
  return button;
}

export function decorateProjectRows(root: ParentNode, options: DecorateOptions): void {
  for (const row of root.querySelectorAll(PROJECT_ROW_SELECTOR)) {
    const projectId = row.getAttribute("data-sidebar-project-id");
    if (projectId === null) continue;
    const emoji = options.emojiByProject.get(projectId);
    const container = labelContainer(row);
    const existing = row.querySelector<HTMLButtonElement>(`[${BUTTON_ATTRIBUTE}]`);
    if (emoji === undefined || container === null) {
      existing?.remove();
      continue;
    }
    const button =
      existing !== null && existing.parentElement === container
        ? existing
        : createButton(options, projectId);
    if (button !== existing) existing?.remove();
    if (container.firstElementChild !== button) container.prepend(button);
    if (button.textContent !== emoji) button.textContent = emoji;
    const label = `Change icon for ${options.projectNames.get(projectId) ?? "project"}`;
    if (button.getAttribute("aria-label") !== label) {
      button.setAttribute("aria-label", label);
      button.title = label;
    }
  }
}

export function removeDecorations(root: ParentNode): void {
  for (const button of root.querySelectorAll(`[${BUTTON_ATTRIBUTE}]`)) {
    button.remove();
  }
}
