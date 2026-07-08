// Global toggle called from onclick="toggleTheme()"
function toggleTheme() {
  var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('pleiades-theme', next);
}


hljs.highlightAll();
