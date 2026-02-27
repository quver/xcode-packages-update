const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs');
const path = require('path');
const { getPackages, comparePackages } = require('./src/packages');

async function run() {
    const projectFile = core.getInput('project_file', { required: true });
    const tempDir = core.getInput('temporary_packages_dir_path');

    const packageResolved = `${projectFile}/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`;
    const currentPackage = path.join(__dirname, 'CurrentPackage.resolved');

    fs.rmSync(tempDir, { recursive: true, force: true });

    core.saveState('temp_dir', tempDir);
    core.saveState('current_package', currentPackage);

    fs.copyFileSync(packageResolved, currentPackage);

    fs.mkdirSync(tempDir, { recursive: true });

    await exec.exec('xcodebuild', [
        '-resolvePackageDependencies',
        '-disablePackageRepositoryCache',
        '-clonedSourcePackagesDirPath', tempDir
    ]);

    const before = getPackages(currentPackage);
    const after = getPackages(packageResolved);
    const { removed, added, updated } = comparePackages(before, after);

    if (removed.length === 0 && added.length === 0 && updated.length === 0) {
        core.info('Dependencies up to date');
        core.setOutput('dependenciesChanged', 'false');
        core.setOutput('summary', '');
        return;
    }

    const lines = [
        ...removed.map(k => `- removed: ${k}: ${before.get(k)}`),
        ...added.map(k =>   `- added:   ${k}: ${after.get(k)}`),
        ...updated.map(k => `- updated: ${k}: ${before.get(k)} → ${after.get(k)}`),
    ];

    const summary = lines.join('\n');
    core.info(`Dependencies changed:\n${summary}`);
    core.setOutput('dependenciesChanged', 'true');
    core.setOutput('summary', summary);
}

run().catch(core.setFailed);
