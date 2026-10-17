// Types for version-compare.js, so the test that pins it can typecheck. The extension itself is
// plain CommonJS JavaScript, because that is what the editor loads and what `vsce package` ships.
export declare const FLOOR: number;
export declare function parts(version: string): [number, number] | null;
export declare function isBehind(installed: string, available: string): boolean;
