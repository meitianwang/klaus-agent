// Skill loader — read markdown, parse frontmatter, render templates

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Skill, SkillFrontmatter } from "./types.js";

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export async function loadSkill(filePath: string): Promise<Skill | null> {
  const raw = await readFile(filePath, "utf-8");
  const match = raw.match(FRONTMATTER_REGEX);

  let frontmatter: SkillFrontmatter;
  let content: string;

  if (match) {
    frontmatter = parseFrontmatter(match[1]);
    content = match[2].trim();
  } else {
    // No frontmatter — use filename as name
    frontmatter = { name: basename(filePath, ".md") };
    content = raw.trim();
  }

  if (!content) return null;

  return {
    name: frontmatter.name,
    description: frontmatter.description ?? "",
    content,
    source: filePath,
  };
}

function parseFrontmatter(raw: string): SkillFrontmatter {
  const result: Record<string, string> = {};

  for (const line of raw.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    result[key] = value;
  }

  return {
    name: result.name ?? "unnamed",
    description: result.description,
  };
}

export function renderSkillTemplate(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}
