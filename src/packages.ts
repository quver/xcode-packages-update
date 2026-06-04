import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export interface PackageInfo {
    version: string;
    url: string;
}

interface ResolvedPin {
    identity: string;
    location?: string;
    state?: {
        version?: string;
        branch?: string;
        revision?: string;
    };
}

interface ResolvedFile {
    pins: ResolvedPin[];
}

function parseResolved(filePath: string): ResolvedPin[] {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as ResolvedFile;
    return parsed.pins ?? [];
}

function resolveVersion(state: ResolvedPin['state']): string {
    return state?.version ?? state?.branch ?? state?.revision ?? '';
}

export function getPackages(filePath: string): Map<string, string> {
    const pins = parseResolved(filePath);
    return new Map(pins.map((pin) => [pin.identity, resolveVersion(pin.state)]));
}

export function getPackagesWithInfo(filePath: string): Map<string, PackageInfo> {
    const pins = parseResolved(filePath);
    return new Map(
        pins.map((pin) => [
            pin.identity,
            {
                version: resolveVersion(pin.state),
                url: pin.location ?? ''
            }
        ])
    );
}

export interface CompareResult {
    removed: string[];
    added: string[];
    updated: string[];
}

// ─── Latest available version ────────────────────────────────────────────────

/** Runs a command and returns its stdout. Mirrors @actions/exec output. */
export type ExecFn = (command: string, args: string[]) => Promise<string>;

function compareVersionParts(a: number[], b: number[]): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

/**
 * Picks the highest stable semantic version from a list of git tags.
 * Pre-release tags (e.g. `1.0.0-beta`) and non-semver tags are ignored.
 * Returns the version without a leading `v`, or '' when no stable tag exists.
 */
export function selectLatestStableVersion(tags: string[]): string {
    let best: number[] | null = null;

    for (const raw of tags) {
        const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
        if (!match) continue;

        const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
        if (!best || compareVersionParts(parts, best) > 0) {
            best = parts;
        }
    }

    return best ? best.join('.') : '';
}

/**
 * Resolves the highest available version for each package by reading its git tags
 * via `git ls-remote`. Packages without a URL or without reachable tags are skipped.
 */
export async function getLatestVersions(
    afterInfo: Map<string, PackageInfo>,
    runGit: ExecFn
): Promise<Map<string, string>> {
    const entries = [...afterInfo.entries()].filter(([, info]) => info.url);

    const results = await Promise.all(
        entries.map(async ([identity, info]) => {
            try {
                const stdout = await runGit('git', ['ls-remote', '--tags', '--refs', info.url]);
                const tags = stdout
                    .split('\n')
                    .map((line) => line.split('/').pop()?.trim() ?? '')
                    .filter(Boolean);
                return [identity, selectLatestStableVersion(tags)] as const;
            } catch {
                return [identity, ''] as const;
            }
        })
    );

    return new Map(results.filter(([, version]) => version));
}

export function comparePackages(before: Map<string, string>, after: Map<string, string>): CompareResult {
    const removed = [...before.keys()].filter((k) => !after.has(k));
    const added = [...after.keys()].filter((k) => !before.has(k));
    const updated = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
    return { removed, added, updated };
}

// ─── Dev package auto-detection ──────────────────────────────────────────────

const EXCLUDE_DIRS = new Set(['.build', 'node_modules', '.git', 'DerivedData', '.spm-tmp', '.swiftpm']);

function findPackageSwiftFiles(rootDir: string): string[] {
    const results: string[] = [];

    function scan(dir: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory() && !EXCLUDE_DIRS.has(entry.name)) {
                scan(path.join(dir, entry.name));
            } else if (entry.isFile() && entry.name === 'Package.swift') {
                results.push(path.join(dir, entry.name));
            }
        }
    }

    scan(rootDir);
    return results;
}

/**
 * Extracts all `.keyword(...)` blocks from Package.swift content using bracket counting.
 * Handles `.testTarget` vs `.target` correctly — `.target` won't match `.testTarget`
 * because Swift uses camelCase (`.testTarget`, not `.targetTest`).
 */
function extractBlocks(content: string, keyword: string): string[] {
    const blocks: string[] = [];
    const pattern = new RegExp(`(?<![A-Za-z0-9])\\.${keyword}\\s*\\(`, 'g');
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
        let depth = 1;
        let i = match.index + match[0].length;

        while (i < content.length && depth > 0) {
            if (content[i] === '(') depth++;
            else if (content[i] === ')') depth--;
            i++;
        }

        blocks.push(content.slice(match.index + match[0].length, i - 1));
    }

    return blocks;
}

