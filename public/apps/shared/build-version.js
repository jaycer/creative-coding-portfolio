// build-version.js — which codebase is running, for the apps that write files.
//
// A save file outlives the code that wrote it. When a loader eventually has to
// change in a way that cannot read an older file, the one thing that says which
// version of the app to hand that file back to is a stamp inside the file — so
// every sub-app that saves JSON writes one, under `build`.
//
// It has to be fetched rather than baked in. `__APP_VERSION__` is a bundler
// substitution and reaches only what the bundler touches; the pages under
// /public ship verbatim and never see it. vite.config publishes the same string
// at /version.json for exactly this, in dev and in the built site alike.
//
// The fetch is async and a save can come before it lands, so this is a getter
// and not a constant: ask at the moment you write the file, not at startup.
//
// Usage, from a save handler:
//   build: window.buildVersion?.() ?? 'unknown'
(function () {
  // What an offline load, or a copy opened straight off the disk over file://,
  // honestly reports. Better in the file than a wrong version or no key at all.
  let build = 'unknown';

  // Resolved against this script rather than against the page, so it finds the
  // site root whatever folder depth the app that loaded it sits at.
  const url = new URL('../../version.json', document.currentScript.src);
  fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((v) => { if (v && v.version) build = String(v.version); })
    .catch(() => { /* stays 'unknown' */ });

  window.buildVersion = () => build;
})();
