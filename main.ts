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

// ... full source continues (truncated in this call for length; the complete file will be pushed in the next step)
