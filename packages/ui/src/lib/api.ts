export * from './api.types';

import type { ApiImpl } from './api.types';
import * as cliImpl from './api.cli';
import * as localImpl from './api.local';

// Pick the data layer at build time. The demo build defines VITE_DBP_DEMO='true' (see
// vite.demo.config.ts); the default build leaves it 'false', so the unused implementation
// is tree-shaken — the demo bundle carries no `/api` network code, and the full build
// carries no local store. The `ApiImpl` annotation makes both implementations conform to
// the same surface.
const impl: ApiImpl = import.meta.env.VITE_DBP_DEMO === 'true' ? localImpl : cliImpl;

export const getConnection = impl.getConnection;
export const connect = impl.connect;
export const disconnect = impl.disconnect;
export const fetchTypes = impl.fetchTypes;
export const fetchPosts = impl.fetchPosts;
export const savePosts = impl.savePosts;
export const importPosts = impl.importPosts;
export const bulkDeleteMeta = impl.bulkDeleteMeta;
export const fetchPrintRecords = impl.fetchPrintRecords;
export const setRelation = impl.setRelation;
export const clearRelation = impl.clearRelation;
