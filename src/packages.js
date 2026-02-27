const fs = require('fs');

function getPackages(filePath) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return new Map(
        data.pins.map(pin => [
            pin.identity,
            pin.state.version || pin.state.branch || pin.state.revision
        ])
    );
}

function comparePackages(before, after) {
    const removed = [...before.keys()].filter(k => !after.has(k));
    const added = [...after.keys()].filter(k => !before.has(k));
    const updated = [...after.keys()].filter(k => before.has(k) && before.get(k) !== after.get(k));
    return { removed, added, updated };
}

module.exports = { getPackages, comparePackages };
