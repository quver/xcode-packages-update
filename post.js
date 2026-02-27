const core = require('@actions/core');
const fs = require('fs');

async function run() {
    const tempDir = core.getState('temp_dir');
    const currentPackage = core.getState('current_package');

    if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    if (currentPackage) {
        fs.rmSync(currentPackage, { force: true });
    }
}

run().catch(core.setFailed);
