/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	DocumentHighlight,
	InitializeResult,
	Hover,
	ConnectionStrategy
} from 'vscode-languageserver/node';

import {
	URI
} from 'vscode-uri';

import {
	TextDocument,
} from 'vscode-languageserver-textdocument';

import * as fs from 'fs';
import * as path from 'path';
import { hasSubscribers } from 'diagnostics_channel';

const chunkSubPath = '/editor/assets/chunks';
const chunkCachePath = '/editor/assets/tools/parsed-effect-info.json';

export class EngineCache {
	enginePath = '';
	CompletionItems: CompletionItem[] = [];
	Hovers: Map<string, Hover> = new Map();
	private _refCount = 0;

	get refCount () {
		return this._refCount;
	}

	public ref () {
		this._refCount++;
	}

	public unref () {
		this._refCount--;
	}

	constructor (enginePath: string, CompletionItems: CompletionItem[], Hovers: Map <string, Hover>) {
		this.enginePath = enginePath;
		this.CompletionItems = CompletionItems;
		this.Hovers = Hovers;
	}
}

export class DocumentCache {
	uri = '';
	enginePath = '';
	CompletionItems: CompletionItem[] = [];
	Hovers: Map<string, Hover> = new Map();
	constructor (uri: string, enginePath: string, CompletionItems: CompletionItem[], Hovers: Map <string, Hover>) {
		this.uri = uri;
		this.enginePath = enginePath;
		this.CompletionItems = CompletionItems;
		this.Hovers = Hovers;
	}
}

const engineCaches = new Map<string, EngineCache>();
const documentCaches = new Map<string, DocumentCache>();

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
	if (pth === '' || !fs.statSync(pth).isDirectory()) {
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
	const res = '';
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
	return res;
}

class ParsedInfo {
	CompletionItems: CompletionItem[] = [];
	Hovers: Map<string, Hover> = new Map();
}

/**
 * Load the parsed-effect-info.json file to get the completion items and hovers
 * 
 * @param parsed the path to the parsed-effect-info.json file
 * @returns the completion items and hovers defined in the cache file
 */
export function load_cache_file(parsed: string) : ParsedInfo {
	const res = new ParsedInfo();
	const json = JSON.parse(fs.readFileSync(parsed, 'utf8'));

	json.list.forEach((item: any) => {
		const completionItem = CompletionItem.create(item.name);
		switch (item.usage) {
			case 'function':
				completionItem.kind = CompletionItemKind.Function;
				res.Hovers.set(item.name, {contents: {language: 'c', value: `${item.type} ${item.name}(${item.args.join(', ')})`}});
				break;
			case 'keyword':
				completionItem.kind = CompletionItemKind.Keyword;
				break;
			case 'macro':
				completionItem.kind = CompletionItemKind.Keyword;
				res.Hovers.set(item.name, {contents: {language: 'c', value: `macro ${item.name}`}});
				break;
			case 'variable':
				completionItem.kind = CompletionItemKind.Variable;
				break;
			default:
				completionItem.kind = CompletionItemKind.Text;
				break;
		}
		completionItem.documentation = 'Cocos-effect system built-in function or variable.';
		completionItem.detail = item.type;
		res.CompletionItems.push(completionItem);
	});

	return res;
}

// class interface EffectPrograms 
// {
// 	programs: string[];
// }

export class ProgramRelations {
	// start: number;
	// end: number;
	public dependsOn: string[] = []; // can depend on anything
	public dependOnBy: string[] = []; // only by the files opened in the editor
}

// const cocosEffectPrograms: Map<string, EffectPrograms> = new Map();
const programs: Map<string, ProgramRelations> = new Map();

const unwindedPrograms: Map<string, string> = new Map(); // the opened program will be cached in this map

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

// The example settings
interface CocosEffectLanguageServerSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: CocosEffectLanguageServerSettings = { maxNumberOfProblems: 1000 };
let globalSettings: CocosEffectLanguageServerSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<CocosEffectLanguageServerSettings>> = new Map();

const DefaultEngineDirectory = '';

function getDocumentSettings(resource: string): Thenable<CocosEffectLanguageServerSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'cocos-effect.languageServer'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

/**
 * Unwind the program and cache it in the map.
 * 1. find the #include statement recursively
 * 2. push all included programs into the map
 * 3. replace the #include statement with the program content
 */
const includeRE = /^(.*)#include\s+[<"]([^>"]+)[>"](.*)$/gm; 
async function unWindProgram(text: string) : Promise<void> {
	// TODO (yiwenxue): if the included chunk is not in the map, we need to load it from the file system manually.
	let header = includeRE.exec(text);
	while (header) {
		const programName = header[2];
		const program = unwindedPrograms.get(programName);
		if (program) {
			// TODO (yiwenxue): replace the include statement with the program.
		} else {
			// TODO (yiwenxue): if the program is not unwinded, we need to unwind it
			// text = 
		}
		connection.console.log(programName);
		header = includeRE.exec(text);
	}
	return;
}