/** Returns package identities referenced via `.product(name:, package:)` in a block. */
function productPackageRefs(block: string): string[] {
    return [...block.matchAll(/\.product\s*\([^)]*package:\s*"([^"]+)"/g)].map(([, pkg]) => pkg.toLowerCase());
}

/** Returns package identities referenced via `.plugin(name:, package:)` in a block. */
function pluginPackageRefs(block: string): string[] {
    return [...block.matchAll(/\.plugin\s*\([^)]*package:\s*"([^"]+)"/g)].map(([, pkg]) => pkg.toLowerCase());
}

/** Derives SPM identity (lowercase repo name) from a remote repository URL. */
function identityFromUrl(url: string): string {
    return url
        .replace(/\.git\s*$/, '')
        .replace(/\/+$/, '')
        .split('/')
        .pop()!
        .toLowerCase();
}

/**
 * Parses a project.pbxproj file and classifies remote SPM packages as dev or app.
 *
 * Dev heuristics for Xcode-level deps:
 *  1. Package product is only linked to targets whose name ends with "Tests".
 *  2. Package is in XCRemoteSwiftPackageReference (added to the project) but none of
 *     its products are linked to non-test targets — i.e. it is used only as a build-tool
 *     plugin (e.g. SwiftLintPlugins).
 */
export function detectXcodeDevPackages(pbxprojPath: string): { devRefs: Set<string>; appRefs: Set<string> } {
    let content: string;
    try {
        content = fs.readFileSync(pbxprojPath, 'utf8');
    } catch {
        return { devRefs: new Set(), appRefs: new Set() };
    }

    // XCRemoteSwiftPackageReference id → identity
    const remoteRefToIdentity = new Map<string, string>();
    for (const m of content.matchAll(
        /(\w{24}) \/\* XCRemoteSwiftPackageReference "[^"]*" \*\/ = \{[^}]*repositoryURL = "([^"]+)"/g
    )) {
        remoteRefToIdentity.set(m[1], identityFromUrl(m[2]));
    }

    // XCSwiftPackageProductDependency id → identity (only for remote packages)
    const prodDepToIdentity = new Map<string, string>();
    for (const m of content.matchAll(
        /(\w{24}) \/\* \S+ \*\/ = \{\s*isa = XCSwiftPackageProductDependency;\s*(?:package = (\w+) [^;]+;\s*)?productName = [^;]+;/g
    )) {
        const depId = m[1];
        const pkgRef = m[2];
        if (pkgRef && remoteRefToIdentity.has(pkgRef)) {
            prodDepToIdentity.set(depId, remoteRefToIdentity.get(pkgRef)!);
        }
    }

    // PBXNativeTarget → classify product deps
    const devRefs = new Set<string>();
    const appRefs = new Set<string>();

    for (const m of content.matchAll(
        /isa = PBXNativeTarget;.*?name = ([^;]+);.*?packageProductDependencies = \(([^)]*)\)/gs
    )) {
        const rawName = m[1].trim().replace(/^"|"$/g, '');
        const isTestTarget = rawName.endsWith('Tests');
        for (const depId of m[2].matchAll(/(\w{24})/g)) {
            const identity = prodDepToIdentity.get(depId[1]);
            if (identity) {
                (isTestTarget ? devRefs : appRefs).add(identity);
            }
        }
    }

    // Package references present in the project but never linked to any non-test target
    // (e.g. build-tool plugins like SwiftLintPlugins) → dev
    for (const identity of remoteRefToIdentity.values()) {
        if (!appRefs.has(identity) && !devRefs.has(identity)) {
            devRefs.add(identity);
        }
    }

    return { devRefs, appRefs };
}

function findPbxprojFiles(rootDir: string): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
        return results;
    }
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name.endsWith('.xcodeproj')) {
            const candidate = path.join(rootDir, entry.name, 'project.pbxproj');
            const pbxprojExists = fs.existsSync(candidate);
            if (pbxprojExists) {
                results.push(candidate);
            }
        }
    }
    return results;
}

/**
 * Scans Package.swift files and project.pbxproj files in `projectRoot` and returns
 * identities that are referenced exclusively in test targets or as build tool plugins —
 * never in regular app targets.
 * Falls back gracefully: if parsing yields no results the set is empty (no false positives).
 */
