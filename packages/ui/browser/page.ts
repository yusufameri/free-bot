/**
 * The export's page vocabulary, shared by the Workspace pages and the Connect apps screen.
 *
 * These are the classes `apps/web/host/index.html` already styles: `.page`, `.page-inner`,
 * `.page-title`, `.card`, `.listcard`, `.listrow`, `.tag`, `.kv`, `.empty-state`, and the two button
 * shapes. Nothing here invents a visual language; each helper builds one of those and the page's own
 * CSS gives it its look.
 */

export function must<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`missing element ${selector}`);
  return found;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

export function icon(name: string, size: "ic" | "ic-sm" = "ic-sm"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", size);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export function tag(text: string, variant: "" | "solid" | "dim" = ""): HTMLElement {
  return el("span", `tag${variant === "" ? "" : ` ${variant}`}`, text);
}

export function kv(label: string, value: string): HTMLElement {
  const row = el("div", "kv");
  row.append(el("span", "k", label), el("span", "v", value));
  return row;
}

export function card(children: readonly HTMLElement[], className = "card"): HTMLElement {
  const node = el("div", className);
  node.append(...children);
  return node;
}

export function emptyState(title: string, body: string): HTMLElement {
  const box = el("div", "card empty-state");
  box.append(el("h3", "", title), el("p", "hint", body));
  return box;
}

export function pageShell(
  title: string,
  eyebrow: string,
  actions: readonly HTMLElement[],
  body: readonly HTMLElement[],
  narrow = false,
): HTMLElement {
  const page = el("div", "page");
  const inner = el("div", `page-inner${narrow ? " narrow" : ""}`);
  const head = el("div", "page-title");
  const titles = el("div");
  titles.append(el("p", "eyebrow", eyebrow), el("h1", "", title));
  const controls = el("div", "row");
  controls.style.flexWrap = "wrap";
  controls.append(...actions);
  head.append(titles, controls);
  inner.append(head, ...body);
  page.append(inner);
  return page;
}

export function backButton(onLeave: () => void): HTMLButtonElement {
  const button = el("button", "btn btn-ghost btn-sm");
  button.type = "button";
  button.append(icon("left"), document.createTextNode("Back to the conversation"));
  button.addEventListener("click", onLeave);
  return button;
}

export function actionButton(
  label: string,
  iconName: string,
  onClick: () => void,
  variant: "btn-secondary" | "btn-ghost" = "btn-secondary",
  disabled = false,
): HTMLButtonElement {
  const button = el("button", `btn ${variant} btn-sm`);
  button.type = "button";
  button.disabled = disabled;
  button.append(icon(iconName), document.createTextNode(label));
  button.addEventListener("click", onClick);
  return button;
}