function load_engine_programs() : boolean {
	// TODO (yiwenxue): load the engine programs from the engine path. if not found, return false, the diagnostics should throw an error.
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
function get_environment_path(document: TextDocument) : string {
	const uri = URI.parse(document.uri).fsPath;
	const documentPath = path.dirname(uri);
	const engine = find_upwards_if(documentPath, is_engine_path);
	const project = find_upwards_if(documentPath, is_project_path);
	let engineDir = DefaultEngineDirectory;

	if (engine !== '') {
		engineDir  = engine;
	} else {
		connection.console.log('We cannot find the engine path');
	}
	
	if (project !== '') {
		const engineDts = get_project_engine_dir(project);
		engineDir = find_upwards_if(engineDts, is_engine_path);
	} else {
		connection.console.log('We cannot find the project path');
	}

	return engineDir;
}

/**
 * load cache file from engine path, if path is not valid, do nothing.
 * if the cache map does not contain the engine path, create a new one.
 * if the cache map already contains the engine path, update the cache.
 **/
function update_engine_cache(engineDir: string) : void {
	if (!is_engine_path(engineDir)) {
		return;
	}
	const cached_file = path.join(engineDir, chunkCachePath);
	const parsedInfo = load_cache_file(cached_file);
	const cache = engineCaches.get(engineDir);
	if (cache) {
		cache.CompletionItems = parsedInfo.CompletionItems;
		cache.Hovers = parsedInfo.Hovers;
	} else {
		const engineCache = new EngineCache(engineDir, parsedInfo.CompletionItems, parsedInfo.Hovers);
		engineCaches.set(engineDir, engineCache);
	}
}

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
		// query the engine path
	} else {
		globalSettings = <CocosEffectLanguageServerSettings>(
			(change.settings['cocos-effect'].languageServer || defaultSettings)
		);
	}
});

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;
	
	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
		);
		hasDiagnosticRelatedInformationCapability = !!(
			capabilities.textDocument &&
			capabilities.textDocument.publishDiagnostics &&
			capabilities.textDocument.publishDiagnostics.relatedInformation
			);
			
			const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true
			},
			hoverProvider: true,
			definitionProvider: true,
			documentHighlightProvider: true,
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}

	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
	if (hasConfigurationCapability) {
		// query the engine path
		connection.workspace.getConfiguration({
			section: 'cocos-effect'
		}).then((settings) => {
			if (is_engine_path(settings.enginePath))
			{
				update_engine_cache(settings.enginePath);
			}
		});
	}
});

documents.onDidOpen(e => {
	const textDocument = e.document;

	const engineDir = get_environment_path(textDocument);

	// priority: default engine path < parent engine path < engine path in the project
	documentCaches.set(textDocument.uri, new DocumentCache(textDocument.uri, engineDir, [], new Map()));
	if (!engineCaches.has(engineDir)) {
		update_engine_cache(engineDir);
	}
	// if this file is in the mapping, we need to remove it
	const fileRelation = programs.get(textDocument.uri);
	if (fileRelation) {
		programs.delete(textDocument.uri);
		connection.console.log('an file already opened');
	}
	programs.set(textDocument.uri, new ProgramRelations());
	// unwind to obtain the relations
	unWindProgram(textDocument.getText());
	// better obtain the parsed info also
	connection.console.log('We received an file open event');
});

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
	// unlink file relations from the relation map
	const fileRelation = programs.get(e.document.uri);
	if (fileRelation) {
		// remove all dependOn relations
		for (const dependOn of fileRelation.dependsOn) {
			const dependOnRelation = programs.get(dependOn);
			if (dependOnRelation) {
				const index = dependOnRelation.dependOnBy.indexOf(e.document.uri);
				dependOnRelation.dependOnBy.splice(index, 1);
			}
		}
		if (fileRelation.dependOnBy.length === 0) {
			programs.delete(e.document.uri);
		}
	}
	// remove cache
	const cache = documentCaches.get(e.document.uri);
	if (cache) {
		const engineCache = engineCaches.get(cache.enginePath);
		if (engineCache) {
			engineCache.unref();
			if (engineCache.refCount === 0) {
				engineCaches.delete(cache.enginePath);
			}
		}
		documentCaches.delete(e.document.uri);
	}
	connection.console.log('We received an file close event');
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	// TODO: we need to check if the file is in the mapping
	const document = change.document;
	// TODO: we need to check if the changed position is a include statement or not
	// update the parsed infos
	connection.console.log('We received an file change event');
});

documents.onDidSave(change => {
	// unwind to obtain the relations
	unWindProgram(change.document.getText());
	connection.console.log('We received an file save event');
});

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
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
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		return item;
	}
);

/**
 * get the word at the position of the line using regex
 * 
 * @param text line text
 * @param offset offset of the position
 * @returns 
 */
function getWordAtPosition(text: string, offset: number) : string | undefined {
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

connection.onHover(
	(_textDocumentPosition: TextDocumentPositionParams): Hover | undefined => {
		const textDocument = documents.get(_textDocumentPosition.textDocument.uri);
		if (textDocument) {
			const cache = documentCaches.get(textDocument.uri);
			if (!cache) {
				return ;
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
	});

connection.onDocumentHighlight(
	(_textDocumentPosition: TextDocumentPositionParams): DocumentHighlight[] => {
		return [];
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
