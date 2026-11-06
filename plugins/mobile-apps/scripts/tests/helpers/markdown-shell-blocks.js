'use strict';

function shellBlocks(text, language = 'bash') {
  const normalized = text.replace(/\r\n?/g, '\n');
  const fences = /^([ \t]*(?:>[ \t]*)*)```(\w+)[ \t]*\n([\s\S]*?)\n[ \t]*(?:>[ \t]*)*```[ \t]*(?=\n|$)/gm;
  return [...normalized.matchAll(fences)]
    .filter((match) => match[2] === language)
    .map((match) => {
      const prefix = match[1];
      // Remove only the Markdown prefix, keeping the command's own indentation and quotes.
      return match[3].split('\n').map((line) => {
        if (line.startsWith(prefix)) return line.slice(prefix.length);
        if (line.trim() === prefix.trim()) return '';
        return line;
      }).join('\n');
    });
}

module.exports = { shellBlocks };
