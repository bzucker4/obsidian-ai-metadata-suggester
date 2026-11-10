# AI Metadata Suggester

Suggest tags, aliases, and a short summary for the current Obsidian note using an AI provider. Review the suggestions in a modal before anything is written to frontmatter.

## Features

- Command + ribbon icon: **Suggest metadata for current note**
- Batch command: process a folder (opens review modal per note)
- Prefers existing vault tags (with fuzzy matching) and optional strict mode (no new tags)
- Review modal with checkboxes for tags (new tags highlighted), editable aliases and summary
- Regenerate button
- Append or replace modes for tags, aliases, and summary
- Configurable OpenAI-compatible endpoint with quick presets (OpenAI, Ollama, OpenRouter)
- Test connection button
- Exclude folders, strip code blocks, adjustable content length
- Custom prompt addition
- Tag cache for performance

## Setup

1. Build: `npm install && npm run build`
2. Copy the folder into `.obsidian/plugins/`
3. Enable the plugin
4. Configure API key / base URL / model in settings (or use a local Ollama endpoint)
5. Open a note and use the command or ribbon icon

## Privacy

Note content (intelligently truncated) is sent to the API endpoint you configure. Use a local model (Ollama preset) for full privacy.

## Development

```bash
npm install
npm run dev
```

## License

MIT
