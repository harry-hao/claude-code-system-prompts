const { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');

const ROOT_DIR = join(__dirname, '..');
const SOURCE_DIR = join(ROOT_DIR, 'system-prompts');

const SOURCE_FAMILIES = [
  'agent-prompt',
  'system-prompt',
  'system-reminder',
  'tool-description',
  'tool-parameter',
  'data',
  'skill'
];

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseCommentMetadata(comment) {
  const metadata = { variables: [] };
  const lines = comment.split('\n');
  let inVariables = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      inVariables = false;
      continue;
    }

    if (trimmed === 'variables:') {
      inVariables = true;
      continue;
    }

    if (inVariables && trimmed.startsWith('- ')) {
      metadata.variables.push(stripQuotes(trimmed.slice(2)));
      continue;
    }

    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, value] = match;
    if (key === 'name' || key === 'description' || key === 'ccVersion') {
      metadata[key] = stripQuotes(value);
    }
  }

  return metadata;
}

function promptFamilyFromFilename(filename) {
  return SOURCE_FAMILIES.find((prefix) => filename.startsWith(`${prefix}-`));
}

function parsePromptFile(sourcePath, content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^<!--\n([\s\S]*?)\n-->\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`Missing metadata comment in ${sourcePath}`);
  }

  const filename = basename(sourcePath);
  const family = promptFamilyFromFilename(filename);
  if (!family) {
    throw new Error(`Unsupported prompt family for ${sourcePath}`);
  }

  return {
    sourcePath,
    filename,
    family,
    metadata: parseCommentMetadata(match[1]),
    body: match[2].trim()
  };
}

function derivePromptSlug(prompt) {
  return prompt.filename
    .replace(/^(skill|agent-prompt|system-prompt|system-reminder|tool-description|tool-parameter|data)-/, '')
    .replace(/\.md$/, '');
}

function deriveSkillDirectoryName(prompt) {
  return `claude-${derivePromptSlug(prompt)}`;
}

function looksLikeWorkflow(text) {
  return /(\bworkflow\b|\bsteps?\b|\bphase\b|\bgoal\b|\bsuccess criteria\b|\bwhen to use\b)/i.test(text);
}

function stripPlaceholderFragment(text) {
  const match = text.match(/^(?:`[^`]+`|\$\{[^}]+\}|\{[^}]+\}|<[^>]+>)\s*[—-]\s*(.+)$/);
  return match ? match[1].trim() : text;
}

function cleanSummaryCandidate(text) {
  return stripPlaceholderFragment(text.trim().replace(/\s+/g, ' '))
    .replace(/^(?:use when|when the user wants to|when you need to|when you want to)\s+/i, '')
    .replace(/^(?:instructions?|instruction|guidance|prompt|subagent prompt|agent prompt|system prompt|skill)\s+(?:for|to|on|about)\s+/i, '')
    .replace(/^(?:guides?|instructs?|helps?|describes?|covers?|walks through|walks the user through|explains?)\s+(?:the user\s+)?(?:to|through)\s+/i, '')
    .replace(/^(?:you are|you're|you have|you've|you can)\s+/i, '')
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replace(/\s*[.?!]+$/g, '')
    .trim();
}

function hasPlaceholderLikeSnippet(text) {
  return /`[^`]+`|\$\{[^}]+\}|<[^>]+>|\{[^}]+\}/.test(text);
}

function deriveReadableSummary(prompt) {
  const bodyLead = prompt.body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('```'));
  const candidates = [
    prompt.metadata.description,
    bodyLead,
    prompt.metadata.name
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const cleaned = cleanSummaryCandidate(candidate);
    if (!cleaned) {
      continue;
    }

    if (hasPlaceholderLikeSnippet(cleaned)) {
      continue;
    }

    return cleaned;
  }

  return null;
}

function classifyPrompt(prompt) {
  const text = `${prompt.metadata.name || ''} ${prompt.metadata.description || ''} ${prompt.body}`.toLowerCase();

  if (prompt.filename.startsWith('skill-')) {
    return { ...prompt, targetType: 'skill', reason: 'skill-* files are reusable workflows' };
  }

  if (prompt.filename.startsWith('agent-prompt-')) {
    return { ...prompt, targetType: 'skill', reason: 'agent-prompt files are reusable workflows' };
  }

  if (
    prompt.filename.startsWith('system-reminder-') ||
    prompt.filename.startsWith('tool-description-') ||
    prompt.filename.startsWith('tool-parameter-') ||
    prompt.filename.startsWith('data-')
  ) {
    return { ...prompt, targetType: 'rule', reason: `${prompt.family} files are standing guidance or reference material` };
  }

  if (prompt.filename.startsWith('system-prompt-') && /\b(skillify|subagent|plan|mode|session|generator|workflow)\b/i.test(text) && looksLikeWorkflow(text)) {
    return { ...prompt, targetType: 'skill', reason: 'system-prompt content describes a reusable workflow' };
  }

  return { ...prompt, targetType: 'rule', reason: 'system-prompt content defaults to standing guidance' };
}

