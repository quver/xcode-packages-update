# xcode-packages-update

A GitHub Action that resolves Xcode Swift Package Manager dependencies and reports what changed.

After running, the action exposes a `dependenciesChanged` output that you can use to conditionally open a pull request with the updated `Package.resolved`.

## Usage

```yaml
- name: Resolve dependencies
  id: resolution
  uses: Quver/xcode-packages-update@v1
  with:
    project_file: 'MyApp.xcodeproj'

- name: Open pull request with updated Package.resolved
  if: steps.resolution.outputs.dependenciesChanged == 'true'
  uses: peter-evans/create-pull-request@v3
  with:
    branch: deps/spm-updates
    commit-message: 'deps: update SPM packages'
    title: 'deps: update SPM packages'
    body: ${{ steps.resolution.outputs.summary }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `project_file` | Yes | — | Path to the `.xcodeproj` file |
| `temporary_packages_dir_path` | No | `.spm-tmp` | Temporary directory for cloned SPM sources |

## Outputs

| Output | Description |
|--------|-------------|
| `dependenciesChanged` | `true` if any package was added, removed or updated |
| `summary` | Human-readable list of changes, ready to use as a PR body |

## Example output

```
Dependencies changed:
  updated: firebase: 11.12.0 → 11.13.0
  added:   swift-snapshot-testing: 1.18.9
  removed: old-package: 2.0.0
```

## Reporting issues and feature requests

Found a bug or have an idea for improvement? Please [open an issue](../../issues/new/choose). Include as much context as possible — Xcode version, `Package.resolved` snippet, and the full action log.

## License

[MIT](LICENSE)
