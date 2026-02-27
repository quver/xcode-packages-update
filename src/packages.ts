import fs from 'fs';

interface PinState {
    version?: string;
    branch?: string;
    revision?: string;
}

interface Pin {
    identity: string;
    state: PinState;
}

interface PackageResolved {
    pins: Pin[];
}

export interface CompareResult {
    removed: string[];
    added: string[];
    updated: string[];
}

export function getPackages(filePath: string): Map<string, string> {
    const { pins } = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PackageResolved;
    return new Map(pins.map((pin) => [pin.identity, (pin.state.version ?? pin.state.branch ?? pin.state.revision)!]));
}

export function comparePackages(before: Map<string, string>, after: Map<string, string>): CompareResult {
    const removed = [...before.keys()].filter((k) => !after.has(k));
    const added = [...after.keys()].filter((k) => !before.has(k));
    const updated = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
    return { removed, added, updated };
}
