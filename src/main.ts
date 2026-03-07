import * as core from '@actions/core';
import * as exec from '@actions/exec';
import fs from 'fs';
import path from 'path';
import { getPackages, comparePackages } from './packages.js';

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

    for (const [, ref] of contents.matchAll(/location\s*=\s*"container:([^"]+)"/g)) {
        const projectSchemePath = path.join(workspaceDir, ref, 'xcshareddata', 'xcschemes', schemeFilename);
        if (fs.existsSync(projectSchemePath)) return projectSchemePath;
    }

    return null;
}

export async function run(): Promise<void> {
    const projectFile = core.getInput('project_file');
    const workspaceFile = core.getInput('workspace_file');
    const scheme = core.getInput('scheme');
    const tempDir = core.getInput('temporary_packages_dir_path');

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

    const currentPackage = path.join(__dirname, 'CurrentPackage.resolved');

    fs.rmSync(tempDir, { recursive: true, force: true });

    core.saveState('temp_dir', tempDir);
    core.saveState('current_package', currentPackage);

    fs.renameSync(packageResolved, currentPackage);

    fs.mkdirSync(tempDir, { recursive: true });

    const xcodebuildArgs = workspaceFile
        ? [
              '-workspace',
              workspaceFile,
              '-scheme',
              scheme,
              '-resolvePackageDependencies',
              '-disablePackageRepositoryCache',
              '-clonedSourcePackagesDirPath',
              tempDir
          ]
        : [
              '-project',
              projectFile,
              '-resolvePackageDependencies',
              '-disablePackageRepositoryCache',
              '-clonedSourcePackagesDirPath',
              tempDir
          ];

    await exec.exec('xcodebuild', xcodebuildArgs);

    const before = getPackages(currentPackage);
    const after = getPackages(packageResolved);
    const { removed, added, updated } = comparePackages(before, after);

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
