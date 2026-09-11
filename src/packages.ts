import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export interface PackageInfo {
    version: string;
    url: string;
}

interface ResolvedState {
    version?: string | null;
    branch?: string | null;
    revision?: string | null;
}

interface ResolvedPin {
    identity: string;
    location?: string;
    state?: ResolvedState;
}

interface ResolvedFileV2 {
    pins: ResolvedPin[];
}

/** Legacy Package.resolved format written by Xcode <= 13.2. */
interface ResolvedFileV1 {
    object: {
        pins: { package: string; repositoryURL: string; state?: ResolvedState }[];
    };
}

function parseResolved(filePath: string): ResolvedPin[] {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as ResolvedFileV2 | ResolvedFileV1;

    if ('object' in parsed) {
        const pins = parsed.object?.pins;
        if (!Array.isArray(pins)) return [];
        return pins.map((pin) => ({
            identity: identityFromUrl(pin.repositoryURL),
            location: pin.repositoryURL,
            state: pin.state
        }));
    }

    return Array.isArray(parsed.pins) ? parsed.pins : [];
}

/**
 * Resolves a display/compare string for a pin. Branch pins include the short
 * revision (e.g. `main+abc1234`) so that a new commit on an unchanged branch
 * name is still detected as an update by comparePackages.
 */
