
import {
	CompletionItem,
	CompletionItemKind,
	Hover,
	SignatureHelp,
	TextDocument,
	TextDocumentPositionParams
} from 'vscode-languageserver/node';

import {
	// EffectPrograms,
	DefaultEngineDirectory, documents,
} from './server';

import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { Range } from 'vscode-languageserver-textdocument';

export const chunkSubPath = '/editor/assets/chunks';
export const chunkCachePath = '/editor/assets/tools/parsed-effect-info.json';

/**
 * find files or directories upwards if the operation returns true
 * 
 * @param pth the path to start searching from
 * @param operation the operation to perform on each path
 * @returns the path where the operation returned true, or '' if not found
 */
export function find_upwards_if(pth: string, operation: (path: string) => boolean): string {
	let currentDir = pth;
	if (fs.statSync(pth).isFile()) {
		currentDir = path.dirname(pth);
	} else if (fs.statSync(pth).isDirectory()) {
		currentDir = pth;
	} else {
		return '/';
	}

	let prevDir = '';
	while (currentDir !== prevDir) {
		if (operation(currentDir)) {
			return currentDir;
		}
		prevDir = currentDir;
		currentDir = path.dirname(currentDir);
	}
	return '';
}

/**
 * Check if the path is a cocos creator engine path
 * 
 * @param pth the path to check
 * @returns true if the path is a cocos creator engine path
 */
export function is_engine_path(pth: string): boolean {
	const currentDir = pth;
	if (pth === '' || !fs.existsSync(pth) || !fs.statSync(pth).isDirectory()) {
		return false;
	}
	const pkgJsonPath = path.join(currentDir, 'package.json');
	if (fs.existsSync(pkgJsonPath)) {
		const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
		if (pkgJson.name === 'cocos-creator') {
			return true;
		}
	}
	return false;
}

/**
 * Check if the path is a cocos creator path
 */
export function is_cocos_creator_path(pth: string): boolean {
	if (pth === '' || !fs.existsSync(pth) || !fs.statSync(pth).isDirectory()) {
		return false;
	}
	const engine_path = path.join(pth, 'resources', 'resources', '3d', 'engine');
	const mac_engine_path = path.join(pth, 'Contents', 'Resources', 'resources', '3d', 'engine');
	const develop_engine_path = path.join(pth, 'resources', '3d', 'engine');
	return is_engine_path(develop_engine_path) || is_engine_path(engine_path) || is_engine_path(mac_engine_path);
}

/**
 * Check if the path is a cocos creator project path
 * 
 * @param pth the path to check
 * @returns 
 */
export function is_project_path(pth: string): boolean {
	const currentDir = pth;
	const ccDtsPath = path.join(currentDir, 'temp', 'declarations', 'cc.d.ts');
	if (fs.existsSync(ccDtsPath)) {
		return true;
	}
	return false;
}

/**
 * Get the engine path from the project path
 * 
 * @param projectRoot the path to the project root
 * @returns the path to the engine directory
 */
export function get_project_engine_dir(projectRoot: string): string {
	const ccDtsPath = path.join(projectRoot, 'temp', 'declarations', 'cc.d.ts');
	if (fs.existsSync(ccDtsPath)) {
		// read the cc.d.ts file
		const text = fs.readFileSync(ccDtsPath, 'utf8');
		// find the line that contains the engine path
		const referencePathRegExp = /\/\/\/\s*<reference\s+path="([^"]+)"\s*\/>/;
		const match = referencePathRegExp.exec(text);
		if (match && match.length > 1) {
			return match[1];
		}
	}
	return '';
}

/**
 * Get the engine path from the creator path
 * 
 * @param creatorPath the path to the creator root
 * @returns the path to the engine directory
 */
export function get_creator_engine_path(creatorPath: string): string {
	const engine_path = path.join(creatorPath, 'resources', 'resources', '3d', 'engine');
	const mac_engine_path = path.join(creatorPath, 'Contents', 'Resources', 'resources', '3d', 'engine');
	const develop_engine_path = path.join(creatorPath, 'resources', '3d', 'engine');
	if (is_engine_path(develop_engine_path)) { // dev editor
		return develop_engine_path;
	} else if (is_engine_path(engine_path)) { // released editor on windows
		return engine_path;
	} else if (is_engine_path(mac_engine_path)) { // released editor on mac
		return mac_engine_path;
	}
	return '';
}

export class EngineCache {
	enginePath = '';
	CompletionItems: CompletionItem[] = [];
	SignatureHelps: Map<string, SignatureHelp> = new Map();
	Hovers: Map<string, Hover> = new Map();
	private _refCount = 0;

	get refCount() {
		return this._refCount;
	}

	public ref() {
		this._refCount++;
	}

	public unref() {
		this._refCount--;
	}

