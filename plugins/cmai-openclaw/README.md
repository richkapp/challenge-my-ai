# CMAI OpenClaw plugin assets

Static native-plugin assets for `@challenge-my-ai/openclaw-adapter`.

- `openclaw.plugin.json` is the cold, no-code manifest.
- `skills/cmai-contribution/SKILL.md` is the contribution procedure loaded by OpenClaw.
- TypeScript implementation, build metadata, tests, and the private local staging script live in `packages/cmai-openclaw-adapter/`.

The staged local artifact copies these assets beside the compiled `dist/index.js`. This directory is not a separately installable package and is not published by this card.
