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
	InitializeResult
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

// import { unWindProgram } from './cc-program';

// export interface EffectPrograms 
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

let engineDirectory = '';

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

async function query_engine_path() : Promise<string> {
	if (engineDirectory !== '') {
		return Promise.resolve(engineDirectory);
	} else {
		if (!hasConfigurationCapability) {
			return Promise.resolve(engineDirectory);
		}
		return connection.workspace.getConfiguration({
			section: 'cocos-effect'
		}).then((settings) => {
			engineDirectory = settings.engineDirectory;
			return engineDirectory;
		});
	}
}

function load_engine_programs() : boolean {
	// TODO (yiwenxue): load the engine programs from the engine path. if not found, return false, the diagnostics should throw an error.
	return false;
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	// should use glsl validator to validate the shader code.
	// In this simple example we get the settings for every validate run.
	const settings = await getDocumentSettings(textDocument.uri);

	// The validator creates diagnostics for all uppercase words length 2 and more
	const text = textDocument.getText();
	const pattern = /\b[A-Z]{2,}\b/g;
	let m: RegExpExecArray | null;

	let problems = 0;
	const diagnostics: Diagnostic[] = [];
	while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
		problems++;
		const diagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Warning,
			range: {
				start: textDocument.positionAt(m.index),
				end: textDocument.positionAt(m.index + m[0].length)
			},
			message: `${m[0]} is all uppercase.`,
			source: 'ex'
		};
		if (hasDiagnosticRelatedInformationCapability) {
			diagnostic.relatedInformation = [
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: 'Spelling matters'
				},
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: 'Particularly for names'
				}
			];
		}
		diagnostics.push(diagnostic);
	}

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
		// query the engine path
		connection.workspace.getConfiguration({
			section: 'cocos-effect'
		}).then((settings) => {
			engineDirectory = settings.engineDirectory;
		});
	} else {
		globalSettings = <CocosEffectLanguageServerSettings>(
			(change.settings['cocos-program'].languageServer || defaultSettings)
		);
		engineDirectory = '';
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
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
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
		connection.workspace.getConfiguration({
			section: 'cocos-effect'
		}).then((settings) => {
			engineDirectory = settings.engineDirectory;
		});
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
});

documents.onDidOpen(e => {
	const textDocument = e.document;

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
	connection.console.log('We received an file close event');
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	// TODO: we need to check if the file is in the mapping
	const document = change.document;
	// TODO: we need to check if the changed position is a include statement or not
	validateTextDocument(document);
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

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		// the document we are working on
		// const textDocument = documents.get(_textDocumentPosition.textDocument.uri);
		// if (textDocument) {
		// 	const linePrefix = textDocument.getText().substr(0, textDocument.offsetAt(_textDocumentPosition.position));
		// 	if (!linePrefix.endsWith(' ')) {
		// 		return [];
		// 	}
		// 	// TODO: solve the problem of the completion
		// }
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

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
