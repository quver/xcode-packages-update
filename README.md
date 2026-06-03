<div align="center">
  <img src="assets/logo.svg" width="80" alt="logo" />

# xcode-packages-update

[![Build](https://github.com/quver/xcode-packages-update/actions/workflows/test.yml/badge.svg)](https://github.com/quver/xcode-packages-update/actions/workflows/test.yml)
[![codecov](https://codecov.io/github/quver/xcode-packages-update/graph/badge.svg?token=90NQCWJ1ZQ)](https://codecov.io/github/quver/xcode-packages-update)
[![GitHub release](https://img.shields.io/github/v/release/quver/xcode-packages-update)](https://github.com/quver/xcode-packages-update/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-xcode--packages--update-blue?logo=github)](https://github.com/marketplace/actions/xcode-packages-update)

</div>

A GitHub Action that resolves Xcode Swift Package Manager dependencies and reports what changed. Optionally generates an **HTML dependency report**, a **CycloneDX SBOM**, and classifies packages as **App** or **Development** automatically.

## Features

- Resolves all SPM packages and detects additions, removals, and version updates
- Outputs a human-readable summary suitable for PR descriptions
- **HTML report** — full dependency table with version diffs, repo links, type badge, and change status
- **CycloneDX 1.6 SBOM** — machine-readable bill of materials with proper PURL identifiers
- **Automatic dev/app classification** — scans `Package.swift` files and `project.pbxproj` to distinguish test frameworks and build-tool plugins from production dependencies, no configuration required

## Usage

### With an Xcode project

```yaml
- name: Resolve dependencies
  id: resolution
  uses: quver/xcode-packages-update@v3
  with:
    project_file: 'MyApp.xcodeproj'
    html_report_path: 'artifacts/deps.html'
    sbom_path: 'artifacts/sbom.json'

- name: Upload dependency report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: spm-report
    path: artifacts/
```

### With an Xcode workspace

```yaml
- name: Resolve dependencies
  id: resolution
  uses: quver/xcode-packages-update@v3
  with:
    workspace_file: 'MyApp.xcworkspace'
    scheme: 'MyApp'
    html_report_path: 'artifacts/deps.html'
    sbom_path: 'artifacts/sbom.json'
```

> **Note:** The scheme must be marked as shared in Xcode — _Product → Scheme → Manage Schemes → check "Shared"_.

### Open a pull request with updated `Package.resolved`

```yaml
- name: Open pull request
  if: steps.resolution.outputs.dependenciesChanged == 'true'
  uses: peter-evans/create-pull-request@v7
  with:
    branch: deps/spm-updates
    commit-message: 'deps: update SPM packages'
    title: 'deps: update SPM packages'
    body: ${{ steps.resolution.outputs.summary }}
```

### Full example with Trivy vulnerability scan

```yaml
jobs:
  spm-update:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - name: Resolve and report dependencies
        id: spm
        uses: quver/xcode-packages-update@v3
        with:
          project_file: 'MyApp.xcodeproj'
          html_report_path: 'artifacts/deps.html'
          sbom_path: 'artifacts/sbom.json'

      - name: Scan SBOM with Trivy
        uses: aquasecurity/trivy-action@v0.30.0
        with:
          scan-type: sbom
          input: 'artifacts/sbom.json'
          severity: CRITICAL,HIGH
          exit-code: '0'
          format: table

      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: spm-report
          path: artifacts/

      - name: Open pull request
        if: steps.spm.outputs.dependenciesChanged == 'true'
        uses: peter-evans/create-pull-request@v7
        with:
          branch: deps/spm-updates
          commit-message: 'deps: update SPM packages'
          title: 'deps: update SPM packages'
          body: ${{ steps.spm.outputs.summary }}
```

## Inputs

| Input                         | Required                      | Default    | Description                                                                                                                  |
| ----------------------------- | ----------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `project_file`                | Yes (if no `workspace_file`)  | —          | Path to the `.xcodeproj` file. Mutually exclusive with `workspace_file`.                                                     |
| `workspace_file`              | Yes (if no `project_file`)    | —          | Path to the `.xcworkspace` file. Mutually exclusive with `project_file`.                                                     |
| `scheme`                      | Yes (if `workspace_file` set) | —          | Xcode scheme to use. Required with `workspace_file`. Must be a shared scheme.                                                |
| `temporary_packages_dir_path` | No                            | `.spm-tmp` | Temporary directory for cloned SPM sources.                                                                                  |
| `html_report_path`            | No                            | —          | Path where the HTML dependency report will be written. Parent directories are created automatically.                         |
| `sbom_path`                   | No                            | —          | Path where the CycloneDX 1.6 JSON SBOM will be written. Parent directories are created automatically.                        |
| `development_packages`        | No                            | —          | Newline- or comma-separated list of package identities to treat as development-only. Overrides auto-detection when provided. |

## Outputs

| Output                | Description                                                                            |
| --------------------- | -------------------------------------------------------------------------------------- |
| `dependenciesChanged` | `'true'` if any package was added, removed, or updated                                 |
| `summary`             | Human-readable list of changes, suitable for a PR body                                 |
| `html_report_path`    | Path to the generated HTML report (only set when `html_report_path` input is provided) |
| `sbom_path`           | Path to the generated CycloneDX SBOM (only set when `sbom_path` input is provided)     |

## HTML dependency report

When `html_report_path` is set, the action writes a self-contained HTML file with a full dependency table. Each row shows:

- **Package** — repository name, linked to the source URL
- **Version** — installed version; for updated packages shown as `old → new`
- **Type** — `📦 App` or `🛠 Development` (see [Dev package classification](#dev-package-classification))
- **Change** — `✨ added`, `🗑 removed`, `⬆ updated`, or blank

Rows are colour-coded: green for added, yellow for updated, red with strikethrough for removed.

## CycloneDX SBOM

When `sbom_path` is set, the action writes a [CycloneDX 1.6](https://cyclonedx.org/specification/overview/) JSON SBOM. Each component includes:

- `name` — package identity from `Package.resolved`
- `version` — resolved version
- `purl` — package URL in `pkg:swift/{host}/{owner}/{repo}@{version}` format
- `scope` — `required` for app packages, `excluded` for development packages
- `externalReferences` — VCS link to the source repository

The SBOM can be consumed by any CycloneDX-compatible tool, including [Trivy](https://trivy.dev/docs/latest/coverage/language/swift/), GitHub Dependency Review, and OWASP Dependency-Track.

## Dev package classification

The action classifies every resolved package as either **App** or **Development**. Classification is fully automatic — no manual configuration required.

### Automatic detection

The action scans two sources:

**`Package.swift` files** (all modules in the project):

| Condition                                                                     | Classification |
| ----------------------------------------------------------------------------- | -------------- |
| Package referenced in `.testTarget(...)` dependencies                         | Development    |
| Package referenced in `plugins: [.plugin(name:, package:)]` inside any target | Development    |
| Package referenced in `.target(...)` dependencies                             | App            |
| Package appears in both `.target` and `.testTarget`                           | App wins       |

**`project.pbxproj`** (Xcode-managed dependencies):

| Condition                                                                                                       | Classification |
| --------------------------------------------------------------------------------------------------------------- | -------------- |
| Product linked only to targets whose name ends with `Tests`                                                     | Development    |
| Package in project references but not linked to any non-test target (build-tool plugins, e.g. SwiftLintPlugins) | Development    |
| Product linked to at least one non-test target                                                                  | App            |

If a package is classified as App in either source, App wins.

### Manual override

Set `development_packages` to skip auto-detection entirely for that list:

```yaml
- uses: quver/xcode-packages-update@v3
  with:
    project_file: 'MyApp.xcodeproj'
    html_report_path: 'artifacts/deps.html'
    sbom_path: 'artifacts/sbom.json'
    development_packages: |
      swift-snapshot-testing
      pactswift
      swiftlintplugins
```

Identities are matched case-insensitively against the `identity` field in `Package.resolved`.

## Example summary output

```
- removed: old-package 2.0.0
- added:   swift-snapshot-testing 1.18.9
- updated: firebase 11.12.0 → 11.13.0
```

## Reporting issues and feature requests

Found a bug or have an idea for improvement? Please [open an issue](../../issues/new/choose). Include as much context as possible — Xcode version, `Package.resolved` snippet, and the full action log.

## License

[MIT](LICENSE)
