// Applies the saved color theme before the stylesheet paints, so a page never flashes the
// wrong theme. It loads as a normal blocking script in <head> because the content security
// policy allows no inline scripts; it is a few lines and does no network work.
//
// No saved choice (or "system") leaves <html> without data-theme, and the stylesheet follows
// prefers-color-scheme. site.js owns the toggle that writes the choice.
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');
  try {
    var theme = window.localStorage.getItem('power-platform-skills.theme');
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  } catch (error) {
    // Storage is blocked in some private windows; the system theme applies.
  }
}());
