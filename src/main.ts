import * as core from '@actions/core';
import * as exec from '@actions/exec';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    getPackages,
    getPackagesWithInfo,
    comparePackages,
    generateHtmlReport,
    generateSbom,
    detectDevPackages,
    getLatestVersions,
    buildDependencyGraph,
    type PackageInfo
} from './packages.js';

function findSharedScheme(workspaceFile: string, scheme: string): string | null {
    const schemeFilename = `${scheme}.xcscheme`;

    // 1. Workspace-level shared schemes
    const workspaceSchemePath = path.join(workspaceFile, 'xcshareddata', 'xcschemes', schemeFilename);
    if (fs.existsSync(workspaceSchemePath)) return workspaceSchemePath;

    // 2. Project-level shared schemes referenced by the workspace
    const contentsPath = path.join(workspaceFile, 'contents.xcworkspacedata');
    if (!fs.existsSync(contentsPath)) return null;

    const contents = fs.readFileSync(contentsPath, 'utf8');
    const workspaceDir = path.dirname(workspaceFile);

    for (const [, ref] of contents.matchAll(/location\s*=\s*"(?:container|group):([^"]+)"/g)) {
        const projectSchemePath = path.join(workspaceDir, ref, 'xcshareddata', 'xcschemes', schemeFilename);
        if (fs.existsSync(projectSchemePath)) return projectSchemePath;
    }

    return null;
}

/** Matches case-insensitively against Package.resolved identities, which are always lowercase. */
function parseDevPackages(input: string): Set<string> {
    return new Set(
        input
            .split(/[\n,]/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
    );
}

function writeToPath(filePath: string, content: string): void {
    const dir = path.dirname(path.resolve(filePath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

/** Guards against temporary_packages_dir_path pointing outside the workspace before it is recursively deleted. */
function assertSafeTempDir(tempDir: string): void {
    const resolved = path.resolve(tempDir);
    const cwd = process.cwd();
    const relative = path.relative(cwd, resolved);
    const escapesWorkspace = relative === '' || relative.startsWith('..') || path.isAbsolute(relative);

    if (escapesWorkspace) {
        throw new Error(
            `temporary_packages_dir_path ("${tempDir}") must resolve to a subdirectory inside the workspace, ` +
                `not "${resolved}".`
        );
    }
}

export async function run(): Promise<void> {
    const projectFile = core.getInput('project_file');
    const workspaceFile = core.getInput('workspace_file');
    const scheme = core.getInput('scheme');
    const tempDir = core.getInput('temporary_packages_dir_path');
    const htmlReportPath = core.getInput('html_report_path');
    const sbomPath = core.getInput('sbom_path');
    const devPackagesInput = core.getInput('development_packages').trim();

    if (!projectFile && !workspaceFile) {
        throw new Error('Either project_file or workspace_file must be provided.');
    }
    if (projectFile && workspaceFile) {
        throw new Error('Only one of project_file or workspace_file can be provided, not both.');
    }
    if (workspaceFile && !scheme) {
        throw new Error(
            'scheme is required when using workspace_file. ' +
                'Add the scheme input to your workflow. ' +
                'The scheme must be marked as shared in Xcode ' +
                '(Product → Scheme → Manage Schemes → check "Shared").'
        );
    }
    if (scheme && !workspaceFile) {
        core.warning('scheme input is ignored when project_file is used without workspace_file.');
    }

    if (workspaceFile && scheme) {
        const schemePath = findSharedScheme(workspaceFile, scheme);
        if (!schemePath) {
            throw new Error(
                `Scheme "${scheme}" was not found in "${workspaceFile}" or any referenced project. ` +
                    `Make sure the scheme exists and is marked as shared in Xcode ` +
                    `(Product → Scheme → Manage Schemes → check "Shared").`
            );
        }
    }

    const packageResolved = workspaceFile
        ? `${workspaceFile}/xcshareddata/swiftpm/Package.resolved`
        : `${projectFile}/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`;

    // RUNNER_TEMP is a per-job directory managed by the runner, unlike the action's own
    // (shared, cached) install directory under __dirname.
    const snapshotDir = process.env.RUNNER_TEMP || os.tmpdir();
    const currentPackage = path.join(snapshotDir, 'CurrentPackage.resolved');

    assertSafeTempDir(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });

    core.saveState('temp_dir', tempDir);
    core.saveState('current_package', currentPackage);

    // Copy (not move) so the workspace's Package.resolved is never left missing
    // if xcodebuild or report generation fails before it gets rewritten.
    const hadExistingResolved = fs.existsSync(packageResolved);
    if (hadExistingResolved) {
        fs.copyFileSync(packageResolved, currentPackage);
    }

    fs.mkdirSync(tempDir, { recursive: true });

    const xcodebuildArgs = [
        ...(workspaceFile ? ['-workspace', workspaceFile, '-scheme', scheme] : ['-project', projectFile]),
        '-resolvePackageDependencies',
        '-disablePackageRepositoryCache',
        '-clonedSourcePackagesDirPath',
        tempDir
    ];

    await exec.exec('xcodebuild', xcodebuildArgs);

    const before = hadExistingResolved ? getPackages(currentPackage) : new Map<string, string>();
    const after = getPackages(packageResolved);
    const { removed, added, updated } = comparePackages(before, after);

    if (htmlReportPath || sbomPath) {
        const projectRoot = path.resolve(projectFile ? path.dirname(projectFile) : path.dirname(workspaceFile));
        const devPackages = devPackagesInput
            ? parseDevPackages(devPackagesInput)
            : detectDevPackages(packageResolved, projectRoot, tempDir);

        const beforeInfo = hadExistingResolved ? getPackagesWithInfo(currentPackage) : new Map<string, PackageInfo>();
        const afterInfo = getPackagesWithInfo(packageResolved);

        if (htmlReportPath) {
            const runGit = async (command: string, args: string[]): Promise<string> => {
                const { stdout } = await exec.getExecOutput(command, args, {
                    silent: true,
                    // Fail fast instead of hanging on a credential prompt for a private/moved repo.
                    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
                });
                return stdout;
            };
            const latest = await getLatestVersions(afterInfo, runGit);
            const mermaid = buildDependencyGraph(afterInfo, projectRoot, path.join(tempDir, 'checkouts'), tempDir);
            const html = generateHtmlReport(
                beforeInfo,
                afterInfo,
                { removed, added, updated },
                devPackages,
                latest,
                mermaid
            );
            writeToPath(htmlReportPath, html);
            core.setOutput('html_report_path', htmlReportPath);
            core.info(`HTML dependency report written to ${htmlReportPath}`);
        }

        if (sbomPath) {
            const sbom = generateSbom(afterInfo, devPackages);
            writeToPath(sbomPath, sbom);
            core.setOutput('sbom_path', sbomPath);
            core.info(`CycloneDX SBOM written to ${sbomPath}`);
        }
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(currentPackage, { force: true });

    if (removed.length === 0 && added.length === 0 && updated.length === 0) {
        core.info('Dependencies up to date');
        core.setOutput('dependenciesChanged', 'false');
        core.setOutput('summary', '');
        return;
    }

    const lines = [
        ...removed.map((k) => `- removed: ${k}: ${before.get(k)}`),
        ...added.map((k) => `- added:   ${k}: ${after.get(k)}`),
        ...updated.map((k) => `- updated: ${k}: ${before.get(k)} → ${after.get(k)}`)
    ];

    const summary = lines.join('\n');
    core.info(`Dependencies changed:\n${summary}`);
    core.setOutput('dependenciesChanged', 'true');
    core.setOutput('summary', summary);
}
