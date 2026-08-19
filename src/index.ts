import hooks from "./hooks";

const zoteroGlobal = Zotero as unknown as Record<string, unknown>;
if (!zoteroGlobal.YourZotero) {
  zoteroGlobal.YourZotero = {
    initialized: false,
    hooks,
  };
}