export function detectDevPackages(resolvedFilePath: string, projectRoot: string): Set<string> {
    const devRefs = new Set<string>();
    const appRefs = new Set<string>();

    // ── Package.swift scan ──────────────────────────────────────────────────
    for (const filePath of findPackageSwiftFiles(projectRoot)) {
        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch {
            continue;
        }

        for (const block of extractBlocks(content, 'testTarget')) {
            for (const ref of productPackageRefs(block)) devRefs.add(ref);
        }

        for (const block of extractBlocks(content, 'target')) {
            for (const ref of productPackageRefs(block)) appRefs.add(ref);
            for (const [, pluginsBlock] of block.matchAll(/plugins\s*:\s*\[([^\]]*)\]/gs)) {
                for (const ref of pluginPackageRefs(pluginsBlock)) devRefs.add(ref);
            }
        }
    }

    // ── project.pbxproj scan ────────────────────────────────────────────────
    for (const pbxprojPath of findPbxprojFiles(projectRoot)) {
        const { devRefs: pbxDev, appRefs: pbxApp } = detectXcodeDevPackages(pbxprojPath);
        for (const ref of pbxDev) devRefs.add(ref);
        for (const ref of pbxApp) appRefs.add(ref);
    }

    // Packages only in dev context, never in app context
    const resolved = getPackagesWithInfo(resolvedFilePath);
    const result = new Set<string>();

    for (const ref of devRefs) {
        if (!appRefs.has(ref) && resolved.has(ref)) {
            result.add(ref);
        }
    }

    return result;
}

// ─── Dependency graph ────────────────────────────────────────────────────────

/**
 * Returns child package identities declared via `.package(url:)` in a manifest.
 * Each `.package(...)` call is isolated with the bracket-counting `extractBlocks`
 * helper, so a `url:` argument is matched within its own call rather than via a
 * flat regex that breaks on `)` in a preceding argument. Local `.package(path:)`
 * deps have no `url:` and are skipped.
 */
function manifestPackageDeps(content: string): string[] {
    const deps: string[] = [];
    for (const block of extractBlocks(content, 'package')) {
        const match = /url:\s*"([^"]+)"/.exec(block);
        if (match) deps.push(identityFromUrl(match[1]));
    }
    return deps;
}

/**
 * Returns the project's direct SPM dependencies (the graph roots): every package the
 * project itself references, gathered from project.pbxproj remote references and from
 * Package.swift manifests located in the project root. Only identities present in
 * Package.resolved are kept.
 */
export function getDirectDependencies(resolvedSet: Set<string>, projectRoot: string): Set<string> {
    const direct = new Set<string>();

    for (const filePath of findPackageSwiftFiles(projectRoot)) {
        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch {
            continue;
        }
        for (const ref of manifestPackageDeps(content)) {
            if (resolvedSet.has(ref)) direct.add(ref);
        }
    }

    for (const pbxprojPath of findPbxprojFiles(projectRoot)) {
        const { devRefs, appRefs } = detectXcodeDevPackages(pbxprojPath);
        for (const ref of [...devRefs, ...appRefs]) {
            if (resolvedSet.has(ref)) direct.add(ref);
        }
    }

    return direct;
}

/**
 * Builds child edges for every resolved package by reading each cloned checkout's
 * Package.swift manifest. The checkout directory name (lower-cased) is the package
 * identity. Child identities come from `.package(url:)` declarations and are kept
 * only when they are part of the resolved set (this drops e.g. test-only dependencies
 * of dependencies that SPM never resolved).
 */
export function getDependencyEdges(checkoutsDir: string, resolvedSet: Set<string>): Map<string, string[]> {
    const edges = new Map<string, string[]>();

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(checkoutsDir, { withFileTypes: true });
    } catch {
        return edges;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const identity = entry.name.toLowerCase();
        if (!resolvedSet.has(identity)) continue;

        let content: string;
        try {
            content = fs.readFileSync(path.join(checkoutsDir, entry.name, 'Package.swift'), 'utf8');
        } catch {
            continue;
        }

        const children = [...new Set(manifestPackageDeps(content))].filter(
            (child) => child !== identity && resolvedSet.has(child)
        );
        if (children.length > 0) edges.set(identity, children);
    }

    return edges;
}

