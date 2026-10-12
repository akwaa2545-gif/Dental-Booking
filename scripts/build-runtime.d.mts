export type StaticAsset = Readonly<{ body: string; contentType: string }>;
export function stagingHtml(html: string): string;
export function collectStaticAssets(directory: string, maxBytes?: number): Promise<Record<string, StaticAsset>>;
export function renderAssetModule(assets: Record<string, StaticAsset>): string;
export function assertProductionModuleIds(ids: Iterable<string>): void;
export function measureBundle(bundle: Uint8Array, maxBytes?: number, maxGzipBytes?: number): { bytes: number; gzipBytes: number; sha256: string };
export function publicBuildDefines(config: { vars?: Record<string, unknown> }): Record<string, string>;
export function uploadMetadata(config: Record<string, unknown>): { bindings: Array<{ type: string; name: string; text?: string; id?: string }>; [key: string]: unknown };
