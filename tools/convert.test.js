const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const {
  classifyPrompt,
  deriveTargetPath,
  generateDerivedPrompts,
  loadSourcePrompts,
  parsePromptFile,
  renderRuleDocument,
  renderSkillDocument
} = require('./convert.js');

const sampleSkill = `<!--
name: 'Agent Prompt: Quick git commit'
description: Streamlined prompt for creating a single git commit
ccVersion: 2.1.118
variables:
  - IS_BASH_ENV_FN
-->
## Context
Create a single git commit.`;

const sampleRule = `<!--
name: 'System Prompt: Communication style'
description: Instructs Claude to give brief updates
ccVersion: 2.1.104
-->
# Text output
Before your first tool call, state what you're about to do.`;

test('parsePromptFile extracts metadata and body', () => {
  const parsed = parsePromptFile('system-prompts/agent-prompt-quick-git-commit.md', sampleSkill);

  assert.equal(parsed.sourcePath, 'system-prompts/agent-prompt-quick-git-commit.md');
  assert.equal(parsed.family, 'agent-prompt');
  assert.equal(parsed.metadata.name, 'Agent Prompt: Quick git commit');
  assert.equal(parsed.metadata.description, 'Streamlined prompt for creating a single git commit');
  assert.deepEqual(parsed.metadata.variables, ['IS_BASH_ENV_FN']);
  assert.match(parsed.body, /## Context/);
});

test('classifyPrompt returns skill for workflow prompts', () => {
  const parsed = parsePromptFile('system-prompts/agent-prompt-quick-git-commit.md', sampleSkill);
  const classified = classifyPrompt(parsed);

  assert.equal(classified.targetType, 'skill');
  assert.match(classified.reason, /workflow/i);
  assert.equal(deriveTargetPath(classified), 'skills/claude-quick-git-commit/SKILL.md');
});

test('classifyPrompt returns rule for standing guidance', () => {
  const parsed = parsePromptFile('system-prompts/system-prompt-communication-style.md', sampleRule);
  const classified = classifyPrompt(parsed);

  assert.equal(classified.targetType, 'rule');
  assert.match(classified.reason, /guidance/i);
  assert.equal(deriveTargetPath(classified), 'rules/communication-style.md');
});

test('renderSkillDocument emits skill markdown', () => {
  const prompt = classifyPrompt(parsePromptFile('system-prompts/agent-prompt-quick-git-commit.md', sampleSkill));
  const markdown = renderSkillDocument(prompt);

  assert.match(markdown, /^---\nname: "claude-quick-git-commit"/m);
  assert.match(markdown, /when_to_use:/);
  assert.match(markdown, /## Context\nCreate a single git commit\./);
  assert.doesNotMatch(markdown, /## Goal|## Inputs|## Steps|## Success criteria|## Notes|```md/);
});

test('renderSkillDocument ignores placeholder-like example fragments in summaries', () => {
  const prompt = {
    sourcePath: 'system-prompts/agent-prompt-schedule-slash-command.md',
    filename: 'agent-prompt-schedule-slash-command.md',
    family: 'agent-prompt',
    metadata: {
      name: 'Agent Prompt: /schedule slash command',
      description: '`{action: "list"}` — list all routines'
    },
    body: '## What You Can Do\n\n- `{action: "list"}` — list all routines'
  };

  const markdown = renderSkillDocument(prompt);
  const whenToUse = markdown.match(/when_to_use:\s+"([^"]+)"/m)?.[1] ?? '';

  assert.match(whenToUse, /Use when list all routines\./);
  assert.doesNotMatch(whenToUse, /`\{action: "list"\}`|\$\{|\{action:/);
});

test('renderSkillDocument derives actionable when_to_use text for real workflow prompts', () => {
  const cases = [
    {
      sourcePath: 'system-prompts/agent-prompt-batch-slash-command.md',
      whenToUse: /Use when orchestrating a large, parallelizable change across a codebase\./i
    },
    {
      sourcePath: 'system-prompts/agent-prompt-session-search.md',
      whenToUse: /Use when searching past Claude Code conversation sessions/i
    },
    {
      sourcePath: 'system-prompts/skill-computer-use-mcp.md',
      whenToUse: /Use when (?:using computer-use MCP tools|computer-use MCP tools|a computer-use MCP is available)/i
    }
  ];

  for (const { sourcePath, whenToUse } of cases) {
    const prompt = classifyPrompt(parsePromptFile(sourcePath, readFileSync(join(__dirname, '..', sourcePath), 'utf8')));
    const markdown = renderSkillDocument(prompt);
    const frontmatterLine = markdown.match(/^when_to_use:\s+(.*)$/m)?.[1] ?? '';
    const frontmatter = JSON.parse(frontmatterLine);

    assert.notEqual(
      frontmatter,
      `Use when the source prompt "${prompt.metadata.name || prompt.filename}" describes a reusable workflow.`
    );
    assert.match(frontmatter, whenToUse);
  }
});

test('renderRuleDocument emits rule markdown', () => {
  const prompt = classifyPrompt(parsePromptFile('system-prompts/system-prompt-communication-style.md', sampleRule));
  const markdown = renderRuleDocument(prompt);

  assert.match(markdown, /^---\nname: "communication-style"/m);
  assert.match(markdown, /applies_to:/);
  assert.match(markdown, /## Intent/);
  assert.match(markdown, /## Rules/);
});

test('generateDerivedPrompts writes skills and rules for a prompt set', () => {
  const rootDir = mkdtempSync(join(__dirname, '..', '.prompt-conversion-test-'));

  try {
    const records = generateDerivedPrompts(rootDir, [
      {
        sourcePath: 'system-prompts/agent-prompt-quick-git-commit.md',
        filename: 'agent-prompt-quick-git-commit.md',
        family: 'agent-prompt',
        metadata: { name: 'Agent Prompt: Quick git commit', description: 'Streamlined prompt for creating a single git commit' },
        body: '1. Analyze staged changes\n2. Create the commit'
      },
      {
        sourcePath: 'system-prompts/system-prompt-communication-style.md',
        filename: 'system-prompt-communication-style.md',
        family: 'system-prompt',
        metadata: { name: 'System Prompt: Communication style', description: 'Instructs Claude to give brief updates' },
        body: 'Before your first tool call, state what you are about to do.'
      }
    ]);
    assert.equal(records.length, 2);
    assert.equal(existsSync(join(rootDir, 'skills/claude-quick-git-commit/SKILL.md')), true);
    assert.equal(existsSync(join(rootDir, 'rules/communication-style.md')), true);
    assert.equal(existsSync(join(rootDir, 'rules/communication-style.md')), true);
    assert.equal(existsSync(join(rootDir, 'docs')), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('generated skill summaries stay readable across the corpus smoke set', () => {
  const rootDir = mkdtempSync(join(__dirname, '..', '.prompt-conversion-test-'));

  try {
    generateDerivedPrompts(rootDir, [
      {
        sourcePath: 'system-prompts/agent-prompt-schedule-slash-command.md',
        filename: 'agent-prompt-schedule-slash-command.md',
        family: 'agent-prompt',
        metadata: {
          name: 'Agent Prompt: /schedule slash command',
          description: '`{action: "list"}` — list all routines'
        },
        body: '## What You Can Do\n\n- `{action: "list"}` — list all routines'
      }
    ]);

    const markdown = readFileSync(join(rootDir, 'skills/claude-schedule-slash-command/SKILL.md'), 'utf8');
    const frontmatter = markdown.match(/when_to_use:\s+"([^"]+)"/m)?.[1] ?? '';

    assert.doesNotMatch(frontmatter, /`|\$\{|\{action:/);
    assert.doesNotMatch(markdown, /## Goal|## Inputs|## Steps|## Success criteria|## Notes|```md/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('generateDerivedPrompts disambiguates colliding skill slugs by source filename', () => {
  const rootDir = mkdtempSync(join(__dirname, '..', '.prompt-conversion-test-'));

  try {
    generateDerivedPrompts(rootDir, [
      {
        sourcePath: 'system-prompts/agent-prompt-dream-memory-consolidation.md',
        filename: 'agent-prompt-dream-memory-consolidation.md',
        family: 'agent-prompt',
        metadata: { name: 'Agent Prompt: Dream memory consolidation', description: 'Summarizes dream memory into a stable form' },
        body: '1. Review the session history\n2. Consolidate recurring themes'
      },
      {
        sourcePath: 'system-prompts/skill-dream-memory-consolidation.md',
        filename: 'skill-dream-memory-consolidation.md',
        family: 'skill',
        metadata: { name: 'Skill: Dream memory consolidation', description: 'Consolidates dream memory notes' },
        body: '1. Review the memory notes\n2. Merge overlapping ideas'
      }
    ]);

    assert.equal(existsSync(join(rootDir, 'skills/claude-agent-prompt-dream-memory-consolidation/SKILL.md')), true);
    assert.equal(existsSync(join(rootDir, 'skills/claude-skill-dream-memory-consolidation/SKILL.md')), true);
    assert.equal(existsSync(join(rootDir, 'skills/claude-dream-memory-consolidation/SKILL.md')), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('loadSourcePrompts returns every source markdown file', () => {
  const prompts = loadSourcePrompts();
  assert.equal(prompts.length, 293);
});
