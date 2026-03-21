// JSONL read/write helpers

import { readFile, appendFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export async function readJSONL<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as T);
}

export async function appendJSONL(filePath: string, record: unknown): Promise<void> {
  await appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
}

export async function writeJSONLHeader(filePath: string, header: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(header) + "\n", "utf-8");
}
