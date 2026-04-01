// SystemPromptBuilder — auto-assembling system prompt with section collectors
//
// NOT a passive container. The builder owns a set of SectionCollectors that
// automatically re-generate their content on each rebuild(). This means the
// agent loop calls rebuild() every turn, and all dynamic sections are fresh.
//
// Cache strategy: sections are ordered by stability so that the stable prefix
// is identical across turns → maximum prompt cache hit rate with Anthropic.

export type Stability = "static" | "session" | "dynamic";

export interface PromptSection {
  key: string;
  content: string;
  stability: Stability;
  priority?: number;
}

/**
 * A collector is a function that produces section content.
 * Registered once, called on every rebuild().
 * Return empty string to omit the section for this turn.
 */
export type SectionCollector = () => string | Promise<string>;

interface RegisteredCollector {
  key: string;
  stability: Stability;
  priority: number;
  collect: SectionCollector;
}

const STABILITY_ORDER: Record<Stability, number> = {
  static: 0,
  session: 1,
  dynamic: 2,
};

export class SystemPromptBuilder {
  private _staticSections = new Map<string, PromptSection>();
  private _collectors: RegisteredCollector[] = [];
  /** Snapshot from last rebuild — used between rebuilds. */
  private _lastBuild: PromptSection[] = [];

  // ── Static sections (set once, never change) ──────────────────

  set(section: PromptSection): void {
    this._staticSections.set(section.key, section);
  }

  remove(key: string): void {
    this._staticSections.delete(key);
  }

  has(key: string): boolean {
    return this._staticSections.has(key) || this._collectors.some((c) => c.key === key);
  }

  // ── Collectors (called on every rebuild) ──────────────────────

  /**
   * Register a collector that will be called on every rebuild().
   * If a collector with the same key already exists, it is replaced.
   */
  addCollector(
    key: string,
    stability: Stability,
    collect: SectionCollector,
    priority = 100,
  ): void {
    this._collectors = this._collectors.filter((c) => c.key !== key);
    this._collectors.push({ key, stability, priority, collect });
  }

  removeCollector(key: string): void {
    this._collectors = this._collectors.filter((c) => c.key !== key);
  }

  // ── Build ─────────────────────────────────────────────────────

  /**
   * Rebuild all sections: static sections + collector outputs.
   * Call this once per turn before sending to the LLM.
   */
  async rebuild(): Promise<string> {
    const sections: PromptSection[] = [...this._staticSections.values()];

    // Run all collectors
    for (const reg of this._collectors) {
      const content = await reg.collect();
      if (content) {
        sections.push({
          key: reg.key,
          content,
          stability: reg.stability,
          priority: reg.priority,
        });
      }
    }

    this._lastBuild = sections.filter((s) => s.content.length > 0);
    return this._renderSorted(this._lastBuild);
  }

  /** Synchronous build using last-collected values. No collector calls. */
  build(): string {
    if (this._lastBuild.length === 0) {
      // Never rebuilt yet — just use statics
      return this._renderSorted([...this._staticSections.values()].filter((s) => s.content.length > 0));
    }
    return this._renderSorted(this._lastBuild);
  }

  /**
   * Build structured content blocks for Anthropic API with cache_control.
   *
   * Strategy (uses up to 2 of Anthropic's 4 breakpoints on system param):
   *  Block 1: static + session sections → cache_control: ephemeral
   *           (stable across turns — high cache hit rate)
   *  Block 2: dynamic sections → NO cache_control
   *           (changes every turn — caching would waste writes)
   *
   * The remaining 2 breakpoints are available for tools and messages.
   */
  buildCacheBlocks(): Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> {
    const sorted = this._sortSections(
      this._lastBuild.length > 0 ? this._lastBuild : [...this._staticSections.values()],
    );

    const stableText = sorted
      .filter((s) => s.stability !== "dynamic")
      .map((s) => s.content)
      .join("\n\n");

    const dynamicText = sorted
      .filter((s) => s.stability === "dynamic")
      .map((s) => s.content)
      .join("\n\n");

    const blocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [];

    if (stableText) {
      blocks.push({ type: "text", text: stableText, cache_control: { type: "ephemeral" } });
    }
    if (dynamicText) {
      blocks.push({ type: "text", text: dynamicText });
    }

    // Edge case: only dynamic content — still mark for caching
    if (blocks.length === 1 && !stableText) {
      blocks[0].cache_control = { type: "ephemeral" };
    }

    return blocks;
  }

  // ── Internals ─────────────────────────────────────────────────

  private _sortSections(sections: PromptSection[]): PromptSection[] {
    return [...sections].sort((a, b) => {
      const sd = STABILITY_ORDER[a.stability] - STABILITY_ORDER[b.stability];
      return sd !== 0 ? sd : (a.priority ?? 100) - (b.priority ?? 100);
    });
  }

  private _renderSorted(sections: PromptSection[]): string {
    return this._sortSections(sections).map((s) => s.content).join("\n\n");
  }
}
