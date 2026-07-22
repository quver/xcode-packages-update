import * as core from '@actions/core';
import fs from 'fs';

export async function run(): Promise<void> {
    const tempDir = core.getState('temp_dir');
    const currentPackage = core.getState('current_package');
    const packageResolvedPath = core.getState('package_resolved_path');

    if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    if (currentPackage && fs.existsSync(currentPackage)) {
        if (packageResolvedPath && !fs.existsSync(packageResolvedPath)) {
            // main.ts moved the original Package.resolved out of the way and xcodebuild never
            // regenerated it (crash/error) — restore it instead of leaving it missing.
            fs.renameSync(currentPackage, packageResolvedPath);
        } else {
            fs.rmSync(currentPackage, { force: true });
        }
    }
}
