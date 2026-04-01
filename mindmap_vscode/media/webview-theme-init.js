(function () {
  try {
    var m = localStorage.getItem('mindmapUiThemeMode') || 'system';
    var dark = false;
    if (m === 'dark') dark = true;
    else if (m === 'light') dark = false;
    else dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-mm-ui', dark ? 'dark' : 'light');
  } catch (e) {}
})();
