// Koona Pin's phone bridge (NP-151), run before the page's own scripts. The page reads the platform
// here and replaces `back` (src/services/platform.ts); the Kotlin and Swift parts of this plugin call
// `back` on system Back and the iOS edge swipe, and Android passes its insets through `insets`.
// Android numbers each Back: the page claims it with `claim` before it closes anything, and a Back
// Android has already answered itself (the page was too slow) is not claimed, so it closes nothing.
(function () {
  if (window.__KOONA_MOBILE__) return;
  var insets = null;
  function apply() {
    var root = document.documentElement;
    if (!insets || !root) return;
    var sides = ['top', 'right', 'bottom', 'left'];
    for (var i = 0; i < sides.length; i++) root.style.setProperty('--kp-inset-' + sides[i], insets[i] + 'px');
  }
  window.__KOONA_MOBILE__ = {
    platform: '__PLATFORM__',
    // Until the page sets its own: nothing to close, so Android goes to the background.
    back: function () {
      return false;
    },
    claim: function (id) {
      var android = window.KoonaMobileAndroid;
      return !android || typeof id !== 'number' || android.claimBack(id);
    },
    insets: function (top, right, bottom, left) {
      insets = [top, right, bottom, left];
      apply();
    },
  };
  document.addEventListener('DOMContentLoaded', apply);
})();
