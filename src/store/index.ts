/**
 * src/store/index.ts — Public barrel export for the RetroOasisStore.
 */
export {
  RetroOasisStore,
  store,
} from "./RetroOasisStore.js";

export type {
  SliceKey,
  SubscriptionToken,
  StoreSlices,
  SettingsSlice,
  LibrarySlice,
  SessionSlice,
  CloudSyncSlice,
  NetplaySlice,
  CloudLibrarySlice,
  NetplayIceServer,
} from "./RetroOasisStore.js";

export {
  hydrateSettingsIntoStore,
  mirrorSettingsPatchToStore,
  toNetplayIceServers,
  fromNetplayIceServers,
} from "./bridge.js";
export type { SettingsShape } from "./bridge.js";