function resolveVersion(state: ResolvedPin['state']): string {
    if (state?.version) return state.version;
    if (state?.branch) {
        return state.revision ? `${state.branch}+${state.revision.slice(0, 7)}` : state.branch;
    }
    return state?.revision ?? '';
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

/** Projects parsed package info down to identity → version, the shape comparePackages diffs. */
export function toVersionMap(info: Map<string, PackageInfo>): Map<string, string> {
    return new Map([...info].map(([identity, { version }]) => [identity, version]));
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

const GIT_LS_REMOTE_CONCURRENCY = 8;
const GIT_LS_REMOTE_TIMEOUT_MS = 15_000;
const REFS_TAGS_PREFIX = 'refs/tags/';

/** Runs `fn` over `items` with at most `limit` calls in flight at once. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;

    async function worker(): Promise<void> {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/** Races `promise` against a timeout, resolving to `fallback` if `ms` elapses first. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    promise.catch(() => {}); // avoid an unhandled rejection if it settles after the timeout
    return new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(fallback);
            }
        );
    });
}

/**
 * Resolves the highest available version for each package by reading its git tags
 * via `git ls-remote`. Packages without a URL or without reachable tags are skipped.
 * Lookups run with bounded concurrency and a per-package timeout so one slow or
 * unresponsive remote cannot stall the whole run.
 */
export async function getLatestVersions(
    afterInfo: Map<string, PackageInfo>,
    runGit: ExecFn
): Promise<Map<string, string>> {
    const entries = [...afterInfo.entries()].filter(([, info]) => info.url);

    const results = await mapWithConcurrency(entries, GIT_LS_REMOTE_CONCURRENCY, async ([identity, info]) => {
        try {
            // `--` marks the end of options so a location value can never be parsed as a git flag.
            const stdout = await withTimeout(
                runGit('git', ['ls-remote', '--tags', '--refs', '--', info.url]),
                GIT_LS_REMOTE_TIMEOUT_MS,
                ''
            );
            const tags = stdout
                .split('\n')
                .map((line) => line.slice(line.indexOf('\t') + 1).trim())
                .filter((ref) => ref.startsWith(REFS_TAGS_PREFIX))
                .map((ref) => ref.slice(REFS_TAGS_PREFIX.length));
            return [identity, selectLatestStableVersion(tags)] as const;
        } catch {
            return [identity, ''] as const;
        }
    });

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

/** Directory tree walk used by scanProject, skipping EXCLUDE_DIRS and `excludeDir`. */
function walkDirs(
    rootDir: string,
    excludeDir: string | undefined,
    visit: (dir: string, entries: fs.Dirent[]) => void
): void {
    const resolvedExclude = excludeDir ? path.resolve(excludeDir) : undefined;

    function scan(dir: string): void {
        if (resolvedExclude && path.resolve(dir) === resolvedExclude) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        visit(dir, entries);
        for (const entry of entries) {
            if (entry.isDirectory() && !EXCLUDE_DIRS.has(entry.name)) {
                scan(path.join(dir, entry.name));
            }
        }
    }

    scan(rootDir);
}

/** Reads a UTF-8 file, returning null when it is missing or unreadable. */
function readTextOrNull(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

/**
 * Extracts all `.keyword(...)` blocks from Package.swift content using bracket counting.
 * Handles `.testTarget` vs `.target` correctly — `.target` won't match `.testTarget`
 * because Swift uses camelCase (`.testTarget`, not `.targetTest`). Parentheses inside string
 * literals and `//` / `/* *‍/` comments are ignored so they cannot unbalance the count.
 */
function extractBlocks(content: string, keyword: string): string[] {
    const blocks: string[] = [];
    const pattern = new RegExp(`(?<![A-Za-z0-9])\\.${keyword}\\s*\\(`, 'g');
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
        let depth = 1;
        let i = match.index + match[0].length;
        let inString = false;
        let inLineComment = false;
        let inBlockComment = false;

        while (i < content.length && depth > 0) {
            const ch = content[i];
            const next = content[i + 1];

            if (inLineComment) {
                if (ch === '\n') inLineComment = false;
            } else if (inBlockComment) {
                if (ch === '*' && next === '/') {
                    inBlockComment = false;
                    i++;
                }
            } else if (inString) {
                if (ch === '\\') i++;
                else if (ch === '"') inString = false;
            } else if (ch === '/' && next === '/') {
                inLineComment = true;
                i++;
            } else if (ch === '/' && next === '*') {
                inBlockComment = true;
                i++;
            } else if (ch === '"') {
                inString = true;
            } else if (ch === '(') {
                depth++;
            } else if (ch === ')') {
                depth--;
            }
            i++;
        }

        blocks.push(content.slice(match.index + match[0].length, i - 1));
    }

    return blocks;
}

/** Returns package identities referenced via `.product(name:, package:)` or `.plugin(name:, package:)` in a block. */
function packageRefs(block: string, kind: 'product' | 'plugin'): string[] {
    const pattern = new RegExp(`\\.${kind}\\s*\\([^)]*package:\\s*"([^"]+)"`, 'g');
    return [...block.matchAll(pattern)].map(([, pkg]) => pkg.toLowerCase());
}

/** Derives SPM identity (lowercase repo name) from a remote repository URL. */
function identityFromUrl(url: string): string {
    return url
        .replace(/\/+$/, '')
        .replace(/\.git$/, '')
        .split(/[/:]/)
        .pop()!
        .toLowerCase();
}

/**
 * Splits a pbxproj's `objects = { ... }` section into individual `id /* comment *‍/ = { ... };`
 * object blocks using bracket counting. Parsing each object as its own bounded block (rather
 * than one flat regex spanning the whole file) prevents a target with no packageProductDependencies
 * from bleeding into the next target's fields.
 */
function extractPbxObjectBlocks(content: string): string[] {
    const blocks: string[] = [];
    const headerPattern = /\w{24} \/\* [^*]*\*\/ = \{/g;
    let match: RegExpExecArray | null;

    while ((match = headerPattern.exec(content)) !== null) {
        let depth = 1;
        let i = match.index + match[0].length;

        while (i < content.length && depth > 0) {
            if (content[i] === '{') depth++;
            else if (content[i] === '}') depth--;
            i++;
        }

        blocks.push(content.slice(match.index, i));
        headerPattern.lastIndex = i;
    }

    return blocks;
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
    const content = readTextOrNull(pbxprojPath);
    if (content === null) return { devRefs: new Set(), appRefs: new Set() };

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
        const identity = m[2] && remoteRefToIdentity.get(m[2]);
        if (identity) prodDepToIdentity.set(m[1], identity);
    }

    // PBXNativeTarget → classify product deps, one bounded object block at a time.
    const devRefs = new Set<string>();
    const appRefs = new Set<string>();

    for (const block of extractPbxObjectBlocks(content)) {
        if (!/isa\s*=\s*PBXNativeTarget;/.test(block)) continue;

        const nameMatch = /name\s*=\s*([^;]+);/.exec(block);
        const depsMatch = /packageProductDependencies\s*=\s*\(([^)]*)\)/.exec(block);
        if (!nameMatch || !depsMatch) continue;

        const rawName = nameMatch[1].trim().replace(/^"|"$/g, '');
        const isTestTarget = rawName.endsWith('Tests');

        for (const depId of depsMatch[1].matchAll(/(\w{24})/g)) {
            const identity = prodDepToIdentity.get(depId[1]);
            if (identity) {
                (isTestTarget ? devRefs : appRefs).add(identity);
            }
        }
    }

    // Package references present in the project but never linked to any non-test target
    // (e.g. build-tool plugins like SwiftLintPlugins) → dev
    for (const identity of remoteRefToIdentity.values()) {
        if (!appRefs.has(identity)) devRefs.add(identity);
    }

    return { devRefs, appRefs };
}

/** Raw facts from a single walk of the project sources, shared by dev-package detection and the dependency graph. */
export interface ProjectScan {
    /** Contents of every readable Package.swift under the project root. */
    manifests: string[];
    /** Remote packages from every project.pbxproj linked only to test targets (or to no target at all). */
    xcodeDevRefs: Set<string>;
    /** Remote packages from every project.pbxproj linked to at least one non-test target. */
    xcodeAppRefs: Set<string>;
}

/**
 * Walks `projectRoot` once, reading every Package.swift manifest and classifying the remote
 * packages of every `.xcodeproj`. `excludeDir`, when given, is skipped entirely — used to keep
 * the action's own temporary_packages_dir_path (whose cloned checkouts are not project sources)
 * out of the scan, since it may sit under the project root.
 */
export function scanProject(projectRoot: string, excludeDir?: string): ProjectScan {
    const scan: ProjectScan = { manifests: [], xcodeDevRefs: new Set(), xcodeAppRefs: new Set() };

    walkDirs(projectRoot, excludeDir, (dir, entries) => {
        for (const entry of entries) {
            if (entry.isFile() && entry.name === 'Package.swift') {
                const content = readTextOrNull(path.join(dir, entry.name));
                if (content !== null) scan.manifests.push(content);
            } else if (entry.isDirectory() && entry.name.endsWith('.xcodeproj')) {
                const pbxprojPath = path.join(dir, entry.name, 'project.pbxproj');
                if (!fs.existsSync(pbxprojPath)) continue;
                const { devRefs, appRefs } = detectXcodeDevPackages(pbxprojPath);
                for (const ref of devRefs) scan.xcodeDevRefs.add(ref);
                for (const ref of appRefs) scan.xcodeAppRefs.add(ref);
            }
        }
    });

    return scan;
}

/** Non-test target kinds that count as app (production) targets for dev-package detection. */
const APP_TARGET_KEYWORDS = ['target', 'executableTarget', 'macro'];

/**
 * Returns resolved identities that the scanned project references exclusively in test targets
 * or as build tool plugins — never in regular app targets. Falls back gracefully: if parsing
 * yields no results the set is empty (no false positives).
 */
export function detectDevPackages(resolvedSet: Set<string>, scan: ProjectScan): Set<string> {
    const devRefs = new Set(scan.xcodeDevRefs);
    const appRefs = new Set(scan.xcodeAppRefs);

    for (const content of scan.manifests) {
        for (const block of extractBlocks(content, 'testTarget')) {
            for (const ref of packageRefs(block, 'product')) devRefs.add(ref);
        }

        for (const keyword of APP_TARGET_KEYWORDS) {
            for (const block of extractBlocks(content, keyword)) {
                for (const ref of packageRefs(block, 'product')) appRefs.add(ref);
                for (const [, pluginsBlock] of block.matchAll(/plugins\s*:\s*\[([^\]]*)\]/gs)) {
                    for (const ref of packageRefs(pluginsBlock, 'plugin')) devRefs.add(ref);
                }
            }
        }
    }

    // Packages only in dev context, never in app context
    return new Set([...devRefs].filter((ref) => !appRefs.has(ref) && resolvedSet.has(ref)));
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
 * Package.swift `.package(url:)` declarations. Only identities present in Package.resolved
 * are kept.
 */
export function getDirectDependencies(resolvedSet: Set<string>, scan: ProjectScan): Set<string> {
    // detectXcodeDevPackages puts every remote package reference into at least one of the two sets.
    const referenced = [...scan.manifests.flatMap(manifestPackageDeps), ...scan.xcodeDevRefs, ...scan.xcodeAppRefs];
    return new Set(referenced.filter((ref) => resolvedSet.has(ref)));
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

        const content = readTextOrNull(path.join(checkoutsDir, entry.name, 'Package.swift'));
        if (content === null) continue;

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
        const version = afterInfo.get(identity)!.version;
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
 * Orchestrator: combines the project scan and the cloned checkouts into a Mermaid graph
 * definition for the dependency tree. `afterInfo` and `scan` are already computed by the
 * caller, so neither the resolved file nor the project tree is read again here.
 */
export function buildDependencyGraph(
    afterInfo: Map<string, PackageInfo>,
    scan: ProjectScan,
    checkoutsDir: string
): string {
    const resolvedSet = new Set(afterInfo.keys());
    const directDeps = getDirectDependencies(resolvedSet, scan);
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

type ChangeKind = 'added' | 'removed' | 'updated';

/** Builds an identity → change-kind lookup once, replacing repeated Array.includes scans per row. */
function classifyChanges(compare: CompareResult): Map<string, ChangeKind> {
    const kinds = new Map<string, ChangeKind>();
    for (const identity of compare.added) kinds.set(identity, 'added');
    for (const identity of compare.removed) kinds.set(identity, 'removed');
    for (const identity of compare.updated) kinds.set(identity, 'updated');
    return kinds;
}

function typeBadge(identity: string, devPackages: Set<string>): string {
    return devPackages.has(identity)
        ? '<span class="badge badge-dev">🛠 Development</span>'
        : '<span class="badge badge-app">📦 App</span>';
}

function changeBadge(kind: ChangeKind | undefined): string {
    switch (kind) {
        case 'added':
            return '<span class="badge badge-added">✨ added</span>';
        case 'removed':
            return '<span class="badge badge-removed">🗑 removed</span>';
        case 'updated':
            return '<span class="badge badge-updated">⬆ updated</span>';
        default:
            return '';
    }
}

function rowClass(kind: ChangeKind | undefined): string {
    return kind ? ` class="${kind}"` : '';
}

function versionCell(
    identity: string,
    beforeInfo: Map<string, PackageInfo>,
    afterInfo: Map<string, PackageInfo>,
    kind: ChangeKind | undefined
): string {
    const beforeVersion = beforeInfo.get(identity)?.version ?? '';
    const afterVersion = afterInfo.get(identity)?.version ?? '';

    if (kind === 'updated' && beforeVersion && afterVersion && beforeVersion !== afterVersion) {
        return `${escapeHtml(beforeVersion)}<span class="version-arrow">→</span>${escapeHtml(afterVersion)}`;
    }
    return escapeHtml(afterVersion || beforeVersion);
}

function latestCell(identity: string, latest: Map<string, string>): string {
    const version = latest.get(identity);
    return version ? `<code>${escapeHtml(version)}</code>` : '—';
}

/** Only renders http(s) URLs as clickable links — a `javascript:`/`data:` location stays plain text. */
function urlCell(identity: string, url: string): string {
    if (!/^https?:\/\//i.test(url)) return escapeHtml(identity);
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(identity)}</a>`;
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
    const changes = classifyChanges(compare);

    const rows = allIdentities
        .map((identity) => {
            const info = afterInfo.get(identity) ?? beforeInfo.get(identity)!;
            const kind = changes.get(identity);

            return [
                `<tr${rowClass(kind)}>`,
                `  <td>${urlCell(identity, info.url)}</td>`,
                `  <td><code>${versionCell(identity, beforeInfo, afterInfo, kind)}</code></td>`,
                `  <td>${latestCell(identity, latest)}</td>`,
                `  <td>${typeBadge(identity, devPackages)}</td>`,
                `  <td>${changeBadge(kind)}</td>`,
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

// Replaced with a literal version string by esbuild's --define at build time (see package.json)
// and by the matching `define` in vitest.config.ts under test.
declare const __PACKAGE_VERSION__: string;

/** Normalizes an scp-style git URL (git@host:org/repo.git) into a form new URL() can parse. */
function normalizeGitUrl(url: string): string {
    const scpMatch = /^([\w.-]+)@([\w.-]+):(.+)$/.exec(url);
    return scpMatch ? `ssh://${scpMatch[1]}@${scpMatch[2]}/${scpMatch[3]}` : url;
}

function buildPurl(identity: string, version: string, url: string): string {
    const versionSuffix = version ? `@${encodeURIComponent(version)}` : '';
    try {
        const parsed = new URL(normalizeGitUrl(url));
        const host = parsed.hostname;
        const pathParts = parsed.pathname
            .replace(/^\/|\.git$/g, '')
            .split('/')
            .filter(Boolean);
        if (pathParts.length >= 2) {
            const namespace = [host, ...pathParts.slice(0, -1)].join('/');
            const name = pathParts[pathParts.length - 1];
            return `pkg:swift/${namespace}/${name}${versionSuffix}`;
        }
    } catch {
        // fall through
    }
    return `pkg:swift/${identity}${versionSuffix}`;
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
            tools: [{ name: 'xcode-packages-update', version: __PACKAGE_VERSION__ }]
        },
        components
    };

    return JSON.stringify(sbom, null, 2);
}