function deriveTargetPath(prompt) {
  if (prompt.targetType === 'skill') {
    return `skills/${deriveSkillDirectoryName(prompt)}/SKILL.md`;
  }

  return `rules/${derivePromptSlug(prompt)}.md`;
}

function loadSourcePrompts() {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const sourcePath = `system-prompts/${name}`;
      return parsePromptFile(sourcePath, readFileSync(join(SOURCE_DIR, name), 'utf8'));
    });
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function skillNameFromTargetPath(targetPath) {
  return basename(dirname(targetPath));
}

function renderSkillDocument(prompt) {
  const skillName = prompt.targetPath ? skillNameFromTargetPath(prompt.targetPath) : deriveSkillDirectoryName(prompt);
  const summary = deriveReadableSummary(prompt);
  const whenToUse = summary
    ? `Use when ${summary}.`
    : `Use when the source prompt "${prompt.metadata.name || prompt.filename}" describes a reusable workflow.`;

  return ensureTrailingNewline(`---
name: ${yamlString(skillName)}
description: ${yamlString(prompt.metadata.description || 'Derived workflow skill')}
source: ${yamlString(prompt.sourcePath)}
source_type: ${yamlString(prompt.family)}
when_to_use: ${yamlString(whenToUse)}
priority: ${yamlString('default')}
---

${prompt.body}
`);
}

function renderRuleDocument(prompt) {
  const title = (prompt.metadata.name || prompt.filename)
    .replace(/^(Agent Prompt|System Prompt|System Reminder|Tool Description|Tool Parameter|Data|Skill):\s*/i, '');

  return ensureTrailingNewline(`---
name: ${yamlString(prompt.filename.replace(/\.md$/, '').replace(/^(skill|agent-prompt|system-prompt|system-reminder|tool-description|tool-parameter|data)-/, ''))}
description: ${yamlString(prompt.metadata.description || 'Derived persistent rule')}
source: ${yamlString(prompt.sourcePath)}
source_type: ${yamlString(prompt.family)}
applies_to: ${yamlString('always-on behavior')}
priority: ${yamlString('default')}
---

# ${title}

## Intent
Capture the source prompt as standing guidance instead of a triggered workflow.

## Rules
- Preserve the original safety, behavior, or reference guidance from the source prompt.
- Keep the rule active wherever the source context applies.

## Exceptions
- If the source is clearly procedural, it belongs in \`skills/\` instead of \`rules/\`.

## Examples or Notes
Original source prompt:

\`\`\`md
${prompt.body}
\`\`\`
`);
}

function validateUniqueTargets(records) {
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.targetPath)) {
      throw new Error(`Duplicate target path detected: ${record.targetPath}`);
    }
    seen.add(record.targetPath);
  }
}

function validateRecords(records, sourceCount) {
  if (records.length !== sourceCount) {
    throw new Error(`Expected ${sourceCount} derived records, received ${records.length}`);
  }

  for (const record of records) {
    if (!record.sourcePath || !record.targetType || !record.targetPath || !record.reason) {
      throw new Error(`Incomplete conversion record for ${record.filename || record.sourcePath}`);
    }
  }
}

function resolveDuplicateTargetPaths(records) {
  const counts = new Map();
  for (const record of records) {
    counts.set(record.targetPath, (counts.get(record.targetPath) || 0) + 1);
  }

  return records.map((record) => {
    if ((counts.get(record.targetPath) || 0) <= 1) {
      return record;
    }

    const uniqueSlug = record.filename.replace(/\.md$/, '');
    const uniqueTargetPath = record.targetType === 'skill'
      ? `skills/claude-${uniqueSlug}/SKILL.md`
      : `rules/${uniqueSlug}.md`;
    return { ...record, targetPath: uniqueTargetPath };
  });
}

function writeOutputFile(rootDir, relativePath, content) {
  const fullPath = join(rootDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

function cleanGeneratedOutputs(rootDir) {
  rmSync(join(rootDir, 'skills'), { recursive: true, force: true });
  rmSync(join(rootDir, 'rules'), { recursive: true, force: true });
}

function generateDerivedPrompts(rootDir = ROOT_DIR, prompts = loadSourcePrompts()) {
  const records = resolveDuplicateTargetPaths(prompts
    .map((prompt) => classifyPrompt(prompt))
    .map((prompt) => ({ ...prompt, targetPath: deriveTargetPath(prompt) })));

  validateRecords(records, prompts.length);
  validateUniqueTargets(records);

  cleanGeneratedOutputs(rootDir);

  for (const record of records) {
    const content = record.targetType === 'skill'
      ? renderSkillDocument(record)
      : renderRuleDocument(record);
    writeOutputFile(rootDir, record.targetPath, content);
  }

  return records;
}

if (require.main === module) {
  const records = generateDerivedPrompts();
  console.log(`Generated ${records.length} derived prompt documents.`);
}

module.exports = {
  classifyPrompt,
  deriveTargetPath,
  generateDerivedPrompts,
  loadSourcePrompts,
  parsePromptFile,
  renderRuleDocument,
  renderSkillDocument
};
