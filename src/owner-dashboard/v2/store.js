// src/owner-dashboard/v2/store.js
//
// Browser storage access for the v2 dashboard. Both calls take a GETTER for the
// storage object (for example () => window.localStorage) because merely reading
// window.localStorage can throw (blocked storage, sandboxed frame). Every read
// and write is wrapped: a failure reads as "no value" / "not stored", so the
// caller always falls back to its default.

/** The stored string, or null when there is none or the storage is unusable. */
export function readStored(getStorage, key) {
  try {
    const value = getStorage().getItem(key);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Store a string; true when it was written, false when the storage refused. */
export function writeStored(getStorage, key, value) {
  try {
    getStorage().setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
