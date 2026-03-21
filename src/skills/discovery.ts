// Skill discovery — scan directories, parse frontmatter from markdown

import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { existsSync } from "node:fs";
import type { Skill, SkillSource } from "./types.js";
import { loadSkill } from "./loader.js";

export async function discoverSkills(sources: SkillSource[]): Promise<Skill[]> {
  const skills: Skill[] = [];

  for (const source of sources) {
    if (!existsSync(source.directory)) continue;

    const pattern = source.pattern ?? ".md";
    const files = await readdir(source.directory);

    for (const file of files) {
      if (!file.endsWith(pattern)) continue;

      const filePath = join(source.directory, file);
      try {
        const skill = await loadSkill(filePath);
        if (skill) skills.push(skill);
      } catch {
        // Skip invalid skill files
      }
    }
  }

  return skills;
}
