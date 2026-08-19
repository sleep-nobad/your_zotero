declare const rootURI: string;
declare const _globalThis: Record<string, unknown>;
declare const PathUtils: {
  join(...parts: string[]): string;
};
declare const IOUtils: {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, options?: Record<string, unknown>): Promise<number>;
  remove(path: string, options?: Record<string, unknown>): Promise<void>;
};

interface Window {
  ZoteroPane?: {
    getSelectedItems(asIDs?: boolean): Zotero.Item[];
  };
  Zotero_Tabs?: {
    selectedID: string;
    selectedType: string;
  };
}

interface YourZoteroGlobal {
  initialized: boolean;
  hooks: {
    onStartup(): Promise<void>;
    onShutdown(): Promise<void>;
    onMainWindowLoad(win: Window): Promise<void>;
    onMainWindowUnload(win: Window): Promise<void>;
    onPrefsLoad(win: Window): void;
  };
}

declare namespace _ZoteroTypes {
  interface Zotero {
    YourZotero: YourZoteroGlobal;
  }
}