	constructor(enginePath: string, CompletionItems: CompletionItem[] = [], SignatureHelps: Map<string, SignatureHelp> = new Map(), Hovers: Map<string, Hover> = new Map()) {
		this.enginePath = enginePath;
		this.CompletionItems = CompletionItems;
		this.SignatureHelps = SignatureHelps;
		this.Hovers = Hovers;
	}
}

export class DocumentCache {
	uri = '';
	enginePath = '';
	CompletionItems: CompletionItem[] = [];
	SignatureHelps: Map<string, SignatureHelp> = new Map();
	Hovers: Map<string, Hover> = new Map();
	constructor(uri: string, enginePath: string, CompletionItems: CompletionItem[] = [], SignatureHelps: Map<string, SignatureHelp> = new Map(), Hovers: Map<string, Hover> = new Map()) {
		this.uri = uri;
		this.enginePath = enginePath;
		this.CompletionItems = CompletionItems;
		this.SignatureHelps = SignatureHelps;
		this.Hovers = Hovers;
	}
}

class ParsedInfo {
	CompletionItems: CompletionItem[] = [];
	SignatureHelps: Map<string, SignatureHelp> = new Map();
	Hovers: Map<string, Hover> = new Map();
}

export const engineCaches = new Map<string, EngineCache>();
export const documentCaches = new Map<string, DocumentCache>();

// const cocosEffectPrograms: Map<string, EffectPrograms> = new Map();
export const programs: Map<string, ProgramRelations> = new Map();

export const unwindedPrograms: Map<string, string> = new Map(); // the opened program will be cached in this map

/**
 * Load the parsed-effect-info.json file to get the completion items and hovers
 * 
 * @param parsed the path to the parsed-effect-info.json file
 * @returns the completion items and hovers defined in the cache file
 */
export function load_cache_file(parsed: string): ParsedInfo {
	const res = new ParsedInfo();
	const json = JSON.parse(fs.readFileSync(parsed, 'utf8'));

	json.list.forEach((item: any) => {
		const completionItem = CompletionItem.create(item.name);
		completionItem.documentation = item.comment || 'Cocos-effect system built-in function or variable.';
		completionItem.detail = item.type;
		switch (item.usage) {
			case 'function':
				completionItem.detail = `${item.type} ${item.name}(${item.args.join(', ')})`;
				completionItem.kind = CompletionItemKind.Function;
				res.Hovers.set(item.name, {
					contents: [
						{
							language: 'c',
							value: `${item.type} ${item.name}(${item.args.join(', ')})`
						},
						{
							language: 'markdown',
							value: `# comments \n${item.comment || 'Cocos-effect system built-in function or variable.'}`
						},
						{
							language: 'markdown',
							value: item.file ? `# defined in\n${item.file}: l${item.line}, c${item.column}` : '# intrinsic function'
						}
					]
				});
				res.SignatureHelps.set(item.name,
					{
						signatures:
							[
								{
									label: `${item.type} ${item.name}(${item.args.join(', ')})`,
									parameters: item.args.map((arg: string) => { return { label: arg, documentation: '' }; }),
								},
							],
						activeSignature: 0,
						activeParameter: 0,
					});
				break;
			case 'keyword':
				completionItem.kind = CompletionItemKind.Keyword;
				break;
			case 'macro':
				completionItem.kind = CompletionItemKind.Keyword;
				res.Hovers.set(item.name, { contents: { language: 'c', value: `macro ${item.name}` } });
				break;
			case 'variable':
				completionItem.kind = CompletionItemKind.Variable;
				break;
			default:
				completionItem.kind = CompletionItemKind.Text;
				break;
		}
		res.CompletionItems.push(completionItem);
	});

	return res;
}

export class ProgramRelations {
	// start: number;
	// end: number;
	public dependsOn: string[] = []; // can depend on anything
	public dependOnBy: string[] = []; // only by the files opened in the editor
}

/**
 * Unwind the program and cache it in the map.
 * 1. find the #include statement recursively
 * 2. push all included programs into the map
 * 3. replace the #include statement with the program content
 */
const includeRE = /^(.*)#include\s+[<"]([^>"]+)[>"](.*)$/gm;
export async function unWindProgram(text: string): Promise<void> {
	// TODO: if the included chunk is not in the map, we need to load it from the file system manually.
	let header = includeRE.exec(text);
	while (header) {
		const programName = header[2];
		const program = unwindedPrograms.get(programName);
		if (program) {
			// TODO: replace the include statement with the program.
		} else {
			// TODO: if the program is not unwinded, we need to unwind it
		}
		header = includeRE.exec(text);
	}
	return;
}

export function load_engine_programs(): boolean {
	// TODO: load the engine programs from the engine path. if not found, return false, the diagnostics should throw an error.
	return false;
}

/**
 * obtain the engine path for a given document
 * it will
 * 1. set the res to the default engine path
 * 2. search upwards for the engine, if found, set the res to it
 * 3. search upwards for the project, if found, set the res to the engine that the last time the project was opened
 * so that the res will be default engine < parent engine < engine that the last time the project was opened
 **/
