export type HttpMethod = "GET" | "POST";
export interface HttpRequest { url: string; method: HttpMethod; headers: Record<string, string>; body?: string }
export interface HttpResponse { status: number; headers: Record<string, string>; text: string }
export type SendHttp = (request: HttpRequest) => Promise<HttpResponse>;

export type SecretId = "readplace-access-token" | "readplace-refresh-token";
export interface SecretStore { get(id: SecretId): string | null; set(id: SecretId, value: string): void }

export type OpenInBrowser = (url: string) => void;
export type Notify = (message: string) => void;
export type Clock = () => Date;
export type RandomBytes = (length: number) => Uint8Array;

export interface VaultPort {
	normalizePath(path: string): string;
	fileExists(path: string): boolean;
	folderExists(path: string): boolean;
	createFolder(path: string): Promise<void>;
	create(path: string, content: string): Promise<void>;
	read(path: string): Promise<string>;
	process(path: string, update: (current: string) => string): Promise<string>;
	rename(path: string, newPath: string): Promise<void>;
}

export interface PluginDataStore { load(): Promise<unknown>; save(data: unknown): Promise<void> }
