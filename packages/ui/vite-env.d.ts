/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'true' in the browser-demo build (api.local.ts); 'false'/unset otherwise. */
  readonly VITE_DBP_DEMO?: string;
}
