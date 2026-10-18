// Koona Pin's phone bridge (NP-151), run before the page's own scripts. The page replaces `back`
// (src/platform/back.ts); the Kotlin and Swift parts of this plugin call `back` on system Back and
// the iOS edge swipe, and Android passes its insets through `insets`. The platform itself comes from
// the app's own `window.__KOONA__` (src-tauri/src/capabilities.rs, NP-072a).
// Android numbers each Back: the page claims it with `claim` before it closes anything, and a Back
// Android has already answered itself (the page was too slow) is not claimed, so it closes nothing.
// The system's signals for the page's look (NP-072b, src/platform/system.ts): Android answers them
// at once as the bridge starts, so the first render knows them, and sends `systemChanged` later.
(function () {
  if (window.__KOONA_MOBILE__) return;
  var insets = null;
  var system = { powerSave: false, lowRam: false, textScale: 1 };
  function take(next) {
    if (!next || typeof next !== 'object') return;
    for (var key in system) if (typeof next[key] === typeof system[key]) system[key] = next[key];
  }
  var android = window.KoonaMobileAndroid;
  if (android && android.system) {
    try {
      take(JSON.parse(android.system()));
    } catch (e) {
      // An older plugin, or none: the calm defaults.
    }
  }
  function apply() {
    var root = document.documentElement;
    if (!insets || !root) return;
    var sides = ['top', 'right', 'bottom', 'left'];
    for (var i = 0; i < sides.length; i++) root.style.setProperty('--kp-inset-' + sides[i], insets[i] + 'px');
  }
  window.__KOONA_MOBILE__ = {
    // Until the page sets its own: nothing to close, so Android goes to the background.
    back: function () {
      return false;
    },
    // Only Android numbers its Backs (iOS has nothing to race). There a numbered Back without the
    // Kotlin interface is refused: nothing closes and Android moves the app to the background, so a
    // Back never has two outcomes.
    claim: function (id) {
      if (typeof id !== 'number') return true;
      var android = window.KoonaMobileAndroid;
      if (!android) return '__PLATFORM__' !== 'android';
      return android.claimBack(id) === true;
    },
    insets: function (top, right, bottom, left) {
      insets = [top, right, bottom, left];
      apply();
    },
    // A copy: battery saver, a low-RAM device, the text scale.
    system: function () {
      return { powerSave: system.powerSave, lowRam: system.lowRam, textScale: system.textScale };
    },
    systemChanged: function (next) {
      take(next);
      window.dispatchEvent(new Event('koona-system'));
    },
  };
  document.addEventListener('DOMContentLoaded', apply);
})();
