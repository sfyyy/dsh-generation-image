# Implement — dsh-generation-image

## Ordered execution plan

1. **Scaffold** the plugin at the workspace root (this repo IS the plugin):
   - `package.json` (name `@dsh-extension/dsh-generation-image`, version
     1.0.0, plain ESM, peerDeps + `dsh.bundle` block, scripts
     `test`/`prepack`), `cordis.patch.yml`, `.gitignore`, `LICENSE` (MIT),
     `AGENTS.md` already present.
2. **Host half** `lib/index.js`:
   - Config constants + `z` schema (`enabled/baseUrl/apiKey/apiKeyEnv/model/
     size/quality`), env helpers, config-file helpers, `resolveConfig`.
   - `sniffMediaType`, `contentHasImage`, `rewriteImagesDeep`,
     `imageMarker`, `rewriteImageBlocksToMarkers`, `collectMessageAttachmentRefs`
     (only the pieces actually needed).
   - `resolveBaseUrl`, `parseSseImages`, `generateImagesFromApi`.
   - `installAdmissionBypass`, `installSessionWrap` (+ `agent/pre-step`),
     `createGenerateImageTool`, `syncToolRegistration`,
     `installSettingsRoute`, `system-prompt/assemble` hook.
   - `apply(ctx, config)` composing everything; `export const inject`, `name`.
3. **Browser half** `lib/client.js`: Settings section form (ModuleLoader
   format), route `/_dsh/generation-image/settings`.
4. **Tests** `test/index.test.js`: fake ctx + canned fetch; cover the
   acceptance criteria in R6.
5. **Docs**: `README.md` + `README.zh-CN.md`.
6. **Verify**:
   - `npm test` green.
   - `node --check lib/index.js` and `node --check lib/client.js`.
   - Optional live check: install into the `web` profile (link dependency,
     like vision-bridge) and restart `dsh web`; confirm the Settings page
     section + `generate_image` tool.
7. **Commit** per Trellis Phase 3.4.

## Validation commands

- `npm test` (node --test)
- `node --check lib/index.js lib/client.js`
- `python3 ./.trellis/scripts/task.py validate <task>` (context manifests)

## Review gates

- After step 4 (tests green) before writing docs: re-read `prd.md` acceptance
  criteria and confirm coverage.
- Before commit: `trellis-check` style pass — lint/type-check equivalent
  (`node --check`), cross-file consistency, no leftover TODOs.

## Rollback

- Keep `lib/` changes isolated; `git` tracks every file. If a piece misbehaves,
  revert the specific file and re-run tests.