export function get_environment_path(document: TextDocument): string {
	const uri = URI.parse(document.uri).fsPath;
	const documentPath = path.dirname(uri);
	const engine = find_upwards_if(documentPath, is_engine_path);
	const project = find_upwards_if(documentPath, is_project_path);
	let engineDir = DefaultEngineDirectory;

	if (engine !== '') {
		engineDir = engine;
	}
	if (project !== '') {
		const engineDts = get_project_engine_dir(project);
		engineDir = find_upwards_if(engineDts, is_engine_path);
	}

	return engineDir;
}

/**
 * load cache file from engine path, if path is not valid, do nothing.
 * if the cache map does not contain the engine path, create a new one.
 * if the cache map already contains the engine path, update the cache.
 **/
export function update_engine_cache(engineDir: string): void {
	if (!is_engine_path(engineDir)) {
		return;
	}
	const cached_file = path.join(engineDir, chunkCachePath);
	const parsedInfo = load_cache_file(cached_file);
	const cache = engineCaches.get(engineDir);
	if (cache) {
		cache.CompletionItems = parsedInfo.CompletionItems;
		cache.Hovers = parsedInfo.Hovers;
		cache.SignatureHelps = parsedInfo.SignatureHelps;
	} else {
		const engineCache = new EngineCache(engineDir, parsedInfo.CompletionItems, parsedInfo.SignatureHelps, parsedInfo.Hovers);
		engineCaches.set(engineDir, engineCache);
	}
}


/**
 * get the word at the position of the line using regex
 * 
 * @param text line text
 * @param offset offset of the position
 * @returns 
 */
export function getWordAtPosition(text: string, offset: number): string | undefined {
	const wordRegex = /\w+/g;
	let match;
	while ((match = wordRegex.exec(text)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (start <= offset && offset <= end) {
			return match[0];
		}
	}
}

export function getFunctionRanges(textDocument: TextDocument): Range[] {
	const text = textDocument.getText();
	const functionRegex = /(\S+)\s+(\w+)\s*\(([^)]*)\)\s*\{([^}]*)\}/g;
	let match;
	const ranges: Range[] = [];
	while ((match = functionRegex.exec(text)) !== null) {
		const start = match.index + match[0].indexOf(match[1]);
		const end = start + match[1].length;
		// console.log(`function name: ${match[1]}`);
		ranges.push(
			{
				start: textDocument.positionAt(start),
				end: textDocument.positionAt(end)
			}
		);
	}
	return ranges;
}

export function completionProvider(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] {
	const textDocument = documents.get(_textDocumentPosition.textDocument.uri);
	if (textDocument) {
		const cache = documentCaches.get(textDocument.uri);
		if (!cache) {
			return [];
		}
		const engineCache = engineCaches.get(cache?.enginePath);
		return [cache.CompletionItems, engineCache?.CompletionItems || []].flat();
	}
	return [];
}

export function completionResolver(_item: CompletionItem): CompletionItem {
	return _item;
}

export function hoverProvider(_textDocumentPosition: TextDocumentPositionParams): Hover | undefined {
	const textDocument = documents.get(_textDocumentPosition.textDocument.uri);
	if (textDocument) {
		const cache = documentCaches.get(textDocument.uri);
		if (!cache) {
			return;
		}
		const engineCache = engineCaches.get(cache?.enginePath);
		const text = textDocument.getText();
		const line = text.split('\n')[_textDocumentPosition.position.line];
		const word = getWordAtPosition(line, _textDocumentPosition.position.character);

		if (!word) {
			return;
		}

		let hover = cache.Hovers.get(word);
		if (hover) {
			return hover;
		}

		hover = engineCache?.Hovers.get(word);
		if (hover) {
			return hover;
		}

		return {
			contents: [
				{
					language: 'c',
					value: word,
				},]
		};
	}
	return;
}

export function signatureHelpProvider(_textDocumentPosition: TextDocumentPositionParams): SignatureHelp | undefined {
	const textDocument = documents.get(_textDocumentPosition.textDocument.uri);
	if (textDocument) {
		const cache = documentCaches.get(textDocument.uri);
		if (!cache) {
			return;
		}
		const engineCache = engineCaches.get(cache?.enginePath);
		const text = textDocument.getText();
		const line = text.split('\n')[_textDocumentPosition.position.line];
		const word = getWordAtPosition(line, _textDocumentPosition.position.character - 2);

		if (!word) {
			return;
		}

		let signatureHelp = cache.SignatureHelps.get(word);
		if (signatureHelp) {
			return signatureHelp;
		}

		signatureHelp = engineCache?.SignatureHelps.get(word);
		if (signatureHelp) {
			return signatureHelp;
		}
	}
	return;
}