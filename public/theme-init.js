// Apply the saved theme before first paint (see src/shell/theme.ts).
// Loaded as a blocking script from index.html.
try {
  var saved = JSON.parse(localStorage.getItem("meridian.theme") || "null");
  var pref = saved && saved.state && saved.state.pref;
  if (pref === "light" || pref === "dark" || pref === "system") {
    document.documentElement.setAttribute("data-theme", pref);
  }
} catch (e) {}
