import * as core from '@actions/core';
import fs from 'fs';

export async function run(): Promise<void> {
    const tempDir = core.getState('temp_dir');
    const currentPackage = core.getState('current_package');

    if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    if (currentPackage) {
        fs.rmSync(currentPackage, { force: true });
    }
}
