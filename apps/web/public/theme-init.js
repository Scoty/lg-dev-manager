// Early paint: apply the saved / system theme before React mounts to avoid a flash.
// Kept as an external file so the Content-Security-Policy can forbid inline scripts.
(function () {
  try {
    var saved = localStorage.getItem('lgdm-theme');
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = saved === 'light' || saved === 'dark' ? saved : dark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();

// Frame protection: GitHub Pages can't send X-Frame-Options / frame-ancestors, so refuse to run inside another
// page's frame (clickjacking). main.tsx sees this flag and shows "open in its own tab" instead of the app, and
// never connects to the bridge.
(function () {
  var framed;
  try {
    framed = window.top !== window.self;
  } catch (e) {
    framed = true;
  }
  if (framed) document.documentElement.setAttribute('data-framed', '');
})();