function escapeMermaidLabel(label: string): string {
    return label.replace(/"/g, "'");
}

/**
 * Renders a Mermaid `flowchart TD` definition of the dependency graph. Direct
 * dependencies are tagged with the `direct` class. Returns '' when there are no
 * packages to show.
 */
export function generateMermaidGraph(
    afterInfo: Map<string, PackageInfo>,
    directDeps: Set<string>,
    edges: Map<string, string[]>
): string {
    const identities = [...afterInfo.keys()].sort();
    if (identities.length === 0) return '';

    const nodeId = new Map<string, string>();
    identities.forEach((identity, index) => nodeId.set(identity, `n${index}`));

    const lines: string[] = ['flowchart TD'];

    for (const identity of identities) {
        const version = afterInfo.get(identity)?.version ?? '';
        const label = version ? `${identity} ${version}` : identity;
        const tag = directDeps.has(identity) ? ':::direct' : '';
        lines.push(`  ${nodeId.get(identity)}["${escapeMermaidLabel(label)}"]${tag}`);
    }

    for (const identity of identities) {
        for (const child of edges.get(identity) ?? []) {
            if (nodeId.has(child)) {
                lines.push(`  ${nodeId.get(identity)} --> ${nodeId.get(child)}`);
            }
        }
    }

    lines.push('  classDef direct fill:#e3f2fd,stroke:#1565c0,stroke-width:2px;');

    return lines.join('\n');
}

/**
 * Orchestrator: reads the project sources and the cloned checkouts and returns a
 * Mermaid graph definition for the dependency tree. `afterInfo` is the already-parsed
 * resolved package set, so the resolved file is not read again here.
 */
export function buildDependencyGraph(
    afterInfo: Map<string, PackageInfo>,
    projectRoot: string,
    checkoutsDir: string
): string {
    const resolvedSet = new Set(afterInfo.keys());
    const directDeps = getDirectDependencies(resolvedSet, projectRoot);
    const edges = getDependencyEdges(checkoutsDir, resolvedSet);
    return generateMermaidGraph(afterInfo, directDeps, edges);
}

// ─── HTML report ─────────────────────────────────────────────────────────────

const HTML_STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #1d1d1f; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  .meta { font-size: 0.875rem; color: #6e6e73; margin-bottom: 1.5rem; }
  .meta span { margin-right: 1.5rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th { background: #f5f5f7; text-align: left; padding: 10px 12px; border-bottom: 2px solid #d1d1d6; }
  td { padding: 9px 12px; border-bottom: 1px solid #e5e5ea; vertical-align: middle; }
  tr:hover td { background: #f9f9f9; }
  tr.added td { background: #e6f9ec; }
  tr.removed td { background: #fde8e8; text-decoration: line-through; color: #6e6e73; }
  tr.updated td { background: #fff8e6; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.78rem; font-weight: 500; }
  .badge-app { background: #e3f2fd; color: #1565c0; }
  .badge-dev { background: #f3e5f5; color: #7b1fa2; }
  .badge-added { background: #e6f9ec; color: #2e7d32; }
  .badge-removed { background: #fde8e8; color: #c62828; }
  .badge-updated { background: #fff8e6; color: #e65100; }
  a { color: #0071e3; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .version-arrow { color: #6e6e73; margin: 0 4px; }
  h2 { font-size: 1.2rem; margin-top: 2.5rem; margin-bottom: 0.25rem; }
  .graph-legend { font-size: 0.8rem; color: #6e6e73; margin-bottom: 0.75rem; }
  pre.mermaid { background: #fff; line-height: 1.4; }
`.trim();

function typeBadge(identity: string, devPackages: Set<string>): string {
    return devPackages.has(identity)
        ? '<span class="badge badge-dev">🛠 Development</span>'
        : '<span class="badge badge-app">📦 App</span>';
}

function changeBadge(identity: string, compare: CompareResult): string {
    if (compare.added.includes(identity)) return '<span class="badge badge-added">✨ added</span>';
    if (compare.removed.includes(identity)) return '<span class="badge badge-removed">🗑 removed</span>';
    if (compare.updated.includes(identity)) return '<span class="badge badge-updated">⬆ updated</span>';
    return '';
}

function rowClass(identity: string, compare: CompareResult): string {
    if (compare.added.includes(identity)) return ' class="added"';
    if (compare.removed.includes(identity)) return ' class="removed"';
    if (compare.updated.includes(identity)) return ' class="updated"';
    return '';
}

function versionCell(
    identity: string,
    beforeInfo: Map<string, PackageInfo>,
    afterInfo: Map<string, PackageInfo>,
    compare: CompareResult
): string {
    const beforeVersion = beforeInfo.get(identity)?.version ?? '';
    const afterVersion = afterInfo.get(identity)?.version ?? '';

    if (compare.updated.includes(identity) && beforeVersion && afterVersion && beforeVersion !== afterVersion) {
        return `${escapeHtml(beforeVersion)}<span class="version-arrow">→</span>${escapeHtml(afterVersion)}`;
    }
    return escapeHtml(afterVersion || beforeVersion);
}

function latestCell(identity: string, latest: Map<string, string>): string {
    const version = latest.get(identity);
    return version ? `<code>${escapeHtml(version)}</code>` : '—';
}

export function generateHtmlReport(
    beforeInfo: Map<string, PackageInfo>,
    afterInfo: Map<string, PackageInfo>,
    compare: CompareResult,
    devPackages: Set<string> = new Set(),
    latest: Map<string, string> = new Map(),
    mermaid: string = ''
): string {
    const allIdentities = [...new Set([...beforeInfo.keys(), ...afterInfo.keys()])].sort();

    const rows = allIdentities
        .map((identity) => {
            const info = afterInfo.get(identity) ?? beforeInfo.get(identity)!;
            const urlCell = info.url
                ? `<a href="${escapeHtml(info.url)}" target="_blank">${escapeHtml(identity)}</a>`
                : escapeHtml(identity);

            return [
                `<tr${rowClass(identity, compare)}>`,
                `  <td>${urlCell}</td>`,
                `  <td><code>${versionCell(identity, beforeInfo, afterInfo, compare)}</code></td>`,
                `  <td>${latestCell(identity, latest)}</td>`,
                `  <td>${typeBadge(identity, devPackages)}</td>`,
                `  <td>${changeBadge(identity, compare)}</td>`,
                `</tr>`
            ].join('\n');
        })
        .join('\n');

    const total = allIdentities.length;
    const added = compare.added.length;
    const removed = compare.removed.length;
    const updated = compare.updated.length;
    const generated = new Date().toUTCString();

    const mermaidScript = mermaid
        ? `<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({ startOnLoad: true });
</script>`
        : '';

    const graphSection = mermaid
        ? `<h2>Dependency graph</h2>
<div class="graph-legend">Highlighted nodes are your direct dependencies; the rest are pulled in transitively.</div>
<pre class="mermaid">
${escapeHtml(mermaid)}
</pre>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swift Package Dependencies</title>
<style>${HTML_STYLES}</style>
${mermaidScript}
</head>
<body>
<h1>Swift Package Dependencies</h1>
<div class="meta">
  <span>📦 Total: ${total}</span>
  <span>✨ Added: ${added}</span>
  <span>🗑 Removed: ${removed}</span>
  <span>⬆ Updated: ${updated}</span>
  <span>🕒 ${escapeHtml(generated)}</span>
</div>
<table>
<thead>
  <tr>
    <th>Package</th>
    <th>Version</th>
    <th>Latest available</th>
    <th>Type</th>
    <th>Change</th>
  </tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
${graphSection}
</body>
</html>`;
}

function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── CycloneDX SBOM ──────────────────────────────────────────────────────────

function buildPurl(identity: string, version: string, url: string): string {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        const pathParts = parsed.pathname
            .replace(/^\/|\.git$/g, '')
            .split('/')
            .filter(Boolean);
        if (pathParts.length >= 2) {
            const namespace = [host, ...pathParts.slice(0, -1)].join('/');
            const name = pathParts[pathParts.length - 1];
            return `pkg:swift/${namespace}/${name}@${version}`;
        }
    } catch {
        // fall through
    }
    return `pkg:swift/${identity}@${version}`;
}

export function generateSbom(afterInfo: Map<string, PackageInfo>, devPackages: Set<string> = new Set()): string {
    const components = [...afterInfo.entries()].map(([identity, info]) => ({
        type: 'library',
        name: identity,
        version: info.version,
        scope: devPackages.has(identity) ? 'excluded' : 'required',
        purl: buildPurl(identity, info.version, info.url),
        ...(info.url ? { externalReferences: [{ type: 'vcs', url: info.url }] } : {})
    }));

    const sbom = {
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        serialNumber: `urn:uuid:${randomUUID()}`,
        version: 1,
        metadata: {
            timestamp: new Date().toISOString(),
            tools: [{ name: 'xcode-packages-update', version: '1.0.0' }]
        },
        components
    };

    return JSON.stringify(sbom, null, 2);
}
