#!/usr/bin/env node

/**
 * Validates that skill metadata descriptions are present and under the
 * GitHub Copilot supported limit.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAX_DESCRIPTION_LENGTH = 1024;

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else {
      files.push(entryPath);
    }
  }

  return files;
}

function isSkillMetadataFile(filePath) {
  const normalized = path.relative(ROOT, filePath).split(path.sep).join('/');
  return (
    normalized.includes('/skills/') &&
    (normalized.endsWith('/SKILL.md') || normalized.endsWith('/SKILL.template.md'))
  );
}

function getFrontmatter(content) {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;

  const startLine = content.slice(0, match.index).split(/\r?\n/).length;
  return {
    body: match[1],
    startLine,
  };
}

function countIndent(line) {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

function stripBlockIndent(lines) {
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => countIndent(line));
  const indent = indents.length > 0 ? Math.min(...indents) : 0;

  return lines.map((line) => {
    if (line.trim() === '') return '';
    return line.slice(Math.min(indent, countIndent(line)));
  });
}

function foldBlockLines(lines) {
  let value = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > 0) {
      const previousLine = lines[index - 1];
      value += previousLine === '' || line === '' ? '\n' : ' ';
    }
    value += line;
  }

  return value;
}

function unquoteInlineValue(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) {
    return trimmed;
  }

  const unquoted = trimmed.slice(1, -1);
  if (quote === "'") {
    return unquoted.replace(/''/g, "'");
  }

  return unquoted
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

function parseDescription(frontmatter) {
  const lines = frontmatter.body.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^description\s*:\s*(.*)$/);
    if (!match) continue;

    const rawValue = match[1].trim();
    const lineNumber = frontmatter.startLine + index + 1;
    const blockMatch = rawValue.match(/^([>|])/);

    if (!blockMatch) {
      return {
        value: unquoteInlineValue(rawValue),
        lineNumber,
      };
    }

    const blockLines = [];
    const parentIndent = countIndent(line);
    const explicitIndentMatch = rawValue.match(/^[>|]([1-9])/);
    let blockIndent = explicitIndentMatch
      ? parentIndent + Number(explicitIndentMatch[1])
      : null;

    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const blockLine = lines[blockIndex];
      if (blockLine.trim() !== '') {
        const lineIndent = countIndent(blockLine);
        if (blockIndent === null) {
          if (lineIndent <= parentIndent) break;
          blockIndent = lineIndent;
        } else if (lineIndent < blockIndent) {
          break;
        }
      }
      blockLines.push(blockLine);
    }

    const strippedLines = stripBlockIndent(blockLines);
    const value =
      blockMatch[1] === '|'
        ? strippedLines.join('\n').trimEnd()
        : foldBlockLines(strippedLines).trimEnd();

    return {
      value,
      lineNumber,
    };
  }

  return null;
}

const skillFiles = walkFiles(ROOT).filter(isSkillMetadataFile).sort();
const errors = [];

for (const filePath of skillFiles) {
  const relativePath = path.relative(ROOT, filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const frontmatter = getFrontmatter(content);

  if (!frontmatter) {
    errors.push(`${relativePath}: missing YAML frontmatter`);
    continue;
  }

  const description = parseDescription(frontmatter);
  if (!description) {
    errors.push(`${relativePath}: missing description in YAML frontmatter`);
    continue;
  }

  const descriptionLength = Array.from(description.value).length;
  if (descriptionLength >= MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `${relativePath}:${description.lineNumber}: description is ${descriptionLength} characters; ` +
        `must be fewer than ${MAX_DESCRIPTION_LENGTH} characters because GitHub Copilot ` +
        `does not support longer skill descriptions`
    );
  }
}

if (errors.length > 0) {
  console.log('Found invalid skill descriptions:');
  for (const error of errors) {
    console.log(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Validated ${skillFiles.length} skill metadata file(s); all descriptions are under ${MAX_DESCRIPTION_LENGTH} characters.`
);
