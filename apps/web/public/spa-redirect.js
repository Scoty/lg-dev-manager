// Used by 404.html on GitHub Pages: a typed or bookmarked path such as /apps/homebrew becomes /#/apps/homebrew.
// Only the path is kept (same origin), so this can't send anyone elsewhere.
(function () {
  var path = window.location.pathname.replace(/\/{2,}/g, '/').replace(/\/index\.html$/, '/');
  window.location.replace(path === '/' ? '/' : '/#' + path + window.location.search);
})();
