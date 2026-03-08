# Contributing to RetroVault

Thank you for your interest in contributing! This document describes the workflow, standards, and guidelines for contributing to RetroVault.

---

## Ways to Contribute

- **Bug reports** — open an issue with reproduction steps and debug info from Settings → Debug → "Copy Debug Info"
- **Bug fixes** — fork, fix, and open a pull request (PR) with a regression test
- **New features** — discuss in an issue first if the feature is large; smaller improvements can go straight to a PR
- **New system support** — add system definitions and tier tuning (see below)
- **Documentation** — improve docs, fix inaccuracies, or expand guides
- **Testing** — work through [`docs/USER_TESTING.md`](docs/USER_TESTING.md) and report any failures

---

## Development Setup

```bash
git clone https://github.com/awest813/WebPPSSPP.git
cd WebPPSSPP
npm install
npm run dev        # dev server at http://localhost:5173
npm test           # run all unit tests
npm run build      # type-check + production build
npm run lint       # ESLint on src/
npm run doctor     # first-time environment diagnostics
```

### Requirements

- Node.js 18+ (Node 20+ recommended)
- npm 9+
- Modern browser (Chrome/Edge for PSP testing)

---

## Branching & PR Workflow

1. **Fork** the repository and clone your fork locally
2. Create a **feature branch** from `main`:
   ```bash
   git checkout -b feat/my-change
   ```
3. Make focused, incremental commits with clear messages
4. Run `npm test` and `npm run build` before pushing — both must pass
5. Push your branch and **open a pull request** against `main`
6. Fill out the PR description with:
   - What changed and why
   - How to test the change manually
   - For performance changes: an empirical measurement or benchmark result
   - Screenshots or recordings for UI changes

Branch naming conventions:

| Prefix | Use for |
|--------|---------|
| `feat/` | New features or enhancements |
| `fix/` | Bug fixes |
| `docs/` | Documentation-only changes |
| `perf/` | Performance improvements |
| `refactor/` | Code restructuring without behaviour change |
| `test/` | Adding or improving tests |

---

## Code Standards

### TypeScript

- All source files are TypeScript; avoid `any` except where unavoidable (add a comment explaining why)
- Use explicit return types on exported functions
- Prefer `const` over `let`; avoid `var`
- Use `===` / `!==` for all comparisons

### Style

- Follow the existing code style — 2-space indentation, single quotes for strings
- ESLint is configured in `eslint.config.js`; run `npm run lint` and fix all warnings before opening a PR
- Do not add comments that merely repeat the code; comments should explain *why*, not *what*

### Visual Studio Code

If you use VS Code, disable the auto-formatter for this repo to avoid style conflicts:

```json
// .vscode/settings.json
{
  "diffEditor.ignoreTrimWhitespace": false,
  "editor.formatOnPaste": false,
  "editor.formatOnSave": false,
  "editor.formatOnSaveMode": "modifications"
}
```

---

## Testing

Every code change should include tests where practical.

- Tests live alongside source files as `src/*.test.ts`
- The test runner is [Vitest](https://vitest.dev/) with jsdom environment
- Run a single test file: `npx vitest run src/my-module.test.ts`
- Run all tests: `npm test`
- All 1 050+ existing tests must continue to pass

### Writing tests

- Follow the existing test file structure (describe / it blocks)
- Use `vi.fn()` for mocks; restore with `vi.restoreAllMocks()` in `afterEach`
- Test behaviour, not implementation — avoid reaching into private internals unless testing an invariant
- For UI tests, use `buildDOM()` + `initUI()` pattern from existing `src/ui.test.ts`

### What needs a test

| Change type | Test required |
|-------------|---------------|
| New utility function | Unit test covering happy path + edge cases |
| Bug fix | Regression test that fails before the fix, passes after |
| New emulator option / tier setting | Test in `src/systems.test.ts` |
| UI behaviour change | Test in `src/ui.test.ts` |
| Performance improvement | Benchmark or measurement in PR description (not necessarily a test) |

---

## Adding System Support

To add a new emulated system:

1. **`src/systems.ts`** — add a `SystemInfo` entry with:
   - `id`, `name`, `extensions` array, `ejsSystem` (EmulatorJS system key)
   - `tierSettings` object with `low`, `medium`, `high`, and `ultra` entries
   - BIOS requirements if applicable
2. **`src/systems.test.ts`** — add tests verifying the new system is returned by `getSystemById()` and that all four tiers are defined
3. **`docs/ROADMAP.md`** — add the new system to the relevant completed phase
4. **`README.md`** — add the system to the features list if it is a notable addition

### Tier settings guidelines

| Tier | Target hardware | Goal |
|------|-----------------|------|
| Low | Integrated GPU / low-end mobile | Playable at native resolution with minimal enhancements |
| Medium | Mid-range GPU / modern mobile | Moderate resolution scaling and filtering |
| High | Discrete GPU / desktop | High-resolution scaling, enhanced filtering, better accuracy |
| Ultra | High-end desktop / gaming GPU | Maximum quality; accuracy over performance |

---

## Performance Improvements

Performance PRs must include one of:

- A measured before/after value from DevTools Performance panel
- A benchmark result from `benchmark.js` or `benchmark_dom.js`
- An empirical timing from the diagnostic event timeline (Settings → Debug)

Document the measurement in the PR description so it can be reproduced by reviewers.

---

## Documentation Changes

- Keep documentation accurate and consistent with the code
- Update `docs/ROADMAP.md` when completing or planning features
- Update `README.md` when adding significant new capabilities
- Consult `docs/USER_TESTING.md` when describing how to manually verify a feature

---

## Reporting Bugs

Open a GitHub issue and include:

1. Browser name and version
2. Operating system
3. Debug info from Settings → Debug → "Copy Debug Info" (paste as a code block)
4. Exact reproduction steps
5. Expected vs actual behaviour
6. Screenshot or recording if relevant

---

## Code of Conduct

All contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Be respectful and constructive in all interactions.

---

## License

By contributing, you agree that your changes will be licensed under the [MIT License](LICENSE) that covers this project.
