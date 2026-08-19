import { bindPreferencePane, registerPreferencePane } from "./prefs";
import { CompanionUI } from "./ui";

const interfaces = new Map<Window, CompanionUI>();

function createReaderToolbarButton(doc: Document): HTMLButtonElement {
  const button = doc.createElement("button");
  button.id = "papercompanion-reader-toolbar-button";
  button.type = "button";
  button.className = "toolbar-button";
  button.title = "your_zotero（Ctrl+2）";
  button.setAttribute("aria-label", "打开 your_zotero");
  button.style.cssText =
    "width:28px;height:28px;padding:3px;border:0;background:transparent;cursor:pointer;box-sizing:border-box;";
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("style", "display:block;width:22px;height:22px;pointer-events:none;");
  const tile = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
  tile.setAttribute("x", "2");
  tile.setAttribute("y", "2");
  tile.setAttribute("width", "20");
  tile.setAttribute("height", "20");
  tile.setAttribute("rx", "6");
  tile.setAttribute("fill", "#5b7df5");
  const page = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  page.setAttribute("d", "M7 6h7.2A2.8 2.8 0 0 1 17 8.8V17H9.8A2.8 2.8 0 0 1 7 14.2V6Z");
  page.setAttribute("fill", "white");
  const sparkle = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  sparkle.setAttribute("d", "m17.2 13 .7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z");
  sparkle.setAttribute("fill", "#20243a");
  svg.append(tile, page, sparkle);
  button.append(svg);
  button.addEventListener("click", () => {
    const win = Zotero.getMainWindow();
    const ui = interfaces.get(win);
    if (ui) void ui.toggle();
  });
  return button;
}

const readerToolbarHandler: _ZoteroTypes.Reader.EventHandler<"renderToolbar"> = ({
  doc,
  append,
}) => {
  if (doc.getElementById("papercompanion-reader-toolbar-button")) return;
  append(createReaderToolbarButton(doc));
};

function injectExistingReaderToolbarButtons(): void {
  for (const reader of Zotero.Reader._readers) {
    const doc = reader._iframeWindow?.document;
    if (!doc || doc.getElementById("papercompanion-reader-toolbar-button")) continue;
    const customSections = doc.querySelector(".toolbar .custom-sections");
    if (!customSections) continue;
    const section = doc.createElement("div");
    section.className = "section";
    section.dataset.paperCompanion = "true";
    section.append(createReaderToolbarButton(doc));
    customSections.append(section);
  }
}

function injectStyle(win: Window): void {
  if (win.document.getElementById("papercompanion-style")) return;
  const link = win.document.createElementNS("http://www.w3.org/1999/xhtml", "link");
  link.id = "papercompanion-style";
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("href", "chrome://your_zotero/content/papercompanion.css");
  win.document.documentElement?.append(link);
}

function registerToolsMenu(win: Window, ui: CompanionUI): void {
  if (win.document.getElementById("papercompanion-tools-menu")) return;
  const popup = win.document.getElementById("menu_ToolsPopup");
  if (!popup) return;
  const menuItem = win.document.createXULElement("menuitem");
  menuItem.id = "papercompanion-tools-menu";
  menuItem.setAttribute("label", "your_zotero");
  menuItem.setAttribute("accesskey", "P");
  menuItem.addEventListener("command", () => void ui.toggle());
  popup.append(menuItem);
}

async function onStartup(): Promise<void> {
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise]);
  // Reader tabs restored at launch can render their toolbar before uiReady.
  // Register here so those initial render events are not missed.
  Zotero.Reader.registerEventListener(
    "renderToolbar",
    readerToolbarHandler,
    "your_zotero@zotero.local",
  );
  await Zotero.uiReadyPromise;
  registerPreferencePane();
  for (const win of Zotero.getMainWindows()) await onMainWindowLoad(win);
  injectExistingReaderToolbarButtons();
  ((Zotero as unknown as Record<string, unknown>).YourZotero as YourZoteroGlobal).initialized =
    true;
}

async function onMainWindowLoad(win: Window): Promise<void> {
  if (interfaces.has(win)) return;
  injectStyle(win);
  const ui = new CompanionUI(win);
  interfaces.set(win, ui);
  registerToolsMenu(win, ui);
  injectExistingReaderToolbarButtons();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  interfaces.get(win)?.destroy();
  interfaces.delete(win);
  win.document.getElementById("papercompanion-style")?.remove();
  win.document.getElementById("papercompanion-tools-menu")?.remove();
}

async function onShutdown(): Promise<void> {
  Zotero.Reader.unregisterEventListener("renderToolbar", readerToolbarHandler);
  for (const reader of Zotero.Reader._readers) {
    const button = reader._iframeWindow?.document.getElementById(
      "papercompanion-reader-toolbar-button",
    );
    const section = button?.closest('[data-paper-companion="true"]');
    if (section) section.remove();
    else button?.remove();
  }
  for (const [win, ui] of interfaces) {
    ui.destroy();
    win.document.getElementById("papercompanion-style")?.remove();
    win.document.getElementById("papercompanion-tools-menu")?.remove();
  }
  interfaces.clear();
  ((Zotero as unknown as Record<string, unknown>).YourZotero as YourZoteroGlobal).initialized =
    false;
  delete (Zotero as unknown as Record<string, unknown>).YourZotero;
}

function onPrefsLoad(win: Window): void {
  bindPreferencePane(win);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsLoad,
};
