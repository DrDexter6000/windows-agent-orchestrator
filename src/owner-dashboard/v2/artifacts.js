// src/owner-dashboard/v2/artifacts.js
//
// The blob URLs of the delivered images, and nothing else. DOM-free, network-free: the three things it needs
// are injected, so the tests can count every create and revoke.
//
//   load(spec)     -> Promise<{ok: true, blob} | {ok: false}>   (the authenticated fetch of api.js)
//   createUrl(b)   -> string                                      (URL.createObjectURL)
//   revokeUrl(u)   -> void                                        (URL.revokeObjectURL)
//
// The page tells the store, on every draw, which images it needs NOW (want). Whatever it no longer needs
// has its URL revoked at once; an answer that arrives for an image nobody wants any more creates no URL at
// all. So a URL lives exactly as long as its image is on screen: switching worker, leaving the Deliverable
// tab, a new delivery commit or closing the panel all end it (release() ends every one: page unload).

/**
 * @param {{load: Function, createUrl: Function, revokeUrl: Function, onChange: () => void}} io
 */
export function createImageStore({ load, createUrl, revokeUrl, onChange }) {
  const entries = new Map(); // id -> { state: "loading" | "ready" | "failed", url: string | null }

  function drop(id) {
    const entry = entries.get(id);
    if (entry === undefined) return;
    entries.delete(id);
    if (entry.url !== null) revokeUrl(entry.url);
  }

  function start(spec) {
    const entry = { state: "loading", url: null };
    entries.set(spec.id, entry);
    let asked;
    try {
      asked = Promise.resolve(load(spec));
    } catch {
      asked = Promise.resolve({ ok: false });
    }
    asked
      .then((result) => result, () => ({ ok: false }))
      .then((result) => {
        // Dropped (or dropped and asked for again, which is a new entry) while the answer was on its way:
        // nothing is created for it.
        if (entries.get(spec.id) !== entry) return;
        if (result?.ok === true) {
          entry.url = createUrl(result.blob);
          entry.state = "ready";
        } else {
          entry.state = "failed";
        }
        onChange();
      });
  }

  return {
    /** Set the images needed now (each { id, ... } the load function understands); everything else goes. */
    want(specs) {
      const wanted = new Set(specs.map((spec) => spec.id));
      for (const id of [...entries.keys()]) if (!wanted.has(id)) drop(id);
      for (const spec of specs) if (!entries.has(spec.id)) start(spec);
    },
    /** Revoke every URL and forget every entry. */
    release() {
      for (const id of [...entries.keys()]) drop(id);
    },
    /** id -> { state, url } for the views (a plain copy: the views never hold the live entries). */
    view() {
      return Object.fromEntries([...entries].map(([id, entry]) => [id, { state: entry.state, url: entry.url }]));
    },
    size: () => entries.size,
  };
}
