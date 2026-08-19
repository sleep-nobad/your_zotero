/**
 * Bootstrapped Zotero extension entry point.
 * Structure follows Zotero's official Make It Red example and developer documentation.
 */

var chromeHandle;

function install() {}

async function startup({ rootURI }) {
  const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"].getService(
    Components.interfaces.amIAddonManagerStartup,
  );
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "content/"],
  ]);

  const context = {
    rootURI,
    Zotero,
    Services,
    Components,
    ChromeUtils,
    PathUtils,
    IOUtils,
  };
  context._globalThis = context;
  Services.scriptloader.loadSubScript(rootURI + "content/scripts/__addonRef__.js", context);
  await Zotero.__addonInstance__.hooks.onStartup();
}

async function onMainWindowLoad({ window }) {
  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown(_data, reason) {
  if (reason === APP_SHUTDOWN) return;
  await Zotero.__addonInstance__?.hooks.onShutdown();
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}

