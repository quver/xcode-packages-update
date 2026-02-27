# Contributing

## Reporting bugs and requesting features

Before opening a pull request, please [open an issue](../../issues/new/choose) first to discuss what you would like to change. For bugs, include the Xcode version, the `Package.resolved` snippet that caused the problem, and the full action log.

## Development setup

```bash
npm ci
```

## Making changes

Source files:
- `main.js` — entry point, reads inputs and orchestrates the run
- `post.js` — cleanup, always runs after the action finishes
- `src/packages.js` — core logic for parsing and comparing `Package.resolved`

After modifying source files, rebuild the dist:

```bash
npm run build
```

Commit both the source changes and the updated `dist/`.

## Tests

```bash
npm test
```

Tests live in `tests/`. Add a test for every new behaviour in `src/packages.js`.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | When to use |
|--------|-------------|
| `feat:` | New feature or input/output |
| `fix:` | Bug fix |
| `perf:` | Performance improvement |
| `deps:` | Dependency update |
| `build:` | Build system changes |
| `docs:` | Documentation only |
| `test:` | Tests only |
| `chore:` | Anything else |

## Releasing

Releases are created via the **Release** workflow in GitHub Actions. Provide the version in `A.B.C` format and the workflow handles tagging, changelog generation and publishing the GitHub Release.
