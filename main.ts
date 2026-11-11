import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
} from "obsidian";

interface AIMetadataSuggesterSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  suggestTags: boolean;
  suggestAliases: boolean;
  suggestSummary: boolean;
  maxTags: number;
  preferExistingTags: boolean;
  strictExistingTags: boolean;
  tagMode: "append" | "replace";
  aliasMode: "append" | "replace";
  summaryMode: "append" | "replace" | "skip-if-exists";
  customPrompt: string;
  excludeFolders: string;
  stripCodeBlocks: boolean;
  maxContentLength: number;
}

const DEFAULT_SETTINGS: AIMetadataSuggesterSettings = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  temperature: 0.3,
  suggestTags: true,
  suggestAliases: true,
  suggestSummary: true,
  maxTags: 5,
  preferExistingTags: true,
  strictExistingTags: false,
  tagMode: "append",
  aliasMode: "append",
  summaryMode: "replace",
  customPrompt: "",
  excludeFolders: "",
  stripCodeBlocks: true,
  maxContentLength: 6000,
};

interface SuggestionResult {
  tags: string[];
  aliases: string[];
  summary: string;
}

interface TagSuggestion {
  tag: string;
  isNew: boolean;
  selected: boolean;
}

export default class AIMetadataSuggester extends Plugin {
  settings: AIMetadataSuggesterSettings;
  tagCache: string[] = [];
  tagCacheTime = 0;
  private ribbonIcon: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "suggest-metadata",
      name: "Suggest metadata for current note",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.suggestForActiveNote(view);
      },
    });

    this.addCommand({
      id: "batch-suggest-metadata",
      name: "Batch suggest metadata for folder",
      callback: () => this.openBatchModal(),
    });

    this.ribbonIcon = this.addRibbonIcon("tag", "Suggest metadata", async () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        await this.suggestForActiveNote(view);
      } else {
        new Notice("No active markdown note");
      }
    });

    this.addSettingTab(new AIMetadataSuggesterSettingTab(this.app, this));
  }

  onunload() {
    this.ribbonIcon?.remove();
  }

  async suggestForActiveNote(view: MarkdownView) {
    const file = view.file;
    if (!file) {
      new Notice("No active file");
      return;
    }
    await this.suggestForFile(file);
  }

  async suggestForFile(file: TFile, silent = false): Promise<boolean> {
    if (this.isExcluded(file)) {
      if (!silent) new Notice("This note is in an excluded folder");
      return false;
    }

    if (!this.settings.apiKey && !this.isLocalEndpoint()) {
      if (!silent) new Notice("Please set an API key in settings");
      return false;
    }

    if (!silent) new Notice("Analyzing note...");

    try {
      const content = await this.app.vault.read(file);
      const body = this.prepareContent(content);
      const existingTags = await this.getExistingTags();
      const existingFm = this.getExistingFrontmatter(file);

      const result = await this.callAI(body, file.basename, existingTags, existingFm);

      new SuggestionModal(this.app, this, file, result, existingTags).open();
      return true;
    } catch (e) {
      console.error(e);
      if (!silent) new Notice("Failed to get suggestions: " + (e as Error).message);
      return false;
    }
  }

  isExcluded(file: TFile): boolean {
    const excludes = this.settings.excludeFolders
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return excludes.some((ex) => file.path.startsWith(ex) || file.path.startsWith(normalizePath(ex)));
  }

  isLocalEndpoint(): boolean {
    const url = this.settings.baseUrl.toLowerCase();
    return url.includes("localhost") || url.includes("127.0.0.1") || url.includes("0.0.0.0");
  }

  prepareContent(content: string): string {
    let body = this.stripFrontmatter(content);
    if (this.settings.stripCodeBlocks) {
      body = body.replace(/```[\s\S]*?```/g, "[code block omitted]");
    }
    // Prefer start + headings
    const lines = body.split("\n");
    const headings = lines.filter((l) => l.startsWith("#")).slice(0, 10).join("\n");
    const start = lines.slice(0, 40).join("\n");
    const combined = headings + "\n\n" + start;
    return combined.slice(0, this.settings.maxContentLength);
  }

  stripFrontmatter(content: string): string {
    const match = content.match(/^---\n[\s\S]*?\n---\n?/);
    return match ? content.slice(match[0].length) : content;
  }

  getExistingFrontmatter(file: TFile): Record<string, unknown> {
    const cache = this.app.metadataCache.getFileCache(file);
    return cache?.frontmatter || {};
  }

  async getExistingTags(): Promise<string[]> {
    const now = Date.now();
    if (this.tagCache.length && now - this.tagCacheTime < 60_000) {
      return this.tagCache;
    }
    const tags = new Set<string>();
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.tags) {
        cache.tags.forEach((t) => tags.add(t.tag.replace(/^#/, "")));
      }
      if (cache?.frontmatter?.tags) {
        const ft = cache.frontmatter.tags;
        const arr = Array.isArray(ft) ? ft : [ft];
        arr.forEach((t) => tags.add(String(t).replace(/^#/, "")));
      }
    }
    this.tagCache = Array.from(tags).sort();
    this.tagCacheTime = now;
    return this.tagCache;
  }

  fuzzyMatchTag(suggested: string, existing: string[]): string {
    const lower = suggested.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const ex of existing) {
      const exLower = ex.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (exLower === lower) return ex;
    }
    // simple contains
    for (const ex of existing) {
      if (ex.toLowerCase().includes(lower) || lower.includes(ex.toLowerCase())) {
        return ex;
      }
    }
    return suggested;
  }

  async callAI(
    body: string,
    title: string,
    existingTags: string[],
    existingFm: Record<string, unknown>
  ): Promise<SuggestionResult> {
    const tagList = existingTags.slice(0, 150).join(", ");
    const fmSummary = Object.keys(existingFm).length
      ? `Existing frontmatter keys: ${Object.keys(existingFm).join(", ")}`
      : "No existing frontmatter.";

    let prompt = `Analyze this Obsidian note and suggest metadata.
Title: ${title}
${fmSummary}
Content excerpt:
${body}

`;

    if (this.settings.preferExistingTags && tagList) {
      prompt += `Prefer these existing tags when relevant (use exact spelling): ${tagList}\n`;
    }
    if (this.settings.strictExistingTags) {
      prompt += "Only suggest tags that already exist in the vault. Do not invent new tags.\n";
    }

    prompt += `Return ONLY valid JSON with this exact structure:
{
  "tags": ["tag1", "tag2"],
  "aliases": ["alias1"],
  "summary": "one sentence summary"
}
Max tags: ${this.settings.maxTags}.
Use lowercase kebab-case for new tags.
Do not suggest tags or aliases that already exist on this note if possible.
Empty arrays or empty string if nothing useful.`;

    if (this.settings.customPrompt) {
      prompt += `\nAdditional instructions: ${this.settings.customPrompt}`;
    }

    const messages = [
      {
        role: "system",
        content:
          "You are a helpful assistant that suggests clean Obsidian metadata. Always respond with valid JSON only, no markdown fences.",
      },
      { role: "user", content: prompt },
    ];

    let parsed = await this.tryCallAI(messages);
    if (!parsed) {
      // retry with stricter instruction
      messages.push({
        role: "user",
        content: "Your previous response was not valid JSON. Reply with only the JSON object, nothing else.",
      });
      parsed = await this.tryCallAI(messages);
    }

    if (!parsed) {
      throw new Error("AI returned invalid JSON after retry");
    }

    let tags = Array.isArray(parsed.tags) ? parsed.tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [];
    tags = tags.slice(0, this.settings.maxTags);

    // Fuzzy match to existing
    tags = tags.map((t) => this.fuzzyMatchTag(t, existingTags));

    if (this.settings.strictExistingTags) {
      const set = new Set(existingTags.map((t) => t.toLowerCase()));
      tags = tags.filter((t) => set.has(t.toLowerCase()));
    }

    return {
      tags,
      aliases: Array.isArray(parsed.aliases)
        ? parsed.aliases.map((a: unknown) => String(a).trim()).filter(Boolean)
        : [],
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    };
  }

  private async tryCallAI(messages: Array<{role: string; content: string}>): Promise<SuggestionResult | null> {
    const body: Record<string, unknown> = {
      model: this.settings.model,
      messages,
      temperature: this.settings.temperature,
    };
    // Only request json_object if it looks like OpenAI
    if (this.settings.baseUrl.includes("openai.com") || this.settings.model.includes("gpt")) {
      body.response_format = { type: "json_object" };
    }

    const response = await requestUrl({
      url: `${this.settings.baseUrl}/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (response.status !== 200) {
      throw new Error(`API error ${response.status}: ${String(response.text).slice(0, 200)}`);
    }

    const data = response.json;
    const text = data.choices?.[0]?.message?.content || "{}";
    try {
      const cleaned = text.replace(/```json|```/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  async applySuggestions(file: TFile, result: SuggestionResult) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (this.settings.suggestTags && result.tags.length > 0) {
        if (this.settings.tagMode === "replace") {
          fm.tags = result.tags;
        } else {
          const existing = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
          fm.tags = [...new Set([...existing, ...result.tags])];
        }
      }
      if (this.settings.suggestAliases && result.aliases.length > 0) {
        if (this.settings.aliasMode === "replace") {
          fm.aliases = result.aliases;
        } else {
          const existing = Array.isArray(fm.aliases) ? fm.aliases : fm.aliases ? [fm.aliases] : [];
          fm.aliases = [...new Set([...existing, ...result.aliases])];
        }
      }
      if (this.settings.suggestSummary && result.summary) {
        if (this.settings.summaryMode === "skip-if-exists" && fm.summary) {
          // skip
        } else {
          fm.summary = result.summary;
        }
      }
    });
    new Notice("Metadata applied");
  }

  openBatchModal() {
    new BatchModal(this.app, this).open();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class SuggestionModal extends Modal {
  plugin: AIMetadataSuggester;
  file: TFile;
  result: SuggestionResult;
  existingTags: string[];
  tagChecks: TagSuggestion[] = [];
  aliasesEl: HTMLInputElement;
  summaryEl: HTMLTextAreaElement;

  constructor(
    app: App,
    plugin: AIMetadataSuggester,
    file: TFile,
    result: SuggestionResult,
    existingTags: string[]
  ) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.result = result;
    this.existingTags = existingTags;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-metadata-modal");
    new Setting(contentEl).setName("Review AI suggestions").setHeading();

    // Tags with checkboxes
    if (this.result.tags.length) {
      new Setting(contentEl).setName("Tags").setHeading();
      const tagContainer = contentEl.createDiv({ cls: "tag-suggestions" });
      this.tagChecks = this.result.tags.map((tag) => {
        const isNew = !this.existingTags.some((ex) => ex.toLowerCase() === tag.toLowerCase());
        const row = tagContainer.createDiv({ cls: "tag-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = true;
        const label = row.createEl("label");
        label.textContent = tag + (isNew ? " (new)" : " (existing)");
        if (isNew) label.addClass("tag-new");
        label.prepend(cb);
        return { tag, isNew, selected: true };
      });
    } else {
      contentEl.createEl("p", { text: "No tag suggestions." });
    }

    if (this.result.aliases.length) {
      new Setting(contentEl).setName("Aliases").setHeading();
      this.aliasesEl = contentEl.createEl("input", { type: "text" });
      this.aliasesEl.addClass("full-width");
      this.aliasesEl.value = this.result.aliases.join(", ");
    }

    if (this.result.summary) {
      new Setting(contentEl).setName("Summary").setHeading();
      this.summaryEl = contentEl.createEl("textarea");
      this.summaryEl.addClass("summary-area");
      this.summaryEl.value = this.result.summary;
    }

    const buttonRow = contentEl.createDiv({ cls: "modal-button-row" });


    const applyBtn = buttonRow.createEl("button", { text: "Apply" });
    applyBtn.onclick = async () => {
      const selectedTags = this.tagChecks.filter((_, i) => {
        const cbs = contentEl.querySelectorAll(".tag-row input[type=checkbox]");
        return (cbs[i] as HTMLInputElement)?.checked;
      }).map((t) => t.tag);

      const updated: SuggestionResult = {
        tags: selectedTags,
        aliases: this.aliasesEl
          ? this.aliasesEl.value.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        summary: this.summaryEl ? this.summaryEl.value.trim() : "",
      };
      await this.plugin.applySuggestions(this.file, updated);
      this.close();
    };

    const regenBtn = buttonRow.createEl("button", { text: "Regenerate" });
    regenBtn.onclick = async () => {
      this.close();
      await this.plugin.suggestForFile(this.file);
    };

    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class BatchModal extends Modal {
  plugin: AIMetadataSuggester;
  folderEl: HTMLInputElement;

  constructor(app: App, plugin: AIMetadataSuggester) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    new Setting(contentEl).setName("Batch suggest metadata").setHeading();
    contentEl.createEl("p", { text: "Enter a folder path (relative to vault root). All markdown notes in that folder (non-recursive) will be processed." });

    this.folderEl = contentEl.createEl("input", { type: "text", placeholder: "Inbox" });
    this.folderEl.addClass("full-width");
    this.folderEl.addClass("folder-input");

    const go = contentEl.createEl("button", { text: "Start" });
    go.onclick = async () => {
      const folder = this.folderEl.value.trim();
      if (!folder) return;
      this.close();
      await this.runBatch(folder);
    };
  }

  async runBatch(folder: string) {
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.parent?.path === folder || f.path.startsWith(folder + "/"));
    if (!files.length) {
      new Notice("No markdown files found in that folder");
      return;
    }
    new Notice(`Processing ${files.length} notes...`);
    let success = 0;
    for (const file of files) {
      const ok = await this.plugin.suggestForFile(file, true);
      if (ok) success++;
      // simple delay to avoid rate limits
      await new Promise((r) => window.setTimeout(r, 800));
    }
    new Notice(`Batch complete. Opened review for ${success} notes.`);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class AIMetadataSuggesterSettingTab extends PluginSettingTab {
  plugin: AIMetadataSuggester;

  constructor(app: App, plugin: AIMetadataSuggester) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Presets
    new Setting(containerEl)
      .setName("Quick presets")
      .setDesc("Fill common endpoints")
      .addButton((btn) =>
        btn.setButtonText("OpenAI").onClick(async () => {
          this.plugin.settings.baseUrl = "https://api.openai.com/v1";
          this.plugin.settings.model = "gpt-4o-mini";
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Ollama").onClick(async () => {
          this.plugin.settings.baseUrl = "http://localhost:11434/v1";
          this.plugin.settings.model = "llama3";
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("OpenRouter").onClick(async () => {
          this.plugin.settings.baseUrl = "https://openrouter.ai/api/v1";
          this.plugin.settings.model = "openai/gpt-4o-mini";
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Leave empty for local endpoints that do not require a key")
      .addText((text) =>
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Base URL")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .addText((text) =>
        text
          .setPlaceholder("gpt-4o-mini")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Temperature")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.1)
          .setValue(this.plugin.settings.temperature)
                    .onChange(async (value) => {
            this.plugin.settings.temperature = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Send a minimal request to verify the endpoint and key")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          try {
            const res = await requestUrl({
              url: `${this.plugin.settings.baseUrl}/chat/completions`,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.plugin.settings.apiKey}`,
              },
              body: JSON.stringify({
                model: this.plugin.settings.model,
                messages: [{ role: "user", content: "Reply with the word ok" }],
                max_tokens: 5,
              }),
            });
            if (res.status === 200) new Notice("Connection successful");
            else new Notice("Connection failed: " + res.status);
          } catch (e) {
            new Notice("Connection error: " + (e as Error).message);
          }
        })
      );

    new Setting(containerEl).setName("Suggest tags").addToggle((t) =>
      t.setValue(this.plugin.settings.suggestTags).onChange(async (v) => {
        this.plugin.settings.suggestTags = v;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl).setName("Suggest aliases").addToggle((t) =>
      t.setValue(this.plugin.settings.suggestAliases).onChange(async (v) => {
        this.plugin.settings.suggestAliases = v;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl).setName("Suggest summary").addToggle((t) =>
      t.setValue(this.plugin.settings.suggestSummary).onChange(async (v) => {
        this.plugin.settings.suggestSummary = v;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl)
      .setName("Max tags")
      .addSlider((s) =>
        s
          .setLimits(1, 12, 1)
          .setValue(this.plugin.settings.maxTags)
                    .onChange(async (v) => {
            this.plugin.settings.maxTags = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Prefer existing tags")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.preferExistingTags).onChange(async (v) => {
          this.plugin.settings.preferExistingTags = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Strict existing tags only")
      .setDesc("Never create new tags")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.strictExistingTags).onChange(async (v) => {
          this.plugin.settings.strictExistingTags = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Tag apply mode")
      .addDropdown((d) =>
        d
          .addOption("append", "Append")
          .addOption("replace", "Replace")
          .setValue(this.plugin.settings.tagMode)
          .onChange(async (v: "append" | "replace") => {
            this.plugin.settings.tagMode = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Alias apply mode")
      .addDropdown((d) =>
        d
          .addOption("append", "Append")
          .addOption("replace", "Replace")
          .setValue(this.plugin.settings.aliasMode)
          .onChange(async (v: "append" | "replace") => {
            this.plugin.settings.aliasMode = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Summary apply mode")
      .addDropdown((d) =>
        d
          .addOption("replace", "Replace")
          .addOption("skip-if-exists", "Skip if exists")
          .setValue(this.plugin.settings.summaryMode)
          .onChange(async (v: string) => {
            this.plugin.settings.summaryMode = v as "replace" | "skip-if-exists";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Strip code blocks")
      .setDesc("Omit code blocks from the content sent to the AI")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.stripCodeBlocks).onChange(async (v) => {
          this.plugin.settings.stripCodeBlocks = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Max content length")
      .addSlider((s) =>
        s
          .setLimits(2000, 12000, 500)
          .setValue(this.plugin.settings.maxContentLength)
                    .onChange(async (v) => {
            this.plugin.settings.maxContentLength = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Exclude folders")
      .setDesc("Comma-separated folder paths")
      .addText((text) =>
        text
          .setPlaceholder("Templates, Archive")
          .setValue(this.plugin.settings.excludeFolders)
          .onChange(async (value) => {
            this.plugin.settings.excludeFolders = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Custom prompt addition")
      .addTextArea((text) =>
        text
          .setPlaceholder("Prefer technical tags...")
          .setValue(this.plugin.settings.customPrompt)
          .onChange(async (value) => {
            this.plugin.settings.customPrompt = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("p", {
      text: "Privacy: Note content is sent to the configured API endpoint. Use a local endpoint (Ollama) for full privacy.",
      cls: "setting-item-description",
    });
  }
}