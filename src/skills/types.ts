// Skill system types

export interface Skill {
  name: string;
  description: string;
  content: string;
  source: string; // file path or identifier
}

export interface SkillSource {
  directory: string;
  pattern?: string; // glob pattern, default "*.md"
}

export interface SkillFrontmatter {
  name: string;
  description?: string;
}
